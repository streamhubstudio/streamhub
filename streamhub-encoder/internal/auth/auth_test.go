package auth

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestBootstrapCreatesAdminAndPasswordFile(t *testing.T) {
	e := newEnv(t)
	if len(e.pw) < 20 {
		t.Fatalf("initial password too short: %q", e.pw)
	}
	b, err := os.ReadFile(filepath.Join(e.dir, "initial-admin-password"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(b)) != e.pw {
		t.Fatalf("password file %q != returned %q", b, e.pw)
	}
	for _, f := range []string{"initial-admin-password", "users.json", "audit.log"} {
		fi, err := os.Stat(filepath.Join(e.dir, f))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s mode %v, want 0600", f, fi.Mode().Perm())
		}
	}
	us := e.a.Users()
	if len(us) != 1 || us[0].Name != "admin" || us[0].Role != RoleAdmin || !us[0].MustChangePassword || us[0].Disabled {
		t.Fatalf("users = %+v", us)
	}
	raw, _ := os.ReadFile(filepath.Join(e.dir, "users.json"))
	if bytes.Contains(raw, []byte(e.pw)) {
		t.Fatal("users.json contains the plaintext password")
	}
	// A second start does not bootstrap again.
	_ = e.a.Close()
	a2, pw2, err := New(testOptions(e.dir, e.clock))
	if err != nil {
		t.Fatal(err)
	}
	defer a2.Close()
	if pw2 != "" || len(a2.Users()) != 1 {
		t.Fatalf("re-bootstrapped: pw=%q users=%d", pw2, len(a2.Users()))
	}
}

func TestDefaultBcryptCostIs12(t *testing.T) {
	dir := t.TempDir()
	a, _, err := New(Options{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	u, _ := a.store.getUser("admin")
	if c, err := bcrypt.Cost([]byte(u.PasswordHash)); err != nil || c != 12 {
		t.Fatalf("bcrypt cost %d (%v), want 12", c, err)
	}
}

func TestLoginCookieMeLogout(t *testing.T) {
	e := newEnv(t)
	e.a.CreateUser("ops", "password-ops", RoleOperator, false)

	w := e.do("POST", "/api/v1/auth/login", `{"user":"OPS","password":"password-ops"}`)
	wantCode(t, w, 200)
	lr := decode[LoginResponse](t, w)
	if lr.User != "ops" || lr.Role != RoleOperator || lr.MustChangePassword {
		t.Fatalf("login response %+v", lr)
	}
	c := sessionFrom(w)
	if c == nil || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Secure || c.Path != "/" {
		t.Fatalf("cookie %+v", c)
	}
	if raw, _ := base64Len(c.Value); raw != 32 {
		t.Fatalf("session id has %d bytes, want 32", raw)
	}

	// Over TLS the cookie is Secure.
	w = e.do("POST", "https://enc.local/api/v1/auth/login", `{"user":"ops","password":"password-ops"}`)
	wantCode(t, w, 200)
	if !sessionFrom(w).Secure {
		t.Fatal("cookie not Secure over TLS")
	}

	w = e.do("GET", "/api/v1/auth/me", "", cookie(c.Value))
	wantCode(t, w, 200)
	p := decode[Principal](t, w)
	if p.Name != "ops" || p.Role != RoleOperator || p.Kind != KindUser {
		t.Fatalf("me = %+v", p)
	}

	// Logout needs the CSRF header like any cookie mutation.
	wantCode(t, e.do("POST", "/api/v1/auth/logout", "", cookie(c.Value)), 403)
	w = e.do("POST", "/api/v1/auth/logout", "", cookie(c.Value), csrf())
	wantCode(t, w, 204)
	if cc := sessionFrom(w); cc == nil || cc.MaxAge >= 0 {
		t.Fatalf("logout did not clear the cookie: %+v", cc)
	}
	wantCode(t, e.do("GET", "/api/v1/auth/me", "", cookie(c.Value)), 401)
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie("bogus")), 401)
}

func base64Len(s string) (int, error) {
	b, err := decodeB64(s)
	return len(b), err
}

func TestLoginRequiresJSON(t *testing.T) {
	e := newEnv(t)
	r := e.do("POST", "/api/v1/auth/login", "", header("Content-Type", "text/plain"))
	wantCode(t, r, 415)
}

