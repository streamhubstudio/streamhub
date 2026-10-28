package recording

import (
	"context"
	"log/slog"
	"sort"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
)

// Narrow views of the collaborators (Node injects them; optional ones are
// getters that may return nil and are resolved at call time).

// LiveKit is the slice of the livekit service the recording flow drives.
type LiveKit interface {
	StartEgress(ctx context.Context, in livekit.StartEgressInput) (livekit.EgressInfo, error)
	StartTrackCompositeEgress(ctx context.Context, in livekit.TrackCompositeInput) (livekit.EgressInfo, error)
	StopEgress(ctx context.Context, egressID string) (livekit.EgressInfo, error)
}

// Logs is LogsServiceContract.write (logs.Service.Write; appID nil).
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Callbacks is CallbacksServiceContract.dispatch; payload field order is
// the Node object's (the signature covers the exact bytes).
type Callbacks interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// Metrics is the recording slice of MetricsService (optional).
type Metrics interface {
	RecordingStarted(app string)
	VodGenerated(app string)
	RecordingFailed(app, reason string)
}

// Transcription is the transcription plugin hook (optional, fire-and-forget).
type Transcription interface {
	OnVodReady(app string, vodID int64)
}

// StreamRef is the part of a streams row the record-live routes need.
type StreamRef struct {
	Room        string // "" = null
	Participant string // "" = null
}

// Streams resolves stream rows and per-app live stats.
type Streams interface {
	// Lookup returns nil when the stream does not exist.
	Lookup(ctx context.Context, app, streamID string) (*StreamRef, error)
	// LiveStats is StreamsService.liveStats (any JSON-marshalable value).
	LiveStats(ctx context.Context, app string) (any, error)
}

// Quotas is the recording-minutes quota gate.
type Quotas interface {
	EnforceRecordingMinutes(ctx context.Context, p *auth.Principal) error
}

// Secrets resolves a data/secrets.json reference (DRM key-server token).
type Secrets interface {
	Get(ref string) (string, bool)
}

// Optional are the lazily resolved collaborators.
type Optional struct {
	Metrics       func() Metrics
	Transcription func() Transcription
}

func get[T any](f func() T) T {
	var zero T
	if f == nil {
		return zero
	}
	return f()
}

// Deps wires the recording module.
type Deps struct {
	Config    *config.Config
	Store     *db.Service
	Apps      contracts.AppsService
	S3        contracts.S3Service
	LiveKit   LiveKit
	Logs      Logs
	Callbacks Callbacks
	Streams   Streams
	Quotas    Quotas
	Secrets   Secrets
	Runner    Runner // nil → ExecRunner
	Log       *slog.Logger
	Optional  Optional
}

// write logs through the logs module (meta any, appId null).
func write(l Logs, level, msg string, meta any) {
	if l != nil {
		l.Write(level, "recording", msg, meta, nil)
	}
}

// sortedApps lists every app name (internal caller → all apps).
func sortedApps(ctx context.Context, apps contracts.AppsService) ([]string, error) {
	list, err := apps.List(ctx, nil)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(list))
	for _, a := range list {
		names = append(names, a.Name)
	}
	sort.Strings(names)
	return names, nil
}
