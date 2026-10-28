package contracts

import (
	"context"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
)

// AppsService is the narrow surface other modules use from the apps module
// (Node AppsServiceContract, plus the tenant-scoped list the controllers
// call). Errors are *httpx.Error with the Node exception text.
type AppsService interface {
	// List returns apps visible to p (own tenant for user-scope; superadmin,
	// global credentials and internal callers — p == nil — see every app),
	// sorted by name.
	List(ctx context.Context, p *auth.Principal) ([]AppRecord, error)
	// Get returns the registry row, or nil when the app does not exist.
	Get(ctx context.Context, name string) (*AppRecord, error)
	Create(ctx context.Context, in CreateAppInput) (*AppRecord, error)
	Delete(ctx context.Context, name string, opts DeleteAppOptions) error
	// GetConfig is the parsed config.yaml with resolved credentials (404 when
	// the app is missing).
	GetConfig(ctx context.Context, name string) (*AppConfig, error)
	// UpdateConfig persists a partial config; returns the merged config.
	UpdateConfig(ctx context.Context, name string, patch AppConfigPatch) (*AppConfig, error)
	// AppDir is the absolute apps/<name>/ path.
	AppDir(name string) string
}

// CreateAppInput is AppsService.Create's input.
type CreateAppInput struct {
	Name        string
	DisplayName string
	RoomPrefix  string
	// TenantID owns the app ("" = platform tenant).
	TenantID string
	// Config is an optional initial patch applied over the defaults.
	Config *AppConfigPatch
}

// DeleteAppOptions: DeleteVods also purges apps/<name>/ on disk.
type DeleteAppOptions struct {
	DeleteVods bool
}

// AppConfigPatch is Partial<AppConfig>: nil = leave untouched.
type AppConfigPatch struct {
	DisplayName  *string
	RoomPrefix   *string
	Timezone     *string
	Variables    *[]Var // whole-map replace, insertion order kept
	Recording    *RecordingPatch
	S3           *S3Patch
	Webrtc       *WebrtcPatch
	Rtmp         *RtmpPatch
	Transcoding  *TranscodingPatch
	Callbacks    *CallbacksPatch
	Mqtt         *MqttPatch
	LatencyAlert *LatencyAlertPatch
	Features     *FeaturesPatch
}

// Var is one variables entry; Value is any JSON value (coerced with JS
// String() on resolve).
type Var struct {
	Key   string
	Value any
}

// RecordingPatch patches AppConfig.recording.
type RecordingPatch struct {
	Enabled                *bool
	Mode                   *string
	Layout                 *string
	LocalDir               *string
	DeleteLocalAfterUpload *bool
	SplitMinutes           *float64
	SnapshotSeconds        *float64
	FilenameTemplate       *string
	SnapshotTemplate       *string
	RetentionDays          *float64
}

// S3Patch patches AppConfig.s3 (AccessKey/SecretKey go to secrets.json).
type S3Patch struct {
	Provider       *string
	Bucket         *string
	Region         *string
	Endpoint       *string
	ForcePathStyle *bool
	Prefix         *string
	PublicURL      *string
	AccessKey      string
	SecretKey      string
}

// WebrtcPatch patches AppConfig.webrtc. Layers nil = untouched; a non-nil
// (even empty) slice replaces the ladder.
type WebrtcPatch struct {
	Adaptive           *bool
	Layers             []WebrtcLayer
	TranscodeMaxHeight *float64
}

// RtmpPatch patches AppConfig.rtmp.
type RtmpPatch struct {
	Enabled     *bool
	Transcode   *bool
	Passthrough *bool
}

// TranscodingPatch patches AppConfig.transcoding (VodRenditions nil = untouched).
type TranscodingPatch struct {
	Enabled       *bool
	Encoding      *string
	VodAdaptive   *bool
	VodRenditions []VodRendition
}

// CallbacksPatch patches AppConfig.callbacks.
type CallbacksPatch struct {
	URL    *string
	Secret *string
}

// MqttPatch patches AppConfig.mqtt (Password "" keeps the stored one).
type MqttPatch struct {
	Enabled     *bool
	URL         *string
	Username    *string
	TopicPrefix *string
	Qos         *int
	TLS         *bool
	Events      []string
	Logs        *MqttLogsPatch
	Password    string
}

// MqttLogsPatch patches mqtt.logs.
type MqttLogsPatch struct {
	Enabled *bool
	Level   *string
}

// LatencyAlertPatch patches AppConfig.latencyAlert.
type LatencyAlertPatch struct {
	Enabled         *bool
	ThresholdMs     *float64
	CooldownSeconds *float64
	IntervalSeconds *float64
}

// FeaturesPatch patches AppConfig.features.
type FeaturesPatch struct {
	RtmpPassword   *bool
	ViewerCounter  *bool
	Chat           *bool
	Reactions      *bool
	HiddenQc       *bool
	AdaptivePlayer *bool
	PublicPlayback *bool
	WsIngest       *WsIngestPatch
	Drm            *DrmFeatures
}

// WsIngestPatch replaces features.ws_ingest (nil fields are omitted on disk).
type WsIngestPatch struct {
	Enabled       *bool
	MaxCameras    *float64
	MaxFps        *float64
	MaxFrameKb    *float64
	MaxDataBytes  *float64
	MaxDataPerSec *float64
}

// S3Service is the multi-provider S3 abstraction (Node S3ServiceContract).
type S3Service interface {
	Upload(ctx context.Context, cfg S3Config, localPath, key, contentType string) (*S3UploadResult, error)
	PresignGet(ctx context.Context, cfg S3Config, key string, expiresInSeconds float64, opts *S3PresignOptions) (string, error)
	Delete(ctx context.Context, cfg S3Config, key string) error
	Exists(ctx context.Context, cfg S3Config, key string) (bool, error)
}
