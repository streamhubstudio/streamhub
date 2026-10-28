package authn_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

func TestSignupLoginMe(t *testing.T) {
	s := newStack(t)
	tok := s.signup("Alice@Example.com", "longenough")
	me := s.call("GET", "/auth/me", tok, "")
	s.expect(me, 200, `"via":"user_jwt"`, `"role":"owner"`, `"scope":"user"`, `"isSuperadmin":false`, `"email":"alice@example.com"`)
	tenant := me.str("data.tenantId")
	if !strings.HasPrefix(tenant, "tnt_") || s.ten.GetTenant(context.Background(), tenant).Name != "alice@example.com" {
		t.Fatal("team defaults to the email")
	}

	s.expect(s.call("POST", "/auth/signup", "", `{"email":"alice@example.com","password":"longenough"}`), 400, `"email already in use"`)
	s.expect(s.call("POST", "/auth/signup", "", `{"email":"bob@example.com","password":"short"}`), 400, `"password must be longer than or equal to 8 characters"`)
	s.expect(s.call("POST", "/auth/signup", "", `{"email":"ROOT@x.io","password":"longenough"}`), 400, `"email already in use"`)
	s.expect(s.call("POST", "/auth/signup", "", `{"email":"bob@example.com","password":"longenough","teamName":"  Bob Co "}`), 201)
	if u := s.ten.GetUserByEmail(context.Background(), "bob@example.com"); s.ten.GetTenant(context.Background(), s.ten.PrimaryMembership(context.Background(), u.ID).TenantID).Name != "Bob Co" {
		t.Fatal("team name")
	}

	s.expect(s.call("POST", "/auth/login", "", `{"user":"ALICE@example.com","password":"longenough"}`), 200, `"token":"`)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"alice@example.com","password":"nope"}`), 401, `"message":"Invalid username or password"`)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"ghost@example.com","password":"nope"}`), 401)

	s.expect(s.call("GET", "/auth/me", "", ""), 401, `"message":"Missing Bearer token"`)
	s.expect(s.call("GET", "/auth/me", "garbage", ""), 401, `"message":"Invalid or expired token"`)

	// Audit trail: login outcomes, identity only.
	page, _ := s.aud.Query(context.Background(), audit.Query{Action: "auth.login"})
	if page.Total != 3 || page.Entries[0].Result != "failure" || string(page.Entries[0].Meta) != `{"error":"Invalid username or password"}` {
		t.Fatalf("%+v", page.Entries)
	}
	if *page.Entries[0].ActorID != "ghost@example.com" || *page.Entries[0].IP != "198.51.100.1" {
		t.Fatal("actor")
	}
}

