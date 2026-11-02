package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Security 3.3.4: the dashboard SPA can't be framed (CSP frame-ancestors
// 'none' + X-Frame-Options: DENY, script-src 'self', LiveKit in
// connect-src), while every embeddable surface keeps working in an iframe.
func TestDashboardCSP(t *testing.T) {
	data, webDir := t.TempDir(), t.TempDir()
	for p, body := range map[string]string{
		filepath.Join(webDir, "index.html"):                              "<!doctype html>spa",
		filepath.Join(webDir, "assets", "app.js"):                        "js",
		filepath.Join(data, "apps", "live", "samples", "embed.html"):     "<!doctype html>sample",
		filepath.Join(data, "apps", "live", "hls", "room", "index.m3u8"): "#EXTM3U",
		filepath.Join(data, "sdk", "streamhub-adaptor.global.js"):        "sdk",
	} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	csp := DashboardCSP("wss://media.example.com")
	mux := http.NewServeMux()
	Mount(mux, Options{DataDir: data, WebDir: webDir, DashboardCSP: csp})
	get := func(target string) http.Header {
		t.Helper()
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d", target, w.Code)
		}
		return w.Header()
	}

	for _, p := range []string{"/", "/apps/live", "/login", "/assets/app.js"} {
		h := get(p)
		if h.Get("X-Frame-Options") != "DENY" || h.Get("Content-Security-Policy") != csp {
			t.Errorf("%s: XFO=%q CSP=%q", p, h.Get("X-Frame-Options"), h.Get("Content-Security-Policy"))
		}
	}
	for _, want := range []string{"default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'",
		"connect-src 'self' wss://media.example.com https://media.example.com https:"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP lacks %q: %s", want, csp)
		}
	}
	// The public /embed player and /play share page are iframe targets.
	for _, p := range []string{"/embed/live/room", "/play/live/room"} {
		h := get(p)
		if h.Get("X-Frame-Options") != "" || !strings.Contains(h.Get("Content-Security-Policy"), "frame-ancestors *") {
			t.Errorf("%s not embeddable: XFO=%q CSP=%q", p, h.Get("X-Frame-Options"), h.Get("Content-Security-Policy"))
		}
	}
	// Samples keep their own sandbox CSP; HLS and the SDK get none of this.
	if h := get("/samples/live/embed.html"); h.Get("X-Frame-Options") != "" || !strings.Contains(h.Get("Content-Security-Policy"), "frame-ancestors *") {
		t.Errorf("samples: %v", h)
	}
	for _, p := range []string{"/hls/live/room/index.m3u8", "/sdk/streamhub-adaptor.global.js"} {
		if h := get(p); h.Get("X-Frame-Options") != "" || h.Get("Content-Security-Policy") != "" {
			t.Errorf("%s: %v", p, h)
		}
	}
	// No PUBLIC_WS_URL (LiveKit through /rtc, same origin) or a junk one.
	for _, raw := range []string{"", "not a url", "ftp://x", "wss://a b"} {
		if c := DashboardCSP(raw); !strings.Contains(c, "connect-src 'self' https:;") {
			t.Errorf("%q → %s", raw, c)
		}
	}
	if c := DashboardCSP("ws://10.0.0.5:7880"); !strings.Contains(c, "connect-src 'self' ws://10.0.0.5:7880 http://10.0.0.5:7880 https:;") {
		t.Error(c)
	}
}
