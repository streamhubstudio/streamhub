package authn_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authn"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/server"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

const (
	jwtSecret = "test-jwt-secret"
	adminUser = "root@x.io"
	adminPass = "rootpass"
)

// fakeMailer records sends and answers with result.
type fakeMailer struct {
	mu       sync.Mutex
	result   authn.SendResult
	urls     []string
	contexts []authn.SendContext
	tests    []string
}

func (f *fakeMailer) SendMagicLink(_ context.Context, _, url string, sc authn.SendContext) authn.SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.urls, f.contexts = append(f.urls, url), append(f.contexts, sc)
	return f.result
}

func (f *fakeMailer) SendInvite(_ context.Context, _, url string, _ authn.InviteOptions, sc authn.SendContext) authn.SendResult {
	return f.SendMagicLink(context.Background(), "", url, sc)
}

func (f *fakeMailer) TestUserSMTP(_ context.Context, userID, to string) authn.SendResult {
	f.tests = append(f.tests, userID+"→"+to)
	return authn.SendResult{OK: true, MessageID: "m1"}
}

func (f *fakeMailer) lastToken(t *testing.T) string {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.urls) == 0 {
		t.Fatal("no link sent")
	}
	u := f.urls[len(f.urls)-1]
	return u[strings.Index(u, "token=")+len("token="):]
}

type fakeRole struct{ role string }

func (r *fakeRole) Role(context.Context) string { return r.role }
func (r *fakeRole) MasterURL(context.Context) *string {
	if r.role != "edge" {
		return nil
	}
	u := "https://master.example"
	return &u
}

type stack struct {
	t    *testing.T
	h    http.Handler
	svc  *authn.Service
	ten  *tenancy.Service
	g    *sql.DB
	aud  *audit.Service
	rep  *security.Reputation
	mail *fakeMailer
	role *fakeRole
	cfg  *config.Config
}

// newStack wires the auth plane exactly like cmd/streamhub (minus timers)
// over a fresh DATA_DIR, behind server.Handler.
func newStack(t *testing.T) *stack {
	t.Helper()
	t.Setenv("AUTH_RATE_LIMIT_MAX", "100000")
	store, g, dir := testutil.Store(t)
	ctx := context.Background()
	cfg := &config.Config{DataDir: dir, NodeEnv: "test", JWTSecret: jwtSecret, AdminUser: adminUser, AdminPass: adminPass, LogRetentionDays: 30}
	log := testutil.Log()
	ten := tenancy.New(g, cfg.AdminUser, log)
	ten.Init(ctx)
	aud := audit.New(g, cfg.Env, log)
	aud.Init(ctx)
	settings := security.ResolveSettings(cfg.Env)
	rules := security.NewRules(g, log)
	rules.Init(ctx)
	rep := security.NewReputation(g, settings, rules, log)
	rep.Init(ctx)
	quo := quotas.New(g, store.App, log)
	mail := &fakeMailer{result: authn.SendResult{OK: true}}
	role := &fakeRole{role: "standalone"}
	svc := authn.New(authn.Deps{Config: cfg, DB: g, Tenancy: ten, Quotas: quo, Audit: aud, Reputation: rep, NodeRole: role, Mailer: mail, Log: log})
	svc.Init(ctx)
	limiter := httpx.NewAuthRateLimiter(cfg.Env)
	h := server.Handler(server.Deps{
		Config: cfg, Log: log, Authn: svc,
		APIHooks:   []func(huma.API){authz.NewGuard(authz.New(g), aud, log).Install},
		Middleware: []func(http.Handler) http.Handler{httpx.JSONBodyParser, limiter.Middleware, security.Middleware(settings, rules, rep, log)},
		Modules:    []api.Module{svc, quo, audit.NewRoutes(aud), security.NewRoutes(settings, rules, rep, aud)},
	})
	return &stack{t, h, svc, ten, g, aud, rep, mail, role, cfg}
}

type resp struct {
	code int
	raw  string
	body map[string]any
	hdr  http.Header
}

// str digs a dotted path ("data.token") out of the JSON body.
func (r resp) str(path string) string {
	var cur any = r.body
	for _, k := range strings.Split(path, ".") {
		m, _ := cur.(map[string]any)
		cur = m[k]
	}
	switch v := cur.(type) {
	case string:
		return v
	case nil:
		return ""
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

// call performs a request; ip (optional) is the client address.
func (s *stack) call(method, path, token, body string, ip ...string) resp {
	s.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = bytes.NewBufferString(body)
	}
	r := httptest.NewRequest(method, "/api/v1"+path, rd)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("User-Agent", "go-test")
	r.RemoteAddr = "198.51.100.1:4000"
	if len(ip) > 0 {
		r.RemoteAddr = net.JoinHostPort(ip[0], "4000")
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, r)
	out := resp{code: w.Code, raw: w.Body.String(), hdr: w.Header()}
	_ = json.Unmarshal(w.Body.Bytes(), &out.body)
	return out
}

func (s *stack) expect(r resp, code int, contains ...string) {
	s.t.Helper()
	if r.code != code {
		s.t.Fatalf("status %d, want %d: %s", r.code, code, r.raw)
	}
	for _, c := range contains {
		if !strings.Contains(r.raw, c) {
			s.t.Fatalf("body %s lacks %q", r.raw, c)
		}
	}
}

func (s *stack) adminToken() string {
	s.t.Helper()
	r := s.call("POST", "/auth/login", "", `{"user":"`+adminUser+`","password":"`+adminPass+`"}`)
	s.expect(r, 200)
	return r.str("data.token")
}

// globalToken mints a global sk_ token through the API.
func (s *stack) globalToken() string {
	s.t.Helper()
	r := s.call("POST", "/tokens", s.adminToken(), `{"name":"ci","scope":"global"}`)
	s.expect(r, 201)
	return r.str("token")
}

// signup creates a user + team with public registration on.
func (s *stack) signup(email, pass string) string {
	s.t.Helper()
	s.t.Setenv("STREAMHUB_PUBLIC_REGISTRATION", "1")
	r := s.call("POST", "/auth/signup", "", `{"email":"`+email+`","password":"`+pass+`"}`)
	s.expect(r, 201)
	return r.str("data.token")
}