func TestPendingUserAndSignupFlag(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	t.Setenv("STREAMHUB_PUBLIC_REGISTRATION", "")
	t.Setenv("STREAMHUB_ALLOW_SIGNUP", "")
	s.expect(s.call("GET", "/auth/config", "", ""), 200, `"allowSignup":false`, `"nodeRole":"standalone"`, `"masterUrl":null`, `"loginEnabled":true`, `"appVersion":`)
	s.expect(s.call("POST", "/auth/signup", "", `{"email":"new@x.io","password":"longenough"}`), 403, `"message":"signup_disabled"`)
	if s.ten.GetUserByEmail(ctx, "new@x.io") != nil {
		t.Fatal("nothing must be created")
	}

	team, _ := s.ten.CreateTeam(ctx, "T", "")
	pending, _ := s.ten.CreateUser(ctx, tenancy.CreateUserInput{Email: "inv@x.io", Status: "pending"})
	s.ten.AddMembership(ctx, pending, team, tenancy.RoleEditor)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"inv@x.io","password":"whatever1"}`), 401)
	tok := s.call("POST", "/auth/signup", "", `{"email":"inv@x.io","password":"longenough"}`)
	s.expect(tok, 201)
	s.expect(s.call("GET", "/auth/me", tok.str("data.token"), ""), 200, `"tenantId":"`+team+`"`, `"role":"editor"`)

	t.Setenv("STREAMHUB_ALLOW_SIGNUP", "1")
	s.expect(s.call("GET", "/auth/config", "", ""), 200, `"allowSignup":true`)
	t.Setenv("STREAMHUB_PUBLIC_REGISTRATION", "0") // canonical flag wins
	s.expect(s.call("GET", "/auth/config", "", ""), 200, `"allowSignup":false`)
}

func TestBreakGlassAdmin(t *testing.T) {
	s := newStack(t)
	tok := s.adminToken()
	s.expect(s.call("GET", "/auth/me", tok, ""), 200,
		`{"data":{"userId":"admin","tenantId":"platform","role":"superadmin","isSuperadmin":true,"scope":"global","via":"admin_jwt","email":"root@x.io"}}`)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"root@x.io","password":"wrong"}`), 401)

	// sub=admin is superadmin even without ADMIN_USER; legacy sub=ADMIN_USER too.
	s.cfg.AdminUser = ""
	adminJWT, _ := auth.SignJWT(map[string]any{"sub": "admin"}, jwtSecret, time.Hour)
	s.expect(s.call("GET", "/auth/me", adminJWT, ""), 200, `"via":"admin_jwt"`)
	s.cfg.AdminUser = adminUser
	legacy, _ := auth.SignJWT(map[string]any{"sub": adminUser}, jwtSecret, time.Hour)
	s.expect(s.call("GET", "/auth/me", legacy, ""), 200, `"userId":"admin"`)

	// No admin creds configured → the break-glass path is closed.
	s.cfg.AdminPass = ""
	s.expect(s.call("POST", "/auth/login", "", `{"user":"root@x.io","password":""}`), 400)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"root@x.io","password":"rootpass"}`), 401)

	// No JWT secret → login is not configured.
	s.cfg.JWTSecret = ""
	s.expect(s.call("POST", "/auth/login", "", `{"user":"x","password":"y"}`), 401, `"message":"Login is not configured"`)
}

func TestJWTValidation(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	tok := s.signup("u@x.io", "longenough")
	uid := s.ten.GetUserByEmail(ctx, "u@x.io").ID

	expired, _ := auth.SignJWT(map[string]any{"sub": uid, "exp": time.Now().Add(-time.Minute).Unix()}, jwtSecret, time.Hour)
	s.expect(s.call("GET", "/auth/me", expired, ""), 401, `"Invalid or expired token"`)
	wrong, _ := auth.SignJWT(map[string]any{"sub": uid}, "other", time.Hour)
	s.expect(s.call("GET", "/auth/me", wrong, ""), 401)
	ghost, _ := auth.SignJWT(map[string]any{"sub": "usr_ghost"}, jwtSecret, time.Hour)
	s.expect(s.call("GET", "/auth/me", ghost, ""), 401, `"Invalid or expired token"`)
	legacy, _ := auth.SignJWT(map[string]any{"sub": uid}, jwtSecret, time.Hour) // no sid: grace
	s.expect(s.call("GET", "/auth/me", legacy, ""), 200)
	unknownSid, _ := auth.SignJWT(map[string]any{"sub": uid, "sid": "nope"}, jwtSecret, time.Hour)
	s.expect(s.call("GET", "/auth/me", unknownSid, ""), 401, `"Session revoked or expired"`)

	// Revoking the session kills the token everywhere.
	claims, _ := auth.VerifyJWT(tok, jwtSecret)
	sid := claims.String("sid")
	s.expect(s.call("DELETE", "/auth/sessions/"+sid, tok, ""), 200, `{"data":{"revoked":true,"current":true},"error":null}`)
	s.expect(s.call("GET", "/auth/me", tok, ""), 401, `"Session revoked or expired"`)
}

func TestPublicPathBypass(t *testing.T) {
	s := newStack(t)
	for _, p := range []string{"/api/v1/health", "/api/v1/docs/x", "/api/v1/openapi.json", "/api/v1/play/a", "/api/v1/embed", "/api/v1/assets/x.js", "/api/v1/samples/a/b"} {
		r := httptest.NewRequest("GET", p, nil)
		if pr, err := s.svc.Authenticate(r); pr != nil || err != nil {
			t.Errorf("%s not public", p)
		}
	}
	for _, p := range []string{"/api/v1/healthz", "/api/v1/apps", "/api/v1/playlist"} {
		if _, err := s.svc.Authenticate(httptest.NewRequest("GET", p, nil)); err == nil {
			t.Errorf("%s treated as public", p)
		}
	}
}

func TestTokens(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	admin := s.adminToken()
	testutil.Exec(t, s.g, `INSERT INTO apps (id, name, tenant_id) VALUES (5, 'live', 'tnt_live')`)

	created := s.call("POST", "/tokens", admin, `{"name":"ci","scope":"global","allowedIps":[" 198.51.100.1 ",""]}`)
	s.expect(created, 201, `"id":1`, `"token":"sk_`)
	sk := created.str("token")
	var hash, tenant, ips string
	s.g.QueryRow(`SELECT token_hash, tenant_id, allowed_ips_json FROM api_tokens WHERE id = 1`).Scan(&hash, &tenant, &ips)
	if hash != auth.HashToken(sk) || tenant != "platform" || ips != `["198.51.100.1"]` {
		t.Fatalf("row %s %s %s", hash, tenant, ips)
	}
	s.expect(s.call("GET", "/auth/me", sk, ""), 200,
		`{"data":{"userId":"token:1","tenantId":"platform","role":"service","isSuperadmin":true,"scope":"global","via":"api_token"}}`)
	var used *string
	s.g.QueryRow(`SELECT last_used_at FROM api_tokens WHERE id = 1`).Scan(&used)
	if used == nil {
		t.Fatal("last_used_at not touched")
	}

	s.expect(s.call("POST", "/tokens", admin, `{"name":"a","scope":"app"}`), 400, `"appId is required when scope=app"`)
	s.expect(s.call("POST", "/tokens", admin, `{"name":"a","scope":"app","appId":9}`), 400, `"app 9 does not exist"`)
	s.expect(s.call("POST", "/tokens", admin, `{"name":"a","scope":"global","appId":5}`), 400, `"appId is only valid when scope=app"`)
	s.expect(s.call("POST", "/tokens", admin, `{"scope":"nope"}`), 400, `"scope must be one of the following values: global, app"`)
	appTok := s.call("POST", "/tokens", admin, `{"name":"a","scope":"app","appId":5}`)
	s.expect(appTok, 201)
	s.g.QueryRow(`SELECT tenant_id FROM api_tokens WHERE id = 2`).Scan(&tenant)
	if tenant != "tnt_live" {
		t.Fatalf("app token tenant %s (M2)", tenant)
	}
	app := appTok.str("token")
	s.expect(s.call("GET", "/auth/me", app, ""), 200, `"tenantId":"tnt_live"`, `"isSuperadmin":false`, `"scope":"app"`)

	// App-scoped tokens can't manage tokens (escalation closed).
	for _, r := range []resp{
		s.call("GET", "/tokens", app, ""),
		s.call("POST", "/tokens", app, `{"name":"x","scope":"global"}`),
		s.call("DELETE", "/tokens/1", app, ""),
	} {
		s.expect(r, 403, `"token management requires a global-scope credential"`)
	}

	list := s.call("GET", "/tokens", sk, "")
	s.expect(list, 200, `"scope":"app","appId":5`, `"revoked":false`)
	if strings.Contains(list.raw, hash) || strings.Contains(list.raw, "token_hash") {
		t.Fatal("hash leaked")
	}
	s.expect(s.call("DELETE", "/tokens/2", sk, ""), 204)
	s.expect(s.call("GET", "/auth/me", app, ""), 401, `"Invalid or revoked API token"`)
	s.expect(s.call("DELETE", "/tokens/99", sk, ""), 400, `"token 99 not found"`)
	s.expect(s.call("DELETE", "/tokens/x", sk, ""), 400, `"Validation failed (numeric string is expected)"`)
	s.expect(s.call("GET", "/auth/me", "sk_unknown", ""), 401, `"Invalid or revoked API token"`)

	page, _ := s.aud.Query(ctx, audit.Query{Action: "token."})
	if page.Total != 3 || page.Entries[0].Action != "token.revoke" || string(page.Entries[2].Meta) != `{"name":"ci","scope":"global","appId":null}` {
		t.Fatalf("%+v", page.Entries)
	}
}

