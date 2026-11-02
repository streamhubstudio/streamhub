// Package presets holds the built-in encode profiles (what to encode) and
// destination presets (where to send it: generic templates for third-party
// media servers, CDNs and broadcast gear). Presets are plain data: applying
// one only fills config fields — there is no per-vendor logic anywhere else.
package presets

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

// Profile is an encode profile (video + audio of a channel).
type Profile struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Video       config.Video `json:"video"`
	Audio       config.Audio `json:"audio"`
}

func b(v bool) *bool { return &v }

// Profiles are the built-in encode profiles.
var Profiles = []Profile{
	{ID: "hevc-1080p25-4m-calidad", Name: "HEVC 1080p25 4 Mbps (calidad)", Description: "Reemplazo directo del HERO 5000E: 1080i50 → desentrelazado → HEVC 4 Mbps CBR, GOP 2 s, B-pyramid. Contribución punto a punto.",
		Video: config.Video{Codec: "h265", Encoder: "auto", Width: 1920, Height: 1080, FPS: "25", BitrateKbps: 4000, RateControl: "cbr", GOP: 50, BFrames: 3, Preset: "faster", Deinterlace: b(true)},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 128, Channels: 2}},
	{ID: "hevc-1080p25-4m-baja-latencia", Name: "HEVC 1080p25 4 Mbps (baja latencia)", Description: "HEVC zerolatency, sin B-frames ni lookahead.",
		Video: config.Video{Codec: "h265", Encoder: "auto", Width: 1920, Height: 1080, FPS: "25", BitrateKbps: 4000, RateControl: "cbr", GOP: 50, LowLatency: true, Preset: "veryfast", Deinterlace: b(true)},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 128, Channels: 2}},
	{ID: "hevc-1080p50-8m", Name: "HEVC 1080p50 8 Mbps", Video: config.Video{Codec: "h265", Encoder: "auto", Width: 1920, Height: 1080, FPS: "50", BitrateKbps: 8000, RateControl: "cbr", GOP: 100, BFrames: 2, Preset: "veryfast"},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 128, Channels: 2}},
	{ID: "hevc-720p50-3m", Name: "HEVC 720p50 3 Mbps", Video: config.Video{Codec: "h265", Encoder: "auto", Width: 1280, Height: 720, FPS: "50", BitrateKbps: 3000, RateControl: "cbr", GOP: 100, BFrames: 2, Preset: "faster"},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 128, Channels: 2}},
	{ID: "hevc-2160p30-15m", Name: "HEVC 2160p30 15 Mbps (NVENC/QSV)", Description: "4K: requiere encoder por hardware.",
		Video: config.Video{Codec: "h265", Encoder: "auto", Width: 3840, Height: 2160, FPS: "30", BitrateKbps: 15000, RateControl: "cbr", GOP: 60, Preset: "p4"},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 192, Channels: 2}},
	{ID: "h264-1080p30-6m", Name: "H.264 1080p30 6 Mbps", Description: "Perfil universal: RTMP, YouTube, Twitch, LiveKit/StreamHub, CDNs.",
		Video: config.Video{Codec: "h264", Encoder: "auto", Width: 1920, Height: 1080, FPS: "30", BitrateKbps: 6000, RateControl: "cbr", GOP: 60, BFrames: 2, Profile: "high", Preset: "veryfast"},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 128, Channels: 2}},
	{ID: "h264-1080p60-9m", Name: "H.264 1080p60 9 Mbps", Video: config.Video{Codec: "h264", Encoder: "auto", Width: 1920, Height: 1080, FPS: "60", BitrateKbps: 9000, RateControl: "cbr", GOP: 120, BFrames: 2, Profile: "high", Preset: "veryfast"},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 160, Channels: 2}},
	{ID: "h264-720p30-3m", Name: "H.264 720p30 3 Mbps", Video: config.Video{Codec: "h264", Encoder: "auto", Width: 1280, Height: 720, FPS: "30", BitrateKbps: 3000, RateControl: "cbr", GOP: 60, BFrames: 2, Profile: "high", Preset: "veryfast"},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 128, Channels: 2}},
	{ID: "h264-1080i50-8m-entrelazado", Name: "H.264 1080i50 8 Mbps (entrelazado, x264)", Description: "Salida entrelazada nativa para IRD/headends.",
		Video: config.Video{Codec: "h264", Encoder: "x264", Width: 1920, Height: 1080, FPS: "25", Interlaced: true, BitrateKbps: 8000, RateControl: "cbr", GOP: 50, BFrames: 2, Profile: "high", Preset: "veryfast"},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 192, Channels: 2}},
	{ID: "h264-webrtc-1080p30-4m", Name: "H.264 WebRTC/WHIP 1080p30 4 Mbps", Description: "Sin B-frames, baja latencia: WHIP (LiveKit/StreamHub, MediaMTX, Ant Media).",
		Video: config.Video{Codec: "h264", Encoder: "auto", Width: 1920, Height: 1080, FPS: "30", BitrateKbps: 4000, RateControl: "cbr", GOP: 60, Profile: "high", LowLatency: true, Preset: "veryfast"},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 128, Channels: 2}},
	{ID: "h264-2160p30-20m", Name: "H.264 2160p30 20 Mbps (NVENC/QSV)", Video: config.Video{Codec: "h264", Encoder: "auto", Width: 3840, Height: 2160, FPS: "30", BitrateKbps: 20000, RateControl: "cbr", GOP: 60, Profile: "high", Preset: "p4"},
		Audio: config.Audio{Codec: "aac", BitrateKbps: 192, Channels: 2}},
}

