package config

import (
	"fmt"
	"net"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var (
	reLang     = regexp.MustCompile(`^[a-z]{3}$`)
	reMaster   = regexp.MustCompile(`^G\(\d+,\d+\)B\(\d+,\d+\)R\(\d+,\d+\)WP\(\d+,\d+\)L\(\d+,\d+\)$`)
	reMaxCLL   = regexp.MustCompile(`^\d{1,5},\d{1,5}$`)
	rePNG      = regexp.MustCompile(`^/[A-Za-z0-9._/-]+\.png$`)
	reHostPort = regexp.MustCompile(`^[A-Za-z0-9.:\[\]-]+:\d{1,5}$`)
)

// AudioCodecs accepted for the main track and extra tracks.
var AudioCodecs = []string{"aac", "ac3", "mp2"}

// DefaultMasterDisplay is BT.2020/P3-D65 1000-nit (x265 syntax), used for PQ
// when masterDisplay is not given.
const DefaultMasterDisplay = "G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)"

// applyProDefaults fills the professional-feature fields.
func (c *Channel) applyProDefaults() {
	v := &c.Video
	if v.BitDepth == 0 {
		v.BitDepth = 8
	}
	if v.Chroma == "" {
		v.Chroma = "420"
	}
	if v.HDR == "pq" {
		if v.MasterDisplay == "" {
			v.MasterDisplay = DefaultMasterDisplay
		}
		if v.MaxCLL == "" {
			v.MaxCLL = "1000,400"
		}
	}
	for i := range v.Renditions {
		r := &v.Renditions[i]
		if r.Name == "" {
			r.Name = fmt.Sprintf("%dp", r.Height)
		}
	}
	a := &c.Audio
	for i := range a.Tracks {
		t := &a.Tracks[i]
		if t.Codec == "" {
			t.Codec = a.Codec
		}
		if t.Channels == 0 {
			t.Channels = 2
		}
		if t.BitrateKbps == 0 {
			t.BitrateKbps = 64 * t.Channels
			if t.BitrateKbps > 512 {
				t.BitrateKbps = 512
			}
		}
	}
	if c.SCTE35 != nil && c.SCTE35.PID == 0 {
		c.SCTE35.PID = 500
	}
	for i := range c.Outputs {
		o := &c.Outputs[i]
		switch o.Type {
		case OutRIST:
			if o.RIST == nil {
				o.RIST = &RISTOptions{}
			}
			if o.RIST.BufferMs == 0 {
				o.RIST.BufferMs = 1000
			}
		case OutRecord:
			if o.Record == nil {
				o.Record = &RecordOptions{}
			}
			if o.Record.SegmentSeconds == 0 {
				o.Record.SegmentSeconds = 60
			}
			if o.Record.MaxSegments == 0 {
				o.Record.MaxSegments = 60
			}
		}
	}
}

func validateAudioCodec(errs *Errors, p, codec string, ch, kbps int) {
	switch codec {
	case "aac":
	case "ac3":
		if ch != 1 && ch != 2 && ch != 6 {
			errs.add(p+".channels", "AC-3 carries 1, 2 or 6 (5.1) channels")
		}
		if kbps < 64 || kbps > 640 {
			errs.add(p+".bitrateKbps", "AC-3 bitrate must be 64..640")
		}
	case "mp2":
		if ch > 2 {
			errs.add(p+".channels", "MPEG-1 Layer II carries 1 or 2 channels")
		}
		if kbps < 64 || kbps > 384 {
			errs.add(p+".bitrateKbps", "MP2 bitrate must be 64..384")
		}
	default:
		errs.add(p+".codec", "must be aac|ac3|mp2")
	}
}

// validatePro checks the professional-feature fields of a channel.
func (c *Channel) validatePro(errs *Errors) {
	v := c.Video
	if v.BitDepth != 8 && v.BitDepth != 10 {
		errs.add("video.bitDepth", "must be 8 or 10")
	}
	if v.BitDepth == 10 {
		if v.Codec != CodecH265 {
			errs.add("video.bitDepth", "10-bit needs h265 (Main10)")
		}
		if !slices.Contains([]string{EncAuto, EncX265, EncNVENC}, v.Encoder) {
			errs.add("video.bitDepth", "10-bit is validated with x265 and NVENC only")
		}
	}
	switch v.Chroma {
	case "420":
	case "422":
		if v.Codec != CodecH265 || v.BitDepth != 10 || (v.Encoder != EncX265 && v.Encoder != EncAuto) {
			errs.add("video.chroma", "4:2:2 needs h265 10-bit on x265 (Main 4:2:2 10); NVENC has no 4:2:2")
		}
	default:
		errs.add("video.chroma", "must be 420 or 422")
	}
	switch v.HDR {
	case "":
	case "hlg", "pq":
		if v.Codec != CodecH265 || v.BitDepth != 10 {
			errs.add("video.hdr", "HDR needs h265 10-bit")
		}
	default:
		errs.add("video.hdr", "must be empty, hlg or pq")
	}
	if v.MasterDisplay != "" && (v.HDR != "pq" || !reMaster.MatchString(v.MasterDisplay)) {
		errs.add("video.masterDisplay", "PQ only, format G(x,y)B(x,y)R(x,y)WP(x,y)L(max,min)")
	}
	if v.MaxCLL != "" && (v.HDR != "pq" || !reMaxCLL.MatchString(v.MaxCLL)) {
		errs.add("video.maxCll", "PQ only, format maxCLL,maxFALL")
	}
	if v.TimecodeSEI && (v.Codec != CodecH264 || (v.Encoder != EncX264 && v.Encoder != EncAuto)) {
		errs.add("video.timecodeSei", "timecode SEI is implemented for h264/x264")
	}
	if len(v.Renditions) > 4 {
		errs.add("video.renditions", "at most 4 extra renditions")
	}
	for i, r := range v.Renditions {
		p := fmt.Sprintf("video.renditions[%d]", i)
		if r.Width < 128 || r.Width > v.Width || r.Width%2 != 0 || r.Height < 96 || r.Height > v.Height || r.Height%2 != 0 {
			errs.add(p, "even size between 128x96 and the main raster")
		}
		if r.BitrateKbps < 100 || r.BitrateKbps > v.BitrateKbps {
			errs.add(p+".bitrateKbps", "must be 100..main bitrate")
		}
		if !SafeValue(r.Name) || len(r.Name) > 16 {
			errs.add(p+".name", "max 16 printable chars")
		}
	}
	a := c.Audio
	if !a.Disabled {
		validateAudioCodec(errs, "audio", a.Codec, a.Channels, a.BitrateKbps)
		if a.Lang != "" && !reLang.MatchString(a.Lang) {
			errs.add("audio.lang", "ISO 639-2 code, 3 lowercase letters")
		}
		if len(a.Tracks) > 7 {
			errs.add("audio.tracks", "at most 7 extra tracks")
		}
		for i, t := range a.Tracks {
			p := fmt.Sprintf("audio.tracks[%d]", i)
			if !slices.Contains([]int{1, 2, 6, 8}, t.Channels) {
				errs.add(p+".channels", "must be 1, 2, 6 or 8")
			}
			validateAudioCodec(errs, p, t.Codec, t.Channels, t.BitrateKbps)
			if t.Lang != "" && !reLang.MatchString(t.Lang) {
				errs.add(p+".lang", "ISO 639-2 code, 3 lowercase letters")
			}
			if len(t.Map) > 0 {
				if c.Input.Type != InDeckLink {
					errs.add(p+".map", "channel mapping needs a DeckLink input")
				} else if len(t.Map) != t.Channels {
					errs.add(p+".map", "needs one input index per channel")
				}
				for j, m := range t.Map {
					if m < 0 || m >= c.Input.AudioInputCh {
						errs.add(fmt.Sprintf("%s.map[%d]", p, j), "input channel out of range")
					}
				}
			}
		}
	} else if len(a.Tracks) > 0 {
		errs.add("audio.tracks", "audio is disabled")
	}
	o := c.Overlay
	if o.Logo != "" && (!rePNG.MatchString(o.Logo) || strings.Contains(o.Logo, "..")) {
		errs.add("overlay.logo", "absolute .png path without '..'")
	}
	if o.LogoAlpha < 0 || o.LogoAlpha > 1 || o.LogoX < 0 || o.LogoY < 0 {
		errs.add("overlay.logoAlpha", "alpha 0..1, offsets ≥ 0")
	}
	if s := c.SCTE35; s != nil && s.Enabled {
		if s.PID < 32 || s.PID > 8190 || s.PID == c.Mux.VideoPID || s.PID == c.Mux.AudioPID || (s.PID >= 0x110 && s.PID < 0x130) {
			errs.add("scte35.pid", "32..8190, not used by video/audio/renditions/tracks")
		}
		if s.HeartbeatSec < 0 || s.HeartbeatSec > 60 {
			errs.add("scte35.heartbeatSec", "0..60")
		}
	}
	if al := c.Alarms; al != nil {
		if al.BlackSec < 0 || al.FreezeSec < 0 || al.SilenceSec < 0 || al.BitrateDropPct < 0 || al.BitrateDropPct > 100 {
			errs.add("alarms", "durations ≥ 0, bitrateDropPct 0..100")
		}
		if al.LoudnessTarget != 0 && (al.LoudnessTarget < -40 || al.LoudnessTarget > -5) {
			errs.add("alarms.loudnessTarget", "-40..-5 LUFS (0 = off)")
		}
	}
}

// validateOutputPro checks the professional output options.
func (o *Output) validateOutputPro(c *Channel, errs *Errors) {
	if o.Rendition < 0 || o.Rendition > len(c.Video.Renditions) {
		errs.add("rendition", "must be 0..%d", len(c.Video.Renditions))
	}
	if o.Rendition > 0 && !slices.Contains([]string{OutRTMP, OutSRT, OutUDP, OutHLS}, o.Type) {
		errs.add("rendition", "rendition selection is available for rtmp, srt, udp and hls outputs")
	}
	needsAAC := o.Type == OutRTMP || o.Type == OutWHIP || o.Type == OutStreamHub
	if needsAAC && !c.Audio.Disabled && c.Audio.Codec != "aac" {
		errs.add("type", "%s carries AAC audio only (set audio.codec=aac)", o.Type)
	}
	switch o.Type {
	case OutRIST:
		u := validateURL(errs, "url", o.URL, []string{"rist"}, false)
		if u != nil {
			if _, p, err := net.SplitHostPort(u.Host); err == nil {
				if n, _ := strconv.Atoi(p); n%2 != 0 {
					errs.add("url", "RIST needs an even port (RTP), RTCP uses port+1")
				}
			}
		}
		if r := o.RIST; r != nil {
			for i, b := range r.Bonding {
				if !reHostPort.MatchString(b) {
					errs.add(fmt.Sprintf("rist.bonding[%d]", i), "host:port")
				}
			}
			if r.BufferMs < 50 || r.BufferMs > 30000 {
				errs.add("rist.bufferMs", "50..30000")
			}
		}
	case OutRecord:
		if !reAbsPath.MatchString(o.URL) || strings.Contains(o.URL, "..") || strings.Contains(o.URL, " ") {
			errs.add("url", "record output needs an absolute directory path")
		}
		if r := o.Record; r != nil && (r.SegmentSeconds < 2 || r.SegmentSeconds > 3600 || r.MaxSegments < 1 || r.MaxSegments > 10000) {
			errs.add("record", "segmentSeconds 2..3600, maxSegments 1..10000")
		}
	case OutHLS:
		if o.HLS != nil && o.HLS.Ladder && len(c.Video.Renditions) == 0 {
			errs.add("hls.ladder", "needs video.renditions")
		}
		if o.HLS != nil && o.HLS.Ladder && o.Rendition != 0 {
			errs.add("hls.ladder", "ladder publishes every rendition; leave rendition at 0")
		}
	}
}