func TestTokenIPAllowlist(t *testing.T) {
	s := newStack(t)
	admin := s.adminToken()
	mk := func(ips string) string {
		r := s.call("POST", "/tokens", admin, `{"name":"x","scope":"global","allowedIps":`+ips+`}`)
		s.expect(r, 201)
		return r.str("token")
	}
	exact, cidr, empty := mk(`["203.0.113.5"]`), mk(`["10.0.0.0/8"]`), mk(`[]`)
	loop := mk(`["127.0.0.1"]`)
	cases := []struct {
		tok, ip string
		code    int
	}{
		{exact, "203.0.113.5", 200}, {exact, "203.0.113.6", 401}, {exact, "::ffff:203.0.113.5", 200},
		{cidr, "10.9.8.7", 200}, {cidr, "11.0.0.1", 401}, {empty, "8.8.8.8", 200},
		{loop, "8.8.8.8", 401},
	}
	for _, c := range cases {
		r := s.call("GET", "/auth/me", c.tok, "", c.ip)
		if r.code != c.code {
			t.Errorf("%s from %s: %d %s", c.tok[:8], c.ip, r.code, r.raw)
		}
	}
	s.expect(s.call("GET", "/auth/me", exact, "", "203.0.113.6"), 401, `"Client IP not allowed for this token"`)

	// A spoofed client XFF never wins over the proxy-appended hop.
	r := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	r.RemoteAddr = "10.0.0.2:1"
	r.Header.Set("X-Forwarded-For", "127.0.0.1, 8.8.8.8")
	r.Header.Set("Authorization", "Bearer "+loop)
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("spoofed XFF satisfied a loopback-only whitelist")
	}
}

