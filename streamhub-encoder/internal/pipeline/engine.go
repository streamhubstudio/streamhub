// Package pipeline turns a validated channel config into the exact process
// command lines the encoder runs:
//
//   - the ENGINE (one gst-launch-1.0 per channel): input (+failover) →
//     pre-proc/overlays → video+audio encode → mpegtsmux → UDP on 127.0.0.1
//     (the channel's internal "TS bus");
//   - one OUTPUT process per destination, reading the bus and pushing to the
//     network (srtsink, rtmp2sink, udpsink, WHIP via encoderd, HLS via ffmpeg).
//
// Splitting encode and outputs into processes is what makes outputs hot
// add/remove without touching the encode or the other outputs, and confines a
// crashing output to itself. Everything here is pure string building — golden
// tests lock the exact pipelines.
package pipeline

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

// Caps answers "is this GStreamer element available on this host".
type Caps interface {
	Has(element string) bool
}

// StaticCaps is a fixed element set (tests, dry-runs).
type StaticCaps map[string]bool

// Has implements Caps.
func (s StaticCaps) Has(e string) bool { return s[e] }

// AllCaps pretends every element exists (golden tests of HW encoders).
type AllCaps struct{}

// Has implements Caps.
func (AllCaps) Has(string) bool { return true }

// Encoder backends → GStreamer elements.
var encoderElements = map[string]map[string]string{
	config.CodecH264: {config.EncX264: "x264enc", config.EncNVENC: "nvh264enc", config.EncQSV: "qsvh264enc", config.EncVAAPI: "vah264enc"},
	config.CodecH265: {config.EncX265: "x265enc", config.EncNVENC: "nvh265enc", config.EncQSV: "qsvh265enc", config.EncVAAPI: "vah265enc"},
}

// autoOrder is the "auto" preference: hardware first (density), then software.
var autoOrder = map[string][]string{
	config.CodecH264: {config.EncNVENC, config.EncQSV, config.EncVAAPI, config.EncX264},
	config.CodecH265: {config.EncNVENC, config.EncQSV, config.EncVAAPI, config.EncX265},
}

// ResolveEncoder picks the concrete backend + element for a video config.
func ResolveEncoder(v config.Video, caps Caps) (backend, element string, err error) {
	elems := encoderElements[v.Codec]
	if elems == nil {
		return "", "", fmt.Errorf("unknown codec %q", v.Codec)
	}
	if v.Encoder == config.EncAuto || v.Encoder == "" {
		if v.Interlaced || v.TimecodeSEI { // field encoding / pic-timing SEI: x264 only
			return config.EncX264, "x264enc", requireEl(caps, "x264enc")
		}
		if v.Chroma == "422" { // Main 4:2:2 10: x265 only
			return config.EncX265, "x265enc", requireEl(caps, "x265enc")
		}
		for _, b := range autoOrder[v.Codec] {
			if v.BitDepth == 10 && b != config.EncNVENC && b != config.EncX265 {
				continue // 10-bit validated on NVENC and x265 only
			}
			if caps.Has(elems[b]) {
				return b, elems[b], nil
			}
		}
		return "", "", fmt.Errorf("no %s encoder available on this host", v.Codec)
	}
	el, ok := elems[v.Encoder]
	if !ok {
		return "", "", fmt.Errorf("encoder %q cannot produce %s", v.Encoder, v.Codec)
	}
	return v.Encoder, el, requireEl(caps, el)
}

func requireEl(caps Caps, el string) error {
	if !caps.Has(el) {
		return fmt.Errorf("GStreamer element %q is not available on this host (missing plugin or hardware)", el)
	}
	return nil
}

// q quotes a user value for a gst-launch description. Callers validated the
// value with config.SafeValue; q re-checks so a bug can never inject elements.
func q(s string) (string, error) {
	if !config.SafeValue(s) {
		return "", fmt.Errorf("unsafe value %q", s)
	}
	return `"` + s + `"`, nil
}

// mustQ is q for values the builder itself produced.
func mustQ(s string) string {
	v, err := q(s)
	if err != nil {
		panic(err)
	}
	return v
}

