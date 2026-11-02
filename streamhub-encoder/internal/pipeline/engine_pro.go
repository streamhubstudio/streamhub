package pipeline

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

// PID layout of the engine TS.
const (
	RenditionPIDBase = 0x110 // video.renditions[i] → 0x110+i
	TrackPIDBase     = 0x120 // audio.tracks[i]     → 0x120+i
)

// Ports are the loopback UDP ports the engine writes to.
type Ports struct {
	Bus   int // MPEG-TS (mandatory)
	Thumb int // JPEG confidence thumbnails, 2 fps, 320x180 (0 = off)
	PCM   int // S16LE PCM of the main audio track, 20 ms datagrams (0 = off)
}

// ThumbWidth/ThumbHeight are the confidence-thumbnail raster.
const (
	ThumbWidth  = 320
	ThumbHeight = 180
)

// BuildEngine builds the engine pipeline that encodes channel ch and sends
// MPEG-TS (7×188-byte datagrams) to 127.0.0.1:busPort (no monitoring taps).
func BuildEngine(ch config.Channel, busPort int, caps Caps) (Engine, error) {
	return BuildEngineWith(ch, Ports{Bus: busPort}, caps)
}

// BuildEngineWith builds the engine with optional thumbnail/PCM taps.
//
//	video source ─ base proc (deinterlace, scale, overlays) ─ tee vt ─┬─ main encode ──────────┐
//	                                                                  ├─ rendition i encodes ──┤ mpegtsmux ─ udpsink (bus)
//	                                                                  └─ JPEG thumbnails (UDP) │
//	audio source ─ tee ain ─┬─ main track (map, gain) ─ tee amt ─┬─ encode ─────────────────────┤
//	                        │                                    └─ PCM tap (UDP, loudness)     │
//	                        └─ extra tracks (map, lang) ─ encode ─────────────────────────────────┘
func BuildEngineWith(ch config.Channel, ports Ports, caps Caps) (Engine, error) {
	if errs := ch.Validate(); len(errs) > 0 {
		return Engine{}, errs
	}
	backend, element, err := ResolveEncoder(ch.Video, caps)
	if err != nil {
		return Engine{}, err
	}
	fn, fd, _ := config.ParseFPS(ch.Video.FPS)
	b := &builder{ch: ch, fpsN: fn, fpsD: fd, backend: backend, element: element}

	vsrc, asrc, err := b.sources()
	if err != nil {
		return Engine{}, err
	}
	const q2s = "queue max-size-buffers=0 max-size-bytes=0 max-size-time=2000000000"
	var parts []string
	parts = append(parts, vsrc+" ! "+b.videoBase()+" ! tee name=vt")
	// main encode
	venc, err := b.videoEncoderFor(ch.Video, false)
	if err != nil {
		return Engine{}, err
	}
	parts = append(parts, "vt. ! "+b.encFormat(ch.Video)+" ! "+venc+" ! "+q2s+" ! mux.sink_"+strconv.Itoa(ch.Mux.VideoPID))
	// ABR ladder renditions (same GOP → aligned keyframes)
	for i, r := range ch.Video.Renditions {
		rv := ch.Video
		rv.Width, rv.Height, rv.BitrateKbps, rv.MaxKbps, rv.Interlaced = r.Width, r.Height, r.BitrateKbps, 0, false
		renc, err := b.videoEncoderFor(rv, true)
		if err != nil {
			return Engine{}, err
		}
		parts = append(parts, fmt.Sprintf("vt. ! queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 ! videoscale n-threads=%d ! video/x-raw,width=%d,height=%d,pixel-aspect-ratio=1/1 ! %s ! %s ! %s ! mux.sink_%d",
			b.threads(), r.Width, r.Height, b.encFormat(rv), renc, q2s, RenditionPIDBase+i))
	}
	if ports.Thumb > 0 {
		parts = append(parts, fmt.Sprintf("vt. ! queue leaky=downstream max-size-buffers=2 max-size-bytes=0 max-size-time=0 ! videorate drop-only=true max-rate=2 ! videoscale ! videoconvert ! video/x-raw,format=I420,width=%d,height=%d,pixel-aspect-ratio=1/1 ! jpegenc quality=70 ! udpsink host=127.0.0.1 port=%d sync=false async=false",
			ThumbWidth, ThumbHeight, ports.Thumb))
	}
	if !ch.Audio.Disabled {
		a := ch.Audio
		parts = append(parts, asrc+" ! tee name=ain")
		parts = append(parts, "ain. ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000 ! "+b.audioShape(a.Channels, a.Map, a.GainDb)+" ! tee name=amt")
		parts = append(parts, "amt. ! "+q2s+" ! "+audioEncoder(a.Codec, a.BitrateKbps, a.Lang)+" ! "+q2s+" ! mux.sink_"+strconv.Itoa(ch.Mux.AudioPID))
		if ports.PCM > 0 {
			parts = append(parts, fmt.Sprintf("amt. ! queue leaky=downstream max-size-buffers=0 max-size-bytes=0 max-size-time=500000000 ! audioconvert ! audio/x-raw,format=S16LE,layout=interleaved ! audiobuffersplit output-buffer-duration=1/50 ! udpsink host=127.0.0.1 port=%d sync=false async=false", ports.PCM))
		}
		for i, t := range a.Tracks {
			parts = append(parts, "ain. ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=1000000000 ! "+b.audioShape(t.Channels, t.Map, 0)+" ! "+audioEncoder(t.Codec, t.BitrateKbps, t.Lang)+" ! "+q2s+" ! mux.sink_"+strconv.Itoa(TrackPIDBase+i))
		}
	}
	mux := fmt.Sprintf("mpegtsmux name=mux alignment=7 pcr-interval=%d pat-interval=9000 pmt-interval=9000", ch.Mux.PCRIntervalMs*90)
	if ch.Mux.MuxRateKbps > 0 {
		mux += fmt.Sprintf(" bitrate=%d", ch.Mux.MuxRateKbps*1000)
	}
	// File inputs are not live: pace them in real time at the bus sink.
	sync := "false"
	if ch.Input.Type == config.InFile {
		sync = "true"
	}
	parts = append(parts, mux+fmt.Sprintf(" ! queue ! udpsink host=127.0.0.1 port=%d sync=%s async=false buffer-size=4194304", ports.Bus, sync))
	return Engine{Backend: backend, Element: element, Description: strings.Join(parts, "  "), Feeder: b.feeder}, nil
}

