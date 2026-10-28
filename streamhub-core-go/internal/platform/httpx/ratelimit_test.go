package httpx

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAuthRateLimiter(t *testing.T) {
	l := NewRateLimiter(time.Minute, 3, AuthRateLimitPaths)
	now := time.Unix(1_700_000_000, 0)
	l.now = func() time.Time { return now }
	var reported []string
	l.SetOffenseReporter(func(ip string) { reported = append(reported, ip) })
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	do := func(method, path, ip string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.RemoteAddr = ip + ":1"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for i := 0; i < 3; i++ {
		if w := do("POST", "/api/v1/auth/login", "203.0.113.1"); w.Code != 200 {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
	w := do("POST", "/api/v1/auth/login", "203.0.113.1")
	if w.Code != 429 || strings.TrimSpace(w.Body.String()) != `{"data":null,"error":{"code":"rate_limited","message":"Too many attempts. Please retry later."}}` {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w.Header().Get("RateLimit-Policy") != "3;w=60" || w.Header().Get("RateLimit") != "limit=3, remaining=0, reset=60" || w.Header().Get("Retry-After") != "60" {
		t.Fatalf("headers %v", w.Header())
	}
	if len(reported) != 1 || reported[0] != "203.0.113.1" {
		t.Fatalf("reporter %v", reported)
	}
	// Per path prefix, shared by the three sensitive paths; another IP is independent.
	if do("POST", "/api/v1/auth/magic/verify", "203.0.113.1").Code != 429 || do("POST", "/api/v1/auth/login", "203.0.113.2").Code != 200 {
		t.Fatal("keying")
	}
	// Normal routes are never limited (dashboard polling).
	for i := 0; i < 12; i++ {
		if do("GET", "/api/v1/health", "203.0.113.1").Code != 200 || do("GET", "/api/v1/auth/me", "203.0.113.1").Code != 200 {
			t.Fatal("non-auth path limited")
		}
	}
	now = now.Add(61 * time.Second)
	if do("POST", "/api/v1/auth/login", "203.0.113.1").Code != 200 {
		t.Fatal("window did not reset")
	}
	// A panicking reporter never breaks the 429.
	l.SetOffenseReporter(func(string) { panic("boom") })
	for i := 0; i < 3; i++ {
		do("POST", "/api/v1/auth/magic-link", "203.0.113.3")
	}
	if do("POST", "/api/v1/auth/magic-link", "203.0.113.3").Code != 429 {
		t.Fatal("429 lost")
	}
	if strings.Join(AuthRateLimitPaths, ",") != "/api/v1/auth/login,/api/v1/auth/magic-link,/api/v1/auth/magic/verify" {
		t.Fatal("limited paths changed")
	}
}

func TestAuthRateLimiterEnv(t *testing.T) {
	env := map[string]string{"AUTH_RATE_LIMIT_MAX": "0", "AUTH_RATE_LIMIT_WINDOW_MS": "5000"}
	l := NewAuthRateLimiter(func(k string) string { return env[k] })
	if l.limit != 10 || l.window != 5*time.Second {
		t.Fatalf("%d %v", l.limit, l.window)
	}
}
