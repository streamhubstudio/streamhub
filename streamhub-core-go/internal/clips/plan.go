// Package clips is G6 — instant and event clips (features/dvr-clips.md):
// POST /apps/:app/streams/:id/clips cuts [from, to] out of the stream's live
// HLS/DVR segments with ffmpeg `-c copy` (no re-encode), publishes the MP4
// to the app's S3 through the recording upload flow as a VOD row with
// source=clip, and dispatches clip.ready / clip.failed through the signed
// callbacks funnel (so Streamflow and webhooks see them). Jobs are async with
// a persisted state (queued → running → ready | failed) in apps/<app>/app.db.
//
// This file is the pure half: request → range, range ↔ the on-disk window,
// segment selection and the ffmpeg argv. No I/O.
package clips

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/streams"
)

const (
	// DefaultEventBefore / DefaultEventAfter frame an event clip (20 s total).
	DefaultEventBefore = 10.0
	DefaultEventAfter  = 10.0
	// MaxFutureSeconds bounds how far past "now" a clip may end: the job
	// waits for those segments to be written, never longer.
	MaxFutureSeconds = 120.0
	// minClipSeconds refuses degenerate (empty) ranges.
	minClipSeconds = 1.0
)

// minEpochMs: a number below it is epoch SECONDS (what the vision workers
// send as `ts`), at or above it epoch milliseconds.
const minEpochMs = 100_000_000_000

// ParseInstant reads an instant: epoch seconds or ms (number or numeric
// string) or an RFC 3339 / ISO-8601 string. ok=false on anything else.
func ParseInstant(v any) (float64, bool) {
	toMs := func(n float64) (float64, bool) {
		if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
			return 0, false
		}
		if n < minEpochMs {
			return math.Round(n * 1000), true
		}
		return math.Round(n), true
	}
	switch x := v.(type) {
	case float64:
		return toMs(x)
	case int:
		return toMs(float64(x))
	case int64:
		return toMs(float64(x))
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0, false
		}
		if n, err := strconv.ParseFloat(s, 64); err == nil {
			return toMs(n)
		}
		for _, l := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z0700", "2006-01-02T15:04:05Z0700"} {
			if t, err := time.Parse(l, s); err == nil {
				return float64(t.UnixMilli()), true
			}
		}
	}
	return 0, false
}

// Request is the parsed POST body: either {from, to} or {eventTs, before,
// after} (before/after default to 10 s). Raw values, validated by Resolve.
type Request struct {
	From, To, EventTs any
	Before, After     *float64
}

// Range is a clip interval on the wall clock (epoch ms).
type Range struct {
	FromMs, ToMs float64
}

// DurationS is the range length in seconds.
func (r Range) DurationS() float64 { return (r.ToMs - r.FromMs) / 1000 }

// Resolve validates the request shape and turns it into a range (the window
// and the limits are checked later, against the room's segments).
func (q Request) Resolve() (Range, error) {
	hasRange := q.From != nil || q.To != nil
	hasEvent := q.EventTs != nil
	switch {
	case hasRange && hasEvent:
		return Range{}, httpx.BadRequest("send either {from, to} or {eventTs, before, after}, not both")
	case hasEvent:
		ts, ok := ParseInstant(q.EventTs)
		if !ok {
			return Range{}, httpx.BadRequest("eventTs must be an epoch (s or ms) or an ISO-8601 date")
		}
		before, after := DefaultEventBefore, DefaultEventAfter
		if q.Before != nil {
			before = *q.Before
		}
		if q.After != nil {
			after = *q.After
		}
		if !(before >= 0 && after >= 0) || math.IsInf(before, 0) || math.IsInf(after, 0) {
			return Range{}, httpx.BadRequest("before and after must be non-negative seconds")
		}
		return Range{ts - before*1000, ts + after*1000}, nil
	case hasRange:
		from, okF := ParseInstant(q.From)
		to, okT := ParseInstant(q.To)
		if !okF || !okT {
			return Range{}, httpx.BadRequest("from and to must be epochs (s or ms) or ISO-8601 dates")
		}
		return Range{from, to}, nil
	}
	return Range{}, httpx.BadRequest("send {from, to} or {eventTs, before, after}")
}

