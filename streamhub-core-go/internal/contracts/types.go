// Package contracts holds the cross-module domain types and service
// interfaces (Node shared/contracts). STABLE CONTRACT: field names and JSON
// shapes match the Node core exactly; only additive changes are safe.
package contracts

import (
	"regexp"
	"strings"
)

// S3Provider is aws | wasabi | minio.
type S3Provider = string

// RecordingMode is room-composite | participant.
type RecordingMode = string

// LogLevel is trace | debug | info | warn | error | fatal.
type LogLevel = string

// S3Config is the resolved S3 configuration of one app: credentials already
// dereferenced from env / data/secrets.json (never the raw *_env refs).
type S3Config struct {
	Provider S3Provider `json:"provider"`
	Bucket   string     `json:"bucket"`
	Region   string     `json:"region"`
	// Endpoint is empty for plain AWS (absent in JSON, as Node's undefined).
	Endpoint       string `json:"endpoint,omitempty"`
	ForcePathStyle bool   `json:"forcePathStyle"`
	Prefix         string `json:"prefix"`
	// PublicURL, when set, makes VOD URLs <publicUrl>/<key> (no presign).
	PublicURL string `json:"publicUrl,omitempty"`
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
	// StorageClass pins every PutObject to an S3 storage class (STANDARD_IA,
	// INTELLIGENT_TIERING…); "" = the bucket/provider default (absent in JSON).
	StorageClass string `json:"storageClass,omitempty"`
}

// S3UploadResult is the result of an S3 upload.
type S3UploadResult struct {
	Key       string `json:"key"`
	Bucket    string `json:"bucket"`
	URL       string `json:"url"`
	SizeBytes int64  `json:"sizeBytes"`
	ETag      string `json:"etag,omitempty"`
}

// S3PresignOptions override the response headers of a presigned GET.
type S3PresignOptions struct {
	ResponseContentDisposition string
	ResponseContentType        string
}

// WebrtcLayer is one rung of the WebRTC simulcast ladder.
type WebrtcLayer struct {
	Name   string  `json:"name"`
	Height float64 `json:"height"`
}

// VodRendition is one rung of the adaptive VOD ladder.
type VodRendition struct {
	Height      float64 `json:"height"`
	BitrateKbps float64 `json:"bitrateKbps"`
}

// WsIngestFeatures are the direct WebSocket MJPEG ingest limits.
type WsIngestFeatures struct {
	Enabled       bool    `json:"enabled"`
	MaxCameras    float64 `json:"maxCameras"`
	MaxFps        float64 `json:"maxFps"`
	MaxFrameKb    float64 `json:"maxFrameKb"`
	MaxDataBytes  float64 `json:"maxDataBytes"`
	MaxDataPerSec float64 `json:"maxDataPerSec"`
}

// DrmLicenseUrls are the per-system license server URLs.
type DrmLicenseUrls struct {
	Widevine  string `json:"widevine"`
	Playready string `json:"playready"`
	Fairplay  string `json:"fairplay"`
}

// DrmFeatures is the resolved features.drm block (default OFF).
type DrmFeatures struct {
	Enabled           bool           `json:"enabled"`
	Provider          string         `json:"provider"` // none | external
	Systems           []string       `json:"systems"`  // widevine | playready | fairplay
	Scheme            string         `json:"scheme"`   // cenc | cbcs
	KeyServerURL      string         `json:"keyServerUrl"`
	KeyServerTokenEnv string         `json:"keyServerTokenEnv"`
	LicenseUrls       DrmLicenseUrls `json:"licenseUrls"`
	FairplayCertURL   string         `json:"fairplayCertUrl"`
	FailOpen          bool           `json:"failOpen"`
}

// LinearChannelFeatures are the 24/7 linear-channel knobs.
type LinearChannelFeatures struct {
	PersistentRoom          bool    `json:"persistentRoom"`
	RoomEmptyTimeoutSeconds float64 `json:"roomEmptyTimeoutSeconds"`
	AlwaysOnHls             bool    `json:"alwaysOnHls"`
	Dvr                     bool    `json:"dvr"`
	DvrWindowSeconds        float64 `json:"dvrWindowSeconds"`
}

// DvrFeatures is features.dvr (G5): a rewindable window on the live HLS of
// every stream of the app. Present only when config.yaml carries the block.
type DvrFeatures struct {
	Enabled       bool    `json:"enabled"`
	WindowMinutes float64 `json:"windowMinutes"`
}

