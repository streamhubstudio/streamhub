package main

import (
	"context"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/apps"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/samples"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tags"
)

// The streams plane: streams (+ per-stream plugin opt-out, live HLS egress,
// HLS watchdog/DVR janitor), tags and samples/examples.
//
// Provides: "streams" (*streams.Service — Upsert/End/StreamRoom/LiveStats for
// the livekit webhooks and the stats route), "streams.plugins"
// (*streams.PluginOverrides — overlay resolution for the plugins module),
// "streams.hls" (*streams.Hls), "tags" (*tags.Repository), "samples"
// (*samples.Service).
//
// Optional, resolved lazily at call time (later planes): "livekit.hls"
// (streams.Egress), "callbacks" (streams.Callbacks), "logs" (streams.Logs),
// "metrics" (streams.Metrics).
func init() {
	registerPlane(30, "streams", func(ctx context.Context, c *core) error {
		appsSvc := need[contracts.AppsService](c, "apps")
		s3svc, _ := maybe[contracts.S3Service](c, "s3")

		// Like StreamsService's constructor: own SDK clients only when the
		// LiveKit URL + key + secret are all configured.
		var rooms streams.Rooms
		if c.cfg.LivekitURL != "" && c.cfg.LivekitAPIKey != "" && c.cfg.LivekitAPISecret != "" {
			rooms = streams.NewLKRooms(c.cfg.LivekitURL, c.cfg.LivekitAPIKey, c.cfg.LivekitAPISecret)
		}
		opt := streams.Optional{
			Rooms:     func() streams.Rooms { return rooms },
			Egress:    lazy[streams.Egress](c, "livekit.hls"),
			Callbacks: lazy[streams.Callbacks](c, "callbacks"),
			Logs:      lazy[streams.Logs](c, "logs"),
			Metrics:   lazy[streams.Metrics](c, "metrics"),
		}
		streamsSvc := streams.New(streams.Deps{
			Config: c.cfg, Store: c.store, Global: c.global, Apps: appsSvc, S3: s3svc, Opt: opt, Log: c.log,
		})
		plugins := streams.NewPluginOverrides(c.store)
		hls := streams.NewHls(streamsSvc)
		watchdog := streams.NewWatchdog(streamsSvc, hls)
		tagRepo := tags.New(c.store, c.global)

		smp := samples.New(samples.Deps{
			Apps: appsSvc, PublicBaseURL: c.cfg.PublicBaseURL,
			PublicWsURL: c.cfg.PublicWsURL, SamplesURL: c.cfg.SamplesURL, Env: c.cfg.Env, Log: c.log,
		})
		need[*apps.Service](c, "apps").BindSamples(smp) // AppsService.create → samples.generate

		provide(c, "streams", streamsSvc)
		provide(c, "streams.plugins", plugins)
		provide(c, "streams.hls", hls)
		provide(c, "tags", tagRepo)
		provide(c, "samples", smp)

		c.modules = append(c.modules, &streams.Module{Streams: streamsSvc, Plugins: plugins, Hls: hls}, tagRepo, smp)
		c.starters = append(c.starters, smp.Backfill, watchdog.Start)
		return nil
	})
}

// lazy resolves an optional service at call time (nil interface when absent
// or of another type), so planes wired after this one are picked up.
func lazy[T any](c *core, name string) func() T {
	return func() T {
		v, _ := maybe[T](c, name)
		return v
	}
}
