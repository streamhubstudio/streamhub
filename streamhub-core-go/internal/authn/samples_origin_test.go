package authn_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/server"
)

// GET /auth/config tells the SPA where samples live; the field is omitted
// (response unchanged) while samples share the dashboard origin.
func TestAuthConfigSamplesURL(t *testing.T) {
	s := newStack(t)
	if r := s.call("GET", "/auth/config", "", ""); r.code != 200 || strings.Contains(r.raw, "samplesUrl") {
		t.Fatalf("unset: %d %s", r.code, r.raw)
	}
	s.cfg.SamplesURL = "https://samples.example.com"
	s.expect(s.call("GET", "/auth/config", "", ""), 200, `"samplesUrl":"https://samples.example.com"`)
}

// server.Handler installs the host split from the config: a no-op when
// STREAMHUB_SAMPLES_URL is unset, the samples/dashboard split when set.
func TestServerHandlerSamplesOrigin(t *testing.T) {
	get := func(h http.Handler, host, target string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", target, nil)
		r.Host = host
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	dir := t.TempDir()
	base := &config.Config{DataDir: dir, NodeEnv: "test", PublicBaseURL: "https://app.example.com/"}
	plain := server.Handler(server.Deps{Config: base, Log: testutil.Log()})
	if w := get(plain, "app.example.com", "/samples/live/x.html"); w.Code != 404 || w.Header().Get("Location") != "" {
		t.Errorf("unset: /samples must be served in place (404 here), got %d %q", w.Code, w.Header().Get("Location"))
	}

	iso := *base
	iso.SamplesURL = "https://samples.example.com"
	h := server.Handler(server.Deps{Config: &iso, Log: testutil.Log()})
	if w := get(h, "app.example.com", "/samples/live/x.html?room=a"); w.Code != 302 ||
		w.Header().Get("Location") != "https://samples.example.com/samples/live/x.html?room=a" {
		t.Errorf("dashboard /samples: %d %q", w.Code, w.Header().Get("Location"))
	}
	if w := get(h, "samples.example.com", "/apps/live"); w.Code != 302 || w.Header().Get("Location") != "https://app.example.com/apps/live" {
		t.Errorf("samples SPA: %d %q", w.Code, w.Header().Get("Location"))
	}
	if w := get(h, "samples.example.com", "/samples/live/x.html"); w.Code != 404 || w.Header().Get("Location") != "" {
		t.Errorf("samples host /samples must be served in place, got %d", w.Code)
	}
	// Outer middleware still covers the samples host and its redirects.
	if w := get(h, "samples.example.com", "/"); w.Header().Get("Strict-Transport-Security") == "" {
		t.Error("security headers missing on the samples host")
	}
}