func TestWrongPasswordAndRateLimit(t *testing.T) {
	e := newEnv(t)
	e.a.CreateUser("bob", "password-bob", RoleViewer, false)
	ip := from("198.51.100.7:5555")
	for i := 0; i < 5; i++ {
		w := e.do("POST", "/api/v1/auth/login", `{"user":"bob","password":"wrong-password"}`, ip)
		wantCode(t, w, 401)
		if strings.Contains(w.Body.String(), "bob") {
			t.Fatal("error leaks the user name")
		}
	}
	// Locked: even the right password gets 429.
	w := e.do("POST", "/api/v1/auth/login", `{"user":"bob","password":"password-bob"}`, ip)
	wantCode(t, w, 429)
	if ra := w.Header().Get("Retry-After"); ra == "" || ra == "0" {
		t.Fatalf("Retry-After = %q", ra)
	}
	// Another IP is not affected.
	e.login("bob", "password-bob", from("198.51.100.8:5555"))
	// Unknown users get the same 401 (no user enumeration).
	wantCode(t, e.do("POST", "/api/v1/auth/login", `{"user":"nobody","password":"whatever-pw"}`, ip), 401)
	// Window expiry unlocks.
	e.clock.Advance(15*time.Minute + time.Second)
	e.login("bob", "password-bob", ip)
}

func TestPerIPSprayLimit(t *testing.T) {
	e := newEnv(t)
	e.a.CreateUser("carol", "password-carol", RoleViewer, false)
	ip := from("203.0.113.9:1")
	for i := 0; i < maxFailsIP; i++ {
		e.do("POST", "/api/v1/auth/login", `{"user":"u`+string(rune('a'+i))+`","password":"xxxxxxxxxxxx"}`, ip)
	}
	wantCode(t, e.do("POST", "/api/v1/auth/login", `{"user":"carol","password":"password-carol"}`, ip), 429)
}

func TestMustChangePasswordGate(t *testing.T) {
	e := newEnv(t)
	sid := e.login("admin", e.pw)

	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(sid)), 403)
	wantCode(t, e.do("GET", "/api/v1/users", "", cookie(sid)), 403)
	w := e.do("GET", "/api/v1/auth/me", "", cookie(sid))
	wantCode(t, w, 200)
	if !decode[Principal](t, w).MustChangePassword {
		t.Fatal("me does not report mustChangePassword")
	}
	wantCode(t, e.do("POST", "/api/v1/auth/password", `{"current":"`+e.pw+`","new":"short"}`, cookie(sid), csrf()), 422)
	wantCode(t, e.do("POST", "/api/v1/auth/password", `{"current":"nope-nope-nope","new":"a-long-new-password"}`, cookie(sid), csrf()), 403)
	wantCode(t, e.do("POST", "/api/v1/auth/password", `{"current":"`+e.pw+`","new":"`+e.pw+`"}`, cookie(sid), csrf()), 422)

	w = e.do("POST", "/api/v1/auth/password", `{"current":"`+e.pw+`","new":"a-long-new-password"}`, cookie(sid), csrf())
	wantCode(t, w, 200)
	nc := sessionFrom(w)
	if nc == nil || nc.Value == sid {
		t.Fatal("session not rotated after password change")
	}
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(sid)), 401) // old session gone
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(nc.Value)), 200)
	if _, err := os.Stat(filepath.Join(e.dir, "initial-admin-password")); !os.IsNotExist(err) {
		t.Fatal("initial-admin-password not removed after the change")
	}
	e.login("admin", "a-long-new-password")
	// Tokens have no password.
	wantCode(t, e.do("POST", "/api/v1/auth/password", `{"current":"x","new":"yyyyyyyyyyyy"}`, bearer(legacyTok)), 400)
}

