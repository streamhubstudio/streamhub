package healthworker

import (
	"math"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of probe.js: ffprobe argv + JSON output parsing. The per-track
// start_time difference within one segment is the A/V desync signal.

// FfprobeArgs is the ffprobe argv (after the binary) for one media file.
func FfprobeArgs(file string) []string {
	return []string{"-v", "error", "-print_format", "json", "-show_format", "-show_streams", file}
}

// ParseFps parses "30000/1001" | "25/1" | "25" into fps (1 decimal).
func ParseFps(rate any) *float64 {
	s := ""
	if !y.IsNullish(rate) {
		s = y.Trim(y.ToString(rate))
	}
	if s == "" || s == "0/0" {
		return nil
	}
	parts := strings.Split(s, "/")
	n := y.StringToNumber(parts[0])
	d := 1.0
	if len(parts) > 1 {
		d = y.StringToNumber(parts[1])
	}
	if !finite(n) || !finite(d) || d == 0 || n <= 0 {
		return nil
	}
	f := jsRound(n/d*10) / 10
	return &f
}

// jsNum is probe.js num(): a finite number (strings via Number()), else nil.
func jsNum(v any) *float64 {
	var n float64
	switch x := v.(type) {
	case string:
		n = y.StringToNumber(x)
	case float64:
		n = x
	default:
		return nil
	}
	if !finite(n) {
		return nil
	}
	return &n
}

func kbpsOf(v any) *float64 {
	n := jsNum(v)
	if n == nil {
		return nil
	}
	k := jsRound(*n / 1000)
	return &k
}

// Video is a segment's video track.
type Video struct {
	Codec       string
	Width       *float64
	Height      *float64
	Fps         *float64
	BitrateKbps *float64
	StartTime   *float64
}

// Audio is a segment's audio track.
type Audio struct {
	Codec       string
	SampleRate  *float64
	Channels    *float64
	BitrateKbps *float64
	StartTime   *float64
}

// Facts is one ffprobe result.
type Facts struct {
	Video              *Video
	Audio              *Audio
	DurationSec        *float64
	OverallBitrateKbps *float64
	DesyncMs           *float64
}

func prop(v any, k string) any {
	if m, ok := v.(*y.Map); ok && m != nil {
		return m.Get(k)
	}
	return y.Undefined
}

func truthy(v any) bool { return y.Truthy(v) }

func codec(v any) string {
	if y.IsNullish(v) {
		return ""
	}
	return y.ToString(v)
}

// ParseFfprobe parses `ffprobe -print_format json` output (nil = unparseable).
func ParseFfprobe(jsonText string) *Facts {
	parsed, err := y.ParseJSON([]byte(jsonText))
	if err != nil {
		return nil
	}
	root, ok := parsed.(*y.Map)
	if !ok || root == nil {
		if _, isArr := parsed.([]any); !isArr {
			return nil
		}
	}
	var streams []any
	if root != nil {
		streams, _ = root.Get("streams").([]any)
	}
	find := func(kind string) any {
		for _, s := range streams {
			if truthy(s) && prop(s, "codec_type") == kind {
				return s
			}
		}
		return nil
	}
	f := &Facts{}
	if v := find("video"); v != nil {
		fps := ParseFps(prop(v, "avg_frame_rate"))
		if fps == nil {
			fps = ParseFps(prop(v, "r_frame_rate"))
		}
		f.Video = &Video{Codec: codec(prop(v, "codec_name")), Width: jsNum(prop(v, "width")), Height: jsNum(prop(v, "height")),
			Fps: fps, BitrateKbps: kbpsOf(prop(v, "bit_rate")), StartTime: jsNum(prop(v, "start_time"))}
	}
	if a := find("audio"); a != nil {
		f.Audio = &Audio{Codec: codec(prop(a, "codec_name")), SampleRate: jsNum(prop(a, "sample_rate")), Channels: jsNum(prop(a, "channels")),
			BitrateKbps: kbpsOf(prop(a, "bit_rate")), StartTime: jsNum(prop(a, "start_time"))}
	}
	if f.Video != nil && f.Video.StartTime != nil && f.Audio != nil && f.Audio.StartTime != nil {
		d := jsRound(math.Abs(*f.Video.StartTime-*f.Audio.StartTime) * 1000)
		f.DesyncMs = &d
	}
	format := prop(root, "format")
	if _, isObj := format.(*y.Map); !isObj {
		format = nil
	}
	f.DurationSec = jsNum(prop(format, "duration"))
	f.OverallBitrateKbps = kbpsOf(prop(format, "bit_rate"))
	return f
}
