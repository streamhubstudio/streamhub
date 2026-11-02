// Package config holds the encoder's persistent model (channels, inputs,
// encodes, outputs, StreamHub link), its defaults and its validation.
//
// The model is deliberately flat and JSON-first: it is what the REST API
// accepts, what the UI edits, what `GET /config/backup` exports and what the
// pipeline builder consumes. Nothing in here touches GStreamer or processes.
package config

import "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/notify"

// SchemaVersion is bumped on any incompatible change of the persisted model.
const SchemaVersion = 1

// Config is the whole persisted state of one encoder.
type Config struct {
	Version   int       `json:"version"`
	Device    Device    `json:"device"`
	Channels  []Channel `json:"channels"`
	StreamHub StreamHub `json:"streamhub"`
	Settings  Settings  `json:"settings"`
}

// Device identifies the box (shown in the UI, sent in the pairing hello).
type Device struct {
	ID   string `json:"id"`   // stable random id generated on first boot
	Name string `json:"name"` // operator label
}

// NotifyConfig is notify.Config under its own name (OpenAPI schema names must be unique).
type NotifyConfig notify.Config

// Settings are box-wide knobs.
type Settings struct {
	// MetricsPublic exposes /metrics without the API token (read-only, no secrets).
	MetricsPublic *bool `json:"metricsPublic,omitempty"`
	// Notify: alarm destinations (webhooks, SNMP traps).
	Notify *NotifyConfig `json:"notify,omitempty"`
}

// Channel is one encode: an input (+ optional backup) → one encode → N outputs.
type Channel struct {
	ID      string   `json:"id"`
	Name    string   `json:"name,omitempty"`
	Enabled bool     `json:"enabled"` // desired state: running
	Input   Input    `json:"input"`
	Backup  *Input   `json:"backup,omitempty"` // failover input (URI inputs only)
	Video   Video    `json:"video"`
	Audio   Audio    `json:"audio"`
	Overlay Overlay  `json:"overlay"`
	Mux     Mux      `json:"mux"`
	Outputs []Output `json:"outputs"`
	// SCTE35 enables cue insertion through the API (PID in the PMT, CUEI).
	SCTE35 *SCTE35Options `json:"scte35,omitempty"`
	// Alarms tunes the confidence-monitoring alarms (defaults apply when nil).
	Alarms *AlarmOptions `json:"alarms,omitempty"`
}

// Input types.
const (
	InTest     = "test"     // videotestsrc + audiotestsrc (bars + tone)
	InFile     = "file"     // local file, optionally looped
	InSRT      = "srt"      // srt://host:port?mode=caller|listener
	InUDP      = "udp"      // udp://[@]group:port (MPEG-TS, unicast/multicast)
	InRTMP     = "rtmp"     // rtmp://host/app/stream (pull)
	InRTSP     = "rtsp"     // rtsp://camera/stream
	InDeckLink = "decklink" // Blackmagic DeckLink SDI/HDMI capture
	InV4L2     = "v4l2"     // V4L2/UVC (HDMI-USB dongles, Magewell)
)

// Input describes where the channel's video+audio come from.
type Input struct {
	Type string `json:"type"`
	// URI for file/srt/udp/rtmp/rtsp. file: an absolute path or file:// URI.
	URI  string `json:"uri,omitempty"`
	Loop bool   `json:"loop,omitempty"` // file: restart on EOS
	// DeckLink
	Device       int    `json:"device,omitempty"`     // device-number
	Connection   string `json:"connection,omitempty"` // auto|sdi|hdmi
	Mode         string `json:"mode,omitempty"`       // auto|1080i50|1080p25|720p50|...
	AudioInputCh int    `json:"audioInputChannels,omitempty"`
	// V4L2
	DevicePath  string `json:"devicePath,omitempty"`  // /dev/video0
	AudioDevice string `json:"audioDevice,omitempty"` // ALSA device, e.g. hw:1,0 (empty = silence)
	Format      string `json:"format,omitempty"`      // raw|mjpeg (v4l2 capture format)
	// Test pattern
	Pattern string `json:"pattern,omitempty"` // smpte|smpte100|ball|snow|black|bar|...
	ToneHz  int    `json:"toneHz,omitempty"`
	// TimeoutMs: no data for this long → switch to backup/slate (URI inputs) or
	// to the slate (device inputs). Default 2000.
	TimeoutMs int `json:"timeoutMs,omitempty"`
	// Interlaced marks the source as interlaced (e.g. 1080i50 over IP) so the
	// deinterlacer kicks in; DeckLink detects it from the mode.
	Interlaced bool `json:"interlaced,omitempty"`
}

// Codecs and encoder backends.
const (
	CodecH264 = "h264"
	CodecH265 = "h265"

	EncAuto  = "auto"
	EncX264  = "x264"
	EncX265  = "x265"
	EncNVENC = "nvenc"
	EncQSV   = "qsv"
	EncVAAPI = "vaapi"
)

