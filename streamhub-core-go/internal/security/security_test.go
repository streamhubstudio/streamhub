package security

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

func newRules(t *testing.T) (*Rules, *sql.DB) {
	t.Helper()
	_, g, _ := testutil.Store(t)
	r := NewRules(g, testutil.Log())
	r.Init(context.Background())
	r.Init(context.Background()) // idempotent
	return r, g
}

func TestRules(t *testing.T) {
	r, g := newRules(t)
	ctx := context.Background()
	if r.Evaluate("8.8.8.8") != MatchNone {
		t.Fatal("no rules → none")
	}
	v4, err := r.Add(ctx, "203.0.113.7", "block", ptr("  scanner "), ptr("admin"))
	if err != nil || v4.CIDR != "203.0.113.7/32" || *v4.Note != "scanner" || *v4.CreatedBy != "admin" || v4.CreatedAt == "" {
		t.Fatalf("%+v %v", v4, err)
	}
	if v6, _ := r.Add(ctx, "2001:db8::1", "block", ptr(""), nil); v6.CIDR != "2001:db8::1/128" || v6.Note != nil {
		t.Fatalf("%+v", v6)
	}
	if _, err := r.Add(ctx, "nope", "block", nil, nil); err == nil || !strings.Contains(err.Error(), "invalid CIDR") {
		t.Fatalf("invalid: %v", err)
	}
	if _, err := r.Add(ctx, "203.0.113.7/32", "block", nil, nil); err == nil || !strings.Contains(err.Error(), "rule already exists (id 1)") {
		t.Fatalf("dup: %v", err)
	}
	r.Add(ctx, "198.51.100.0/24", "block", nil, nil)
	if r.Evaluate("198.51.100.9") != MatchBlock || r.Evaluate("2001:db8::1") != MatchBlock {
		t.Fatal("block by CIDR")
	}
	allow, _ := r.Add(ctx, "198.51.100.9", "allow", nil, nil)
	if r.Evaluate("198.51.100.9") != MatchAllow || !r.IsAllowlisted("198.51.100.9") || r.Evaluate("198.51.100.10") != MatchBlock {
		t.Fatal("allow must win over an overlapping block")
	}
	if r.Evaluate("garbage") != MatchNone {
		t.Fatal("unparseable never matches")
	}
	if total, a, b := r.Counts(); total != 4 || a != 1 || b != 3 {
		t.Fatalf("counts %d %d %d", total, a, b)
	}
	list, _ := r.List(ctx)
	if len(list) != 4 || list[0].ID != allow.ID {
		t.Fatal("list newest first")
	}
	if err := r.Remove(ctx, allow.ID); err != nil || r.Evaluate("198.51.100.9") != MatchBlock {
		t.Fatal("remove takes effect immediately")
	}
	if err := r.Remove(ctx, 999); err == nil || !strings.Contains(err.Error(), "ip rule 999 not found") {
		t.Fatalf("404: %v", err)
	}
	// Survives a restart (recompiled from the DB).
	r2 := NewRules(g, testutil.Log())
	r2.Init(ctx)
	if r2.Evaluate("203.0.113.7") != MatchBlock {
		t.Fatal("rules not reloaded")
	}
}

func ptr(s string) *string { return &s }

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }
func repSettings(enabled bool) Settings {
	return Settings{Mode: "off", AutobanEnabled: enabled, AutobanMaxOffenses: 3, AutobanWindowS: 60, AutobanBaseTTLS: 100}
}

func newRep(t *testing.T, s Settings) (*Reputation, *Rules, *clock) {
	t.Helper()
	r, g := newRules(t)
	rep := NewReputation(g, s, r, testutil.Log())
	c := &clock{time.Now()}
	rep.now = c.now
	rep.Init(context.Background())
	return rep, r, c
}

const pub = "203.0.113.50"

func TestReputationThresholdWindowExpiry(t *testing.T) {
	rep, _, c := newRep(t, repSettings(true))
	rep.RecordOffense(pub, OffenseLoginFailed)
	rep.RecordOffense(pub, OffenseLoginFailed)
	if rep.IsBanned(pub) {
		t.Fatal("banned before threshold")
	}
	c.add(61 * time.Second) // first two slide out of the window
	rep.RecordOffense(pub, OffenseLoginFailed)
	if rep.IsBanned(pub) {
		t.Fatal("old offenses counted")
	}
	rep.RecordOffense(pub, OffenseLoginFailed)
	rep.RecordOffense(pub, OffenseInvalidToken)
	if !rep.IsBanned(pub) {
		t.Fatal("not banned at threshold")
	}
	until := rep.ActiveBans()[0].BannedUntil
	rep.RecordOffense(pub, OffenseLoginFailed) // idempotent while banned
	if rep.ActiveBans()[0].BannedUntil != until {
		t.Fatal("TTL extended while banned")
	}
	c.add(101 * time.Second)
	if rep.IsBanned(pub) {
		t.Fatal("ban did not expire")
	}
}