// FindProfile returns a profile by id.
func FindProfile(id string) (Profile, bool) {
	for _, p := range Profiles {
		if p.ID == id {
			return p, true
		}
	}
	return Profile{}, false
}

// ApplyProfile overwrites the channel's video/audio with the profile,
// keeping the encoder backend/GPU the operator chose when the profile says auto.
func ApplyProfile(ch *config.Channel, p Profile) {
	keepEnc, keepGPU := ch.Video.Encoder, ch.Video.GPU
	ch.Video = p.Video
	if ch.Video.Encoder == "auto" && keepEnc != "" && keepEnc != "auto" {
		// only keep a backend that can produce the profile's codec
		if !(keepEnc == "x264" && p.Video.Codec != "h264") && !(keepEnc == "x265" && p.Video.Codec != "h265") {
			ch.Video.Encoder = keepEnc
		}
	}
	ch.Video.GPU = keepGPU
	disabled, mapping := ch.Audio.Disabled, ch.Audio.Map
	ch.Audio = p.Audio
	ch.Audio.Disabled = disabled
	if len(mapping) == ch.Audio.Channels {
		ch.Audio.Map = mapping
	}
}

// Param is a template parameter of a destination.
type Param struct {
	Name     string `json:"name"`
	Label    string `json:"label"`
	Default  string `json:"default,omitempty"`
	Secret   bool   `json:"secret,omitempty"`
	Optional bool   `json:"optional,omitempty"`
}

// Destination is a template for an output.
type Destination struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Vendor   string   `json:"vendor"`
	Type     string   `json:"type"` // output type
	URL      string   `json:"url"`  // template with {param}
	Params   []Param  `json:"params"`
	Codecs   []string `json:"codecs"` // accepted video codecs
	NoBFrame bool     `json:"noBFrames,omitempty"`
	Notes    string   `json:"notes,omitempty"`
	// Option templates (values may use {param}).
	SRTMode     string `json:"srtMode,omitempty"`
	SRTLatency  int    `json:"srtLatencyMs,omitempty"`
	SRTStreamID string `json:"srtStreamId,omitempty"`
	SRTPass     string `json:"srtPassphrase,omitempty"` // template, usually {passphrase}
	WHIPBearer  string `json:"whipBearer,omitempty"`
	TTL         int    `json:"ttl,omitempty"`
}

var (
	pHost    = Param{Name: "host", Label: "Host / IP"}
	pApp     = func(def string) Param { return Param{Name: "app", Label: "Application", Default: def} }
	pStream  = Param{Name: "stream", Label: "Stream name / ID"}
	pKey     = Param{Name: "key", Label: "Stream key", Secret: true}
	pPort    = func(def string) Param { return Param{Name: "port", Label: "Port", Default: def} }
	pPass    = Param{Name: "passphrase", Label: "SRT passphrase (10–79, optional)", Secret: true, Optional: true}
	pPath    = Param{Name: "path", Label: "Path", Default: "live"}
	both     = []string{"h264", "h265"}
	h264Only = []string{"h264"}
)

