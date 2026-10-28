package main

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit/compliance"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authn"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

// authPlane is the wired auth plane: tenancy, audit, security, authz,
// quotas and the auth module (validator + controllers).
type authPlane struct {
	authn      *authn.Service
	tenancy    *tenancy.Service
	rules      *security.Rules
	reputation *security.Reputation
	modules    []api.Module
	apiHooks   []func(huma.API)
	middleware []func(http.Handler) http.Handler
	// shared with the modules wired after the auth plane
	quotas *quotas.Service
	audit  *audit.Service
}

func init() {
	registerPlane(10, "auth", func(ctx context.Context, c *core) error {
		p := wireAuthPlane(ctx, c.cfg, c.log, c.store, c.global)
		c.modules = append(c.modules, p.modules...)
		c.apiHooks = append(c.apiHooks, p.apiHooks...)
		c.middleware = append(c.middleware, p.middleware...)
		provide(c, "authn", p.authn)
		provide(c, "tenancy", p.tenancy)
		provide(c, "audit", p.audit)
		provide(c, "quotas", p.quotas)
		provide(c, "security.rules", p.rules)
		provide(c, "security.reputation", p.reputation)
		return nil
	})
}

// wireAuthPlane builds and boots (onModuleInit order) the auth-plane
// modules and starts their timers on ctx.
func wireAuthPlane(ctx context.Context, cfg *config.Config, log *slog.Logger, store *db.Service, global *sql.DB) authPlane {
	ten := tenancy.New(global, cfg.AdminUser, log)
	ten.Init(ctx)

	aud := audit.New(global, cfg.Env, log)
	aud.Init(ctx)
	aud.Start(ctx)

	settings := security.ResolveSettings(cfg.Env)
	rules := security.NewRules(global, log)
	rules.Init(ctx)
	rep := security.NewReputation(global, settings, rules, log)
	rep.Init(ctx)
	rep.Start(ctx)

	limiter := httpx.NewAuthRateLimiter(cfg.Env)
	limiter.SetOffenseReporter(func(ip string) { rep.RecordOffense(ip, security.OffenseRateLimited) })

	quo := quotas.New(global, store.App, log)
	guard := authz.NewGuard(authz.New(global), aud, log).SamplesIsolated(cfg.SamplesIsolated())

	auth := authn.New(authn.Deps{
		Config: cfg, DB: global, Tenancy: ten, Quotas: quo, Audit: aud, Reputation: rep,
		NodeRole: authn.MetaNodeRole{DB: global}, Log: log,
	})
	auth.Init(ctx)

	return authPlane{
		authn: auth, tenancy: ten, rules: rules, reputation: rep,
		modules: []api.Module{
			auth,
			quo,
			audit.NewRoutes(aud),
			compliance.New(cfg, global, aud),
			security.NewRoutes(settings, rules, rep, aud),
		},
		apiHooks:   []func(huma.API){guard.Install},
		middleware: []func(http.Handler) http.Handler{httpx.JSONBodyParser, limiter.Middleware, security.Middleware(settings, rules, rep, log)},
		quotas:     quo,
		audit:      aud,
	}
}