func TestSessions(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	a1 := s.signup("a@x.io", "longenough")
	a2 := s.call("POST", "/auth/login", "", `{"user":"a@x.io","password":"longenough"}`).str("data.token")
	b := s.signup("b@x.io", "longenough")
	list := s.call("GET", "/auth/sessions", a2, "")
	s.expect(list, 200, `"userAgent":"go-test"`, `"ip":"198.51.100.1"`, `"current":true`, `"current":false`)
	sessions, _ := s.svc.Sessions.ListForUser(ctx, s.ten.GetUserByEmail(ctx, "a@x.io").ID, "")
	if len(sessions) != 2 {
		t.Fatal("two sessions expected")
	}
	bClaims, _ := auth.VerifyJWT(b, jwtSecret)
	s.expect(s.call("DELETE", "/auth/sessions/"+bClaims.String("sid"), a1, ""), 404, `"session not found"`)
	s.expect(s.call("DELETE", "/auth/sessions", a2, ""), 200, `{"data":{"revoked":1},"error":null}`)
	s.expect(s.call("GET", "/auth/me", a1, ""), 401)
	s.expect(s.call("GET", "/auth/me", a2, ""), 200)
	s.expect(s.call("GET", "/auth/me", b, ""), 200)
	sk := s.globalToken()
	s.expect(s.call("GET", "/auth/sessions", sk, ""), 403, `"API tokens have no sessions"`)
}

func TestEdgeLock(t *testing.T) {
	s := newStack(t)
	user := s.signup("u@x.io", "longenough")
	sk := s.globalToken()
	s.role.role = "edge"
	s.expect(s.call("GET", "/auth/config", "", ""), 200, `"nodeRole":"edge"`, `"masterUrl":"https://master.example"`, `"loginEnabled":false`)
	s.expect(s.call("POST", "/auth/signup", "", `{"email":"n@x.io","password":"longenough"}`), 403, `"cluster_edge_login_disabled"`)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"root@x.io","password":"rootpass"}`), 403, `"cluster_edge_login_disabled"`)
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"aaaaaaaaaaaaaaaa"}`), 403, `"cluster_edge_login_disabled"`)
	s.expect(s.call("GET", "/auth/me", user, ""), 200) // already-issued JWTs still validate
	s.expect(s.call("GET", "/auth/me", sk, ""), 200)
}

func TestSuperadminNeverBlocked(t *testing.T) {
	s := newStack(t)
	t.Setenv(authz.EnforceEnv, "on")
	for _, tok := range []string{s.globalToken(), s.adminToken()} {
		s.expect(s.call("GET", "/teams/mine", tok, ""), 200, `"id":"platform"`)
		s.expect(s.call("GET", "/tenants/platform/usage", tok, ""), 200)
	}
}

func TestOffenseWiring(t *testing.T) {
	t.Setenv("STREAMHUB_AUTOBAN_ENABLED", "1")
	t.Setenv("STREAMHUB_AUTOBAN_MAX_OFFENSES", "100")
	s := newStack(t)
	good := s.globalToken()
	ip := "203.0.113.70"
	s.call("POST", "/auth/login", "", `{"user":"x@x.io","password":"bad"}`, ip)
	s.call("GET", "/auth/me", "sk_bogus", "", ip)
	s.call("GET", "/auth/me", "a.b.c", "", ip)
	s.call("GET", "/auth/me", "", "", ip)   // anonymous: not an offense
	s.call("GET", "/auth/me", good, "", ip) // valid: not an offense
	s.call("POST", "/auth/magic/verify", "", `{"token":"bogus-token-xyz"}`, ip)
	off := s.rep.Offenders(10)
	if len(off) != 1 || off[0].IP != ip || off[0].Count != 4 ||
		off[0].Kinds["login_failed"] != 1 || off[0].Kinds["invalid_token"] != 2 || off[0].Kinds["magic_verify_failed"] != 1 {
		t.Fatalf("%+v", off)
	}
}
