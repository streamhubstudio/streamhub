package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// FieldError is one validation failure, addressed by a JSON-ish path.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// Errors is a validation result; nil/empty means valid.
type Errors []FieldError

func (e Errors) Error() string {
	parts := make([]string, len(e))
	for i, fe := range e {
		parts[i] = fe.Field + ": " + fe.Message
	}
	return strings.Join(parts, "; ")
}

func (e *Errors) add(field, format string, args ...any) {
	*e = append(*e, FieldError{Field: field, Message: fmt.Sprintf(format, args...)})
}

// Err returns nil when there are no errors (so callers can `if err := ...`).
func (e Errors) Err() error {
	if len(e) == 0 {
		return nil
	}
	return e
}

var (
	reID      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	reApp     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	reRoom    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	reV4L2    = regexp.MustCompile(`^/dev/(video[0-9]+|v4l/by-(id|path)/[A-Za-z0-9._:-]+)$`)
	reALSA    = regexp.MustCompile(`^(hw|plughw|default|sysdefault)(:[A-Za-z0-9,=_]+)?$`)
	reAbsPath = regexp.MustCompile(`^/[A-Za-z0-9._/ -]+$`)
	reOutPath = regexp.MustCompile(`^/[A-Za-z0-9._/{}-]+$`) // {ts} = start timestamp
)

// MaxChannels bounds the per-box channel count (also a sanity check for the API).
const MaxChannels = 32

var (
	testPatterns  = []string{"smpte", "smpte75", "smpte100", "bar", "ball", "snow", "black", "white", "red", "green", "blue", "checkers-8", "circular", "colors", "gamut", "zone-plate", "pinwheel", "spokes"}
	deckLinkModes = []string{"auto", "ntsc", "pal", "1080p2398", "1080p24", "1080p25", "1080p2997", "1080p30", "1080i50", "1080i5994", "1080i60", "1080p50", "1080p5994", "1080p60", "720p50", "720p5994", "720p60", "2160p25", "2160p2997", "2160p30", "2160p50", "2160p60"}
	x26xPresets   = []string{"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"}
	nvencPresets  = []string{"p1", "p2", "p3", "p4", "p5", "p6", "p7"}
)

// IsURIInput reports whether an input type is handled by the URI (fallbacksrc) path.
func IsURIInput(t string) bool {
	switch t {
	case InFile, InSRT, InUDP, InRTMP, InRTSP:
		return true
	}
	return false
}

// SafeValue rejects characters that could break out of a quoted GStreamer
// property value or a command argument. Everything user-supplied that ends up
// in a pipeline description goes through it (and is quoted on top).
func SafeValue(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r == '"' || r == '\\' || r == '\'' || r == '`' {
			return false
		}
	}
	return true
}

func safeURL(s string) bool { return SafeValue(s) && !strings.ContainsAny(s, " \t") }

// Validate checks the whole config (after defaults).
func (c *Config) Validate() Errors {
	var errs Errors
	if len(c.Channels) > MaxChannels {
		errs.add("channels", "at most %d channels", MaxChannels)
	}
	seen := map[string]bool{}
	for i := range c.Channels {
		ch := &c.Channels[i]
		p := fmt.Sprintf("channels[%d]", i)
		if seen[ch.ID] {
			errs.add(p+".id", "duplicate channel id %q", ch.ID)
		}
		seen[ch.ID] = true
		for _, fe := range ch.Validate() {
			errs = append(errs, FieldError{Field: p + "." + fe.Field, Message: fe.Message})
		}
	}
	validateNotify(&errs, c.Settings.Notify)
	return errs
}