// Video is the single encode of the channel (shared by every output).
type Video struct {
	Codec   string `json:"codec"`             // h264|h265
	Encoder string `json:"encoder,omitempty"` // auto|x264|x265|nvenc|qsv|vaapi
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	// FPS as "25", "30", "50", "60", "30000/1001", "60000/1001", "24000/1001".
	FPS string `json:"fps"`
	// Interlaced encodes interlaced (PAFF, x264 only) — 1080i50/1080i59.94 out.
	Interlaced bool `json:"interlaced,omitempty"`
	// Deinterlace interlaced input before encoding progressive (default true).
	Deinterlace *bool  `json:"deinterlace,omitempty"`
	BitrateKbps int    `json:"bitrateKbps"`
	MaxKbps     int    `json:"maxBitrateKbps,omitempty"` // VBR cap (vbr only)
	RateControl string `json:"rateControl,omitempty"`    // cbr|vbr
	GOP         int    `json:"gop,omitempty"`            // keyframe interval in frames (0 = 2 s)
	BFrames     int    `json:"bframes,omitempty"`
	Profile     string `json:"profile,omitempty"` // h264: baseline|main|high ; h265: main
	Preset      string `json:"preset,omitempty"`  // ultrafast..slow (x26x) ; p1..p7 (nvenc)
	// LowLatency: zerolatency tune, no lookahead, no B-frames (forced).
	LowLatency bool `json:"lowLatency,omitempty"`
	// GPU index for nvenc (cuda-device-id) / render node for vaapi.
	GPU int `json:"gpu,omitempty"`
	// BitDepth 8 (default) or 10 (HEVC Main10 / Main 4:2:2 10).
	BitDepth int `json:"bitDepth,omitempty"`
	// Chroma "420" (default) or "422" (x265 Main 4:2:2 10).
	Chroma string `json:"chroma,omitempty"`
	// HDR signalling: "" (SDR), "hlg" (ARIB STD-B67) or "pq" (SMPTE ST 2084 / HDR10), BT.2020.
	HDR string `json:"hdr,omitempty"`
	// MasterDisplay (PQ): x265 syntax G(x,y)B(x,y)R(x,y)WP(x,y)L(max,min).
	MasterDisplay string `json:"masterDisplay,omitempty"`
	// MaxCLL (PQ): "maxCLL,maxFALL" in cd/m2, e.g. "1000,400".
	MaxCLL string `json:"maxCll,omitempty"`
	// TimecodeSEI carries the timecode (DeckLink RP188/VITC, else RTC) in H.264 picture-timing SEI (x264).
	TimecodeSEI bool `json:"timecodeSei,omitempty"`
	// Renditions are extra encodes of the same picture (ABR ladder), muxed into
	// the same TS on PIDs 0x110+i; outputs pick one with output.rendition.
	Renditions []Rendition `json:"renditions,omitempty"`
}

// Audio is the single audio track of the channel.
type Audio struct {
	// Lang is the ISO 639-2 code of the main track (e.g. "spa").
	Lang string `json:"lang,omitempty"`
	// Tracks are extra audio tracks (other languages / channel groups) on PIDs 0x120+i.
	Tracks      []AudioTrack `json:"tracks,omitempty"`
	Disabled    bool         `json:"disabled,omitempty"`
	Codec       string       `json:"codec,omitempty"` // aac
	BitrateKbps int          `json:"bitrateKbps,omitempty"`
	Channels    int          `json:"channels,omitempty"`   // output channels 1..8
	SampleRate  int          `json:"sampleRate,omitempty"` // 48000
	Map         []int        `json:"map,omitempty"`        // output ch i ← input ch Map[i]
	GainDb      float64      `json:"gainDb,omitempty"`
}

// Overlay burns things into the picture before the encode.
type Overlay struct {
	Timecode bool   `json:"timecode,omitempty"` // RTC timecode HH:MM:SS:FF (latency tests)
	Clock    bool   `json:"clock,omitempty"`    // wall clock HH:MM:SS
	Text     string `json:"text,omitempty"`     // static label
	// Logo: absolute path of a PNG (alpha honoured) composited at LogoX/LogoY.
	Logo      string  `json:"logo,omitempty"`
	LogoX     int     `json:"logoX,omitempty"`
	LogoY     int     `json:"logoY,omitempty"`
	LogoAlpha float64 `json:"logoAlpha,omitempty"` // 0..1 (0 = opaque)
}

// Mux configures the MPEG-TS the engine produces (the internal bus format,
// sent as-is by SRT/UDP/RTP/file outputs).
type Mux struct {
	VideoPID      int `json:"videoPid,omitempty"`      // default 256 (0x100)
	AudioPID      int `json:"audioPid,omitempty"`      // default 257
	PCRIntervalMs int `json:"pcrIntervalMs,omitempty"` // default 20
	// MuxRateKbps > 0 → CBR transport stream padded with null packets.
	MuxRateKbps int `json:"muxRateKbps,omitempty"`
}

