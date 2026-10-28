// Package healthworker is the stream-health worker (`streamhub-core
// health-worker`): a sampling-based ORIGIN HLS quality probe, spawned per
// app by the plugin framework. Port of the Node health-worker/ (plain Node,
// zero npm deps) — same env contract, same events, same stdout lines.
//
// Sampling model (CPU-honest, never a full decode): the loop ticks every 2 s;
// a room is probed when its resolved sample_interval_sec elapsed. One probe =
// playlist read+diff, stat() of new segments, and — only when a NEW segment
// appeared — one ffprobe (headers), one bounded TS continuity read (first
// 4 MB) and one audio-only volumedetect decode of that single segment.
package healthworker

import (
	"math"
	"regexp"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of playlist.js: HLS media-playlist parsing + poll-to-poll diffing.

// Segment is one media segment of a playlist.
type Segment struct {
	URI           string
	Duration      float64
	Discontinuity bool
	Seq           float64
}

// Playlist is a parsed media playlist.
type Playlist struct {
	MediaSequence  float64
	TargetDuration *float64
	Endlist        bool
	Segments       []Segment
}

var lineSplit = regexp.MustCompile(`\r?\n`)

// num is Number(s) when finite.
func num(s string) (float64, bool) {
	n := y.StringToNumber(s)
	return n, !math.IsNaN(n) && !math.IsInf(n, 0)
}

// ParsePlaylist parses a media playlist (never fails).
func ParsePlaylist(text string) Playlist {
	pl := Playlist{Segments: []Segment{}}
	var pendingDuration *float64
	pendingDisc := false
	for _, raw := range lineSplit.Split(text, -1) {
		line := y.Trim(raw)
		switch {
		case line == "":
		case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			if n, ok := num(line[len("#EXT-X-MEDIA-SEQUENCE:"):]); ok {
				pl.MediaSequence = n
			}
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			if n, ok := num(line[len("#EXT-X-TARGETDURATION:"):]); ok {
				pl.TargetDuration = &n
			}
		case strings.HasPrefix(line, "#EXT-X-DISCONTINUITY"):
			if !strings.HasPrefix(line, "#EXT-X-DISCONTINUITY-SEQUENCE") {
				pendingDisc = true
			}
		case strings.HasPrefix(line, "#EXTINF:"):
			d := 0.0
			if n, ok := num(strings.SplitN(line[len("#EXTINF:"):], ",", 2)[0]); ok {
				d = n
			}
			pendingDuration = &d
		case line == "#EXT-X-ENDLIST":
			pl.Endlist = true
		case !strings.HasPrefix(line, "#"):
			d := 0.0
			if pendingDuration != nil {
				d = *pendingDuration
			}
			pl.Segments = append(pl.Segments, Segment{URI: line, Duration: d, Discontinuity: pendingDisc,
				Seq: pl.MediaSequence + float64(len(pl.Segments))})
			pendingDuration, pendingDisc = nil, false
		}
	}
	return pl
}

// Diff is one poll-to-poll diff.
type Diff struct {
	Advanced             bool
	NewSegments          []Segment
	DroppedSegments      float64
	NewDiscontinuityTags int
}

func countDisc(segs []Segment) int {
	n := 0
	for _, s := range segs {
		if s.Discontinuity {
			n++
		}
	}
	return n
}

// DiffPlaylist diffs two consecutive polls (prev nil = first poll).
func DiffPlaylist(prev *Playlist, curr Playlist) Diff {
	if prev == nil {
		segs := append([]Segment{}, curr.Segments...)
		return Diff{Advanced: len(curr.Segments) > 0, NewSegments: segs, NewDiscontinuityTags: countDisc(segs)}
	}
	currEnd := curr.MediaSequence + float64(len(curr.Segments))
	prevEnd := prev.MediaSequence + float64(len(prev.Segments))
	d := Diff{Advanced: currEnd > prevEnd, NewSegments: []Segment{}, DroppedSegments: math.Max(0, curr.MediaSequence-prevEnd)}
	for _, s := range curr.Segments {
		if s.Seq >= prevEnd {
			d.NewSegments = append(d.NewSegments, s)
		}
	}
	d.NewDiscontinuityTags = countDisc(d.NewSegments)
	return d
}

// SegInfo is one new segment's byte size + EXTINF seconds.
type SegInfo struct {
	Bytes    float64
	Duration float64
}

// MeasuredKbps is the delivery bitrate over the new segments (nil = nothing new).
func MeasuredKbps(segs []SegInfo) *float64 {
	var bytes, seconds float64
	for _, s := range segs {
		if !finite(s.Bytes) || !finite(s.Duration) {
			continue
		}
		bytes += math.Max(0, s.Bytes)
		seconds += math.Max(0, s.Duration)
	}
	if seconds <= 0 || bytes <= 0 {
		return nil
	}
	k := jsRound(bytes * 8 / seconds / 1000)
	return &k
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// jsRound is Math.round.
func jsRound(x float64) float64 { return math.Floor(x+0.5) + 0 }