func TestRoleMatrix(t *testing.T) {
	e := newEnv(t)
	creds := map[string]reqOpt{
		"anon":     func(*http.Request) {},
		"viewer":   bearer(e.token("v", RoleViewer)),
		"operator": bearer(e.token("o", RoleOperator)),
		"admin":    bearer(e.token("a", RoleAdmin)),
		"legacy":   bearer(legacyTok),
		"vcookie":  cookie(e.user("vic", RoleViewer)),
		"ocookie":  cookie(e.user("otto", RoleOperator)),
		"acookie":  cookie(e.user("ada", RoleAdmin)),
	}
	type tc struct {
		method, path string
		want         map[string]int // principal → status; missing = all others
		def          int
	}
	cases := []tc{
		// Public.
		{"GET", "/api/v1/health", nil, 200},
		{"GET", "/api/v1/docs", nil, 200},
		{"GET", "/api/v1/openapi.json", nil, 200},
		{"GET", "/api/v1/schemas/Channel.json", nil, 200},
		{"GET", "/", nil, 200},
		{"GET", "/assets/app.js", nil, 200},
		{"GET", "/metrics", map[string]int{"anon": 401}, 200},
		// Viewer: every GET except admin-only ones.
		{"GET", "/api/v1/channels", map[string]int{"anon": 401}, 200},
		{"GET", "/api/v1/channels/c1/status", map[string]int{"anon": 401}, 200},
		{"HEAD", "/api/v1/system", map[string]int{"anon": 401}, 200},
		{"GET", "/api/v1/config/backup", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403, "operator": 403, "ocookie": 403}, 200},
		{"GET", "/api/v1/users", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403, "operator": 403, "ocookie": 403}, 200},
		{"GET", "/api/v1/tokens", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403, "operator": 403, "ocookie": 403}, 200},
		{"GET", "/api/v1/audit", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403, "operator": 403, "ocookie": 403}, 200},
		// Operator actions.
		{"POST", "/api/v1/channels/c1/start", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403}, 200},
		{"POST", "/api/v1/channels/c1/stop", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403}, 200},
		{"POST", "/api/v1/channels/c1/restart", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403}, 200},
		{"POST", "/api/v1/channels/c1/outputs/o1/restart", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403}, 200},
		{"POST", "/api/v1/channels/c1/scte35", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403}, 200},
		{"POST", "/api/v1/alarms/a1/ack", map[string]int{"anon": 401, "viewer": 403, "vcookie": 403}, 200},
		// Admin only.
		{"POST", "/api/v1/channels", adminOnly(), 200},
		{"PUT", "/api/v1/channels/c1", adminOnly(), 200},
		{"PATCH", "/api/v1/channels/c1", adminOnly(), 200},
		{"DELETE", "/api/v1/channels/c1", adminOnly(), 200},
		{"POST", "/api/v1/channels/c1/outputs", adminOnly(), 200},
		{"DELETE", "/api/v1/channels/c1/outputs/o1", adminOnly(), 200},
		{"POST", "/api/v1/channels/c1/profile", adminOnly(), 200},
		{"PUT", "/api/v1/config/backup", adminOnly(), 200},
		{"POST", "/api/v1/streamhub/pair", adminOnly(), 200},
		{"POST", "/api/v1/streamhub/unpair", adminOnly(), 200},
		{"POST", "/api/v1/channels/c1/start/extra", adminOnly(), 200},
		{"POST", "/api/v1/somethingnew", adminOnly(), 200},
		{"POST", "/static/upload", adminOnly(), 200},
	}
	for _, c := range cases {
		for who, opt := range creds {
			want, ok := c.want[who]
			if !ok {
				want = c.def
			}
			var opts []reqOpt
			opts = append(opts, opt)
			if strings.HasSuffix(who, "cookie") {
				opts = append(opts, csrf())
			}
			w := e.do(c.method, c.path, "", opts...)
			if w.Code != want {
				t.Errorf("%s %s as %s: %d, want %d (%s)", c.method, c.path, who, w.Code, want, strings.TrimSpace(w.Body.String()))
			}
		}
	}
	// MetricsPublic opens /metrics.
	e.a.SetMetricsPublic(true)
	wantCode(t, e.do("GET", "/metrics", ""), 200)
}

func adminOnly() map[string]int {
	return map[string]int{"anon": 401, "viewer": 403, "vcookie": 403, "operator": 403, "ocookie": 403}
}