// Validate checks one channel (call ApplyDefaults first).
func (c *Channel) Validate() Errors {
	var errs Errors
	if !reID.MatchString(c.ID) {
		errs.add("id", "must match %s", reID)
	}
	if len(c.Name) > 64 || !SafeValue(c.Name) {
		errs.add("name", "max 64 printable chars, no quotes")
	}
	validateInput(&errs, "input", &c.Input)
	if c.Backup != nil {
		validateInput(&errs, "backup", c.Backup)
		if !IsURIInput(c.Input.Type) || !IsURIInput(c.Backup.Type) {
			errs.add("backup", "backup failover needs URI inputs (file/srt/udp/rtmp/rtsp) for both primary and backup; device inputs fail over to the slate")
		}
	}
	validateVideo(&errs, &c.Video)
	if c.Video.Interlaced && !c.Input.Interlaced && c.Input.Type != InDeckLink {
		errs.add("video.interlaced", "interlaced output needs an interlaced source (DeckLink 1080i, or input.interlaced=true for an interlaced IP/test source)")
	}
	validateAudio(&errs, &c.Audio, &c.Input)
	c.validatePro(&errs)
	if len(c.Overlay.Text) > 64 || !SafeValue(c.Overlay.Text) {
		errs.add("overlay.text", "max 64 printable chars, no quotes or backslashes")
	}
	m := c.Mux
	for _, pid := range []struct {
		n string
		v int
	}{{"mux.videoPid", m.VideoPID}, {"mux.audioPid", m.AudioPID}} {
		if pid.v < 32 || pid.v > 8190 {
			errs.add(pid.n, "PID must be 32..8190")
		}
	}
	if m.VideoPID == m.AudioPID {
		errs.add("mux.audioPid", "must differ from videoPid")
	}
	if m.PCRIntervalMs < 10 || m.PCRIntervalMs > 100 {
		errs.add("mux.pcrIntervalMs", "must be 10..100 (ISO 13818-1 requires ≤100 ms)")
	}
	if m.MuxRateKbps != 0 {
		need := c.Video.BitrateKbps + c.Audio.BitrateKbps
		if c.Video.RateControl == "vbr" && c.Video.MaxKbps > 0 {
			need = c.Video.MaxKbps + c.Audio.BitrateKbps
		}
		need = need * 115 / 100
		if m.MuxRateKbps < need {
			errs.add("mux.muxRateKbps", "too low for the elementary streams: need ≥ %d kbps (video+audio+15%% overhead)", need)
		}
	}
	ids := map[string]bool{}
	for i := range c.Outputs {
		o := &c.Outputs[i]
		p := fmt.Sprintf("outputs[%d]", i)
		if ids[o.ID] {
			errs.add(p+".id", "duplicate output id %q", o.ID)
		}
		ids[o.ID] = true
		for _, fe := range o.Validate(c) {
			errs = append(errs, FieldError{Field: p + "." + fe.Field, Message: fe.Message})
		}
	}
	return errs
}

func validateInput(errs *Errors, p string, in *Input) {
	if in.TimeoutMs < 200 || in.TimeoutMs > 60000 {
		errs.add(p+".timeoutMs", "must be 200..60000")
	}
	switch in.Type {
	case InTest:
		if !slices.Contains(testPatterns, in.Pattern) {
			errs.add(p+".pattern", "unknown pattern %q", in.Pattern)
		}
		if in.ToneHz < 20 || in.ToneHz > 20000 {
			errs.add(p+".toneHz", "must be 20..20000")
		}
	case InFile:
		u := strings.TrimPrefix(in.URI, "file://")
		if !strings.HasPrefix(in.URI, "file:///") || !reAbsPath.MatchString(u) || strings.Contains(u, "..") {
			errs.add(p+".uri", "file input needs an absolute path (file:///… or /…) without '..'")
		}
	case InSRT, InUDP, InRTMP, InRTSP:
		schemes := map[string][]string{InSRT: {"srt"}, InUDP: {"udp"}, InRTMP: {"rtmp", "rtmps"}, InRTSP: {"rtsp", "rtsps"}}[in.Type]
		validateURL(errs, p+".uri", in.URI, schemes, in.Type == InSRT || in.Type == InUDP)
	case InDeckLink:
		if in.Device < 0 || in.Device > 15 {
			errs.add(p+".device", "must be 0..15")
		}
		if !slices.Contains([]string{"auto", "sdi", "hdmi", "optical-sdi", "component", "composite", "svideo"}, in.Connection) {
			errs.add(p+".connection", "must be auto|sdi|hdmi|optical-sdi|component|composite|svideo")
		}
		if !slices.Contains(deckLinkModes, in.Mode) {
			errs.add(p+".mode", "unknown DeckLink mode %q", in.Mode)
		}
		if in.AudioInputCh != 2 && in.AudioInputCh != 8 && in.AudioInputCh != 16 {
			errs.add(p+".audioInputChannels", "DeckLink captures 2, 8 or 16 channels")
		}
	case InV4L2:
		if !reV4L2.MatchString(in.DevicePath) {
			errs.add(p+".devicePath", "must be /dev/videoN or /dev/v4l/by-id|by-path/…")
		}
		if in.AudioDevice != "" && !reALSA.MatchString(in.AudioDevice) {
			errs.add(p+".audioDevice", "must be an ALSA device like hw:1,0")
		}
		if in.Format != "raw" && in.Format != "mjpeg" {
			errs.add(p+".format", "must be raw|mjpeg")
		}
	default:
		errs.add(p+".type", "unknown input type %q (test|file|srt|udp|rtmp|rtsp|decklink|v4l2)", in.Type)
	}
}

