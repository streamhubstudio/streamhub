package config

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseFPS parses "25", "29.97", "30000/1001" into a reduced num/den.
// Only broadcast rates are accepted.
func ParseFPS(s string) (num, den int, err error) {
	s = strings.TrimSpace(s)
	switch s {
	case "23.976", "23.98":
		return 24000, 1001, nil
	case "29.97":
		return 30000, 1001, nil
	case "59.94":
		return 60000, 1001, nil
	}
	if a, b, ok := strings.Cut(s, "/"); ok {
		n, e1 := strconv.Atoi(a)
		d, e2 := strconv.Atoi(b)
		if e1 != nil || e2 != nil || n <= 0 || d <= 0 {
			return 0, 0, fmt.Errorf("invalid fps %q", s)
		}
		num, den = n, d
	} else {
		n, e := strconv.Atoi(s)
		if e != nil || n <= 0 {
			return 0, 0, fmt.Errorf("invalid fps %q", s)
		}
		num, den = n, 1
	}
	if den != 1 && den != 1001 {
		g := gcd(num, den)
		num, den = num/g, den/g
	}
	ok := false
	for _, r := range AllowedFPS {
		if r[0] == num && r[1] == den {
			ok = true
		}
	}
	if !ok {
		return 0, 0, fmt.Errorf("unsupported fps %q (allowed: 23.976 24 25 29.97 30 50 59.94 60)", s)
	}
	return num, den, nil
}

// AllowedFPS are the frame rates the encoder accepts (num, den).
var AllowedFPS = [][2]int{{24000, 1001}, {24, 1}, {25, 1}, {30000, 1001}, {30, 1}, {50, 1}, {60000, 1001}, {60, 1}}

// FPSFloat returns the frame rate as a float (0 on error).
func FPSFloat(s string) float64 {
	n, d, err := ParseFPS(s)
	if err != nil {
		return 0
	}
	return float64(n) / float64(d)
}

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func boolPtr(b bool) *bool { return &b }

// DeinterlaceOn reports whether interlaced input gets deinterlaced.
func (v Video) DeinterlaceOn() bool { return v.Deinterlace == nil || *v.Deinterlace }

// ApplyDefaults fills zero values of a channel in place. It is idempotent.
func (c *Channel) ApplyDefaults() {
	if c.Name == "" {
		c.Name = c.ID
	}
	in := &c.Input
	in.applyDefaults()
	if c.Backup != nil {
		c.Backup.applyDefaults()
	}
	v := &c.Video
	if v.Codec == "" {
		v.Codec = CodecH264
	}
	if v.Encoder == "" {
		v.Encoder = EncAuto
	}
	if v.Width == 0 && v.Height == 0 {
		v.Width, v.Height = 1920, 1080
	}
	if v.FPS == "" {
		v.FPS = "30"
	}
	if v.BitrateKbps == 0 {
		v.BitrateKbps = 4000
	}
	if v.RateControl == "" {
		v.RateControl = "cbr"
	}
	if v.GOP == 0 {
		f := FPSFloat(v.FPS)
		if f == 0 {
			f = 30
		}
		v.GOP = int(f*2 + 0.5) // 2 s, the usual HLS/CDN-friendly keyframe interval
	}
	if v.Profile == "" {
		if v.Codec == CodecH265 {
			v.Profile = "main"
		} else {
			v.Profile = "high"
		}
	}
	if v.LowLatency {
		v.BFrames = 0
	}
	if v.Deinterlace == nil {
		v.Deinterlace = boolPtr(true)
	}
	a := &c.Audio
	if a.Codec == "" {
		a.Codec = "aac"
	}
	if a.Channels == 0 {
		a.Channels = 2
	}
	if a.SampleRate == 0 {
		a.SampleRate = 48000
	}
	if a.BitrateKbps == 0 {
		a.BitrateKbps = 64 * a.Channels
		if a.Channels == 1 {
			a.BitrateKbps = 96
		}
		if a.BitrateKbps > 512 {
			a.BitrateKbps = 512
		}
	}
	m := &c.Mux
	if m.VideoPID == 0 {
		m.VideoPID = 256
	}
	if m.AudioPID == 0 {
		m.AudioPID = 257
	}
	if m.PCRIntervalMs == 0 {
		m.PCRIntervalMs = 20
	}
	if c.Outputs == nil {
		c.Outputs = []Output{}
	}
	for i := range c.Outputs {
		c.Outputs[i].ApplyDefaults(c.ID)
	}
	c.applyProDefaults()
}

func (in *Input) applyDefaults() {
	if in.TimeoutMs == 0 {
		in.TimeoutMs = 2000
	}
	switch in.Type {
	case InTest:
		if in.Pattern == "" {
			in.Pattern = "smpte"
		}
		if in.ToneHz == 0 {
			in.ToneHz = 1000
		}
	case InDeckLink:
		if in.Connection == "" {
			in.Connection = "auto"
		}
		if in.Mode == "" {
			in.Mode = "auto"
		}
		if in.AudioInputCh == 0 {
			in.AudioInputCh = 2
		}
	case InV4L2:
		if in.DevicePath == "" {
			in.DevicePath = "/dev/video0"
		}
		if in.Format == "" {
			in.Format = "raw"
		}
	case InFile:
		if in.URI != "" && strings.HasPrefix(in.URI, "/") {
			in.URI = "file://" + in.URI
		}
	}
}

// ApplyDefaults fills zero values of an output in place.
func (o *Output) ApplyDefaults(channelID string) {
	switch o.Type {
	case OutSRT:
		if o.SRT == nil {
			o.SRT = &SRTOptions{}
		}
		if o.SRT.Mode == "" {
			o.SRT.Mode = "caller"
			if strings.HasPrefix(o.URL, "srt://:") {
				o.SRT.Mode = "listener"
			}
		}
		if o.SRT.LatencyMs == 0 {
			o.SRT.LatencyMs = 200
		}
		if o.SRT.Passphrase != "" && o.SRT.PBKeyLen == 0 {
			o.SRT.PBKeyLen = 16
		}
	case OutUDP, OutRTP:
		if o.UDP == nil {
			o.UDP = &UDPOptions{}
		}
		if o.UDP.TTL == 0 {
			o.UDP.TTL = 16
		}
	case OutHLS:
		if o.HLS == nil {
			o.HLS = &HLSOptions{}
		}
		if o.HLS.SegmentSeconds == 0 {
			o.HLS.SegmentSeconds = 2
		}
		if o.HLS.ListSize == 0 {
			o.HLS.ListSize = 6
		}
	case OutStreamHub:
		if o.StreamHub == nil {
			o.StreamHub = &StreamHubOutput{}
		}
		if o.StreamHub.Protocol == "" {
			o.StreamHub.Protocol = "rtmp"
		}
		if o.StreamHub.Room == "" {
			o.StreamHub.Room = channelID
		}
		o.StreamHub.BaseURL = strings.TrimRight(o.StreamHub.BaseURL, "/")
	}
	if o.Name == "" {
		o.Name = o.ID
	}
}