func TestReputationEscalationPersistenceUnban(t *testing.T) {
	rep, rules, c := newRep(t, repSettings(true))
	ctx := context.Background()
	ban := func() BanView {
		for i := 0; i < 3; i++ {
			rep.RecordOffense(pub, OffenseLoginFailed)
		}
		return rep.ActiveBans()[0]
	}
	b0 := ban()
	if b0.EscalationLevel != 0 || b0.Reason != "login_failed" || b0.OffenseCount != 3 {
		t.Fatalf("%+v", b0)
	}
	c.add(101 * time.Second)
	b1 := ban()
	if b1.EscalationLevel != 1 || b1.FirstSeen != b0.FirstSeen {
		t.Fatalf("%+v", b1)
	}
	if got, _ := time.Parse(time.RFC3339, b1.BannedUntil); got.Sub(c.t).Round(time.Second) != 200*time.Second {
		t.Fatalf("ttl %v", got.Sub(c.t))
	}
	// Survives restart while active; an expired one does not.
	rep2 := NewReputation(rep.db, rep.Settings, rules, testutil.Log())
	rep2.now = c.now
	rep2.Init(ctx)
	if !rep2.IsBanned(pub) {
		t.Fatal("active ban not restored")
	}
	c.add(201 * time.Second)
	rep3 := NewReputation(rep.db, rep.Settings, rules, testutil.Log())
	rep3.now = c.now
	rep3.Init(ctx)
	if rep3.IsBanned(pub) {
		t.Fatal("expired ban restored")
	}
	if recent, _ := rep3.RecentBans(ctx, 50); len(recent) != 1 || recent[0].Active {
		t.Fatalf("recent %+v", recent)
	}
	// Unban is a clean slate: next ban restarts at level 0.
	if !rep.Unban(ctx, pub) || rep.Unban(ctx, "198.51.100.1") {
		t.Fatal("unban result")
	}
	if b := ban(); b.EscalationLevel != 0 {
		t.Fatalf("escalation not reset: %+v", b)
	}
}

func TestReputationNeverBansAndKillSwitch(t *testing.T) {
	rep, rules, _ := newRep(t, repSettings(true))
	rules.Add(context.Background(), "198.51.100.77", "allow", nil, nil)
	for i := 0; i < 5; i++ {
		rep.RecordOffense("127.0.0.1", OffenseLoginFailed)
		rep.RecordOffense("10.0.0.1", OffenseLoginFailed)
		rep.RecordOffense("198.51.100.77", OffenseLoginFailed)
		rep.RecordOffense("", OffenseLoginFailed)
		rep.RecordOffense("garbage", OffenseLoginFailed)
	}
	if rep.IsBanned("127.0.0.1") || rep.IsBanned("10.0.0.1") || rep.IsBanned("198.51.100.77") {
		t.Fatal("private/allowlisted banned")
	}
	off := rep.Offenders(50)
	if len(off) != 3 || off[0].Count != 5 || off[0].Kinds["login_failed"] != 5 {
		t.Fatalf("offenders still visible: %+v", off)
	}

	dormant, _, _ := newRep(t, repSettings(false))
	for i := 0; i < 5; i++ {
		dormant.RecordOffense(pub, OffenseLoginFailed)
	}
	if dormant.IsBanned(pub) || len(dormant.Offenders(50)) != 0 {
		t.Fatal("autoban off must be a no-op")
	}
}

func serve(t *testing.T, s Settings, rules *Rules, rep *Reputation, status int) func(xff string) (*httptest.ResponseRecorder, bool) {
	t.Helper()
	var annotated bool
	h := Middleware(s, rules, rep, testutil.Log())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		annotated = WouldBlock(r.Context())
		w.WriteHeader(status)
	}))
	return func(ip string) (*httptest.ResponseRecorder, bool) {
		annotated = false
		r := httptest.NewRequest("GET", "/api/v1/x", nil)
		r.RemoteAddr = ip + ":5555"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w, annotated
	}
}