// validateURL checks scheme, safety and host:port. emptyHostOK allows
// listener/multicast-any forms like srt://:9000 or udp://@239.1.1.1:5000.
func validateURL(errs *Errors, field, raw string, schemes []string, emptyHostOK bool) *url.URL {
	if raw == "" {
		errs.add(field, "required")
		return nil
	}
	if strings.Contains(raw, Redacted) {
		errs.add(field, placeholderMsg)
		return nil
	}
	if !safeURL(raw) || len(raw) > 1024 {
		errs.add(field, "contains forbidden characters (quotes, backslashes, spaces or control chars)")
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // url.Error repeats the whole URL (credentials included)
		}
		errs.add(field, "invalid URL: %v", err)
		return nil
	}
	if !slices.Contains(schemes, u.Scheme) {
		errs.add(field, "scheme must be one of %v", schemes)
		return nil
	}
	host := strings.TrimPrefix(u.Host, "@")
	h, port, err := net.SplitHostPort(host)
	if u.Scheme == "srt" || u.Scheme == "udp" || u.Scheme == "rtp" {
		if err != nil {
			errs.add(field, "needs host:port")
			return u
		}
		if n, e := strconv.Atoi(port); e != nil || n < 1 || n > 65535 {
			errs.add(field, "invalid port %q", port)
		}
		if h == "" && !emptyHostOK {
			errs.add(field, "needs a host")
		}
	} else if u.Host == "" {
		errs.add(field, "needs a host")
	}
	return u
}

func validateVideo(errs *Errors, v *Video) {
	if v.Codec != CodecH264 && v.Codec != CodecH265 {
		errs.add("video.codec", "must be h264|h265")
	}
	switch v.Encoder {
	case EncAuto, EncNVENC, EncQSV, EncVAAPI:
	case EncX264:
		if v.Codec != CodecH264 {
			errs.add("video.encoder", "x264 only encodes h264")
		}
	case EncX265:
		if v.Codec != CodecH265 {
			errs.add("video.encoder", "x265 only encodes h265")
		}
	default:
		errs.add("video.encoder", "must be auto|x264|x265|nvenc|qsv|vaapi")
	}
	if v.Width < 128 || v.Width > 4096 || v.Width%2 != 0 {
		errs.add("video.width", "must be an even number 128..4096")
	}
	if v.Height < 96 || v.Height > 2160 || v.Height%2 != 0 {
		errs.add("video.height", "must be an even number 96..2160")
	}
	if _, _, err := ParseFPS(v.FPS); err != nil {
		errs.add("video.fps", "%v", err)
	}
	if v.BitrateKbps < 100 || v.BitrateKbps > 80000 {
		errs.add("video.bitrateKbps", "must be 100..80000")
	}
	if v.RateControl != "cbr" && v.RateControl != "vbr" {
		errs.add("video.rateControl", "must be cbr|vbr")
	}
	if v.MaxKbps != 0 && (v.MaxKbps < v.BitrateKbps || v.MaxKbps > 120000) {
		errs.add("video.maxBitrateKbps", "must be ≥ bitrateKbps and ≤ 120000")
	}
	if v.GOP < 1 || v.GOP > 600 {
		errs.add("video.gop", "must be 1..600 frames")
	}
	if v.BFrames < 0 || v.BFrames > 4 {
		errs.add("video.bframes", "must be 0..4")
	}
	if v.LowLatency && v.BFrames != 0 {
		errs.add("video.bframes", "lowLatency forces 0 B-frames")
	}
	if v.Codec == CodecH264 && !slices.Contains([]string{"baseline", "main", "high"}, v.Profile) {
		errs.add("video.profile", "h264 profile must be baseline|main|high")
	}
	if v.Codec == CodecH264 && v.Profile == "baseline" && v.BFrames > 0 {
		errs.add("video.bframes", "baseline profile has no B-frames")
	}
	if v.Codec == CodecH265 && v.Profile != "main" {
		errs.add("video.profile", "h265 profile must be main (4:2:0 8-bit)")
	}
	if v.Preset != "" && !slices.Contains(x26xPresets, v.Preset) && !slices.Contains(nvencPresets, v.Preset) {
		errs.add("video.preset", "must be a x264/x265 speed preset (ultrafast..veryslow) or p1..p7")
	}
	if v.Interlaced && (v.Codec != CodecH264 || (v.Encoder != EncX264 && v.Encoder != EncAuto)) {
		errs.add("video.interlaced", "interlaced encoding is supported with h264/x264 only; use deinterlace for HEVC")
	}
	if v.GPU < 0 || v.GPU > 7 {
		errs.add("video.gpu", "must be 0..7")
	}
}

