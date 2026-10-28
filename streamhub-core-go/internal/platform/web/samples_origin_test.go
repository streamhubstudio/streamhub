package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newSite mounts the real static surfaces plus a stub API route over a temp
// DATA_DIR/WEB_DIR holding one sample, one SDK file and the SPA index.
func newSite(t *testing.T) http.Handler {
	t.Helper()
	data, webDir := t.TempDir(), t.TempDir()
	write := func(p, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(data, "apps", "live", "samples", "conference.html"), "<!doctype html>sample")
	write(filepath.Join(data, "sdk", "streamhub-adaptor.global.js"), "sdk")
	write(filepath.Join(data, "apps", "live", "hls", "room", "index.m3u8"), "#EXTM3U")
	write(filepath.Join(webDir, "index.html"), "<!doctype html>spa")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/apps/{app}/play-token/{room}", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"token":"t"}}`))
	})
	Mount(mux, Options{DataDir: data, WebDir: webDir})
	return mux
}

func serve(h http.Handler, method, host, target string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	r.Host = host
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestSamplesOriginUnsetIsPassThrough(t *testing.T) {
	site := newSite(t)
	h := SamplesOrigin(site, "", "https://app.example.com")
	for _, target := range []string{"/samples/live/conference.html", "/", "/apps/live"} {
		w := serve(h, "GET", "app.example.com", target)
		if w.Code != 200 {
			t.Errorf("%s: %d", target, w.Code)
		}
	}
	w := serve(h, "GET", "app.example.com", "/samples/live/conference.html")
	if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "allow-same-origin") {
		t.Errorf("CSP changed: %q", csp)
	}
}

func TestSamplesOriginHostSplit(t *testing.T) {
	h := SamplesOrigin(newSite(t), "https://samples.example.com", "https://app.example.com")
	const dash, smp = "app.example.com", "samples.example.com"
	cases := []struct {
		method, host, target string
		code                 int
		location, body       string
	}{
		// samples host: the sample, its same-origin API/SDK/HLS calls.
		{"GET", smp, "/samples/live/conference.html", 200, "", "sample"},
		{"GET", "SAMPLES.example.com:443", "/samples/live/conference.html", 200, "", "sample"},
		{"GET", smp, "/api/v1/apps/live/play-token/room", 200, "", `"token"`},
		{"GET", smp, "/sdk/streamhub-adaptor.global.js", 200, "", "sdk"},
		{"GET", smp, "/hls/live/room/index.m3u8", 200, "", "#EXTM3U"},
		// samples host: never the SPA — redirected to the dashboard.
		{"GET", smp, "/", 302, "https://app.example.com/", ""},
		{"GET", smp, "/login?next=%2Fapps", 302, "https://app.example.com/login?next=%2Fapps", ""},
		{"GET", smp, "/assets/index.js", 302, "https://app.example.com/assets/index.js", ""},
		{"GET", smp, "/metrics", 302, "https://app.example.com/metrics", ""},
		// dashboard host: samples redirected to the samples origin (path+query kept).
		{"GET", dash, "/samples/live/conference.html?room=r1&token=x", 302,
			"https://samples.example.com/samples/live/conference.html?room=r1&token=x", ""},
		{"HEAD", dash, "/samples/live/conference.html", 302, "https://samples.example.com/samples/live/conference.html", ""},
		{"GET", "127.0.0.1:3020", "/samples/live/conference.html", 302, "https://samples.example.com/samples/live/conference.html", ""},
		// dashboard host: everything else untouched.
		{"GET", dash, "/", 200, "", "spa"},
		{"GET", dash, "/apps/live", 200, "", "spa"},
		{"GET", dash, "/api/v1/apps/live/play-token/room", 200, "", `"token"`},
		{"GET", dash, "/sdk/streamhub-adaptor.global.js", 200, "", "sdk"},
	}
	for _, c := range cases {
		w := serve(h, c.method, c.host, c.target)
		if w.Code != c.code {
			t.Errorf("%s %s%s: %d, want %d", c.method, c.host, c.target, w.Code, c.code)
			continue
		}
		if loc := w.Header().Get("Location"); loc != c.location {
			t.Errorf("%s %s%s: Location %q, want %q", c.method, c.host, c.target, loc, c.location)
		}
		if c.body != "" && !strings.Contains(w.Body.String(), c.body) {
			t.Errorf("%s %s%s: body %q", c.method, c.host, c.target, w.Body)
		}
	}
	// On the samples origin the page keeps its same-origin sandbox (that
	// origin is now the samples one): getUserMedia needs a real origin.
	w := serve(h, "GET", smp, "/samples/live/conference.html")
	if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox allow-scripts allow-same-origin") {
		t.Errorf("CSP: %q", csp)
	}
}

func TestSamplesOriginPortAndMissingDashboard(t *testing.T) {
	// An explicit port must match: two origins may differ only by port.
	h := SamplesOrigin(newSite(t), "https://shared.localtest:8444", "")
	if w := serve(h, "GET", "shared.localtest:8444", "/samples/live/conference.html"); w.Code != 200 {
		t.Errorf("samples port: %d", w.Code)
	}
	if w := serve(h, "GET", "shared.localtest:8443", "/samples/live/conference.html"); w.Code != 302 {
		t.Errorf("dashboard port must redirect: %d", w.Code)
	}
	// No dashboard URL known: the samples host 404s the SPA instead of serving it.
	w := serve(h, "GET", "shared.localtest:8444", "/")
	if w.Code != 404 || strings.Contains(w.Body.String(), "spa") {
		t.Errorf("SPA on samples host without dashboard URL: %d %q", w.Code, w.Body)
	}
}
