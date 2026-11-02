package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// Security 3.3.4: STREAMHUB_API_DOCS_PUBLIC=false unmounts the OpenAPI
// document, the docs UI and the schemas (404, like any unmounted route);
// unset keeps them public as before.
func TestAPIDocsFlag(t *testing.T) {
	paths := []string{"/api/v1/openapi.json", "/api/v1/openapi.yaml", "/api/v1/docs"}
	get := func(h http.Handler, p string) int {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
		return w.Code
	}
	cfg := &config.Config{DataDir: t.TempDir(), NodeEnv: "test"}
	t.Setenv("WEB_DIR", t.TempDir())

	t.Setenv("STREAMHUB_API_DOCS_PUBLIC", "")
	open := Handler(Deps{Config: cfg, Log: testutil.Log()})
	for _, p := range paths {
		if c := get(open, p); c != http.StatusOK {
			t.Errorf("default: %s = %d, want 200", p, c)
		}
	}

	t.Setenv("STREAMHUB_API_DOCS_PUBLIC", "false")
	closed := Handler(Deps{Config: cfg, Log: testutil.Log()})
	for _, p := range paths {
		if c := get(closed, p); c != http.StatusNotFound {
			t.Errorf("STREAMHUB_API_DOCS_PUBLIC=false: %s = %d, want 404", p, c)
		}
	}
}