func TestMiddleware(t *testing.T) {
	rep, rules, _ := newRep(t, repSettings(true))
	ctx := context.Background()
	rules.Add(ctx, "203.0.113.0/24", "block", nil, nil)
	rules.Add(ctx, "203.0.113.9", "allow", nil, nil)
	rules.Add(ctx, "127.0.0.0/8", "block", nil, nil) // pointless: loopback is always permitted
	for i := 0; i < 3; i++ {
		rep.RecordOffense("198.51.100.5", OffenseLoginFailed)
		rep.RecordOffense("203.0.113.9", OffenseLoginFailed) // allowlisted: never banned
	}

	enforce := Settings{Mode: "enforce", AutobanEnabled: true}
	do := serve(t, enforce, rules, rep, 200)
	cases := []struct {
		ip   string
		code int
		body string
	}{
		{"127.0.0.1", 200, ""}, {"10.0.0.7", 200, ""}, {"192.168.1.1", 200, ""}, {"::1", 200, ""}, {"fd00::5", 200, ""},
		{"203.0.113.10", 403, `{"data":null,"error":{"code":"forbidden","message":"Access denied"}}`},
		{"198.51.100.5", 429, `{"data":null,"error":{"code":"rate_limited","message":"Too many requests. Please retry later."}}`},
		{"203.0.113.9", 200, ""}, // explicit allow beats block
		{"8.8.8.8", 200, ""},
	}
	for _, c := range cases {
		w, _ := do(c.ip)
		if w.Code != c.code || strings.TrimSpace(w.Body.String()) != c.body && c.body != "" {
			t.Errorf("%s: %d %s", c.ip, w.Code, w.Body)
		}
	}

	only := serve(t, Settings{Mode: "enforce", AllowlistOnly: true}, rules, rep, 200)
	if w, _ := only("8.8.8.8"); w.Code != 403 {
		t.Fatal("allowlist-only must reject unlisted public IPs")
	}
	if w, _ := only("203.0.113.9"); w.Code != 200 {
		t.Fatal("allowlisted IP rejected")
	}
	if w, _ := only("127.0.0.1"); w.Code != 200 {
		t.Fatal("loopback rejected in allowlist-only")
	}

	logMode := serve(t, Settings{Mode: "log"}, rules, rep, 200)
	if w, ann := logMode("203.0.113.10"); w.Code != 200 || !ann {
		t.Fatal("log mode must pass + annotate")
	}
	if _, ann := logMode("8.8.8.8"); ann {
		t.Fatal("non-matching annotated")
	}

	dormant := serve(t, Settings{Mode: "off"}, rules, rep, 200)
	if w, _ := dormant("198.51.100.5"); w.Code != 200 {
		t.Fatal("dormant must pass everything")
	}
	if w, _ := serve(t, Settings{Mode: "off", AutobanEnabled: true}, rules, rep, 200)("198.51.100.5"); w.Code != 429 {
		t.Fatal("mode=off still enforces bans when autoban is on")
	}
}

func TestMiddlewareXFFSpoofing(t *testing.T) {
	rep, rules, _ := newRep(t, repSettings(true))
	rules.Add(context.Background(), "203.0.113.0/24", "block", nil, nil)
	h := Middleware(Settings{Mode: "enforce", AutobanEnabled: true}, rules, rep, testutil.Log())(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	// Behind one proxy the client is the right-most XFF hop; a client-supplied
	// left-most "127.0.0.1" must not ride the private fast-path.
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.2:1234" // the proxy
	r.Header.Set("X-Forwarded-For", "127.0.0.1, 203.0.113.10")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("spoofed XFF bypassed the blocklist: %d", w.Code)
	}
	if httpx.ClientIP(r) != "203.0.113.10" {
		t.Fatal("client IP resolution changed")
	}
}

func TestMiddleware404Storm(t *testing.T) {
	s := repSettings(true)
	s.Autoban404Enabled = true
	rep, rules, _ := newRep(t, s)
	do := serve(t, s, rules, rep, 404)
	for i := 0; i < 3; i++ {
		do("198.51.100.8")
	}
	if !rep.IsBanned("198.51.100.8") {
		t.Fatal("404 storm not recorded")
	}
	s2 := repSettings(true)
	rep2, rules2, _ := newRep(t, s2)
	do2 := serve(t, s2, rules2, rep2, 404)
	for i := 0; i < 3; i++ {
		do2("198.51.100.8")
	}
	if len(rep2.Offenders(10)) != 0 {
		t.Fatal("404s counted with the flag off")
	}
}

func TestNetworkGuard(t *testing.T) {
	rep, rules, _ := newRep(t, repSettings(true))
	rules.Add(context.Background(), "203.0.113.0/24", "block", nil, nil)
	for i := 0; i < 3; i++ {
		rep.RecordOffense("198.51.100.5", OffenseLoginFailed)
	}
	g := NewNetworkGuard(Settings{Mode: "enforce", AutobanEnabled: true}, rules, rep)
	for ip, want := range map[string]UpgradeRejectReason{
		"": "", "127.0.0.1": "", "8.8.8.8": "", "198.51.100.5": RejectBanned, "203.0.113.1": RejectBlocked, "::ffff:203.0.113.1": RejectBlocked,
	} {
		if got := g.RejectUpgradeReason(ip); got != want {
			t.Errorf("%q → %q", ip, got)
		}
	}
	if NewNetworkGuard(Settings{Mode: "log", AutobanEnabled: false}, rules, rep).RejectUpgradeReason("203.0.113.1") != "" {
		t.Fatal("log mode must never reject")
	}
}

func TestResolveSettings(t *testing.T) {
	env := map[string]string{"STREAMHUB_IP_ACCESS_MODE": " Enforce ", "STREAMHUB_AUTOBAN_ENABLED": "yes", "STREAMHUB_AUTOBAN_MAX_OFFENSES": "-1", "STREAMHUB_AUTOBAN_WINDOW_S": "120x"}
	s := ResolveSettings(func(k string) string { return env[k] })
	if s.Mode != "enforce" || !s.AutobanEnabled || s.AutobanMaxOffenses != 10 || s.AutobanWindowS != 120 || s.AutobanBaseTTLS != 900 || s.AllowlistOnly {
		t.Fatalf("%+v", s)
	}
	if ResolveSettings(func(string) string { return "bogus" }).Mode != "off" {
		t.Fatal("unknown mode must be off")
	}
}