// Output types.
const (
	OutSRT       = "srt"
	OutRTMP      = "rtmp" // rtmp:// and rtmps://
	OutUDP       = "udp"  // raw MPEG-TS over UDP (unicast/multicast)
	OutRTP       = "rtp"  // MPEG-TS over RTP (RFC 2250)
	OutWHIP      = "whip"
	OutHLS       = "hls"  // HLS push (HTTP PUT)
	OutFile      = "file" // TS recording on local disk
	OutStreamHub = "streamhub"
	OutRIST      = "rist"   // RIST Simple Profile (ristsink), optional bonding
	OutRecord    = "record" // rolling local recording (segmented TS, ring of N files)
)

// Output is one destination of the channel. Outputs are independent processes:
// adding/removing one never touches the encode or the other outputs.
type Output struct {
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`
	Type    string `json:"type"`
	Enabled bool   `json:"enabled"`
	URL     string `json:"url,omitempty"`
	// Preset is informational: the destination preset this output came from.
	Preset string `json:"preset,omitempty"`
	// ManagedBy = "streamhub" for outputs pushed by a paired StreamHub
	// (config frames replace them wholesale); empty = operator-managed.
	ManagedBy string `json:"managedBy,omitempty"`

	SRT       *SRTOptions      `json:"srt,omitempty"`
	UDP       *UDPOptions      `json:"udp,omitempty"`
	WHIP      *WHIPOptions     `json:"whip,omitempty"`
	HLS       *HLSOptions      `json:"hls,omitempty"`
	StreamHub *StreamHubOutput `json:"streamhub,omitempty"`
	RIST      *RISTOptions     `json:"rist,omitempty"`
	Record    *RecordOptions   `json:"record,omitempty"`
	// Rendition selects the encode: 0 = main, i = video.renditions[i-1]
	// (rtmp/srt/udp/hls). TS outputs at 0 carry the whole ladder.
	Rendition int `json:"rendition,omitempty"`
}

// SRTOptions for srt outputs (srt://host:port, or srt://:port for listener).
type SRTOptions struct {
	Mode       string `json:"mode,omitempty"`      // caller|listener|rendezvous (default caller)
	LatencyMs  int    `json:"latencyMs,omitempty"` // default 200
	Passphrase string `json:"passphrase,omitempty"`
	PBKeyLen   int    `json:"pbkeylen,omitempty"` // 0|16|24|32
	StreamID   string `json:"streamId,omitempty"`
}

// UDPOptions for udp/rtp outputs.
type UDPOptions struct {
	TTL   int    `json:"ttl,omitempty"`   // multicast TTL (default 16)
	Iface string `json:"iface,omitempty"` // multicast egress interface (e.g. eth1)
	Bind  string `json:"bind,omitempty"`  // source address to bind
}

// WHIPOptions for whip outputs.
type WHIPOptions struct {
	BearerToken string `json:"bearerToken,omitempty"`
}

// HLSOptions for HLS push.
type HLSOptions struct {
	SegmentSeconds int `json:"segmentSeconds,omitempty"` // default 2
	ListSize       int `json:"listSize,omitempty"`       // default 6
	// Ladder publishes every rendition with a master playlist (ABR).
	Ladder bool `json:"ladder,omitempty"`
	// CMAF uses fMP4 segments (always on for HEVC).
	CMAF bool `json:"cmaf,omitempty"`
}

// StreamHubOutput publishes into a StreamHub app using the REST API that
// exists TODAY (an app-scoped sk_ token): the encoder creates/reuses an ingress
// and pushes RTMP or WHIP to it.
type StreamHubOutput struct {
	BaseURL  string `json:"baseUrl"`            // https://streamhub.example.com
	App      string `json:"app"`                // app name
	Token    string `json:"token,omitempty"`    // sk_… (redacted on read)
	Room     string `json:"room,omitempty"`     // room/stream name (default = channel id)
	Protocol string `json:"protocol,omitempty"` // rtmp|whip (default rtmp)
	// Resolved by the encoder (persisted so a restart reuses the same key).
	IngressID   string `json:"ingressId,omitempty"`
	ResolvedURL string `json:"resolvedUrl,omitempty"`
	StreamKey   string `json:"streamKey,omitempty"`
	// DeleteOnRemove deletes the ingress in StreamHub when the output is removed.
	DeleteOnRemove bool `json:"deleteOnRemove,omitempty"`
}

// StreamHub is the native pairing state (device plane).
type StreamHub struct {
	BaseURL    string `json:"baseUrl,omitempty"`
	DeviceID   string `json:"deviceId,omitempty"`
	Credential string `json:"credential,omitempty"` // dk_… (redacted on read)
	WSURL      string `json:"wsUrl,omitempty"`
	PairedAt   string `json:"pairedAt,omitempty"`
	ConfigRev  int64  `json:"configRev,omitempty"`
}

// Redacted is the placeholder returned instead of secrets.
const Redacted = "***"
