package livekit

import (
	"context"
	"log/slog"

	"github.com/livekit/protocol/livekit"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// Narrow views of the modules this package calls. Node resolves most of them
// lazily through ModuleRef ({strict:false}) and treats an absent provider as
// "skip"; here each optional one is a getter returning nil when the module is
// not wired (yet), so later planes are picked up at call time.

// Quotas is the quotas surface the token/ingress routes enforce.
type Quotas interface {
	EnforceConcurrentStreams(ctx context.Context, p *auth.Principal) error
	EnforceAppConcurrentStreams(ctx context.Context, app string, limit float64, p *auth.Principal) error
}

// Auditor appends to the structured audit trail (never fails the caller).
type Auditor interface {
	Record(ctx context.Context, e audit.Event)
}

// Logs is LogsServiceContract.write (logs.Service.Write; appID nil).
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Callbacks is CallbacksServiceContract.dispatch (signed app webhooks).
// payload is a JSON-marshalable value whose field order matches Node's.
type Callbacks interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// Streams is the StreamsServiceContract slice the webhooks/data routes use.
type Streams interface {
	// Upsert creates/updates the canonical stream row; participant "" = null.
	Upsert(ctx context.Context, app, streamID, streamType, room, participant string) error
	End(ctx context.Context, app, streamID string) error
	// StreamRoom is streams.get(app, id)?.room ("" when absent / no room).
	StreamRoom(ctx context.Context, app, streamID string) (string, error)
}

// Recording is the RecordingServiceContract slice the webhooks use.
type Recording interface {
	OnEgressEvent(ctx context.Context, egressID, status string, event *livekit.WebhookEvent) error
	// Start begins a recording of room (auto-record); returns vodId/egressId.
	Start(ctx context.Context, app, room string) (vodID int64, egressID string, err error)
}

// Restream advances per-endpoint restream state on egress events (app "" =
// no app resolved, Node's null).
type Restream interface {
	OnEgressEvent(ctx context.Context, app, egressID, status string) error
}

// NetMetrics is the net-metrics tap (Wave 1C).
type NetMetrics interface {
	RecordBytes(app, direction, source string, bytes int64)
}

// HwAccel resolves the opt-in GPU encoding options (HwAccelService). A nil
// result means CPU/default; errors degrade to CPU (logged).
type HwAccel interface {
	EgressEncoding(ctx context.Context, app string) (*livekit.EncodingOptions, error)
	IngressVideo(ctx context.Context, app string) (*livekit.IngressVideoOptions, error)
}

// PassthroughInfo is PassthroughIngressInfo (shared/contracts).
type PassthroughInfo struct {
	Mode          string `json:"mode"`
	IngressID     string `json:"ingressId"`
	App           string `json:"app"`
	Room          string `json:"room"`
	StreamKey     string `json:"streamKey"`
	InputType     string `json:"inputType,omitempty"`
	RtmpURL       string `json:"rtmpUrl"`
	SrtURL        string `json:"srtUrl,omitempty"`
	SourceURL     string `json:"sourceUrl,omitempty"`
	HlsURL        string `json:"hlsUrl"`
	PlayerURL     string `json:"playerUrl,omitempty"`
	Status        string `json:"status,omitempty"`
	PlaylistFresh *bool  `json:"playlistFresh,omitempty"`
	Capabilities  any    `json:"capabilities"`
}

// MpegtsSource is the raw MPEG-TS pull input of a passthrough create.
type MpegtsSource struct {
	URL             string
	Sources         *string
	Localaddr       *string
	FifoSize        *int64
	OverrunNonfatal *bool
}

// Passthrough is the RTMP/SRT/MPEG-TS → HLS remux plane (PassthroughService).
type Passthrough interface {
	// ParseMpegtsSource validates + canonicalizes a udp:// source; a
	// validation failure returns its message (the route answers 400).
	ParseMpegtsSource(in MpegtsSource) (sourceURL string, validationErr error)
	// Create arms the remux; transport rtmp|srt|mpegts.
	Create(ctx context.Context, app, room, transport, sourceURL string) (*PassthroughInfo, error)
	List(ctx context.Context, app string) ([]PassthroughInfo, error)
	Remove(ctx context.Context, app, id string) bool
}

// Optional are the lazily resolved collaborators (nil getters allowed).
type Optional struct {
	Logs        func() Logs
	Callbacks   func() Callbacks
	Streams     func() Streams
	Recording   func() Recording
	Restream    func() Restream
	NetMetrics  func() NetMetrics
	Passthrough func() Passthrough
	HwAccel     func() HwAccel
}

func get[T any](f func() T) T {
	var zero T
	if f == nil {
		return zero
	}
	return f()
}

// Deps wires the module.
type Deps struct {
	Config *config.Config
	Store  *db.Service
	Apps   contracts.AppsService
	Quotas Quotas
	Audit  Auditor
	Log    *slog.Logger
	// Clients nil → NewClients(cfg).
	Clients *Clients
	// Resolve nil → system DNS (pull-URL SSRF guard).
	Resolve  security.HostResolver
	Optional Optional
}