func validateAudio(errs *Errors, a *Audio, in *Input) {
	if a.Disabled {
		return
	}
	if !slices.Contains([]int{1, 2, 6, 8}, a.Channels) {
		errs.add("audio.channels", "must be 1, 2, 6 (5.1) or 8 (7.1) — the AAC channel layouts")
	}
	if a.SampleRate != 48000 && a.SampleRate != 44100 {
		errs.add("audio.sampleRate", "must be 48000|44100")
	}
	if a.BitrateKbps < 32 || a.BitrateKbps > 512 {
		errs.add("audio.bitrateKbps", "must be 32..512")
	}
	if len(a.Map) > 0 && in.Type != InDeckLink {
		errs.add("audio.map", "channel mapping needs a DeckLink input (known embedded channel count); other inputs are down/up-mixed automatically")
	}
	if len(a.Map) > 0 {
		if len(a.Map) != a.Channels {
			errs.add("audio.map", "needs exactly one input index per output channel (%d)", a.Channels)
		}
		maxIn := 16
		if in.Type == InDeckLink {
			maxIn = in.AudioInputCh
		}
		for i, m := range a.Map {
			if m < 0 || m >= maxIn {
				errs.add(fmt.Sprintf("audio.map[%d]", i), "input channel must be 0..%d", maxIn-1)
			}
		}
	}
	if a.GainDb < -60 || a.GainDb > 30 {
		errs.add("audio.gainDb", "must be -60..30")
	}
}