func TestExtraOperatorRoute(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.ExtraOperatorRoutes = []string{"POST /api/v1/channels/*/loudness/reset"}
		o.ExtraAdminReadPrefixes = []string{"/api/v1/notify"}
	})
	op := bearer(e.token("o", RoleOperator))
	wantCode(t, e.do("POST", "/api/v1/channels/c1/loudness/reset", "", op), 200)
	wantCode(t, e.do("GET", "/api/v1/notify/webhooks", "", bearer(e.token("v", RoleViewer))), 403)
	if _, _, err := New(Options{DataDir: t.TempDir(), ExtraOperatorRoutes: []string{"bad"}}); err == nil {
		t.Fatal("bad route accepted")
	}
}

func TestPathTricks(t *testing.T) {
	e := newEnv(t)
	op := bearer(e.token("o", RoleOperator))
	// Encoded slashes are refused on the API.
	wantCode(t, e.do("POST", "/api/v1/channels/c1%2Fx/start", "", op), 400)
	// Dot segments are evaluated on the cleaned path: this is DELETE of a channel.
	wantCode(t, e.do("DELETE", "/api/v1/channels/c1/start/..", "", op), 403)
	wantCode(t, e.do("GET", "/api/v1/health/../users", "", bearer(e.token("v", RoleViewer))), 403)
	wantCode(t, e.do("GET", "/api/v1/health/../channels", ""), 401)
}

func TestTokensLifecycle(t *testing.T) {
	e := newEnv(t)
	adm := bearer(legacyTok)
	w := e.do("POST", "/api/v1/tokens", `{"name":"ci","role":"operator"}`, adm)
	wantCode(t, w, 201)
	ct := decode[CreatedToken](t, w)
	if !strings.HasPrefix(ct.Token, "ek_") || ct.ID == "" || ct.Role != RoleOperator {
		t.Fatalf("created %+v", ct)
	}
	if b, _ := decodeB64(strings.TrimPrefix(ct.Token, "ek_")); len(b) != 32 {
		t.Fatalf("token carries %d random bytes, want 32", len(b))
	}
	raw, _ := os.ReadFile(filepath.Join(e.dir, "users.json"))
	sum := sha256.Sum256([]byte(ct.Token))
	if bytes.Contains(raw, []byte(ct.Token)) || !bytes.Contains(raw, []byte(hex.EncodeToString(sum[:]))) {
		t.Fatal("users.json must hold the token hash, never the plaintext")
	}
	// The list never shows the token or its hash.
	w = e.do("GET", "/api/v1/tokens", "", adm)
	wantCode(t, w, 200)
	if strings.Contains(w.Body.String(), ct.Token) || strings.Contains(w.Body.String(), hex.EncodeToString(sum[:])) {
		t.Fatal("token list leaks secrets")
	}
	if toks := decode[[]TokenInfo](t, w); len(toks) != 1 || !toks[0].LastUsedAt.IsZero() {
		t.Fatalf("tokens before use %+v", toks)
	}

	e.clock.Advance(time.Hour)
	w = e.do("POST", "/api/v1/channels/c1/start", "", bearer(ct.Token))
	wantCode(t, w, 200)
	if p := decode[struct{ Principal Principal }](t, w).Principal; p.Kind != KindToken || p.TokenID != ct.ID || p.Name != "ci" {
		t.Fatalf("principal %+v", p)
	}
	toks := e.a.Tokens()
	if !toks[0].LastUsedAt.Equal(e.clock.Now()) {
		t.Fatalf("lastUsedAt %v, want %v", toks[0].LastUsedAt, e.clock.Now())
	}
	// Persisted too (first use is always flushed).
	raw, _ = os.ReadFile(filepath.Join(e.dir, "users.json"))
	if !bytes.Contains(raw, []byte("lastUsedAt")) {
		t.Fatal("lastUsedAt not persisted")
	}

	wantCode(t, e.do("DELETE", "/api/v1/tokens/"+ct.ID, "", adm), 204)
	wantCode(t, e.do("GET", "/api/v1/channels", "", bearer(ct.Token)), 401)
	wantCode(t, e.do("DELETE", "/api/v1/tokens/tk_nope", "", adm), 404)
	if toks := e.a.Tokens(); !toks[0].Revoked {
		t.Fatal("token not marked revoked")
	}
	wantCode(t, e.do("POST", "/api/v1/tokens", `{"name":"x","role":"root"}`, adm), 422)
	wantCode(t, e.do("POST", "/api/v1/tokens", `{"name":"x","role":"viewer","extra":1}`, adm), 400)
}