// videoBase: deinterlace → scale/rate → timecode → overlays → logo.
func (b *builder) videoBase() string {
	v := b.ch.Video
	in := b.ch.Input
	var p []string
	if v.Interlaced {
		// Field encoding: keep the fields, only convert the format.
		p = append(p, fmt.Sprintf("videoconvert n-threads=%d", b.threads()))
	} else {
		mayBeInterlaced := in.Interlaced || config.IsURIInput(in.Type) || in.Type == config.InDeckLink || in.Type == config.InV4L2
		if mayBeInterlaced && v.DeinterlaceOn() {
			// mode=auto passes progressive frames through untouched.
			p = append(p, "deinterlace mode=auto method=greedyh fields=all")
		}
		p = append(p, b.rawCaps())
	}
	fs := maxInt(v.Height/30, 10)
	font := mustQ(fmt.Sprintf("DejaVu Sans Mono Bold %d", fs))
	switch {
	case b.ch.Overlay.Timecode:
		p = append(p, "timecodestamper source=rtc set=always ! timeoverlay time-mode=time-code halignment=left valignment=top shaded-background=true font-desc="+font)
	case v.TimecodeSEI:
		// keep an upstream timecode (DeckLink RP188/VITC), else stamp the RTC
		p = append(p, "timecodestamper source=rtc set=keep")
	}
	if b.ch.Overlay.Clock {
		p = append(p, `clockoverlay time-format="%Y-%m-%d %H:%M:%S" halignment=right valignment=top shaded-background=true font-desc=`+font)
	}
	if t := b.ch.Overlay.Text; t != "" {
		p = append(p, "textoverlay text="+mustQ(t)+" halignment=left valignment=bottom shaded-background=true font-desc="+font)
	}
	if l := b.ch.Overlay.Logo; l != "" {
		alpha := b.ch.Overlay.LogoAlpha
		if alpha == 0 {
			alpha = 1
		}
		p = append(p, fmt.Sprintf("gdkpixbufoverlay location=%s offset-x=%d offset-y=%d alpha=%s", mustQ(l), b.ch.Overlay.LogoX, b.ch.Overlay.LogoY, strconv.FormatFloat(alpha, 'f', 2, 64)))
	}
	return strings.Join(p, " ! ")
}

var reMD = regexp.MustCompile(`^G\((\d+),(\d+)\)B\((\d+),(\d+)\)R\((\d+),(\d+)\)WP\((\d+),(\d+)\)L\((\d+),(\d+)\)$`)

// gstMasteringDisplay converts x265 master-display syntax into the GStreamer
// caps string "Rx:Ry:Gx:Gy:Bx:By:Wx:Wy:max:min".
func gstMasteringDisplay(md string) string {
	m := reMD.FindStringSubmatch(md)
	if m == nil {
		return ""
	}
	return strings.Join([]string{m[5], m[6], m[1], m[2], m[3], m[4], m[7], m[8], m[9], m[10]}, ":")
}

