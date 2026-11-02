package system

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// Security 3.3.4: a GPU re-probe spawns host binaries, so POST
// /system/gpu/refresh needs a global credential and GET ?refresh=true from
// anyone else serves the cached status.
func TestGpuRefreshNeedsGlobal(t *testing.T) {
	g, runner := gpuWith(t, nil, noDri)
	var current *auth.Principal
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	a.UseMiddleware(func(hc huma.Context, next func(huma.Context)) {
		next(huma.WithContext(hc, auth.WithPrincipal(hc.Context(), current)))
	})
	(&Module{Gpu: g}).Register(a)
	h := httpx.WithRequest(mux)
	call := func(p *auth.Principal, method, path string) int {
		t.Helper()
		current = p
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
		return w.Code
	}
	tenant := &auth.Principal{UserID: "u", TenantID: "tnt_a", Role: auth.RoleOwner, Scope: auth.ScopeUser, Via: auth.ViaUserJWT}
	global := &auth.Principal{IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAPIToken}

	if c := call(tenant, http.MethodGet, "/api/v1/system/gpu"); c != http.StatusOK {
		t.Fatal(c)
	}
	probes := runner.calls.Load()
	if c := call(tenant, http.MethodPost, "/api/v1/system/gpu/refresh"); c != http.StatusForbidden {
		t.Fatalf("tenant refresh = %d, want 403", c)
	}
	if c := call(tenant, http.MethodGet, "/api/v1/system/gpu?refresh=true"); c != http.StatusOK {
		t.Fatal(c)
	}
	if runner.calls.Load() != probes {
		t.Fatal("a non-global caller re-probed the GPU")
	}
	if c := call(global, http.MethodPost, "/api/v1/system/gpu/refresh"); c != http.StatusCreated {
		t.Fatalf("global refresh = %d", c)
	}
	if runner.calls.Load() == probes {
		t.Fatal("global refresh did not re-probe")
	}
}
