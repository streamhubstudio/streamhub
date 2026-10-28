package main

import (
	"context"
	"os"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
)

// The plugins plane: the plugin framework (registry + installs + worker
// manager + live/event channels + grid + export + appstore).
//
// Needs "apps". Optional: "logs" (plugins.LogsService), "callbacks"
// (plugins.Dispatcher), "streams.plugins" (per-stream opt-outs; built here
// when the streams plane is absent), "vision.sink" (plugins.VisionSink),
// "authn" (manual superadmin gate of the appstore routes).
//
// Provides: "plugins" (*plugins.Service), "plugins.registry"
// (*plugins.Registry), "plugins.repo" (*plugins.Repo), "plugins.workers"
// (*plugins.Manager), "appstore" (*plugins.Appstore), "plugins.versions"
// (*plugins.Versions).
func init() {
	registerPlane(50, "plugins", func(ctx context.Context, c *core) error {
		env := os.Getenv
		paths := plugins.ResolvePaths(env)
		reg := plugins.NewRegistry(paths, env, c.log)
		reg.Discover()

		logSvc, _ := maybe[plugins.LogsService](c, "logs")
		var writer plugins.LogWriter
		if logSvc != nil {
			writer = logSvc
		}
		repo := plugins.NewRepo(c.store)
		history := plugins.NewHistory(c.store)
		workers := plugins.NewManager(plugins.ManagerConfig{
			DataDir: c.cfg.DataDir, LivekitURL: c.cfg.LivekitURL, Port: c.cfg.Port,
			PublicBaseURL: c.cfg.PublicBaseURL, Env: env,
		}, writer)
		grid := plugins.NewGrid(c.global, c.cfg.ClusterToken)
		workers.SetGrid(grid)
		store := plugins.NewAppstore(c.cfg.DataDir, reg, writer, paths, env, version.Get)
		workers.SetPinner(plugins.NewPinSeam(store, repo))

		var scope plugins.ScopeResolver
		if sp, ok := maybe[*streams.PluginOverrides](c, "streams.plugins"); ok {
			scope = sp
		} else {
			scope = streams.NewPluginOverrides(c.store)
		}
		deps := plugins.ServiceDeps{
			Registry: reg, Repo: repo, Workers: workers, Apps: need[contracts.AppsService](c, "apps"),
			Logs: logSvc, LiveData: plugins.NewLiveData(), Scope: scope, Log: c.log,
		}
		if cb, ok := maybe[plugins.Dispatcher](c, "callbacks"); ok {
			deps.Callbacks = cb
			workers.SetCallbacks(cb)
		}
		if vs, ok := maybe[plugins.VisionSink](c, "vision.sink"); ok {
			deps.Vision = vs
		}
		svc := plugins.NewService(deps)
		versions := plugins.NewVersions(svc, store, history)
		authn, _ := maybe[api.Authenticator](c, "authn")
		routes := plugins.NewRoutes(svc, versions, store, plugins.NewAgent(workers),
			plugins.NewExporter(svc, paths, env), c.cfg.ClusterToken, authn)

		provide(c, "plugins", svc)
		provide(c, "plugins.registry", reg)
		provide(c, "plugins.repo", repo)
		provide(c, "plugins.workers", workers)
		provide(c, "appstore", store)
		provide(c, "plugins.versions", versions)
		c.modules = append(c.modules, routes)
		// onApplicationBootstrap: materialize built-in bundles, resume workers.
		// Workers are SIGTERMed on shutdown (onModuleDestroy).
		c.starters = append(c.starters, func(ctx context.Context) {
			store.Boot()
			svc.Boot(ctx)
			go func() {
				<-ctx.Done()
				workers.Shutdown()
			}()
		})
		return nil
	})
}