// encFormat is the conversion to the encoder's input format (+ HDR colorimetry).
func (b *builder) encFormat(v config.Video) string {
	format := "I420"
	switch b.backend {
	case config.EncX265:
		if v.BitDepth == 10 {
			format = "I420_10LE"
			if v.Chroma == "422" {
				format = "I422_10LE"
			}
		}
	case config.EncNVENC:
		format = "NV12"
		if v.BitDepth == 10 {
			format = "P010_10LE"
		}
	case config.EncQSV, config.EncVAAPI:
		format = "NV12"
	}
	c := "video/x-raw,format=" + format
	if v.Interlaced {
		c += ",interlace-mode=interleaved"
	}
	switch v.HDR {
	case "hlg":
		c += ",colorimetry=bt2100-hlg"
	case "pq":
		c += ",colorimetry=bt2100-pq"
		if md := gstMasteringDisplay(v.MasterDisplay); md != "" {
			c += ",mastering-display-info=(string)" + md
		}
		if v.MaxCLL != "" {
			c += ",content-light-level=(string)" + strings.Replace(v.MaxCLL, ",", ":", 1)
		}
	}
	if strings.ContainsAny(c, "()") {
		c = "capsfilter caps=" + mustQ(c) // typed fields need the explicit, quoted form
	}
	return fmt.Sprintf("videoconvert n-threads=%d ! %s ! queue max-size-buffers=3 max-size-bytes=0 max-size-time=0", b.threads(), c)
}

func maxKbpsOf(v config.Video) int {
	if v.MaxKbps > 0 {
		return v.MaxKbps
	}
	return v.BitrateKbps * 3 / 2
}

// videoEncoderFor returns "encoder ! caps ! parser" for one encode.
func (b *builder) videoEncoderFor(v config.Video, rendition bool) (string, error) {
	B, M, G := v.BitrateKbps, maxKbpsOf(v), v.GOP
	var enc string
	switch b.element {
	case "x264enc":
		enc = fmt.Sprintf("x264enc speed-preset=%s key-int-max=%d bframes=%d threads=0 aud=true byte-stream=true", b.x26xPreset("veryfast"), G, v.BFrames)
		if v.LowLatency {
			enc += " tune=zerolatency rc-lookahead=0 sync-lookahead=0"
		} else if v.BFrames > 0 {
			enc += " b-adapt=true b-pyramid=true"
		}
		vbvMs := 1000
		if v.LowLatency {
			vbvMs = 500
		}
		var opts []string
		if v.RateControl == "cbr" {
			enc += fmt.Sprintf(" pass=cbr bitrate=%d vbv-buf-capacity=%d nal-hrd=cbr", B, vbvMs)
		} else {
			// VBR with cap: constant quality (CRF 23) bounded by the VBV ceiling.
			enc += " pass=qual quantizer=23"
			opts = append(opts, fmt.Sprintf("vbv-maxrate=%d", M), fmt.Sprintf("vbv-bufsize=%d", M))
		}
		if v.TimecodeSEI && !rendition {
			opts = append(opts, "pic-struct=1") // pic_struct_present_flag → pic-timing SEI carries clock_timestamp
		}
		if len(opts) > 0 {
			enc += " option-string=" + mustQ(strings.Join(opts, ":"))
		}
		if v.Interlaced {
			enc += " interlaced=true"
		}
		prof := v.Profile
		if prof == "baseline" {
			prof = "constrained-baseline"
		}
		enc += " ! video/x-h264,profile=" + prof
	case "x265enc":
		enc = fmt.Sprintf("x265enc speed-preset=%s key-int-max=%d bitrate=%d", b.x26xPreset("faster"), G, B)
		opts := []string{fmt.Sprintf("bframes=%d", v.BFrames), "repeat-headers=1", "aud=1"}
		if v.LowLatency {
			enc += " tune=zerolatency"
			opts = append(opts, "rc-lookahead=0")
		}
		if v.RateControl == "cbr" {
			opts = append(opts, fmt.Sprintf("vbv-maxrate=%d", B), fmt.Sprintf("vbv-bufsize=%d", B), "strict-cbr=1", "hrd=1")
		} else {
			opts = append(opts, fmt.Sprintf("vbv-maxrate=%d", M), fmt.Sprintf("vbv-bufsize=%d", M))
		}
		switch v.HDR {
		case "hlg":
			opts = append(opts, "colorprim=bt2020", "transfer=arib-std-b67", "colormatrix=bt2020nc", "range=limited")
		case "pq":
			opts = append(opts, "colorprim=bt2020", "transfer=smpte2084", "colormatrix=bt2020nc", "range=limited", "hdr10=1", "hdr10-opt=1")
			if v.MasterDisplay != "" {
				opts = append(opts, "master-display="+v.MasterDisplay)
			}
			if v.MaxCLL != "" {
				opts = append(opts, "max-cll="+v.MaxCLL)
			}
		}
		prof := "main"
		if v.BitDepth == 10 {
			prof = "main-10"
			if v.Chroma == "422" {
				prof = "main-422-10"
			}
		}
		enc += " option-string=" + mustQ(strings.Join(opts, ":")) + " ! video/x-h265,profile=" + prof
	case "nvh264enc", "nvh265enc":
		rc := "cbr"
		if v.RateControl == "vbr" {
			rc = "vbr"
		}
		tune := "high-quality"
		if v.LowLatency {
			tune = "ultra-low-latency"
		}
		enc = fmt.Sprintf("%s cuda-device-id=%d preset=%s tune=%s rc-mode=%s bitrate=%d gop-size=%d bframes=%d aud=true", b.element, v.GPU, b.nvPreset(), tune, rc, B, G, v.BFrames)
		if rc == "vbr" {
			enc += fmt.Sprintf(" max-bitrate=%d", M)
		} else {
			enc += fmt.Sprintf(" vbv-buffer-size=%d", B)
		}
		if v.LowLatency {
			enc += " zerolatency=true rc-lookahead=0"
		}
		if b.element == "nvh264enc" {
			prof := v.Profile
			if prof == "baseline" {
				prof = "constrained-baseline"
			}
			enc += " ! video/x-h264,profile=" + prof
		} else if v.BitDepth == 10 {
			enc += " ! video/x-h265,profile=main-10"
		} else {
			enc += " ! video/x-h265,profile=main"
		}
	case "qsvh264enc", "qsvh265enc":
		rc := "cbr"
		if v.RateControl == "vbr" {
			rc = "vbr"
		}
		enc = fmt.Sprintf("%s target-usage=%d rate-control=%s bitrate=%d max-bitrate=%d gop-size=%d b-frames=%d", b.element, b.targetUsage(), rc, B, M, G, v.BFrames)
		if v.LowLatency {
			enc += " low-latency=true"
		}
	case "vah264enc", "vah265enc":
		rc := "cbr"
		if v.RateControl == "vbr" {
			rc = "vbr"
		}
		enc = fmt.Sprintf("%s target-usage=%d rate-control=%s bitrate=%d key-int-max=%d b-frames=%d", b.element, b.targetUsage(), rc, B, G, v.BFrames)
		if rc == "vbr" {
			enc += fmt.Sprintf(" target-percentage=%d", minInt(100, B*100/M))
		}
	default:
		return "", fmt.Errorf("no builder for encoder %q", b.element)
	}
	parser := "h264parse config-interval=-1"
	if v.Codec == config.CodecH265 {
		parser = "h265parse config-interval=-1"
	} else if v.TimecodeSEI && !rendition {
		parser += " update-timecode=true"
	}
	return enc + " ! " + parser, nil
}