// Engine is the built engine process.
type Engine struct {
	Backend     string // resolved encoder backend
	Element     string // resolved encoder element
	Description string // gst-launch-1.0 pipeline description
	// Feeder, when set, is an ffmpeg argv (without the binary) whose stdout is
	// piped into the engine's stdin (the engine reads it as fd://0). Used for
	// looping files: ffmpeg -stream_loop keeps timestamps continuous across the
	// loop point, while fallbacksrc restart-on-eos inserted a +timeout PTS jump
	// (≈2 s) at every loop, which live receivers (LiveKit ingress) choke on.
	Feeder []string
}

// Args returns the gst-launch-1.0 argv (without the binary).
func (e Engine) Args() []string { return LaunchArgs(e.Description) }

// Command returns the process to run: gst-launch directly, or, with a feeder,
// /bin/sh running "ffmpeg … | exec gst-launch …" (one process group, so the
// supervisor's group signals stop both).
func (e Engine) Command(gstLaunch, ffmpeg string) (string, []string) {
	if len(e.Feeder) == 0 {
		return gstLaunch, e.Args()
	}
	var sb strings.Builder
	sb.WriteString(shQuote(ffmpeg))
	for _, a := range e.Feeder {
		sb.WriteString(" " + shQuote(a))
	}
	sb.WriteString(" | exec " + shQuote(gstLaunch))
	for _, a := range e.Args() {
		sb.WriteString(" " + shQuote(a))
	}
	return "/bin/sh", []string{"-c", sb.String()}
}

// shQuote single-quotes s for /bin/sh.
func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// fileLoopFeeder is the ffmpeg argv that plays path in a seamless real-time
// loop as Matroska on stdout (any codec, timestamps continuous).
func fileLoopFeeder(path string) []string {
	return []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", path,
		"-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "matroska", "-live", "1", "pipe:1"}
}