// HlsFeatures is features.hls (G5, the AMS hlsTime/hlsListSize settings):
// the live HLS egress segment length and the served playlist window.
type HlsFeatures struct {
	// SegmentSeconds ↔ hlsTime (1..30, default 4).
	SegmentSeconds float64 `json:"segmentSeconds"`
	// ListSize ↔ hlsListSize: segments in the served playlist (0 = all).
	ListSize float64 `json:"listSize"`
}

// ClipsFeatures is features.clips (G6): instant/event clips cut from the
// HLS/DVR segments into the app's VODs.
type ClipsFeatures struct {
	Enabled       bool    `json:"enabled"`
	MaxSeconds    float64 `json:"maxSeconds"`
	MaxConcurrent float64 `json:"maxConcurrent"`
	MaxQueued     float64 `json:"maxQueued"`
}

// AppFeatures are the per-app feature flags (always fully resolved).
type AppFeatures struct {
	RtmpPassword   bool                   `json:"rtmpPassword"`
	ViewerCounter  bool                   `json:"viewerCounter"`
	Chat           bool                   `json:"chat"`
	Reactions      bool                   `json:"reactions"`
	HiddenQc       bool                   `json:"hiddenQc"`
	AdaptivePlayer bool                   `json:"adaptivePlayer"`
	PublicPlayback bool                   `json:"publicPlayback"`
	WsIngest       *WsIngestFeatures      `json:"wsIngest,omitempty"`
	Drm            *DrmFeatures           `json:"drm,omitempty"`
	Linear         *LinearChannelFeatures `json:"linear,omitempty"`
	// AllowedPublisherCidr is features.allowed_publisher_cidr (↔ AntMedia
	// allowedPublisherCIDR): the source networks a publisher may come from.
	// Empty/absent = no restriction. Entries are kept as written — an
	// invalid one matches nothing (fail closed).
	AllowedPublisherCidr []string `json:"allowedPublisherCidr,omitempty"`
	// MaxBitrateAccept is features.max_bitrate_accept in bits/s (↔
	// maxBitrateAccept): an ingress publishing above it is cut. 0 = no cap.
	MaxBitrateAccept float64 `json:"maxBitrateAccept,omitempty"`
	// Dvr / Hls / Clips are nil unless config.yaml has the block, so an app
	// that never opted in resolves (and serializes) exactly as before.
	Dvr   *DvrFeatures   `json:"dvr,omitempty"`
	Hls   *HlsFeatures   `json:"hls,omitempty"`
	Clips *ClipsFeatures `json:"clips,omitempty"`
	// The G2 (3.4.0) blocks below are config.yaml-only and omitted from the
	// JSON when unset, so an app that never configured them reads exactly
	// like before.
	// HlsTokenTTLSeconds is features.hls_token_ttl_seconds: the lifetime of
	// the ?st= HLS token of a private app (0 = the default, see hlsauth).
	HlsTokenTTLSeconds int64             `json:"hlsTokenTtlSeconds,omitempty"`
	Geo                *GeoFeatures      `json:"geo,omitempty"`
	PlayAuth           *PlayAuthFeatures `json:"playAuth,omitempty"`
}

// GeoFeatures is features.geo: country allow/deny lists (ISO 3166-1 alpha-2,
// upper-cased) checked against the local GeoLite2 base (STREAMHUB_GEOIP_DB).
// A non-empty Allow admits only those countries; Deny always wins. Publish
// extends the check to the RTMP publishes that pass through the core.
type GeoFeatures struct {
	Allow   []string `json:"allow"`
	Deny    []string `json:"deny"`
	Publish bool     `json:"publish"`
}

// Active reports whether the lists restrict anything.
func (g *GeoFeatures) Active() bool { return g != nil && (len(g.Allow) > 0 || len(g.Deny) > 0) }

// PlayAuthFeatures is features.play_auth: an external webhook consulted on
// every anonymous playback grant (AntMedia's webhookPlayAuthUrl).
type PlayAuthFeatures struct {
	WebhookURL string `json:"webhookUrl"`
	TimeoutMs  int64  `json:"timeoutMs"`
	FailOpen   bool   `json:"failOpen"`
}

// MqttLogsConfig is the mqtt.logs block.
type MqttLogsConfig struct {
	Enabled bool     `json:"enabled"`
	Level   LogLevel `json:"level"`
}

// MqttConfig is the resolved per-app MQTT block (password resolved — never
// return it raw over the API).
type MqttConfig struct {
	Enabled     bool           `json:"enabled"`
	URL         string         `json:"url"`
	Username    string         `json:"username"`
	Password    string         `json:"password"`
	TopicPrefix string         `json:"topicPrefix"`
	Qos         int            `json:"qos"`
	TLS         bool           `json:"tls"`
	Events      []string       `json:"events"`
	Logs        MqttLogsConfig `json:"logs"`
}

