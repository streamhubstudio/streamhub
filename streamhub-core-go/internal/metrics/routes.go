package metrics

import (
	"context"
	"crypto/subtle"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// Register implements api.Module: the Prometheus scrape endpoint at the ROOT
// path /metrics (excluded from the /api/v1 prefix and from the OpenAPI
// document, as @ApiExcludeController). @Public: the guard is skipped; the
// METRICS_TOKEN check below is the only gate.
func (s *Service) Register(a huma.API) {
	type out struct {
		ContentType string `header:"Content-Type"`
		Body        []byte
	}
	op := api.Public(&huma.Operation{
		OperationID: "MetricsController_scrape", Method: http.MethodGet, Path: "/metrics", Hidden: true,
	})
	// @Header('Cache-Control', …) applies to the 404/403 answers too.
	op.Middlewares = huma.Middlewares{func(ctx huma.Context, next func(huma.Context)) {
		ctx.SetHeader("Cache-Control", "no-cache, no-store, must-revalidate")
		next(ctx)
	}}
	huma.Register(a, *op, func(ctx context.Context, _ *struct{}) (*out, error) {
		if err := s.authorize(api.Request(ctx)); err != nil {
			return nil, err
		}
		body, err := s.Scrape(ctx)
		if err != nil {
			return nil, err
		}
		return &out{ContentType: ContentType, Body: body}, nil
	})
}

// authorize is Fase-0 M8 default-deny: without METRICS_TOKEN the endpoint
// does not exist (404, not 403, so a scanner learns nothing); with it, a
// matching `Bearer <token>` header is required. Security 3.3.4: `?token=` is
// no longer accepted (it leaks into access logs, proxies and browser
// history) and the compare is constant-time.
func (s *Service) authorize(r *http.Request) error {
	token := s.d.Env("METRICS_TOKEN")
	if token == "" {
		return httpx.NotFound("")
	}
	h := r.Header.Get("Authorization")
	bearer := ""
	if strings.HasPrefix(h, "Bearer ") {
		bearer = strings.TrimSpace(h[len("Bearer "):])
	}
	if subtle.ConstantTimeCompare([]byte(bearer), []byte(token)) != 1 {
		return httpx.Forbidden("invalid metrics token")
	}
	return nil
}

// Interceptor is the global MetricsInterceptor as a huma middleware. Install
// it after the auth/permission guards (a Nest interceptor runs after guards,
// so a 401/403 from a guard is never measured).
//
// Node quirk kept on purpose: rxjs finalize() reads res.statusCode BEFORE the
// exception filter writes the error, so a request whose handler throws is
// labelled with the route's success status (200, or 201 for creates) and
// never feeds errors_total. Dashboards were built on that series.
func (s *Service) Interceptor(ctx huma.Context, next func(huma.Context)) {
	op := ctx.Operation()
	route := routeLabel(op)
	start := time.Now()
	s.HTTPStart()
	defer func() {
		status := ctx.Status()
		if status == 0 || status >= 400 {
			status = successStatus(op)
		}
		s.ObserveHTTP(ctx.Method(), route, status, time.Since(start).Seconds())
	}()
	next(ctx)
}

// Install registers the interceptor on the API (apiHooks entry).
func (s *Service) Install(a huma.API) { a.UseMiddleware(s.Interceptor) }

var pathParam = regexp.MustCompile(`\{([^}.]+)(\.\.\.)?\}`)

// routeLabel is the Express route pattern Node labels with:
// /api/v1/apps/{app}/streams/{id} → /api/v1/apps/:app/streams/:id.
func routeLabel(op *huma.Operation) string {
	if op == nil || op.Path == "" {
		return "unmatched"
	}
	return pathParam.ReplaceAllStringFunc(op.Path, func(m string) string {
		sub := pathParam.FindStringSubmatch(m)
		if sub[2] != "" {
			return "*"
		}
		return ":" + sub[1]
	})
}

func successStatus(op *huma.Operation) int {
	if op != nil && op.DefaultStatus != 0 {
		return op.DefaultStatus
	}
	if op != nil && op.Method == http.MethodPost {
		return http.StatusCreated
	}
	return http.StatusOK
}