// LaunchArgs splits a description into gst-launch-1.0 argv: one token per
// unquoted whitespace run, quotes kept. gst_parse_launchv() re-joins argv and
// escapes spaces OUTSIDE quotes, so passing the whole description as one
// argument would turn it into a single (invalid) token.
func LaunchArgs(desc string) []string {
	args := []string{"-e"}
	var cur strings.Builder
	inQ := false
	for _, r := range desc {
		switch {
		case r == '"':
			inQ = !inQ
			cur.WriteRune(r)
		case (r == ' ' || r == '\t') && !inQ:
			if cur.Len() > 0 {
				args = append(args, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		args = append(args, cur.String())
	}
	return args
}

type builder struct {
	ch               config.Channel
	fpsN, fpsD       int
	backend, element string
	feeder           []string
}

func (b *builder) fps() string { return fmt.Sprintf("%d/%d", b.fpsN, b.fpsD) }

func ns(ms int) int64 { return int64(ms) * 1_000_000 }

// gstURI adapts user URIs to what GStreamer's URI handlers accept.
func gstURI(in config.Input) string {
	u := in.URI
	if in.Type == config.InUDP {
		u = strings.Replace(u, "udp://@", "udp://", 1) // ffmpeg-style "any source" marker
	}
	return u
}

// sources returns the raw video and audio source chains (ending in a raw pad).
func (b *builder) sources() (video, audio string, err error) {
	in := b.ch.Input
	a := b.ch.Audio
	switch {
	case config.IsURIInput(in.Type):
		uri, err := q(gstURI(in))
		if err != nil {
			return "", "", err
		}
		loopFile := in.Type == config.InFile && in.Loop
		if loopFile {
			b.feeder = fileLoopFeeder(strings.TrimPrefix(in.URI, "file://"))
			uri = `"fd://0"`
		}
		fb := fmt.Sprintf("fallbacksrc name=src uri=%s", uri)
		if bk := b.ch.Backup; bk != nil {
			buri, err := q(gstURI(*bk))
			if err != nil {
				return "", "", err
			}
			fb += " fallback-uri=" + buri
		}
		// timeout: no data → backup (or black/silence); restart-timeout: how
		// long a stalled source may take to come back before a restart;
		// retry-timeout: effectively never give up (24 h).
		fb += fmt.Sprintf(" timeout=%d restart-timeout=%d retry-timeout=86400000000000 immediate-fallback=true", ns(in.TimeoutMs), ns(maxInt(in.TimeoutMs*2, 5000)))
		// A live source that ends (SRT caller hangs up, RTMP publisher stops)
		// sends EOS; without restart-on-eos it would reach the muxer and end the
		// whole engine. A non-looping file is allowed to finish; a looping file
		// comes from the ffmpeg feeder, whose EOS means the feeder died: let the
		// engine exit so the supervisor restarts both.
		if in.Type != config.InFile {
			fb += " restart-on-eos=true"
		}
		if a.Disabled {
			fb += " enable-audio=false"
		}
		video = fb + " src.video_0 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000"
		audio = "src.audio_0 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000"
		return video, audio, nil

	case in.Type == config.InTest:
		w, h, fpsN, fpsD := b.ch.Video.Width, b.ch.Video.Height, b.fpsN, b.fpsD
		video = fmt.Sprintf("videotestsrc is-live=true pattern=%s ! video/x-raw,width=%d,height=%d,framerate=%d/%d", in.Pattern, w, h, fpsN*fieldsFactor(in), fpsD)
		if in.Interlaced { // simulate an interlaced (e.g. 1080i50) source: 2 fields per frame
			video += " ! interlace top-field-first=true field-pattern=1:1"
		}
		video = b.slateSwitch(video, "vfs")
		audio = fmt.Sprintf("audiotestsrc is-live=true wave=sine freq=%d volume=0.1 ! audio/x-raw,rate=%d,channels=%d%s", in.ToneHz, a.SampleRate, a.Channels, channelMask(a.Channels))
		audio = b.slateSwitchAudio(audio)
		return video, audio, nil

	case in.Type == config.InDeckLink:
		conn := ""
		if in.Connection != "auto" {
			conn = " connection=" + in.Connection
		}
		video = fmt.Sprintf("decklinkvideosrc device-number=%d mode=%s%s drop-no-signal-frames=true buffer-size=10 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000 ! videoconvert n-threads=%d", in.Device, in.Mode, conn, b.threads())
		video = b.slateSwitch(video, "vfs")
		audio = fmt.Sprintf("decklinkaudiosrc device-number=%d channels=%d ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000", in.Device, in.AudioInputCh)
		audio = b.slateSwitchAudio(audio)
		return video, audio, nil

	case in.Type == config.InV4L2:
		dev, err := q(in.DevicePath)
		if err != nil {
			return "", "", err
		}
		video = fmt.Sprintf("v4l2src device=%s do-timestamp=true", dev)
		if in.Format == "mjpeg" {
			video += " ! image/jpeg ! jpegparse ! jpegdec"
		}
		video += fmt.Sprintf(" ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000 ! videoconvert n-threads=%d", b.threads())
		video = b.slateSwitch(video, "vfs")
		if in.AudioDevice != "" {
			ad, err := q(in.AudioDevice)
			if err != nil {
				return "", "", err
			}
			audio = fmt.Sprintf("alsasrc device=%s do-timestamp=true ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000", ad)
		} else {
			audio = fmt.Sprintf("audiotestsrc is-live=true wave=silence ! audio/x-raw,rate=%d,channels=%d%s", a.SampleRate, a.Channels, channelMask(a.Channels))
		}
		audio = b.slateSwitchAudio(audio)
		return video, audio, nil
	}
	return "", "", errors.New("unsupported input type " + in.Type)
}

func fieldsFactor(in config.Input) int {
	if in.Interlaced {
		return 2
	}
	return 1
}

// slateSwitch wraps a device/test video chain in a fallbackswitch whose
// priority-1 input is a live "NO SIGNAL" slate: if the device stops delivering
// frames for timeoutMs (cable pulled, drop-no-signal-frames) the encode keeps
// running on the slate and switches back when the signal returns.
func (b *builder) slateSwitch(chain, name string) string {
	v := b.ch.Video
	norm := b.rawCaps()
	slate := fmt.Sprintf("videotestsrc is-live=true pattern=smpte100 ! video/x-raw,width=%d,height=%d,framerate=%s ! textoverlay text=%s valignment=center halignment=center font-desc=%s shaded-background=true",
		v.Width, v.Height, b.fps(), mustQ("SIN SEÑAL / NO SIGNAL"), mustQ(fmt.Sprintf("Sans Bold %d", maxInt(v.Height/20, 12))))
	if b.interlacedPath() {
		// Interlaced passthrough: the slate must match the interleaved caps.
		slate = fmt.Sprintf("videotestsrc is-live=true pattern=smpte100 ! video/x-raw,width=%d,height=%d,framerate=%d/%d ! interlace top-field-first=true field-pattern=1:1", v.Width, v.Height, b.fpsN*2, b.fpsD)
		norm = "videoconvert ! video/x-raw,format=I420"
	}
	// The switch is declared last so the chain ends on its output (gst-launch
	// resolves the forward "name.sink_N" references at the end of parsing).
	return fmt.Sprintf("%s ! %s ! %s.sink_0  %s ! %s ! %s.sink_1  fallbackswitch name=%s timeout=%d immediate-fallback=true sink_0::priority=0 sink_1::priority=1 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000",
		chain, norm, name, slate, norm, name, name, ns(b.ch.Input.TimeoutMs))
}

func (b *builder) slateSwitchAudio(chain string) string {
	a := b.ch.Audio
	in := b.ch.Input
	norm := fmt.Sprintf("audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=%d,channels=%d,layout=interleaved", a.SampleRate, b.audioInChannels())
	slate := fmt.Sprintf("audiotestsrc is-live=true wave=silence ! audio/x-raw,rate=%d,channels=%d%s", a.SampleRate, b.audioInChannels(), b.audioInMask())
	return fmt.Sprintf("%s ! %s%s ! afs.sink_0  %s ! audioconvert ! audio/x-raw,format=S16LE,layout=interleaved%s ! afs.sink_1  fallbackswitch name=afs timeout=%d immediate-fallback=true sink_0::priority=0 sink_1::priority=1 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000",
		chain, norm, b.audioInMask(), slate, b.audioInMask(), ns(in.TimeoutMs))
}

// audioInChannels is the channel count between source and mapping.
func (b *builder) audioInChannels() int {
	if b.ch.Input.Type == config.InDeckLink {
		return b.ch.Input.AudioInputCh
	}
	return b.ch.Audio.Channels
}

func (b *builder) audioInMask() string {
	if b.ch.Input.Type == config.InDeckLink {
		return ",channel-mask=(bitmask)0x0" // SDI embedded channels are unpositioned
	}
	return channelMask(b.ch.Audio.Channels)
}

// channelMask returns the caps fragment positioning n channels as the AAC
// layouts (mono, stereo, 5.1, 7.1).
func channelMask(n int) string {
	switch n {
	case 6:
		return ",channel-mask=(bitmask)0x3f"
	case 8:
		return ",channel-mask=(bitmask)0xff" // FL FR FC LFE RL RR FLC FRC (AAC 7.1)
	}
	return ""
}

func (b *builder) threads() int {
	v := b.ch.Video
	if v.Width*v.Height > 1920*1080 {
		return 8 // 4K: raw conversion on CPU is the bottleneck, not the HW encoder
	}
	return 2
}

func (b *builder) interlacedPath() bool { return b.ch.Video.Interlaced }

// rawCaps is the normalisation to the encode raster (scale + rate + PAR).
func (b *builder) rawCaps() string {
	v := b.ch.Video
	return fmt.Sprintf("videoconvert n-threads=%d ! videoscale n-threads=%d add-borders=true ! videorate ! video/x-raw,width=%d,height=%d,framerate=%s,pixel-aspect-ratio=1/1",
		b.threads(), b.threads(), v.Width, v.Height, b.fps())
}

func (b *builder) preset(def string) string {
	if p := b.ch.Video.Preset; p != "" {
		return p
	}
	return def
}

// x26x presets do not apply to HW encoders and vice versa: map across.
var x26xToNV = map[string]string{"ultrafast": "p1", "superfast": "p2", "veryfast": "p3", "faster": "p3", "fast": "p4", "medium": "p5", "slow": "p6", "slower": "p7", "veryslow": "p7"}
var nvToX26x = map[string]string{"p1": "ultrafast", "p2": "superfast", "p3": "veryfast", "p4": "faster", "p5": "medium", "p6": "slow", "p7": "slower"}

func (b *builder) x26xPreset(def string) string {
	p := b.preset(def)
	if m, ok := nvToX26x[p]; ok {
		return m
	}
	return p
}

func (b *builder) nvPreset() string {
	p := b.preset("p4")
	if m, ok := x26xToNV[p]; ok {
		return m
	}
	return p
}

// targetUsage maps the speed preset to QSV/VA target-usage (1 best … 7 fastest).
func (b *builder) targetUsage() int {
	p := b.nvPreset()
	n, _ := strconv.Atoi(strings.TrimPrefix(p, "p"))
	if n < 1 {
		n = 4
	}
	return 8 - n
}

func dbToLinear(db float64) float64 { return math.Pow(10, db/20) }

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
