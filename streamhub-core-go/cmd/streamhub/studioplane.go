package main

import (
	"context"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livecontrol"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/pipeline"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/recording"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/s3"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/transcription"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/visionapps"
)

// The studio plane: the module-backed halves of three Studio Apps.
//
//   - vision-apps: the occupancy/counting/crowd/demography read + settings
//     routes, the per-model event sink (bound into the plugin framework) and
//     the pipeline dashboard's vision block. The one-shot vision → 4 apps
//     split migration runs HERE, in the wire func (not a starter): it only
//     rewrites our own DATA_DIR rows (plugin installs, per-app sqlite,
//     edge_assignments), is idempotent and a no-op on post-2.16 data, so it
//     also runs under STREAMHUB_SHADOW like any other Init schema work.
//     Worker resume of the freshly-installed apps stays with the plugins
//     plane's Boot starter, which runs after every wire func.
//   - live-control: pause/resume/finish + cover assets (overlay pushes go out
//     over LiveKit data).
//   - transcription: per-VOD transcripts; the pipeline runs in a goroutine
//     per job, started only by a request or the recording hook.
//
// Provides: "vision.sink" (plugins.VisionSink), "vision" (pipeline.Vision),
// "visionapps", "livecontrol", "transcription" (recording.Transcription).
func init() {
	registerPlane(55, "studio", func(ctx context.Context, c *core) error {
		apps := need[contracts.AppsService](c, "apps")
		reg := need[*plugins.Registry](c, "plugins.registry")
		repo := need[*plugins.Repo](c, "plugins.repo")
		var logw plugins.LogWriter
		if l, ok := maybe[*logs.Service](c, "logs"); ok {
			logw = l
		}

		// vision-apps
		store := visionapps.NewStore()
		var appLog visionapps.AppLog
		if al, ok := maybe[*logs.AppLog](c, "applog"); ok {
			appLog = al
		}
		sink := visionapps.NewSink(store, appLog, apps)
		vision := visionapps.New(visionapps.Deps{
			Store: store, Registry: reg, Installs: repo, DB: c.store, Global: c.global, Apps: apps,
			Tags:        lazy[visionapps.Tags](c, "tags"),
			Assignments: lazy[visionapps.Assignments](c, "edge.repo"),
			Gateway:     lazy[visionapps.Gateway](c, "edge.gateway"),
		})
		visionapps.NewMigration(store, repo, reg, apps, c.global, logw, c.log).Migrate(ctx)
		if p, ok := maybe[*plugins.Service](c, "plugins"); ok {
			p.SetVision(sink)
		}

		// live-control
		lc := livecontrol.New(livecontrol.Deps{
			Apps: apps, Installs: repo, Store: livecontrol.NewStore(), Logs: logw,
			S3:        need[*s3.Service](c, "s3"),
			Streams:   lazy[livecontrol.Streams](c, "streams"),
			LiveKit:   lazy[livecontrol.LiveKit](c, "livekit"),
			Callbacks: lazy[plugins.Dispatcher](c, "callbacks"),
		})

		// transcription
		var vods transcription.Vods
		if rec, ok := maybe[*recording.Service](c, "recording"); ok {
			vods = rec.Vods()
		} else {
			vods = recording.NewVods(c.store.App)
		}
		tr := transcription.New(transcription.Deps{
			Repo: transcription.NewRepo(c.store), Vods: vods, Installs: repo, Registry: reg,
			Apps: apps, S3: need[contracts.S3Service](c, "s3"), Logs: logw, Log: c.log,
		})

		provide[plugins.VisionSink](c, "vision.sink", sink)
		provide[pipeline.Vision](c, "vision", vision)
		provide(c, "visionapps", vision)
		provide(c, "livecontrol", lc)
		provide[recording.Transcription](c, "transcription", tr)
		// Node module order: LiveControlModule, then (Edge →) VisionAppsModule;
		// TranscriptionModule rides in with RecordingModule.
		c.modules = append(c.modules, lc, vision, tr)
		return nil
	})
}
