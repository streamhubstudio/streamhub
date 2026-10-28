package main

import (
	"context"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/callbacks"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/dbadmin"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/recording"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/s3"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/system"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/transcoding"
)

// The recording plane: recording (egress start/stop, split/snapshot
// sessions, egress-webhook → upload flow, VOD listing/detail/download/
// probe/delete, per-app stats), the VOD post-transcode pipeline (HLS ladder,
// WebM alternate, DRM packaging), the VOD retention janitor and the
// transcoding config routes.
//
// Provides: "recording" (*recording.Service — the livekit.Recording the
// webhook sink drives and the dbadmin.VodDeleter the ops plane resolves).
// Background work (upload/transcode workers, boot recovery of interrupted
// uploads/transcodes, retention timer) only runs from
// c.starters, so STREAMHUB_SHADOW skips it.
func init() {
	registerPlane(45, "recording", func(ctx context.Context, c *core) error {
		apps := need[contracts.AppsService](c, "apps")
		lgs, _ := maybe[*logs.Service](c, "logs")
		var logw recording.Logs
		if lgs != nil {
			logw = lgs
		}
		cb, _ := maybe[*callbacks.Service](c, "callbacks")
		var cbw recording.Callbacks
		if cb != nil {
			cbw = cb
		}
		strm, _ := maybe[*streams.Service](c, "streams")
		svc := recording.NewService(recording.Deps{
			Config: c.cfg, Store: c.store, Apps: apps,
			S3:      need[contracts.S3Service](c, "s3"),
			LiveKit: need[*livekit.Service](c, "livekit"),
			Logs:    logw, Callbacks: cbw,
			Secrets: need[*s3.SecretsStore](c, "s3.secrets"),
			Log:     c.log,
			Optional: recording.Optional{
				Metrics:       lazy[recording.Metrics](c, "metrics"),
				Transcription: lazy[recording.Transcription](c, "transcription"),
			},
		})
		retention := recording.NewRetention(svc)
		mod := recording.NewModule(svc, streamsAdapter{strm}, need[*quotas.Service](c, "quotas"))

		hw, _ := maybe[*system.HwAccel](c, "hwaccel")
		var hww transcoding.HwAccel
		if hw != nil {
			hww = hw
		}
		var tlogs transcoding.Logs
		if lgs != nil {
			tlogs = lgs
		}

		provide(c, "recording", svc)
		c.modules = append(c.modules, mod, transcoding.New(apps, tlogs, hww))
		c.starters = append(c.starters, svc.Run, svc.RecoverStarter, retention.Start)
		return nil
	})
}

// streamsAdapter is the recording module's view of the streams service.
type streamsAdapter struct{ s *streams.Service }

func (a streamsAdapter) Lookup(ctx context.Context, app, id string) (*recording.StreamRef, error) {
	if a.s == nil {
		return nil, nil
	}
	rec, err := a.s.Get(ctx, app, id)
	if err != nil || rec == nil {
		return nil, err
	}
	ref := &recording.StreamRef{Room: rec.Room}
	if rec.Participant != nil {
		ref.Participant = *rec.Participant
	}
	return ref, nil
}

func (a streamsAdapter) LiveStats(ctx context.Context, app string) (any, error) {
	if a.s == nil {
		return nil, nil
	}
	return a.s.LiveStats(ctx, app)
}

var (
	_ livekit.Recording   = (*recording.Service)(nil)
	_ dbadmin.VodDeleter  = (*recording.Service)(nil)
	_ recording.Metrics   = metricsFacade{}
	_ recording.LiveKit   = (*livekit.Service)(nil)
	_ transcoding.HwAccel = (*system.HwAccel)(nil)
)