func TestLegacyTokenIsAdmin(t *testing.T) {
	e := newEnv(t)
	w := e.do("GET", "/api/v1/auth/me", "", bearer(legacyTok))
	wantCode(t, w, 200)
	if p := decode[Principal](t, w); p.Kind != KindLegacy || p.Role != RoleAdmin {
		t.Fatalf("legacy principal %+v", p)
	}
	wantCode(t, e.do("GET", "/api/v1/users", "", bearer(legacyTok)), 200)
	wantCode(t, e.do("DELETE", "/api/v1/channels/x", "", bearer(legacyTok)), 200)
	wantCode(t, e.do("GET", "/api/v1/users", "", bearer(legacyTok+"x")), 401)
	wantCode(t, e.do("GET", "/api/v1/users", "", header("Authorization", "Basic YTpi")), 401)
	// Without a configured legacy token nothing like it is accepted.
	e2 := newEnv(t, func(o *Options) { o.LegacyToken = "" })
	wantCode(t, e2.do("GET", "/api/v1/channels", "", bearer("")), 401)
	wantCode(t, e2.do("GET", "/api/v1/channels", "", bearer(legacyTok)), 401)
}

func TestCSRFHeaderForCookieMutations(t *testing.T) {
	e := newEnv(t)
	sid := e.user("otto", RoleOperator)
	w := e.do("POST", "/api/v1/channels/c1/start", "", cookie(sid))
	wantCode(t, w, 403)
	if !strings.Contains(w.Body.String(), "X-Requested-With") {
		t.Fatalf("unhelpful CSRF error: %s", w.Body)
	}
	wantCode(t, e.do("POST", "/api/v1/channels/c1/start", "", cookie(sid), header("X-Requested-With", "XMLHttpRequest")), 403)
	wantCode(t, e.do("POST", "/api/v1/channels/c1/start", "", cookie(sid), csrf()), 200)
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(sid)), 200) // reads exempt
	tok := e.token("o", RoleOperator)
	wantCode(t, e.do("POST", "/api/v1/channels/c1/start", "", bearer(tok)), 200) // bearer exempt
}

func readAudit(t *testing.T, dir string) []AuditEntry {
	t.Helper()
	f, err := os.Open(filepath.Join(dir, "audit.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []AuditEntry
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var e AuditEntry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			t.Fatalf("bad audit line %q: %v", sc.Text(), err)
		}
		out = append(out, e)
	}
	return out
}

func TestAuditLog(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.TrustedProxies = []string{"10.0.0.0/8"} })
	e.a.CreateUser("otto", "password-otto", RoleOperator, false)
	tok := e.token("o", RoleOperator)

	e.do("GET", "/api/v1/channels", "", bearer(tok))
	e.do("GET", "/", "")
	if n := len(readAudit(t, e.dir)); n != 0 {
		t.Fatalf("GETs were audited (%d lines)", n)
	}
	e.do("POST", "/api/v1/auth/login", `{"user":"otto","password":"bad-password-x"}`, from("10.1.1.1:9"), header("X-Forwarded-For", "203.0.113.50, 10.2.2.2"))
	sid := e.login("otto", "password-otto")
	e.do("POST", "/api/v1/channels/c1/start", "", bearer(tok))
	e.do("DELETE", "/api/v1/channels/c1", "", bearer(tok)) // denied, still audited
	e.do("POST", "/api/v1/auth/logout", "", cookie(sid), csrf())

	got := readAudit(t, e.dir)
	if len(got) != 5 {
		t.Fatalf("audit lines = %d: %+v", len(got), got)
	}
	exp := []struct {
		event, principal, method, path string
		status                         int
	}{
		{"login_failed", "otto", "POST", "/api/v1/auth/login", 401},
		{"login", "otto", "POST", "/api/v1/auth/login", 200},
		{"request", "o", "POST", "/api/v1/channels/c1/start", 200},
		{"request", "o", "DELETE", "/api/v1/channels/c1", 403},
		{"logout", "otto", "POST", "/api/v1/auth/logout", 204},
	}
	for i, x := range exp {
		g := got[i]
		if g.Event != x.event || g.Principal != x.principal || g.Method != x.method || g.Path != x.path || g.Status != x.status || g.At.IsZero() {
			t.Errorf("line %d = %+v, want %+v", i, g, x)
		}
	}
	if got[0].IP != "203.0.113.50" {
		t.Errorf("trusted-proxy XFF not honored: ip=%q", got[0].IP)
	}
	if got[2].Kind != KindToken || got[2].Role != RoleOperator || got[2].TokenID == "" || got[2].IP != "192.0.2.1" {
		t.Errorf("token line %+v", got[2])
	}
	raw, _ := os.ReadFile(filepath.Join(e.dir, "audit.log"))
	for _, secret := range []string{"password-otto", "bad-password-x", tok, sid} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatalf("audit log contains a secret %q", secret)
		}
	}

	// API: newest first, limit honored, admin only.
	w := e.do("GET", "/api/v1/audit?limit=2", "", bearer(legacyTok))
	wantCode(t, w, 200)
	lines := decode[[]AuditEntry](t, w)
	if len(lines) != 2 || lines[0].Event != "logout" || lines[1].Method != "DELETE" {
		t.Fatalf("audit api = %+v", lines)
	}
	wantCode(t, e.do("GET", "/api/v1/audit?limit=0", "", bearer(legacyTok)), 422)
}