// SmtpConfig is the resolved per-app SMTP override (pass resolved).
type SmtpConfig struct {
	Enabled bool    `json:"enabled"`
	Host    string  `json:"host"`
	Port    float64 `json:"port"`
	User    string  `json:"user"`
	From    string  `json:"from"`
	Pass    string  `json:"pass"`
}

// AppQuotasConfig are the per-app quotas (-1 = unlimited).
type AppQuotasConfig struct {
	MaxConcurrentStreams float64 `json:"maxConcurrentStreams"`
	MaxViewersPerStream  float64 `json:"maxViewersPerStream"`
}

// LatencyAlertConfig is the latency_alert block.
type LatencyAlertConfig struct {
	Enabled         bool    `json:"enabled"`
	ThresholdMs     float64 `json:"thresholdMs"`
	CooldownSeconds float64 `json:"cooldownSeconds"`
	IntervalSeconds float64 `json:"intervalSeconds"`
}

// RecordingConfig is AppConfig.recording.
type RecordingConfig struct {
	Enabled                bool          `json:"enabled"`
	Mode                   RecordingMode `json:"mode"`
	Layout                 string        `json:"layout"`
	LocalDir               string        `json:"localDir"`
	DeleteLocalAfterUpload bool          `json:"deleteLocalAfterUpload"`
	SplitMinutes           float64       `json:"splitMinutes"`
	SnapshotSeconds        float64       `json:"snapshotSeconds"`
	FilenameTemplate       string        `json:"filenameTemplate"`
	SnapshotTemplate       string        `json:"snapshotTemplate"`
	RetentionDays          float64       `json:"retentionDays"`
}

var localDirRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// ValidLocalDir: recording.local_dir is ONE plain directory name under the
// app dir — no separators, no "..", not "." (it is joined onto the app dir
// and egress writes there; "../x" or "/etc" escaped it).
func ValidLocalDir(dir string) bool {
	return localDirRe.MatchString(dir) && dir != "." && !strings.Contains(dir, "..")
}

// WebrtcConfig is AppConfig.webrtc.
type WebrtcConfig struct {
	Adaptive           bool          `json:"adaptive"`
	Layers             []WebrtcLayer `json:"layers"`
	TranscodeMaxHeight int           `json:"transcodeMaxHeight"`
}

// RtmpConfig is AppConfig.rtmp.
type RtmpConfig struct {
	Enabled     bool `json:"enabled"`
	Transcode   bool `json:"transcode"`
	Passthrough bool `json:"passthrough"`
}

// TranscodingConfig is AppConfig.transcoding.
type TranscodingConfig struct {
	Enabled       bool           `json:"enabled"`
	Encoding      string         `json:"encoding"` // h264 | h264+vp8
	VodAdaptive   bool           `json:"vodAdaptive"`
	VodRenditions []VodRendition `json:"vodRenditions"`
}

// CallbacksConfig is AppConfig.callbacks.
type CallbacksConfig struct {
	URL    string `json:"url"`
	Secret string `json:"secret"`
}

// AppConfig is the resolved config.yaml of an app (SPEC §7). Every optional
// block of the Node type is always resolved by the apps service.
type AppConfig struct {
	Name         string             `json:"name"`
	DisplayName  string             `json:"displayName"`
	RoomPrefix   string             `json:"roomPrefix"`
	Timezone     string             `json:"timezone"`
	Recording    RecordingConfig    `json:"recording"`
	S3           S3Config           `json:"s3"`
	Webrtc       WebrtcConfig       `json:"webrtc"`
	Rtmp         RtmpConfig         `json:"rtmp"`
	Transcoding  TranscodingConfig  `json:"transcoding"`
	Callbacks    CallbacksConfig    `json:"callbacks"`
	Mqtt         MqttConfig         `json:"mqtt"`
	Smtp         SmtpConfig         `json:"smtp"`
	LatencyAlert LatencyAlertConfig `json:"latencyAlert"`
	Quotas       *AppQuotasConfig   `json:"quotas,omitempty"` // nil = unlimited (no block)
	Features     AppFeatures        `json:"features"`
	Variables    map[string]string  `json:"variables"`
}

// AppRecord is a row of the global `apps` registry.
type AppRecord struct {
	ID                int64   `json:"id"`
	Name              string  `json:"name"`
	DisplayName       string  `json:"displayName"`
	LivekitRoomPrefix string  `json:"livekitRoomPrefix"`
	CreatedAt         string  `json:"createdAt"`
	UpdatedAt         string  `json:"updatedAt"`
	SettingsJSON      *string `json:"settingsJson"`
}
