package main

import (
	"context"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/callbacks"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/cameras"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/fleet"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/iot"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streamhealth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/wsingest"
)

// The devices plane: direct WS MJPEG ingest (camera/viewer WebSockets + the
// /live HTTP mount + ws-keys REST), fleet (MQTT agent telemetry/commands +
// the per-agent battery-low monitor), iot (MQTT-in → iot.data), the cameras
// Studio App (OpenCam fleet console over MQTT) and the stream-health Studio
// App server side.
//
// Provides: "wsingest" (*wsingest.Service), "framehub" (*wsingest.FrameHub),
// "fleet", "iot", "cameras", "streamhealth".
//
// Order 50 sorts BEFORE the plugins plane (same order, file-name order), so
// "plugins.repo" is resolved lazily at call time. Background work (boot
// cleanup, MQTT reconcile loops) only runs from c.starters.
func init() {
	registerPlane(50, "devices", func(ctx context.Context, c *core) error {
		apps := need[contracts.AppsService](c, "apps")
		repo := lazyPluginRepo{c}

		// --- ws-ingest ---------------------------------------------------
		var reg prometheus.Registerer
		if m, ok := maybe[metricsFacade](c, "metrics"); ok && m.Service != nil {
			reg = m.Registry
		}
		hub := wsingest.NewFrameHub()
		ws := wsingest.New(wsingest.Deps{
			Global: c.global, AppDB: c.store.App, DataDir: c.cfg.DataDir, PublicBaseURL: c.cfg.PublicBaseURL,
			LivekitKey: c.cfg.LivekitAPIKey, LivekitSecret: c.cfg.LivekitAPISecret,
			IngressAuth: need[*livekit.IngressAuth](c, "ingressAuth"), Hub: hub, Metrics: wsingest.NewMetrics(reg),
			Apps: apps, Quotas: lazy[wsingest.Quotas](c, "quotas"), Streams: lazy[wsingest.Streams](c, "streams"),
			Callbacks: lazy[wsingest.Callbacks](c, "callbacks"), Log: c.log,
		})
		var guard wsingest.UpgradeGuard
		rules, okR := maybe[*security.Rules](c, "security.rules")
		rep, okP := maybe[*security.Reputation](c, "security.reputation")
		if okR && okP {
			guard = upgradeGuard{security.NewNetworkGuard(security.ResolveSettings(c.cfg.Env), rules, rep)}
		}
		gw := wsingest.NewGateway(ctx, ws, wsingest.NewLiveHTTP(ws), guard, c.log)
		c.middleware = append(c.middleware, gw.Middleware)

		// --- fleet + iot -------------------------------------------------
		fl := fleet.New(fleet.Deps{Apps: apps, Plugins: repo, Logs: lazy[fleet.Logs](c, "logs")})
		// per-agent battery-low alert (fleet `batteryLowPercent`); independent
		// of the MQTT side — it only reads the registry on its own 60 s cadence
		battery := fleet.NewBatteryMonitor(fl, lazy[fleet.Callbacks](c, "callbacks"))
		io := iot.New(iot.Deps{
			DataDir: c.cfg.DataDir, Apps: apps,
			Callbacks: lazy[iot.Callbacks](c, "callbacks"), Logs: lazy[iot.Logs](c, "logs"),
		})

		// --- cameras (OpenCam fleet console) ----------------------------
		cams := cameras.New(cameras.Deps{
			Apps: apps, Plugins: repo, Logs: lazy[cameras.Logs](c, "logs"), Audit: lazy[cameras.Audit](c, "audit"),
		})

		// --- stream-health -----------------------------------------------
		hstore := streamhealth.NewStore(nil)
		health := streamhealth.New(hstore, apps.AppDir, func(ctx context.Context, app string) *y.Map {
			inst, err := repo.Get(ctx, app, streamhealth.PluginID)
			if err != nil || inst == nil {
				return nil
			}
			return inst.Config
		}, c.log, nil)
		if cb, ok := maybe[*callbacks.Service](c, "callbacks"); ok && cb != nil {
			unsubscribe := cb.OnDispatch(health.OnEvent)
			go func() { <-ctx.Done(); unsubscribe(); hstore.CloseAll() }()
		}

		provide(c, "wsingest", ws)
		provide(c, "framehub", hub)
		provide(c, "fleet", fl)
		provide(c, "iot", io)
		provide(c, "cameras", cams)
		provide(c, "streamhealth", health)

		c.modules = append(c.modules, ws, fl, cams, health) // iot has no routes
		c.starters = append(c.starters, ws.Start, fl.Start, battery.Start, io.Start, cams.Start)
		return nil
	})
}

// upgradeGuard adapts security.NetworkGuard to wsingest.UpgradeGuard.
type upgradeGuard struct{ g *security.NetworkGuard }

func (u upgradeGuard) RejectUpgradeReason(ip string) string {
	return string(u.g.RejectUpgradeReason(ip))
}

// lazyPluginRepo resolves "plugins.repo" at call time (the plugins plane
// wires after this one); absent → not installed.
type lazyPluginRepo struct{ c *core }

func (l lazyPluginRepo) Get(ctx context.Context, app, id string) (*plugins.Installed, error) {
	r, ok := maybe[*plugins.Repo](l.c, "plugins.repo")
	if !ok || r == nil {
		return nil, nil
	}
	return r.Get(ctx, app, id)
}

var _ wsingest.Quotas = (*quotas.Service)(nil)