func TestAuditRotationAndTail(t *testing.T) {
	dir := t.TempDir()
	l, err := openAudit(filepath.Join(dir, "audit.log"), 1000, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	for i := 0; i < 100; i++ {
		if err := l.Write(AuditEntry{Event: "request", Status: i, Path: "/api/v1/x"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"audit.log", "audit.log.1", "audit.log.2"} {
		fi, err := os.Stat(filepath.Join(dir, f))
		if err != nil || fi.Size() > 1000 {
			t.Fatalf("%s: %v size %d", f, err, fi.Size())
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "audit.log.3")); !os.IsNotExist(err) {
		t.Fatal("more backups than configured")
	}
	lines, err := l.Tail(1000)
	if err != nil {
		t.Fatal(err)
	}
	var first AuditEntry
	json.Unmarshal(lines[0], &first)
	if first.Status != 99 {
		t.Fatalf("newest first violated: %+v", first)
	}
	for i := 1; i < len(lines); i++ {
		var a, b AuditEntry
		json.Unmarshal(lines[i-1], &a)
		json.Unmarshal(lines[i], &b)
		if b.Status != a.Status-1 {
			t.Fatalf("gap/order at %d: %d then %d", i, a.Status, b.Status)
		}
	}
}

func TestTailFileLargeChunks(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	var buf bytes.Buffer
	for i := 0; i < 5000; i++ {
		buf.WriteString(`{"n":` + strings.Repeat("1", 30) + "}\n")
	}
	os.WriteFile(p, buf.Bytes(), 0o600)
	n := 0
	if err := tailFile(p, 4000, func(b []byte) {
		if !json.Valid(b) {
			t.Fatalf("broken line %q", b)
		}
		n++
	}); err != nil {
		t.Fatal(err)
	}
	if n != 4000 {
		t.Fatalf("got %d lines", n)
	}
}

func TestLastAdminProtection(t *testing.T) {
	e := newEnv(t)
	adm := bearer(legacyTok)
	wantCode(t, e.do("DELETE", "/api/v1/users/admin", "", adm), 409)
	wantCode(t, e.do("PATCH", "/api/v1/users/admin", `{"role":"operator"}`, adm), 409)
	wantCode(t, e.do("PATCH", "/api/v1/users/admin", `{"disabled":true}`, adm), 409)

	wantCode(t, e.do("POST", "/api/v1/users", `{"name":"second","password":"password-second","role":"admin"}`, adm), 201)
	wantCode(t, e.do("POST", "/api/v1/users", `{"name":"second","password":"password-second","role":"admin"}`, adm), 409)
	wantCode(t, e.do("POST", "/api/v1/users", `{"name":"Bad Name!","password":"password-second","role":"admin"}`, adm), 422)
	wantCode(t, e.do("POST", "/api/v1/users", `{"name":"shorty","password":"123","role":"viewer"}`, adm), 422)
	// Created users must change their password by default.
	if u, _ := e.a.store.getUser("second"); !u.MustChangePassword {
		t.Fatal("new user not flagged mustChangePassword")
	}
	wantCode(t, e.do("PATCH", "/api/v1/users/admin", `{"role":"viewer"}`, adm), 200)
	wantCode(t, e.do("DELETE", "/api/v1/users/second", "", adm), 409) // now the last admin
	wantCode(t, e.do("DELETE", "/api/v1/users/admin", "", adm), 204)
	wantCode(t, e.do("DELETE", "/api/v1/users/admin", "", adm), 404)
	w := e.do("GET", "/api/v1/users", "", adm)
	wantCode(t, w, 200)
	if us := decode[[]UserInfo](t, w); len(us) != 1 || us[0].Name != "second" || strings.Contains(w.Body.String(), "passwordHash") {
		t.Fatalf("users %s", w.Body)
	}
}

func TestDisableAndResetEndSessions(t *testing.T) {
	e := newEnv(t)
	sid := e.user("vic", RoleViewer)
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(sid)), 200)
	wantCode(t, e.do("PATCH", "/api/v1/users/vic", `{"disabled":true}`, bearer(legacyTok)), 200)
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(sid)), 401)
	wantCode(t, e.do("POST", "/api/v1/auth/login", `{"user":"vic","password":"password-vic"}`), 401)

	sid2 := e.user("wes", RoleViewer)
	wantCode(t, e.do("PATCH", "/api/v1/users/wes", `{"password":"brand-new-password"}`, bearer(legacyTok)), 200)
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(sid2)), 401)
	sid3 := e.login("wes", "brand-new-password")
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(sid3)), 403) // admin reset ⇒ must change
	// Role changes apply to live sessions immediately.
	wantCode(t, e.do("PATCH", "/api/v1/users/wes", `{"role":"operator","mustChangePassword":false}`, bearer(legacyTok)), 200)
	wantCode(t, e.do("POST", "/api/v1/channels/c/start", "", cookie(sid3), csrf()), 200)
}

