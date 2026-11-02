package streams

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// HLS media-playlist model shared by the DVR window writer (G5) and the clip
// planner (G6). Pure: parsing, timing and rendering never touch the disk —
// the callers hand in the playlist text and a segment-mtime lookup.

// MediaSegment is one #EXTINF entry of an HLS media playlist.
type MediaSegment struct {
	URI           string
	Duration      float64 // seconds
	PDT           float64 // #EXT-X-PROGRAM-DATE-TIME as epoch ms (0 = absent)
	Discontinuity bool
}

// MediaPlaylist is the subset of an HLS media playlist the core rewrites.
type MediaPlaylist struct {
	Version               int
	TargetDuration        float64
	MediaSequence         int64
	DiscontinuitySequence int64
	Ended                 bool
	Segments              []MediaSegment
}

// pdtLayouts are the PROGRAM-DATE-TIME spellings seen in the wild (LiveKit
// egress writes RFC 3339 with millis; ffmpeg writes a colon-less offset).
var pdtLayouts = []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z0700", "2006-01-02T15:04:05Z0700"}

// ParsePDT parses a PROGRAM-DATE-TIME value into epoch ms (ok=false if not).
func ParsePDT(v string) (float64, bool) {
	v = strings.TrimSpace(v)
	for _, l := range pdtLayouts {
		if t, err := time.Parse(l, v); err == nil {
			return float64(t.UnixMilli()), true
		}
	}
	return 0, false
}

// FormatPDT renders epoch ms as a PROGRAM-DATE-TIME value (UTC, millis).
func FormatPDT(ms float64) string {
	return time.UnixMilli(int64(math.Round(ms))).UTC().Format("2006-01-02T15:04:05.000Z")
}

func tagValue(line, tag string) (string, bool) {
	if !strings.HasPrefix(line, tag) {
		return "", false
	}
	return strings.TrimSpace(line[len(tag):]), true
}

// CompleteLines drops a trailing partial line: a playlist read while the
// egress is rewriting it may end mid-URI, which must not become a segment.
func CompleteLines(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] != '\n' {
		if i := strings.LastIndexByte(string(b), '\n'); i >= 0 {
			return b[:i+1]
		}
		return nil
	}
	return b
}

// ParseMediaPlaylist reads a media playlist; unknown tags are dropped.
func ParseMediaPlaylist(text string) MediaPlaylist {
	var p MediaPlaylist
	var pending MediaSegment
	haveInf := false
	for _, raw := range lineSplit.Split(text, -1) {
		line := jsTrim(raw)
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "#") {
			if !haveInf {
				continue // a URI without #EXTINF is not a segment
			}
			pending.URI = line
			p.Segments = append(p.Segments, pending)
			pending, haveInf = MediaSegment{}, false
			continue
		}
		if v, ok := tagValue(line, "#EXTINF:"); ok {
			d, _ := strconv.ParseFloat(strings.TrimSpace(strings.SplitN(v, ",", 2)[0]), 64)
			if math.IsNaN(d) || math.IsInf(d, 0) || d < 0 {
				d = 0
			}
			pending.Duration, haveInf = d, true
		} else if v, ok := tagValue(line, "#EXT-X-PROGRAM-DATE-TIME:"); ok {
			pending.PDT, _ = ParsePDT(v)
		} else if line == "#EXT-X-DISCONTINUITY" {
			pending.Discontinuity = true
		} else if line == "#EXT-X-ENDLIST" {
			p.Ended = true
		} else if v, ok := tagValue(line, "#EXT-X-VERSION:"); ok {
			p.Version, _ = strconv.Atoi(v)
		} else if v, ok := tagValue(line, "#EXT-X-TARGETDURATION:"); ok {
			p.TargetDuration, _ = strconv.ParseFloat(v, 64)
		} else if v, ok := tagValue(line, "#EXT-X-MEDIA-SEQUENCE:"); ok {
			p.MediaSequence, _ = strconv.ParseInt(v, 10, 64)
		} else if v, ok := tagValue(line, "#EXT-X-DISCONTINUITY-SEQUENCE:"); ok {
			p.DiscontinuitySequence, _ = strconv.ParseInt(v, 10, 64)
		}
	}
	return p
}

// TimedSegment is a segment placed on the wall clock (epoch ms).
type TimedSegment struct {
	MediaSegment
	Start, End float64
}