// audioShape maps/mixes the source to n channels at the channel's rate.
func (b *builder) audioShape(n int, mapping []int, gainDb float64) string {
	a := b.ch.Audio
	var p []string
	if len(mapping) > 0 {
		inN := b.audioInChannels()
		rows := make([]string, n)
		for o := 0; o < n; o++ {
			cols := make([]string, inN)
			for i := 0; i < inN; i++ {
				val := "0.0"
				if mapping[o] == i {
					val = "1.0"
				}
				cols[i] = "(float)" + val
			}
			rows[o] = "<" + strings.Join(cols, ",") + ">"
		}
		p = append(p, "audioconvert mix-matrix="+mustQ("<"+strings.Join(rows, ",")+">"))
	} else {
		p = append(p, "audioconvert")
	}
	p = append(p, fmt.Sprintf("audioresample ! audio/x-raw,rate=%d,channels=%d%s", a.SampleRate, n, channelMask(n)))
	if gainDb != 0 {
		p = append(p, fmt.Sprintf("volume volume=%s", strconv.FormatFloat(dbToLinear(gainDb), 'f', 4, 64)))
	}
	return strings.Join(p, " ! ")
}

// audioEncoder returns "encoder ! parser [! language tag]".
func audioEncoder(codec string, kbps int, lang string) string {
	var s string
	switch codec {
	case "ac3":
		s = fmt.Sprintf("avenc_ac3 bitrate=%d ! ac3parse", kbps*1000)
	case "mp2":
		s = fmt.Sprintf("avenc_mp2 bitrate=%d ! mpegaudioparse", kbps*1000)
	default:
		s = fmt.Sprintf("avenc_aac bitrate=%d ! aacparse", kbps*1000)
	}
	if lang != "" {
		s += " ! taginject tags=" + mustQ("language-code="+lang)
	}
	return s
}