// Validate checks one output in the context of its channel.
func (o *Output) Validate(c *Channel) Errors {
	var errs Errors
	if !reID.MatchString(o.ID) {
		errs.add("id", "must match %s", reID)
	}
	if len(o.Name) > 64 || !SafeValue(o.Name) {
		errs.add("name", "max 64 printable chars, no quotes")
	}
	if o.ManagedBy != "" && o.ManagedBy != "streamhub" {
		errs.add("managedBy", "must be empty or streamhub")
	}
	needWebRTC := func(what string) {
		if c.Video.Codec != CodecH264 {
			errs.add("type", "%s needs h264 video (WebRTC/LiveKit)", what)
		}
		if c.Video.BFrames != 0 {
			errs.add("type", "%s needs bframes=0 (WebRTC has no B-frame reordering)", what)
		}
		if c.Video.Interlaced {
			errs.add("type", "%s needs progressive video", what)
		}
	}
	switch o.Type {
	case OutSRT:
		validateURL(&errs, "url", o.URL, []string{"srt"}, true)
		s := o.SRT
		if s == nil {
			errs.add("srt", "required")
			break
		}
		if !slices.Contains([]string{"caller", "listener", "rendezvous"}, s.Mode) {
			errs.add("srt.mode", "must be caller|listener|rendezvous")
		}
		if s.Mode != "listener" && strings.HasPrefix(o.URL, "srt://:") {
			errs.add("url", "%s mode needs a remote host", s.Mode)
		}
		if s.LatencyMs < 20 || s.LatencyMs > 8000 {
			errs.add("srt.latencyMs", "must be 20..8000")
		}
		if s.Passphrase == Redacted {
			errs.add("srt.passphrase", placeholderMsg)
		} else if s.Passphrase != "" && (len(s.Passphrase) < 10 || len(s.Passphrase) > 79 || !SafeValue(s.Passphrase)) {
			errs.add("srt.passphrase", "must be 10..79 printable chars (libsrt), no quotes")
		}
		if !slices.Contains([]int{0, 16, 24, 32}, s.PBKeyLen) {
			errs.add("srt.pbkeylen", "must be 0|16|24|32")
		}
		if len(s.StreamID) > 512 || !SafeValue(s.StreamID) {
			errs.add("srt.streamId", "max 512 printable chars, no quotes")
		}
	case OutRTMP:
		validateURL(&errs, "url", o.URL, []string{"rtmp", "rtmps"}, false)
		if c.Video.Interlaced {
			errs.add("type", "RTMP/FLV carries progressive video only")
		}
	case OutUDP, OutRTP:
		validateURL(&errs, "url", o.URL, []string{o.Type}, false)
		if o.UDP != nil {
			if o.UDP.TTL < 1 || o.UDP.TTL > 255 {
				errs.add("udp.ttl", "must be 1..255")
			}
			if o.UDP.Iface != "" && !regexp.MustCompile(`^[A-Za-z0-9._-]{1,15}$`).MatchString(o.UDP.Iface) {
				errs.add("udp.iface", "invalid interface name")
			}
			if o.UDP.Bind != "" && net.ParseIP(o.UDP.Bind) == nil {
				errs.add("udp.bind", "must be an IP address")
			}
		}
	case OutWHIP:
		validateURL(&errs, "url", o.URL, []string{"http", "https"}, false)
		needWebRTC("WHIP")
		if o.WHIP != nil && o.WHIP.BearerToken == Redacted {
			errs.add("whip.bearerToken", placeholderMsg)
		} else if o.WHIP != nil && (!SafeValue(o.WHIP.BearerToken) || len(o.WHIP.BearerToken) > 2048) {
			errs.add("whip.bearerToken", "invalid token")
		}
	case OutHLS:
		u := validateURL(&errs, "url", o.URL, []string{"http", "https"}, false)
		if u != nil && !strings.HasSuffix(u.Path, ".m3u8") {
			errs.add("url", "HLS push URL must point to the playlist (…/index.m3u8)")
		}
		if o.HLS != nil {
			if o.HLS.SegmentSeconds < 1 || o.HLS.SegmentSeconds > 10 {
				errs.add("hls.segmentSeconds", "must be 1..10")
			}
			if o.HLS.ListSize < 3 || o.HLS.ListSize > 30 {
				errs.add("hls.listSize", "must be 3..30")
			}
		}
	case OutFile:
		if !reOutPath.MatchString(o.URL) || strings.Contains(o.URL, "..") || !strings.HasSuffix(o.URL, ".ts") {
			errs.add("url", "file output needs an absolute .ts path without '..'")
		}
	case OutStreamHub:
		s := o.StreamHub
		if s == nil {
			errs.add("streamhub", "required")
			break
		}
		validateURL(&errs, "streamhub.baseUrl", s.BaseURL, []string{"http", "https"}, false)
		if !reApp.MatchString(s.App) {
			errs.add("streamhub.app", "invalid app name")
		}
		if !reRoom.MatchString(s.Room) {
			errs.add("streamhub.room", "invalid room name")
		}
		if s.Token == Redacted || s.StreamKey == Redacted || strings.Contains(s.ResolvedURL, Redacted) {
			errs.add("streamhub.token", placeholderMsg)
		} else if s.Token == "" || !SafeValue(s.Token) || strings.ContainsAny(s.Token, " \t") {
			errs.add("streamhub.token", "an app-scoped sk_ token is required")
		}
		if s.Protocol != "rtmp" && s.Protocol != "whip" {
			errs.add("streamhub.protocol", "must be rtmp|whip")
		}
		// LiveKit ingress (the StreamHub transcode plane) decodes H.264 only;
		// WHIP additionally needs WebRTC-compatible video.
		if s.Protocol == "whip" {
			needWebRTC("StreamHub WHIP")
		} else if c.Video.Codec != CodecH264 || c.Video.Interlaced {
			errs.add("type", "StreamHub RTMP (LiveKit ingress) needs progressive h264 video")
		}
	case OutRIST, OutRecord:
		// validated in validateOutputPro
	default:
		errs.add("type", "unknown output type %q (srt|rtmp|udp|rtp|rist|whip|hls|file|record|streamhub)", o.Type)
	}
	o.validateOutputPro(c, &errs)
	return errs
}
