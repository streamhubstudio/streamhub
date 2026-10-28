package healthworker

import "regexp"

// Port of volume.js: the audio-only volumedetect scan of one segment.

// VolumeArgs is the ffmpeg argv (after the binary): audio only, null muxer.
func VolumeArgs(file string) []string {
	return []string{"-hide_banner", "-nostats", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"}
}

// Volume is a parsed volumedetect result.
type Volume struct {
	MeanDb float64
	MaxDb  *float64
}

var (
	meanRe = regexp.MustCompile(`mean_volume:\s*(-?[\d.]+)\s*dB`)
	maxRe  = regexp.MustCompile(`max_volume:\s*(-?[\d.]+)\s*dB`)
)

// ParseVolumeDetect parses ffmpeg's stderr (nil = no volumedetect output,
// e.g. no audio stream: "missing", not "silent").
func ParseVolumeDetect(stderr string) *Volume {
	m := meanRe.FindStringSubmatch(stderr)
	if m == nil {
		return nil
	}
	mean, ok := num(m[1])
	if !ok {
		return nil
	}
	v := &Volume{MeanDb: mean}
	if x := maxRe.FindStringSubmatch(stderr); x != nil {
		if mx, ok := num(x[1]); ok {
			v.MaxDb = &mx
		}
	}
	return v
}