// Destinations are the built-in destination presets.
var Destinations = []Destination{
	// Wowza Streaming Engine
	{ID: "wowza-rtmp", Name: "Wowza Streaming Engine — RTMP", Vendor: "Wowza", Type: "rtmp", URL: "rtmp://{host}:1935/{app}/{stream}", Params: []Param{pHost, pApp("live"), pStream}, Codecs: both, Notes: "HEVC solo con Enhanced RTMP (Wowza ≥ 4.8.24)."},
	{ID: "wowza-srt", Name: "Wowza Streaming Engine — SRT", Vendor: "Wowza", Type: "srt", URL: "srt://{host}:{port}", Params: []Param{pHost, pPort("9000"), pPass}, Codecs: both, SRTMode: "caller", SRTLatency: 400, SRTPass: "{passphrase}", Notes: "Crear un listener SRT (MPEG-TS) en Wowza en ese puerto."},
	// Ant Media Server
	{ID: "antmedia-rtmp", Name: "Ant Media Server — RTMP", Vendor: "Ant Media", Type: "rtmp", URL: "rtmp://{host}/{app}/{stream}", Params: []Param{pHost, pApp("LiveApp"), pStream}, Codecs: h264Only},
	{ID: "antmedia-srt", Name: "Ant Media Server — SRT", Vendor: "Ant Media", Type: "srt", URL: "srt://{host}:{port}", Params: []Param{pHost, pPort("4200"), pApp("LiveApp"), pStream}, Codecs: both, SRTMode: "caller", SRTLatency: 400, SRTStreamID: "{app}/{stream}"},
	{ID: "antmedia-whip", Name: "Ant Media Server — WHIP", Vendor: "Ant Media", Type: "whip", URL: "https://{host}:5443/{app}/whip/{stream}", Params: []Param{pHost, pApp("LiveApp"), pStream}, Codecs: h264Only, NoBFrame: true},
	// nginx-rtmp
	{ID: "nginx-rtmp", Name: "nginx-rtmp", Vendor: "nginx", Type: "rtmp", URL: "rtmp://{host}:1935/{app}/{key}", Params: []Param{pHost, pApp("live"), pKey}, Codecs: h264Only, Notes: "nginx-rtmp solo acepta H.264/AAC."},
	// MediaMTX
	{ID: "mediamtx-srt", Name: "MediaMTX — SRT", Vendor: "MediaMTX", Type: "srt", URL: "srt://{host}:{port}", Params: []Param{pHost, pPort("8890"), pPath, pPass}, Codecs: both, SRTMode: "caller", SRTLatency: 200, SRTStreamID: "publish:{path}", SRTPass: "{passphrase}"},
	{ID: "mediamtx-rtmp", Name: "MediaMTX — RTMP", Vendor: "MediaMTX", Type: "rtmp", URL: "rtmp://{host}:1935/{path}", Params: []Param{pHost, pPath}, Codecs: both, Notes: "HEVC vía Enhanced RTMP."},
	{ID: "mediamtx-whip", Name: "MediaMTX — WHIP", Vendor: "MediaMTX", Type: "whip", URL: "http://{host}:8889/{path}/whip", Params: []Param{pHost, pPath}, Codecs: h264Only, NoBFrame: true},
	// CDNs / social
	{ID: "youtube-rtmps", Name: "YouTube Live — RTMPS", Vendor: "YouTube", Type: "rtmp", URL: "rtmps://a.rtmps.youtube.com:443/live2/{key}", Params: []Param{pKey}, Codecs: both, Notes: "HEVC por Enhanced RTMP."},
	{ID: "youtube-rtmp", Name: "YouTube Live — RTMP", Vendor: "YouTube", Type: "rtmp", URL: "rtmp://a.rtmp.youtube.com/live2/{key}", Params: []Param{pKey}, Codecs: both},
	{ID: "twitch-rtmp", Name: "Twitch — RTMP", Vendor: "Twitch", Type: "rtmp", URL: "rtmp://live.twitch.tv/app/{key}", Params: []Param{pKey}, Codecs: h264Only, Notes: "H.264 hasta 6 Mbps, GOP 2 s."},
	{ID: "twitch-rtmps", Name: "Twitch — RTMPS", Vendor: "Twitch", Type: "rtmp", URL: "rtmps://live.twitch.tv:443/app/{key}", Params: []Param{pKey}, Codecs: h264Only},
	{ID: "facebook-rtmps", Name: "Facebook Live — RTMPS", Vendor: "Meta", Type: "rtmp", URL: "rtmps://live-api-s.facebook.com:443/rtmp/{key}", Params: []Param{pKey}, Codecs: h264Only},
	// AWS / broadcast SRT
	{ID: "aws-medialive-srt", Name: "AWS Elemental MediaLive — SRT (caller)", Vendor: "AWS", Type: "srt", URL: "srt://{host}:{port}", Params: []Param{pHost, pPort("5000"), pPass}, Codecs: both, SRTMode: "caller", SRTLatency: 2000, SRTPass: "{passphrase}", Notes: "Input MediaLive tipo SRT_CALLER/listener del lado AWS; latencia ≥ 4×RTT."},
	{ID: "aws-mediaconnect-srt", Name: "AWS Elemental MediaConnect — SRT listener source", Vendor: "AWS", Type: "srt", URL: "srt://{host}:{port}", Params: []Param{pHost, pPort("5000"), pPass}, Codecs: both, SRTMode: "caller", SRTLatency: 2000, SRTPass: "{passphrase}"},
	{ID: "haivision-srt", Name: "Haivision SRT Gateway / decoder", Vendor: "Haivision", Type: "srt", URL: "srt://{host}:{port}", Params: []Param{pHost, pPort("9000"), pPass}, Codecs: both, SRTMode: "caller", SRTLatency: 500, SRTPass: "{passphrase}"},
	// Generic
	{ID: "generic-srt-caller", Name: "SRT genérico — caller", Vendor: "Generic", Type: "srt", URL: "srt://{host}:{port}", Params: []Param{pHost, pPort("9000"), pPass, {Name: "streamid", Label: "Stream ID (opcional)", Optional: true}}, Codecs: both, SRTMode: "caller", SRTLatency: 200, SRTPass: "{passphrase}", SRTStreamID: "{streamid}"},
	{ID: "generic-srt-listener", Name: "SRT genérico — listener (el decoder llama)", Vendor: "Generic", Type: "srt", URL: "srt://:{port}", Params: []Param{pPort("9000"), pPass}, Codecs: both, SRTMode: "listener", SRTLatency: 200, SRTPass: "{passphrase}"},
	{ID: "generic-udp-multicast", Name: "MPEG-TS UDP multicast", Vendor: "Generic", Type: "udp", URL: "udp://{group}:{port}", Params: []Param{{Name: "group", Label: "Grupo multicast", Default: "239.1.1.1"}, pPort("5000")}, Codecs: both, TTL: 16},
	{ID: "generic-udp-unicast", Name: "MPEG-TS UDP unicast", Vendor: "Generic", Type: "udp", URL: "udp://{host}:{port}", Params: []Param{pHost, pPort("5000")}, Codecs: both, TTL: 64},
	{ID: "generic-rtp", Name: "MPEG-TS sobre RTP (RFC 2250)", Vendor: "Generic", Type: "rtp", URL: "rtp://{host}:{port}", Params: []Param{pHost, pPort("5004")}, Codecs: both, TTL: 16},
	{ID: "iptv-ird", Name: "Headend IPTV / IRD (HERO 5000D)", Vendor: "Broadcast", Type: "udp", URL: "udp://{group}:{port}", Params: []Param{{Name: "group", Label: "Grupo multicast", Default: "239.10.10.10"}, pPort("1234")}, Codecs: both, TTL: 8, Notes: "PIDs fijos: video 0x100, audio 0x101 (Mux). Usar muxRateKbps para TS CBR."},
	{ID: "generic-rtmp", Name: "RTMP/RTMPS genérico", Vendor: "Generic", Type: "rtmp", URL: "{url}", Params: []Param{{Name: "url", Label: "URL completa (rtmp[s]://host/app/key)", Secret: true}}, Codecs: both},
	{ID: "generic-whip", Name: "WHIP genérico", Vendor: "Generic", Type: "whip", URL: "{url}", Params: []Param{{Name: "url", Label: "Endpoint WHIP"}, {Name: "token", Label: "Bearer token (opcional)", Secret: true, Optional: true}}, Codecs: h264Only, NoBFrame: true, WHIPBearer: "{token}"},
	{ID: "hls-push", Name: "HLS push (HTTP PUT)", Vendor: "Generic", Type: "hls", URL: "{url}", Params: []Param{{Name: "url", Label: "URL del playlist (…/index.m3u8)"}}, Codecs: both},
	// StreamHub (works today: REST API + app token)
	{ID: "streamhub-rtmp", Name: "StreamHub — RTMP (plano LiveKit)", Vendor: "StreamHub", Type: "streamhub", Params: []Param{{Name: "baseUrl", Label: "URL de StreamHub"}, {Name: "app", Label: "App"}, {Name: "token", Label: "Token sk_ de la app", Secret: true}, {Name: "room", Label: "Room (opcional)", Optional: true}}, Codecs: h264Only, Notes: "Crea el ingress por la API REST y publica RTMP. WebRTC + HLS en el dashboard."},
	{ID: "streamhub-whip", Name: "StreamHub — WHIP (plano LiveKit)", Vendor: "StreamHub", Type: "streamhub", Params: []Param{{Name: "baseUrl", Label: "URL de StreamHub"}, {Name: "app", Label: "App"}, {Name: "token", Label: "Token sk_ de la app", Secret: true}, {Name: "room", Label: "Room (opcional)", Optional: true}}, Codecs: h264Only, NoBFrame: true},
}

