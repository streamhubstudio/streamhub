package main

import (
	"context"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/broadcast"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/netmetrics"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/notifications"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/passthrough"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/pipeline"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/restream"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/scheduledlive"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/system"
)

// The media plane: restream (multi-destination RTMP forwarding), passthrough
// (RTMP/SRT/MPEG-TS → HLS remux + the MediaMTX single-port hooks), broadcast,
// pipeline and scheduled-live.
func init() {
	registerPlane(45, "media", func(ctx context.Context, c *core) error {
		appsSvc := need[contracts.AppsService](c, "apps")
		lk := need[*livekit.Service](c, "livekit")
		keys := need[*livekit.IngressAuth](c, "ingressAuth")
		streamsSvc := need[*streams.Service](c, "streams")

		// Restream: one stream egress per destination; the livekit webhook
		// sink resolves "restream" lazily to advance per-endpoint state.
		rs := restream.NewService(restream.Deps{
			Repo:      restream.NewRepository(c.store),
			LiveKit:   func() restream.LiveKit { return lk },
			Streams:   streamsSvc,
			Logs:      lazy[restream.Logs](c, "logs"),
			Callbacks: lazy[restream.Callbacks](c, "callbacks"),
			Log:       c.log,
		})
		provide(c, "restream", rs)

		// Passthrough: the remux plane (ffmpeg -c copy), its key gate, the
		// MediaMTX hook sink and the boot re-arm front.
		remux := passthrough.NewRemuxManager(c.cfg.Env("STREAMHUB_FFMPEG_BIN"), nil, lazy[passthrough.Logs](c, "logs"), c.log)
		pt := passthrough.NewService(c.cfg, keys, remux, func() passthrough.Streams { return streamsSvc }, c.log)
		front := passthrough.NewFront(pt, keys, func(ctx context.Context) ([]string, error) {
			list, err := appsSvc.List(ctx, nil)
			if err != nil {
				return nil, err
			}
			names := make([]string, 0, len(list))
			for _, a := range list {
				names = append(names, a.Name)
			}
			return names, nil
		}, c.log)
		provide(c, "passthrough", pt)

		c.modules = append(c.modules, restream.NewModule(rs, need[*quotas.Service](c, "quotas")), &passthrough.Module{Svc: pt})
		// Background work (retry-timer teardown, streams-table sync, boot
		// re-arm of remuxes/MediaMTX paths) only via starters: STREAMHUB_SHADOW
		// must not spawn ffmpeg beside the live Node core.
		c.starters = append(c.starters, rs.Start, pt.Start, front.Start)

		wireMediaApps(c)
		return nil
	})
}

// The livekit plane's lazy views must keep matching these providers.
var (
	_ livekit.Restream     = (*restream.Service)(nil)
	_ livekit.Passthrough  = (*passthrough.Service)(nil)
	_ pipeline.Passthrough = (*passthrough.Service)(nil)
)

// wireMediaApps wires broadcast, pipeline and scheduled-live.
func wireMediaApps(c *core) {
	appsSvc := need[contracts.AppsService](c, "apps")
	lk := need[*livekit.Service](c, "livekit")
	logsLazy := lazy[broadcast.Logs](c, "logs")

	bc := broadcast.New(lk, appsSvc, need[*quotas.Service](c, "quotas"), logsLazy, c.log)

	sl := scheduledlive.NewService(scheduledlive.NewRepository(c.store),
		func() scheduledlive.LiveKit { return lk },
		func() contracts.AppsService { return appsSvc }, c.log)

	pl := pipeline.New(pipeline.Deps{
		Config: c.cfg, Store: c.store, Apps: appsSvc, Log: c.log,
		HwAccel:     need[*system.HwAccel](c, "hwaccel"),
		Notifier:    need[*notifications.Service](c, "notifications"),
		NetMetrics:  need[*netmetrics.Service](c, "netmetrics"),
		Passthrough: lazy[pipeline.Passthrough](c, "passthrough"),
		// plugins (plane 50) and vision (not ported yet) wire after media.
		Plugins:  lazy[pipeline.PluginsRepo](c, "plugins.repo"),
		Registry: lazy[pipeline.PluginsRegistry](c, "plugins.registry"),
		Vision:   lazy[pipeline.Vision](c, "vision"),
	})

	c.modules = append(c.modules, bc, scheduledlive.NewModule(sl, appsSvc), &pipeline.Module{Svc: pl})
}
