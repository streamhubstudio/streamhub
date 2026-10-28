package authz

import (
	"fmt"
	"log/slog"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

const metaPermission = "permission"

// Permission is the (resource, action) an operation requires.
type Permission struct{ Resource, Action string }

// Require declares the permission an operation needs (@RequirePermission).
// Operations without it are not permission-checked (they still pass the
// global auth guard).
func Require(op *huma.Operation, resource, action string) *huma.Operation {
	if op.Metadata == nil {
		op.Metadata = map[string]any{}
	}
	op.Metadata[metaPermission] = Permission{resource, action}
	return op
}

// RequiredBy returns the permission an operation declares, if any.
func RequiredBy(op *huma.Operation) (Permission, bool) {
	p, ok := op.Metadata[metaPermission].(Permission)
	return p, ok
}

// sampleWrite is restricted to superadmin (no tenant role or app-scoped
// token holds it, whatever the policies say) while samples are served from
// the dashboard origin: a stored sample would run with the dashboard session
// (GO-DIVERGENCES, samples). Lifted by SamplesIsolated once samples have
// their own origin (STREAMHUB_SAMPLES_URL).
var sampleWrite = Permission{"sample", "write"}

// Guard is the PermissionGuard. It must run after the auth guard.
type Guard struct {
	svc   *Service
	audit *audit.Service // optional
	log   *slog.Logger
	// superadminOnly are permissions only a superadmin (or global token) holds.
	superadminOnly map[Permission]bool
}

// NewGuard builds the guard; audit may be nil.
func NewGuard(s *Service, a *audit.Service, log *slog.Logger) *Guard {
	return &Guard{svc: s, audit: a, log: log, superadminOnly: map[Permission]bool{sampleWrite: true}}
}

// SamplesIsolated lifts the sample:write restriction: samples are served
// from their own origin, so a stored sample can no longer reach the
// dashboard session. sample:write is then plain RBAC again.
func (g *Guard) SamplesIsolated(isolated bool) *Guard {
	if isolated {
		delete(g.superadminOnly, sampleWrite)
	} else {
		g.superadminOnly[sampleWrite] = true
	}
	return g
}

// Install registers the guard as an API middleware (after api.UseAuth).
func (g *Guard) Install(a huma.API) { a.UseMiddleware(g.Middleware) }

// Middleware composes, in order: app-scoped token isolation (M2), the
// superadmin / api_token bypass, the RBAC verdict and the tenant data-scope
// of the `app` (or `name`) path param.
func (g *Guard) Middleware(ctx huma.Context, next func(huma.Context)) {
	required, ok := RequiredBy(ctx.Operation())
	if !ok {
		next(ctx)
		return
	}
	mode := Mode()
	if mode == ModeOff {
		next(ctx)
		return
	}
	p := auth.From(ctx.Context())
	if p == nil { // public route / pre-wiring back-compat
		next(ctx)
		return
	}
	app := ctx.Param("app")
	if app == "" {
		app = ctx.Param("name")
	}

	if g.crossAppViolation(ctx, p, app) {
		g.decide(ctx, next, mode, p, fmt.Sprintf("app '%s' is outside this credential's app scope", app))
		return
	}
	if !p.IsSuperadmin && g.superadminOnly[required] {
		g.decide(ctx, next, mode, p, fmt.Sprintf("%s:%s is restricted to superadmin", required.Resource, required.Action))
		return
	}
	if p.IsSuperadmin || p.Via == auth.ViaAPIToken {
		next(ctx)
		return
	}
	rbacOK := g.svc.CanPrincipal(p, required.Resource, required.Action)
	scopeOK := app == "" || g.svc.AppBelongsToTenant(ctx.Context(), p, app)
	if rbacOK && scopeOK {
		next(ctx)
		return
	}
	reason := fmt.Sprintf("role '%s' lacks %s:%s", p.Role, required.Resource, required.Action)
	if rbacOK {
		reason = fmt.Sprintf("app '%s' is outside tenant '%s'", app, nullStr(p.TenantID))
	}
	g.decide(ctx, next, mode, p, reason)
}

// crossAppViolation: a non-superadmin app-scoped credential acting on another
// app. Fails safe (no block) when either app id can't be resolved.
func (g *Guard) crossAppViolation(ctx huma.Context, p *auth.Principal, app string) bool {
	if p.IsSuperadmin || p.Scope != auth.ScopeApp || app == "" || p.AppID == nil {
		return false
	}
	routeAppID, ok := g.svc.AppIDByName(ctx.Context(), app)
	if !ok {
		return false
	}
	return routeAppID != *p.AppID
}

type denyMeta struct {
	Method   string `json:"method"`
	Path     string `json:"path"`
	Reason   string `json:"reason"`
	Enforced bool   `json:"enforced"`
}

// decide audits the denial, then 403s ('on') or only logs ('log').
func (g *Guard) decide(ctx huma.Context, next func(huma.Context), mode EnforcementMode, p *auth.Principal, reason string) {
	u := ctx.URL()
	path := u.RequestURI()
	g.audit.Record(ctx.Context(), audit.Event{
		Action: "authz.deny",
		IP:     audit.Str(httpx.ClientIP(api.Request(ctx.Context()))),
		Result: audit.Deny,
		Meta:   denyMeta{ctx.Method(), path, reason, mode == ModeOn},
	}.WithActor(p))
	if mode == ModeOn {
		g.log.Warn(fmt.Sprintf("DENY %s %s — %s (user=%s)", ctx.Method(), path, reason, p.UserID))
		api.WriteError(ctx, httpx.Forbidden(reason))
		return
	}
	g.log.Warn(fmt.Sprintf("WOULD-DENY %s %s — %s (user=%s, tenant=%s)", ctx.Method(), path, reason, p.UserID, nullStr(p.TenantID)))
	next(ctx)
}

// nullStr renders a nullable id the way a JS template literal does.
func nullStr(s string) string {
	if s == "" {
		return "null"
	}
	return s
}
