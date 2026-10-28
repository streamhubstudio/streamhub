// Package contracts holds the cross-module domain types and service
// interfaces (Node shared/contracts). STABLE CONTRACT: field names and JSON
// shapes match the Node core exactly; only additive changes are safe.
package contracts

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