// FindDestination returns a destination preset by id.
func FindDestination(id string) (Destination, bool) {
	for _, d := range Destinations {
		if d.ID == id {
			return d, true
		}
	}
	return Destination{}, false
}

var reParam = regexp.MustCompile(`\{([a-zA-Z]+)\}`)

// Instantiate renders a destination into an output with id outID.
func Instantiate(d Destination, params map[string]string, outID string) (config.Output, error) {
	vals := map[string]string{}
	for _, p := range d.Params {
		v := strings.TrimSpace(params[p.Name])
		if v == "" {
			v = p.Default
		}
		if v == "" && !p.Optional {
			return config.Output{}, fmt.Errorf("parameter %q is required", p.Name)
		}
		if !config.SafeValue(v) || strings.ContainsAny(v, " \t") {
			return config.Output{}, fmt.Errorf("parameter %q has forbidden characters", p.Name)
		}
		vals[p.Name] = v
	}
	render := func(t string) string {
		return reParam.ReplaceAllStringFunc(t, func(m string) string { return vals[m[1:len(m)-1]] })
	}
	o := config.Output{ID: outID, Name: d.Name, Type: d.Type, Enabled: true, Preset: d.ID, URL: render(d.URL)}
	switch d.Type {
	case "srt":
		o.SRT = &config.SRTOptions{Mode: d.SRTMode, LatencyMs: d.SRTLatency, StreamID: render(d.SRTStreamID), Passphrase: render(d.SRTPass)}
	case "udp", "rtp":
		o.UDP = &config.UDPOptions{TTL: d.TTL}
	case "whip":
		if t := render(d.WHIPBearer); t != "" {
			o.WHIP = &config.WHIPOptions{BearerToken: t}
		}
	case "streamhub":
		proto := "rtmp"
		if d.ID == "streamhub-whip" {
			proto = "whip"
		}
		o.URL = ""
		o.StreamHub = &config.StreamHubOutput{BaseURL: vals["baseUrl"], App: vals["app"], Token: vals["token"], Room: vals["room"], Protocol: proto}
	}
	return o, nil
}

// Check returns warnings when a channel's encode does not suit a destination.
func Check(d Destination, ch config.Channel) []string {
	var w []string
	ok := false
	for _, c := range d.Codecs {
		if c == ch.Video.Codec {
			ok = true
		}
	}
	if !ok {
		w = append(w, fmt.Sprintf("%s acepta %v; el canal codifica %s", d.Name, d.Codecs, ch.Video.Codec))
	}
	if d.NoBFrame && ch.Video.BFrames > 0 {
		w = append(w, d.Name+" necesita bframes=0 (WebRTC)")
	}
	return w
}

// DestinationIDs lists ids (sorted).
func DestinationIDs() []string {
	ids := make([]string, len(Destinations))
	for i, d := range Destinations {
		ids[i] = d.ID
	}
	sort.Strings(ids)
	return ids
}
