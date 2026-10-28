package main

import (
	"context"

	appsmod "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/apps"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/callbacks"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logsink"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/metrics"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/metricshistory"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/mqtt"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/netmetrics"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/system"
)

// The observability plane: Prometheus metrics (+ the request interceptor),
// the MQTT publisher + latency monitor, the callbacks funnel, net-metrics
// (+ the /hls byte counter and the threshold monitor) and the resource
// history sampler. Wired at 25 — after apps (20), before every plane that
// dispatches callbacks or records metrics.
//
// Provides: "metrics" (metricsFacade: *metrics.Service + system.GpuMetrics),
// "mqtt" (*mqtt.Service), "callbacks" (*callbacks.Service), "netmetrics"
// (*netmetrics.Service), "metricshistory", "logsink" (*logsink.Switch — the
// writer these modules log through; slog until something Set()s the logs
// service on it).
func init() {
	registerPlane(25, "observability", func(ctx context.Context, c *core) error {
		apps := need[contracts.AppsService](c, "apps")
		logw := logsink.NewSwitch(logsink.Slog{Log: c.log})

		md := metrics.Deps{Global: c.global, AppDB: c.store.App, DataDir: c.cfg.DataDir, Env: c.cfg.Env, Log: c.log}
		if q, ok := maybe[*quotas.Service](c, "quotas"); ok && q != nil {
			md.Quotas = q
		}
		met := metrics.New(md)

		shadow := c.cfg.EnvBool("STREAMHUB_SHADOW", false)
		mq := mqtt.New(apps, logw, nil, c.log)
		mq.Shadow = shadow
		// AppsService drops the app's MQTT client on reload/delete/setMqtt.
		need[*appsmod.Service](c, "apps").BindMqtt(mq)
		cb := callbacks.New(callbacks.Deps{Apps: apps, Logs: logw, Metrics: met, MQTT: mq, Log: c.log, Shadow: shadow})
		listApps := func(ctx context.Context) ([]contracts.AppRecord, error) { return apps.List(ctx, nil) }
		latency := &mqtt.LatencyMonitor{
			ListApps: listApps, Config: apps, AppDB: c.store.App, Callbacks: cb, Logs: logw,
			Probe: mqtt.NewLivekitProbe(c.cfg.LivekitURL, c.cfg.LivekitAPIKey, c.cfg.LivekitAPISecret),
		}

		net := netmetrics.New(c.store.App, c.cfg.MediamtxEnable, c.cfg.MediamtxAPIURL, logw)
		threshold := &netmetrics.ThresholdMonitor{Net: net, ListApps: listApps, AppDir: apps.AppDir, Callbacks: cb, Logs: logw}

		history := metricshistory.New(c.global, c.cfg.DataDir, c.cfg.Env, c.log)
		history.Init(ctx)

		provide(c, "metrics", metricsFacade{met})
		provide(c, "mqtt", mq)
		provide(c, "callbacks", cb)
		provide(c, "netmetrics", net)
		provide(c, "metricshistory", history)
		provide(c, "logsink", logw)

		c.hlsCounter = net
		c.apiHooks = append(c.apiHooks, met.Install) // after the auth/permission guards (plane 10)
		c.modules = append(c.modules, met, history, &netmetrics.Routes{Net: net, AppDir: apps.AppDir})
		c.binds = append(c.binds, func() {
			// The logs service is wired by a later plane: route through it
			// once every plane is in.
			if l, ok := maybe[logsService](c, "logs"); ok {
				logw.Set(logsAdapter{l})
			}
		})
		c.starters = append(c.starters, func(ctx context.Context) {
			latency.Start(ctx)
			net.Start(ctx)
			threshold.Start(ctx)
			history.Start(ctx)
			go func() {
				<-ctx.Done()
				mq.Close()
			}()
		})
		return nil
	})
}

// metricsFacade adapts *metrics.Service to the interfaces other planes
// resolve "metrics" with (system.GpuMetrics takes the GPU status struct).
type metricsFacade struct{ *metrics.Service }

// SetGpuAvailable implements system.GpuMetrics.
func (m metricsFacade) SetGpuAvailable(s system.GpuStatus) { m.SetGPUAvailable(s.Available, s.Type) }

// logsService is LogsService.write as the logs port exposes it.
type logsService interface {
	Write(level, source, message string, meta any, appID *int64)
}

// logsAdapter makes the logs service a logsink.Writer.
type logsAdapter struct{ l logsService }

func (a logsAdapter) Write(level, source, message string, meta map[string]any) {
	if meta == nil {
		a.l.Write(level, source, message, nil, nil)
		return
	}
	a.l.Write(level, source, message, meta, nil)
}
