// Package api is the glue every feature module uses to expose routes: the
// huma API instance, the Module contract, the @Public() marker and the global
// auth guard (shared/auth/auth.guard.ts).
//
// A module is a package under internal/<name> with a constructor taking its
// dependencies and a Register(huma.API) method. Routes are registered with the
// full /api/v1 prefix, exactly as they appear in streamhub-docs/api/openapi.json.
package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Prefix is the global API prefix (GLOBAL_PREFIX in main.ts).
const Prefix = "/api/v1"

// Module registers its operations on the API.
type Module interface {
	Register(api huma.API)
}

// Authenticator validates a request's credentials (AUTH_VALIDATOR contract).
// It returns an *httpx.Error to control the exact 401/403 body, or any other
// error for the generic 401.
type Authenticator interface {
	Authenticate(r *http.Request) (*auth.Principal, error)
}

const metaPublic = "public"

// Public marks an operation as auth-less (the @Public() decorator).
func Public(op *huma.Operation) *huma.Operation {
	if op.Metadata == nil {
		op.Metadata = map[string]any{}
	}
	op.Metadata[metaPublic] = true
	op.Security = nil
	return op
}

// Bearer marks an operation as requiring the bearer token (OpenAPI only; the
// guard enforces auth on every non-public operation regardless).
func Bearer(op *huma.Operation) *huma.Operation {
	op.Security = []map[string][]string{{"bearer": {}}}
	return op
}

// New creates the huma API on mux with the Nest-compatible conventions:
// OpenAPI at /api/v1/openapi.json, docs at /api/v1/docs, no $schema field or
// Link header injection, and Nest-shaped errors.
func New(mux *http.ServeMux, version string) huma.API {
	httpx.InstallHumaErrors()
	cfg := huma.DefaultConfig("StreamHub core API", version)
	cfg.Info.Description = "Management layer over LiveKit (AntMedia-style). SPEC §6."
	cfg.OpenAPIPath = Prefix + "/openapi"
	cfg.DocsPath = Prefix + "/docs"
	cfg.SchemasPath = Prefix + "/schemas"
	cfg.CreateHooks = nil // no $schema property / describedby Link header
	cfg.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		"bearer": {Type: "http", Scheme: "bearer"},
	}
	cfg.OnAddOperation = append(cfg.OnAddOperation, OptionalRawBody)
	return humago.New(mux, cfg)
}

// OptionalRawBody makes a raw-body operation (RawBody []byte, validated by
// hand) accept a missing body: Nest's ValidationPipe validates an absent
// body as {} and answers with the DTO messages, never huma's "request body
// is required". The RequestBody pointer is shared with the registered
// handler, so this takes effect at request time. Typed Body inputs and
// multipart uploads are left alone.
func OptionalRawBody(_ *huma.OpenAPI, op *huma.Operation) {
	if op.RequestBody == nil || len(op.RequestBody.Content) == 0 {
		return
	}
	for ct, mt := range op.RequestBody.Content {
		if strings.HasPrefix(ct, "multipart/") || mt == nil || mt.Schema == nil ||
			mt.Schema.Type != "string" || mt.Schema.Format != "binary" {
			return
		}
	}
	op.RequestBody.Required = false
}

// UseAuth installs the global guard. Without an authenticator the guard
// fails CLOSED in production and open in dev/test (Fase-0 M6 semantics).
func UseAuth(a huma.API, authn Authenticator, production bool) {
	a.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if pub, _ := ctx.Operation().Metadata[metaPublic].(bool); pub {
			next(ctx)
			return
		}
		if authn == nil {
			if production {
				writeErr(a, ctx, httpx.Unauthorized("auth validator not configured (refusing to serve without auth)"))
				return
			}
			next(ctx)
			return
		}
		r, _ := humago.Unwrap(ctx)
		p, err := authn.Authenticate(r)
		if err != nil {
			var he *httpx.Error
			if errors.As(err, &he) && (he.Status == http.StatusUnauthorized || he.Status == http.StatusForbidden) {
				writeErr(a, ctx, he)
				return
			}
			writeErr(a, ctx, httpx.Unauthorized("Invalid or missing API token"))
			return
		}
		next(huma.WithContext(ctx, auth.WithPrincipal(ctx.Context(), p)))
	})
}

// WriteError writes e's exact body from an API middleware (huma.WriteErr
// would re-wrap it via NewError).
func WriteError(ctx huma.Context, e *httpx.Error) { writeErr(nil, ctx, e) }

// writeErr writes e's exact body (huma.WriteErr would re-wrap it via NewError).
func writeErr(_ huma.API, ctx huma.Context, e *httpx.Error) {
	ctx.SetHeader("Content-Type", "application/json; charset=utf-8")
	ctx.SetStatus(e.Status)
	_ = json.NewEncoder(ctx.BodyWriter()).Encode(e.Body)
}