func TestSessionTimeouts(t *testing.T) {
	e := newEnv(t)
	e.a.CreateUser("vic", "password-vic", RoleViewer, false)
	sid := e.login("vic", "password-vic")
	e.clock.Advance(11 * time.Hour)
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(sid)), 200) // refreshes idle
	e.clock.Advance(12*time.Hour + time.Minute)
	wantCode(t, e.do("GET", "/api/v1/channels", "", cookie(sid)), 401) // idle expired

	sid = e.login("vic", "password-vic")
	elapsed := time.Duration(0)
	for elapsed < 8*24*time.Hour { // active every 11 h: only the 7 d absolute limit applies
		e.clock.Advance(11 * time.Hour)
		elapsed += 11 * time.Hour
		want := 200
		if elapsed > DefaultSessionMax {
			want = 401
		}
		if w := e.do("GET", "/api/v1/channels", "", cookie(sid)); w.Code != want {
			t.Fatalf("after %v: %d, want %d", elapsed, w.Code, want)
		}
		if want == 401 {
			return
		}
	}
	t.Fatal("unreachable")
}

func TestSessionCaps(t *testing.T) {
	c := newClock()
	s := newSessionStore(time.Hour, 2*time.Hour, func() time.Time { c.Advance(time.Second); return c.Now() })
	var ids []string
	for i := 0; i < maxSessionsPerUser+5; i++ {
		ids = append(ids, s.create("u"))
	}
	if s.count() != maxSessionsPerUser {
		t.Fatalf("sessions %d, want %d", s.count(), maxSessionsPerUser)
	}
	if _, ok := s.get(ids[len(ids)-1]); !ok {
		t.Fatal("newest session evicted")
	}
}

