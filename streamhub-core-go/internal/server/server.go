// Package server wires the HTTP surface: the huma API with every feature
// module, the global guard, the static mounts and the outer middleware stack.
// It is the Go counterpart of app.module.ts + bootstrap() in main.ts.
package server

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/version"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/web"
)

// Deps are the cross-cutting pieces the handler needs.
type Deps struct {
	Config  *config.Config
	Log     *slog.Logger
	Authn   api.Authenticator // nil until the auth module is wired
	Counter web.ByteCounter   // optional (net-metrics)
	HLSGate web.HLSGate       // optional (signed HLS + geo: the playback plane)
	Modules []api.Module
	// APIHooks run right after the auth guard is installed, before any
	// module registers (e.g. the authz PermissionGuard middleware).
	APIHooks []func(huma.API)
	// Middleware wraps the whole mux inside the logging/recovery stack, in
	// order (outermost first): e.g. the auth rate limiter, then the network
	// security middleware, which therefore cover every path.
	Middleware []func(http.Handler) http.Handler
}

// Handler builds the full http.Handler.
func Handler(d Deps) http.Handler {
	mux := http.NewServeMux()
	var apiOpts []func(*huma.Config)
	if !d.Config.EnvBool("STREAMHUB_API_DOCS_PUBLIC", true) {
		apiOpts = append(apiOpts, api.NoDocs)
	}
	a := api.New(mux, version.Get(), apiOpts...)
	api.UseAuth(a, d.Authn, d.Config.IsProduction())
	for _, h := range d.APIHooks {
		h(a)
	}
	for _, m := range d.Modules {
		m.Register(a)
	}
	web.Mount(mux, web.Options{
		DataDir:      d.Config.DataDir,
		SDKDir:       d.Config.Env("SDK_DIR"),
		WebDir:       webDir(d.Config),
		HLSCDN:       d.Config.EnvBool("STREAMHUB_HLS_CDN", false),
		HLSCache:     &web.HLSCachePolicy{SegmentS: d.Config.HLSSegmentS, PlaylistMaxAge: d.Config.HLSPlaylistMaxAge},
		Counter:      d.Counter,
		DashboardCSP: dashboardCSP(d.Config),
		Gate:         d.HLSGate,
	})
	mws := []func(http.Handler) http.Handler{
		httpx.Recover(d.Log),
		httpx.AccessLog(d.Log),
		httpx.SecurityHeaders,
		httpx.ExpressContentType,
	}
	mws = append(mws, d.Middleware...)
	// Innermost: the samples-origin host split (no-op without
	// STREAMHUB_SAMPLES_URL), so the security middleware, rate limiter and
	// access log still cover the samples host and its redirects.
	inner := web.SamplesOrigin(httpx.ExpressRouting(mux), d.Config.SamplesURL, config.Origin(d.Config.PublicBaseURL))
	return httpx.Chain(inner, append(mws, httpx.WithRequest)...)
}

// dashboardCSP: STREAMHUB_DASHBOARD_CSP verbatim, "off" = no CSP and no
// X-Frame-Options, unset = web.DashboardCSP over PUBLIC_WS_URL.
func dashboardCSP(c *config.Config) string {
	v := strings.TrimSpace(c.Env("STREAMHUB_DASHBOARD_CSP"))
	switch {
	case strings.EqualFold(v, "off"):
		return ""
	case v != "":
		return v
	}
	return web.DashboardCSP(c.PublicWsURL)
}

// webDir: $WEB_DIR, else ./web next to the binary, else ./web in the cwd.
func webDir(c *config.Config) string {
	if d := c.Env("WEB_DIR"); d != "" {
		return d
	}
	if exe, err := os.Executable(); err == nil {
		d := filepath.Join(filepath.Dir(exe), "web")
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			return d
		}
	}
	return "web"
}
