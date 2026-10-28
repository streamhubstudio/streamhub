package main

import (
	"context"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/cluster"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/edge"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// The cluster plane: the node registry + node role (cluster) and the edge
// processing plane (WS gateway, scheduler, watchdog, reconcile, notifier).
//
// Boot steps run at wiring time, as Node's onModuleInit: the node-role seed
// from STREAMHUB_NODE_ROLE (the auth plane's MetaNodeRole reads the same
// _streamhub_meta KV) and the origin self-registration. The edge WebSocket
// is a middleware on /api/v1/edge/ws (Node's 'upgrade' listener). Timers
// (scheduler retry, watchdog, reconcile) are starters.
//
// Provides: "cluster" (*cluster.Service), "noderole" (*cluster.NodeRole),
// "edge.gateway", "edge.scheduler", "edge.repo".
// Optional (resolved lazily): "plugins.registry", "plugins.repo",
// "appstore" (spawn specs, edge-capability, pinned bundles), "logs",
// "notifications", "callbacks", "security.reputation", "apps".
func init() {
	registerPlane(50, "cluster", func(ctx context.Context, c *core) error {
		role := cluster.NewNodeRole(c.global, c.cfg.Env, c.log)
		role.Seed(ctx)
		svc := cluster.New(c.cfg, c.global, role, nil, c.log)
		svc.Init(ctx)

		var offense cluster.OffenseSink
		if rep, ok := maybe[*security.Reputation](c, "security.reputation"); ok {
			offense = func(ip string) { rep.RecordOffense(ip, security.OffenseInvalidToken) }
		}

		apps, _ := maybe[contracts.AppsService](c, "apps")
		logs := lazy[edge.Logs](c, "logs")
		catalog := func() edge.Catalog {
			reg, _ := maybe[*plugins.Registry](c, "plugins.registry")
			repo, _ := maybe[*plugins.Repo](c, "plugins.repo")
			store, _ := maybe[*plugins.Appstore](c, "appstore")
			if reg == nil && repo == nil {
				return nil
			}
			return edge.PluginsCatalog{Registry: reg, Repo: repo, Appstore: store}
		}
		var appDirs edge.AppDirs
		if apps != nil {
			appDirs = apps
		}

		repo := edge.NewRepo(c.global)
		resolver := edge.NewGenericResolver(c.cfg, catalog, appDirs)
		framer := &edge.Framer{Resolver: resolver}
		gw := edge.NewGateway(c.global, func() string { return c.cfg.ClusterToken }, svc, repo, framer, c.log)
		notifier := edge.NewDefaultNotifier(c.global, c.cfg.DataDir, c.log)
		alerter := edge.NewAlerter(notifier, logs(), c.log)
		sched := edge.NewScheduler(c.cfg, c.global, gw, repo, framer, alerter, logs(), c.log)
		watchdog := edge.NewWatchdog(c.global, gw, sched, notifier)
		reconciler := edge.NewReconciler(sched, repo, gw, catalog, c.store, c.global, apps, c.log)

		provide(c, "cluster", svc)
		provide(c, "noderole", role)
		provide(c, "edge.gateway", gw)
		provide(c, "edge.scheduler", sched)
		provide(c, "edge.repo", repo)

		c.middleware = append(c.middleware, gw.Middleware)
		c.modules = append(c.modules, cluster.NewRoutes(svc, offense), edge.NewModule(c.global, gw, sched, repo, catalog, apps, logs))
		c.binds = append(c.binds, func() {
			fanout, _ := maybe[edge.FanOut](c, "notifications")
			callbacks, _ := maybe[edge.Callbacks](c, "callbacks")
			notifier.Bind(logs(), fanout, callbacks)
			// edge workers post events/live data with their scoped token
			if ps, ok := maybe[*plugins.Service](c, "plugins"); ok {
				ps.SetEdgeIngest(edge.IngestVerifier{Resolver: resolver, Repo: repo}.Valid)
			}
		})
		c.starters = append(c.starters, func(ctx context.Context) {
			sched.Start(ctx)
			watchdog.Start(ctx)
			reconciler.Start(ctx)
			go func() {
				<-ctx.Done()
				gw.Shutdown()
			}()
		})
		return nil
	})
}