// Timeline places every segment on the wall clock. PROGRAM-DATE-TIME wins
// (and carries forward over segments without one, as the HLS spec says);
// segments before the first PDT are back-filled by duration. With no PDT at
// all the anchor is the newest segment's file mtime (≈ its end: the egress
// closes the file when the segment is complete). nil when nothing anchors.
func (p MediaPlaylist) Timeline(mtime func(uri string) (float64, bool)) []TimedSegment {
	n := len(p.Segments)
	if n == 0 {
		return nil
	}
	out := make([]TimedSegment, n)
	for i, s := range p.Segments {
		out[i].MediaSegment = s
	}
	anchor := -1
	for i, s := range p.Segments {
		if s.PDT > 0 {
			anchor = i
			break
		}
	}
	if anchor >= 0 {
		for i := anchor; i < n; i++ {
			if p.Segments[i].PDT > 0 {
				out[i].Start = p.Segments[i].PDT
			} else {
				out[i].Start = out[i-1].End
			}
			out[i].End = out[i].Start + p.Segments[i].Duration*1000
		}
		for i := anchor - 1; i >= 0; i-- {
			out[i].End = out[i+1].Start
			out[i].Start = out[i].End - p.Segments[i].Duration*1000
		}
		return out
	}
	if mtime == nil {
		return nil
	}
	last := -1
	var end float64
	for i := n - 1; i >= 0; i-- {
		if m, ok := mtime(p.Segments[i].URI); ok {
			last, end = i, m
			break
		}
	}
	if last < 0 {
		return nil
	}
	out[last].End = end
	out[last].Start = end - p.Segments[last].Duration*1000
	for i := last - 1; i >= 0; i-- {
		out[i].End = out[i+1].Start
		out[i].Start = out[i].End - p.Segments[i].Duration*1000
	}
	for i := last + 1; i < n; i++ {
		out[i].Start = out[i-1].End
		out[i].End = out[i].Start + p.Segments[i].Duration*1000
	}
	return out
}

// BuildWindowPlaylist renders the last maxSegments segments (<= 0 = all) as
// a sliding-window media playlist: MEDIA-SEQUENCE / DISCONTINUITY-SEQUENCE
// advance by what was dropped, no EXT-X-PLAYLIST-TYPE (a window drops its
// head, which EVENT forbids), ENDLIST kept once the source ended. When the
// timeline is known every segment carries a PROGRAM-DATE-TIME, so a player
// can map a wall-clock instant (?t=<epoch>) onto the window.
func BuildWindowPlaylist(p MediaPlaylist, timeline []TimedSegment, maxSegments int) string {
	segs := p.Segments
	from := 0
	if maxSegments > 0 && len(segs) > maxSegments {
		from = len(segs) - maxSegments
	}
	disc := p.DiscontinuitySequence
	for _, s := range segs[:from] {
		if s.Discontinuity {
			disc++
		}
	}
	target := p.TargetDuration
	for _, s := range segs[from:] {
		target = math.Max(target, math.Ceil(s.Duration))
	}
	version := p.Version
	if version < 3 {
		version = 3
	}
	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	fmt.Fprintf(&b, "#EXT-X-VERSION:%d\n", version)
	fmt.Fprintf(&b, "#EXT-X-TARGETDURATION:%d\n", int64(math.Ceil(target)))
	fmt.Fprintf(&b, "#EXT-X-MEDIA-SEQUENCE:%d\n", p.MediaSequence+int64(from))
	if disc > 0 {
		fmt.Fprintf(&b, "#EXT-X-DISCONTINUITY-SEQUENCE:%d\n", disc)
	}
	timed := len(timeline) == len(segs)
	for i := from; i < len(segs); i++ {
		s := segs[i]
		if s.Discontinuity {
			b.WriteString("#EXT-X-DISCONTINUITY\n")
		}
		if timed {
			fmt.Fprintf(&b, "#EXT-X-PROGRAM-DATE-TIME:%s\n", FormatPDT(timeline[i].Start))
		}
		fmt.Fprintf(&b, "#EXTINF:%.3f,\n%s\n", s.Duration, s.URI)
	}
	if p.Ended {
		b.WriteString("#EXT-X-ENDLIST\n")
	}
	return b.String()
}
