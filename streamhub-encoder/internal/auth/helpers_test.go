package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const legacyTok = "ek_legacy0123456789abcdef0123456789abcdef"

// fakeClock is a settable clock shared by sessions, limiter and audit.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock { return &fakeClock{t: time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)} }

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }

func (c *fakeClock) Advance(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

type env struct {
	t     *testing.T
	a     *Auth
	h     http.Handler
	clock *fakeClock
	dir   string
	pw    string // bootstrap admin password
}

func testOptions(dir string, clock *fakeClock) Options {
	return Options{DataDir: dir, LegacyToken: legacyTok, BcryptCost: bcrypt.MinCost, Now: clock.Now}
}

func newEnv(t *testing.T, mut ...func(*Options)) *env {
	t.Helper()
	clock := newClock()
	dir := t.TempDir()
	o := testOptions(dir, clock)
	for _, m := range mut {
		m(&o)
	}
	a, pw, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return &env{t: t, a: a, h: wrap(a), clock: clock, dir: dir, pw: pw}
}

// wrap mounts the auth endpoints plus a catch-all dummy handler that echoes
// the principal, all behind Middleware — exactly how encoderd wires it.
func wrap(a *Auth) http.Handler {
	mux := http.NewServeMux()
	a.Register(mux)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p, _ := PrincipalFrom(r.Context())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "principal": p})
	})
	return a.Middleware(mux)
}

type reqOpt func(*http.Request)

func bearer(tok string) reqOpt {
	return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+tok) }
}

func cookie(v string) reqOpt {
	return func(r *http.Request) { r.AddCookie(&http.Cookie{Name: SessionCookie, Value: v}) }
}

func csrf() reqOpt { return func(r *http.Request) { r.Header.Set("X-Requested-With", UIHeaderValue) } }

func from(addr string) reqOpt { return func(r *http.Request) { r.RemoteAddr = addr } }

func header(k, v string) reqOpt { return func(r *http.Request) { r.Header.Set(k, v) } }

func (e *env) do(method, target, body string, opts ...reqOpt) *httptest.ResponseRecorder {
	e.t.Helper()
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	for _, o := range opts {
		o(r)
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, r)
	return w
}

func sessionFrom(w *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == SessionCookie {
			return c
		}
	}
	return nil
}

// login returns the session cookie value (fails the test on non-200).
func (e *env) login(user, pw string, opts ...reqOpt) string {
	e.t.Helper()
	w := e.do("POST", "/api/v1/auth/login", fmt.Sprintf(`{"user":%q,"password":%q}`, user, pw), opts...)
	if w.Code != http.StatusOK {
		e.t.Fatalf("login %s: %d %s", user, w.Code, w.Body)
	}
	c := sessionFrom(w)
	if c == nil || c.Value == "" {
		e.t.Fatal("login: no session cookie")
	}
	return c.Value
}

// user creates an account directly and returns a logged-in cookie.
func (e *env) user(name string, role Role) string {
	e.t.Helper()
	if _, err := e.a.CreateUser(name, "password-"+name, role, false); err != nil {
		e.t.Fatal(err)
	}
	return e.login(name, "password-"+name)
}

// token creates an API token directly and returns its plaintext.
func (e *env) token(name string, role Role) string {
	e.t.Helper()
	_, plain, err := e.a.CreateToken(name, role)
	if err != nil {
		e.t.Fatal(err)
	}
	return plain
}

func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return v
}

func wantCode(t *testing.T, w *httptest.ResponseRecorder, code int) {
	t.Helper()
	if w.Code != code {
		t.Fatalf("status %d, want %d: %s", w.Code, code, w.Body)
	}
}