func TestPersistenceRoundTrip(t *testing.T) {
	e := newEnv(t)
	e.a.CreateUser("otto", "password-otto", RoleOperator, false)
	tok := e.token("ci", RoleViewer)
	old, _, _ := e.a.CreateToken("old", RoleAdmin)
	e.a.RevokeToken(old.ID)
	wantCode(t, e.do("GET", "/api/v1/channels", "", bearer(tok)), 200)
	e.clock.Advance(30 * time.Second)
	wantCode(t, e.do("GET", "/api/v1/channels", "", bearer(tok)), 200) // in-memory only, flushed by Close
	if err := e.a.Close(); err != nil {
		t.Fatal(err)
	}

	a2, pw, err := New(testOptions(e.dir, e.clock))
	if err != nil {
		t.Fatal(err)
	}
	defer a2.Close()
	if pw != "" {
		t.Fatal("bootstrap ran on reopen")
	}
	e2 := &env{t: t, a: a2, h: wrap(a2), clock: e.clock, dir: e.dir}
	e2.login("otto", "password-otto")
	wantCode(t, e2.do("GET", "/api/v1/channels", "", bearer(tok)), 200)
	var ci, revoked TokenInfo
	for _, x := range a2.Tokens() {
		switch x.Name {
		case "ci":
			ci = x
		case "old":
			revoked = x
		}
	}
	if !revoked.Revoked {
		t.Fatal("revocation not persisted")
	}
	if !ci.LastUsedAt.Equal(e.clock.Now()) {
		t.Fatalf("lastUsedAt %v not flushed on Close (want %v)", ci.LastUsedAt, e.clock.Now())
	}
	us := a2.Users()
	if len(us) != 2 || us[0].Name != "admin" || us[1].Name != "otto" || us[1].Role != RoleOperator {
		t.Fatalf("users after reopen %+v", us)
	}
	// Corrupt store is an error, never silently reset.
	_ = a2.Close()
	os.WriteFile(filepath.Join(e.dir, "users.json"), []byte("{nope"), 0o600)
	if _, _, err := New(testOptions(e.dir, e.clock)); err == nil {
		t.Fatal("corrupt users.json accepted")
	}
}

func TestClientIPTrustedProxies(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.TrustedProxies = []string{"10.0.0.1", "192.168.0.0/16"} })
	mk := func(remote, xff string) *http.Request {
		r, _ := http.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}
	cases := []struct{ remote, xff, want string }{
		{"203.0.113.1:1", "1.2.3.4", "203.0.113.1"},                // untrusted peer: XFF ignored
		{"10.0.0.1:1", "1.2.3.4", "1.2.3.4"},                       // trusted proxy
		{"10.0.0.1:1", "6.6.6.6, 1.2.3.4, 192.168.1.1", "1.2.3.4"}, // skip trusted hops, ignore spoofed left
		{"10.0.0.1:1", "", "10.0.0.1"},
		{"10.0.0.1:1", "garbage", "10.0.0.1"},
		{"[::ffff:10.0.0.1]:1", "1.2.3.4", "1.2.3.4"},
	}
	for _, c := range cases {
		if got := e.a.clientIP(mk(c.remote, c.xff)); got != c.want {
			t.Errorf("clientIP(%s, %q) = %s, want %s", c.remote, c.xff, got, c.want)
		}
	}
	if _, _, err := New(Options{DataDir: t.TempDir(), TrustedProxies: []string{"not-an-ip"}}); err == nil {
		t.Fatal("bad proxy accepted")
	}
	// Secure cookie behind a trusted TLS-terminating proxy.
	e.a.CreateUser("vic", "password-vic", RoleViewer, false)
	w := e.do("POST", "/api/v1/auth/login", `{"user":"vic","password":"password-vic"}`, from("10.0.0.1:3"), header("X-Forwarded-Proto", "https"))
	if c := sessionFrom(w); c == nil || !c.Secure {
		t.Fatal("cookie not Secure behind trusted https proxy")
	}
	w = e.do("POST", "/api/v1/auth/login", `{"user":"vic","password":"password-vic"}`, from("8.8.8.8:3"), header("X-Forwarded-Proto", "https"))
	if c := sessionFrom(w); c == nil || c.Secure {
		t.Fatal("untrusted X-Forwarded-Proto honored")
	}
}

func TestRoleOrdering(t *testing.T) {
	if !RoleAdmin.AtLeast(RoleOperator) || !RoleOperator.AtLeast(RoleViewer) || RoleViewer.AtLeast(RoleOperator) || Role("root").AtLeast(RoleViewer) {
		t.Fatal("role ordering broken")
	}
}