// Window is what the room's segments cover on disk (epoch ms).
type Window struct {
	StartMs, EndMs float64
}

// iso renders epoch ms for error messages.
func iso(ms float64) string {
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
}

// Validate checks a range against the limits and the available window:
// positive and at most maxSeconds long, starting inside the window, and
// ending no later than now + MaxFutureSeconds (the job waits for those
// segments, so a clip may also reach — or start — past the live edge).
func Validate(r Range, maxSeconds float64, w Window, nowMs float64) error {
	d := r.DurationS()
	if !(d >= minClipSeconds) {
		return httpx.BadRequest(fmt.Sprintf("clip must last at least %gs (to must be after from)", minClipSeconds))
	}
	if d > maxSeconds {
		return httpx.BadRequest(fmt.Sprintf("clip lasts %gs; the app allows at most %gs (features.clips.max_seconds)", math.Round(d*10)/10, maxSeconds))
	}
	if r.FromMs < w.StartMs {
		return httpx.BadRequest(fmt.Sprintf("clip starts at %s, before the oldest available segment (%s)", iso(r.FromMs), iso(w.StartMs)))
	}
	if r.ToMs > nowMs+MaxFutureSeconds*1000 {
		return httpx.BadRequest(fmt.Sprintf("clip ends more than %gs in the future", MaxFutureSeconds))
	}
	return nil
}

// WindowOf is the span the timeline covers (ok=false when empty).
func WindowOf(tl []streams.TimedSegment) (Window, bool) {
	if len(tl) == 0 {
		return Window{}, false
	}
	return Window{tl[0].Start, tl[len(tl)-1].End}, true
}

// Selection is what ffmpeg cuts: the overlapping segments, the seek into
// the first one and the output duration.
type Selection struct {
	Segments  []streams.TimedSegment
	OffsetS   float64
	DurationS float64
}

// Select picks the segments overlapping r. The cut is keyframe-aligned by
// `-c copy` (it starts at the keyframe at/before OffsetS — up to one GOP
// early), so callers should treat from/to as ±1 GOP.
func Select(tl []streams.TimedSegment, r Range) (Selection, bool) {
	var sel Selection
	for _, s := range tl {
		if s.End > r.FromMs && s.Start < r.ToMs {
			sel.Segments = append(sel.Segments, s)
		}
	}
	if len(sel.Segments) == 0 {
		return sel, false
	}
	first, last := sel.Segments[0], sel.Segments[len(sel.Segments)-1]
	from := math.Max(r.FromMs, first.Start)
	to := math.Min(r.ToMs, last.End)
	sel.OffsetS = (from - first.Start) / 1000
	sel.DurationS = (to - from) / 1000
	return sel, sel.DurationS > 0
}

// ConcatList is the ffconcat script listing the segment files (absolute
// paths, single quotes escaped the ffconcat way).
func ConcatList(paths []string) string {
	var b strings.Builder
	b.WriteString("ffconcat version 1.0\n")
	for _, p := range paths {
		b.WriteString("file '" + strings.ReplaceAll(p, "'", `'\''`) + "'\n")
	}
	return b.String()
}

func num(f float64) string { return strconv.FormatFloat(math.Round(f*1000)/1000, 'f', -1, 64) }

// FfmpegArgs is the `-c copy` cut: concat demuxer over the segments, input
// seek to the offset, output duration, MPEG-TS AAC → MP4, moov up front.
func FfmpegArgs(listFile, out string, sel Selection) []string {
	return []string{
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "concat", "-safe", "0",
		"-ss", num(sel.OffsetS),
		"-i", listFile,
		"-t", num(sel.DurationS),
		"-c", "copy",
		"-bsf:a", "aac_adtstoasc",
		"-movflags", "+faststart",
		out,
	}
}

// ReadyAt is when the range's last segment should be on disk: the range end
// plus two segments (the egress closes a segment, then lists it).
func ReadyAt(r Range, segmentSeconds float64) float64 {
	if segmentSeconds <= 0 {
		segmentSeconds = 4
	}
	return r.ToMs + 2*segmentSeconds*1000
}
