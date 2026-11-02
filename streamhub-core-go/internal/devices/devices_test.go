package devices

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type fakeApps map[string]bool

func (f fakeApps) Exists(_ context.Context, app string) bool { return f[app] }

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type harness struct {
	t     *testing.T
	svc   *Service
	gw    *Gateway
	srv   *httptest.Server
	clk   *clock
	ing   *fakeIngress
	offns []string
	mu    sync.Mutex
}

// withPrincipal stands in for the auth guard: X-Test-User names the caller.
func withPrincipal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u := r.Header.Get("X-Test-User"); u != "" {
			r = r.WithContext(auth.WithPrincipal(r.Context(), &auth.Principal{UserID: u, Role: auth.Role("owner"), Scope: auth.ScopeUser}))
		}
		next.ServeHTTP(w, r)
	})
}

func newHarness(t *testing.T, enabled bool) *harness {
	t.Helper()
	_, g, _ := testutil.Store(t)
	h := &harness{t: t, clk: &clock{t: time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)}, ing: &fakeIngress{}}
	h.svc = New(Deps{
		DB: g, Enabled: enabled, PublicBaseURL: "https://media.example.com", Apps: fakeApps{"alpha": true, "beta": true},
		Offense: func(ip string) { h.mu.Lock(); h.offns = append(h.offns, ip); h.mu.Unlock() },
		Ingress: h.ing, Log: testutil.Log(), Now: h.clk.now,
	})
	h.gw = NewGateway(h.svc, nil, testutil.Log())
	h.gw.PingEvery = time.Hour
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	(&Module{Svc: h.svc}).Register(a)
	h.srv = httptest.NewServer(httpx.Chain(mux, h.gw.Middleware, withPrincipal, httpx.WithRequest))
	t.Cleanup(func() { h.gw.Shutdown(); h.srv.Close() })
	return h
}

type resp struct {
	code int
	body map[string]any
	raw  string
}

func (r resp) data() map[string]any {
	d, _ := r.body["data"].(map[string]any)
	return d
}

func (h *harness) do(method, path, user, ip string, body any) resp {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		js, _ := json.Marshal(body)
		rd = bytes.NewReader(js)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if user != "" {
		req.Header.Set("X-Test-User", user)
	}
	if ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{code: res.StatusCode, raw: string(raw)}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

type started struct{ id, code, poll string }

func (h *harness) start(ip string) started {
	h.t.Helper()
	r := h.do(http.MethodPost, "/api/v1/devices/pair/start", "", ip, map[string]any{"model": "SH-ENC-4", "version": "0.1.0"})
	if r.code != http.StatusCreated {
		h.t.Fatalf("pair/start: %d %s", r.code, r.raw)
	}
	d := r.data()
	return started{d["deviceId"].(string), d["code"].(string), d["pollToken"].(string)}
}

func (h *harness) poll(s started, token string) resp {
	return h.do(http.MethodGet, "/api/v1/devices/pair/"+s.id+"?token="+token, "", "203.0.113.9", nil)
}

func (h *harness) claim(app, code, user string) resp {
	return h.do(http.MethodPost, "/api/v1/apps/"+app+"/devices/claim", user, "198.51.100.7", map[string]any{"code": code, "name": "Cam truck"})
}

// pair runs the full flow and returns the device id + its credential.
func (h *harness) pair(app string) (string, string) {
	h.t.Helper()
	s := h.start("192.0.2.1")
	if r := h.claim(app, s.code, "owner-"+app); r.code != http.StatusCreated {
		h.t.Fatalf("claim: %d %s", r.code, r.raw)
	}
	r := h.poll(s, s.poll)
	if r.code != http.StatusOK || r.data()["credential"] == nil {
		h.t.Fatalf("poll: %d %s", r.code, r.raw)
	}
	return s.id, r.data()["credential"].(string)
}

func (h *harness) dial(cred string) (*websocket.Conn, *http.Response, error) {
	hdr := http.Header{}
	if cred != "" {
		hdr.Set("Authorization", "Device "+cred)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.srv.URL, "http")+WSPath, &websocket.DialOptions{HTTPHeader: hdr})
}

func readFrame(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func writeFrame(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	js, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, js); err != nil {
		t.Fatal(err)
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// ---------------------------------------------------------------------------
// codes + credentials
// ---------------------------------------------------------------------------

func TestCodesAreUnambiguousAndNormalize(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 2000; i++ {
		c := newCode()
		if len(c) != CodeLength {
			t.Fatalf("code %q length", c)
		}
		for _, r := range c {
			if !strings.ContainsRune(CodeAlphabet, r) {
				t.Fatalf("code %q has %q", c, r)
			}
		}
		seen[c] = true
	}
	if len(seen) < 1990 {
		t.Fatalf("only %d distinct codes of 2000", len(seen))
	}
	for in, want := range map[string]string{"k7q4-m2xp": "K7Q4M2XP", " K7Q4 M2XP ": "K7Q4M2XP", "K7Q4.M2XP": "K7Q4M2XP"} {
		if got, ok := NormalizeCode(in); !ok || got != want {
			t.Errorf("NormalizeCode(%q) = %q %v", in, got, ok)
		}
	}
	for _, bad := range []string{"", "K7Q4M2X", "K7Q4M2XPZ", "K7Q4M2X0", "K7Q4M2XI", "K7Q4M2X%"} {
		if _, ok := NormalizeCode(bad); ok {
			t.Errorf("NormalizeCode(%q) accepted", bad)
		}
	}
	if DisplayCode("K7Q4M2XP") != "K7Q4-M2XP" {
		t.Fatal("display code")
	}
}

func TestParseCredential(t *testing.T) {
	cred := newCredential("dev_0123456789abcdef")
	if id, ok := ParseCredential(cred); !ok || id != "dev_0123456789abcdef" {
		t.Fatalf("ParseCredential(%q) = %q %v", cred, id, ok)
	}
	for _, bad := range []string{"", "dk_", "sk_dev_x.yyyy", "dk_dev_0123456789abcdef", "dk_dev_0123456789abcdef.short", "dk_node_1." + strings.Repeat("a", 43)} {
		if _, ok := ParseCredential(bad); ok {
			t.Errorf("ParseCredential(%q) accepted", bad)
		}
	}
}

// ---------------------------------------------------------------------------
// pairing
// ---------------------------------------------------------------------------

// INVARIANT: the full flow — pending until claimed, then the credential is
// delivered exactly once and only its hash is stored.
func TestPairingDeliversTheCredentialExactlyOnce(t *testing.T) {
	h := newHarness(t, true)
	s := h.start("192.0.2.1")
	if len(s.code) != CodeLength {
		t.Fatalf("code %q", s.code)
	}
	if r := h.poll(s, s.poll); r.code != http.StatusOK || r.data()["status"] != "pending" || r.data()["credential"] != nil {
		t.Fatalf("pending poll: %d %s", r.code, r.raw)
	}
	r := h.claim("alpha", strings.ToLower(DisplayCode(s.code)), "owner-a")
	if r.code != http.StatusCreated || r.data()["id"] != s.id || r.data()["app"] != "alpha" || r.data()["paired"] != false {
		t.Fatalf("claim: %d %s", r.code, r.raw)
	}
	r = h.poll(s, s.poll)
	d := r.data()
	if r.code != http.StatusOK || d["status"] != "claimed" || d["app"] != "alpha" || d["wsUrl"] != "wss://media.example.com"+WSPath {
		t.Fatalf("claimed poll: %d %s", r.code, r.raw)
	}
	cred, _ := d["credential"].(string)
	if id, ok := ParseCredential(cred); !ok || id != s.id {
		t.Fatalf("credential %q", cred)
	}
	// replay of the poll: nothing more to hand out
	if r := h.poll(s, s.poll); r.code != http.StatusNotFound || strings.Contains(r.raw, "dk_") {
		t.Fatalf("second poll: %d %s", r.code, r.raw)
	}
	var stored string
	if err := h.svc.db.QueryRow(`SELECT credential_hash FROM devices WHERE id = ?`, s.id).Scan(&stored); err != nil || stored != hashSecret(cred) {
		t.Fatalf("stored credential: %q %v", stored, err)
	}
	var n int
	h.svc.db.QueryRow(`SELECT COUNT(*) FROM device_pairings`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d pairings left", n)
	}
	if g := h.do(http.MethodGet, "/api/v1/apps/alpha/devices/"+s.id, "owner-a", "", nil); g.code != 200 || g.data()["paired"] != true {
		t.Fatalf("get: %d %s", g.code, g.raw)
	}
}

// SECURITY: a wrong poll token answers like an unknown pairing and
// MaxPollFailures of them burn it — the right token no longer works.
func TestWrongPollTokensBurnThePairing(t *testing.T) {
	h := newHarness(t, true)
	s := h.start("192.0.2.1")
	if r := h.claim("alpha", s.code, "owner-a"); r.code != http.StatusCreated {
		t.Fatalf("claim: %d", r.code)
	}
	for i := 0; i < MaxPollFailures; i++ {
		if r := h.poll(s, "guess"+string(rune('a'+i))); r.code != http.StatusNotFound || r.body["message"] != msgUnknownPair {
			t.Fatalf("wrong token %d: %d %s", i, r.code, r.raw)
		}
	}
	if r := h.poll(s, s.poll); r.code != http.StatusNotFound || strings.Contains(r.raw, "dk_") {
		t.Fatalf("right token after the burn: %d %s", r.code, r.raw)
	}
	if len(h.offns) < MaxPollFailures {
		t.Fatalf("offenses %v", h.offns)
	}
}

// SECURITY: guessing codes locks the caller (backoff) — the right code is
// refused while locked — and the per-IP window caps attempts.
func TestClaimBruteForceIsThrottled(t *testing.T) {
	h := newHarness(t, true)
	s := h.start("192.0.2.1")
	wrong := "AAAAAAAA"
	if wrong == s.code {
		wrong = "BBBBBBBB"
	}
	for i := 0; i < 5; i++ {
		if r := h.claim("alpha", wrong, "attacker"); r.code != http.StatusNotFound || r.body["message"] != msgBadCode {
			t.Fatalf("guess %d: %d %s", i, r.code, r.raw)
		}
	}
	if r := h.claim("alpha", s.code, "attacker"); r.code != http.StatusTooManyRequests {
		t.Fatalf("locked account accepted the right code: %d %s", r.code, r.raw)
	}
	// another account is not locked
	if r := h.claim("alpha", s.code, "owner-a"); r.code != http.StatusCreated {
		t.Fatalf("other account: %d %s", r.code, r.raw)
	}
	// the per-IP window: 30 attempts/min from one address
	h2 := newHarness(t, true)
	got429 := false
	for i := 0; i < 40 && !got429; i++ {
		r := h2.claim("alpha", wrong, "user-"+string(rune('a'+i%26))+string(rune('a'+i/26)))
		got429 = r.code == http.StatusTooManyRequests
	}
	if !got429 {
		t.Fatal("per-IP claim window never tripped")
	}
}

// INVARIANT: an unclaimed code dies after CodeTTL.
func TestPairingCodeExpires(t *testing.T) {
	h := newHarness(t, true)
	s := h.start("192.0.2.1")
	h.clk.add(CodeTTL + time.Second)
	if r := h.claim("alpha", s.code, "owner-a"); r.code != http.StatusNotFound {
		t.Fatalf("expired code claimed: %d %s", r.code, r.raw)
	}
	if r := h.poll(s, s.poll); r.code != http.StatusNotFound {
		t.Fatalf("expired pairing polled: %d %s", r.code, r.raw)
	}
}

// SECURITY: a code is single use — a second app can't claim it — and a
// device is invisible / untouchable through another app's routes.
func TestCrossAppClaimAndAccess(t *testing.T) {
	h := newHarness(t, true)
	s := h.start("192.0.2.1")
	if r := h.claim("alpha", s.code, "owner-a"); r.code != http.StatusCreated {
		t.Fatalf("claim: %d", r.code)
	}
	if r := h.claim("beta", s.code, "owner-b"); r.code != http.StatusNotFound {
		t.Fatalf("second claim from another app: %d %s", r.code, r.raw)
	}
	if r := h.poll(s, s.poll); r.data()["app"] != "alpha" {
		t.Fatalf("credential bound to %v", r.data()["app"])
	}
	base := "/api/v1/apps/beta/devices/" + s.id
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, base, nil},
		{http.MethodGet, base + "/status", nil},
		{http.MethodPatch, base, map[string]any{"name": "pwned"}},
		{http.MethodPost, base + "/commands", map[string]any{"action": "stop", "channel": "1"}},
		{http.MethodDelete, base, nil},
	} {
		if r := h.do(c.method, c.path, "owner-b", "", c.body); r.code != http.StatusNotFound {
			t.Errorf("%s %s via the other app: %d %s", c.method, c.path, r.code, r.raw)
		}
	}
	if l := h.do(http.MethodGet, "/api/v1/apps/beta/devices", "owner-b", "", nil); len(l.body["data"].([]any)) != 0 {
		t.Fatalf("beta lists alpha's device: %s", l.raw)
	}
	if r := h.claim("ghost", "AAAAAAAA", "owner-a"); r.code != http.StatusNotFound || r.body["message"] != msgUnknownApp {
		t.Fatalf("unknown app: %d %s", r.code, r.raw)
	}
}

func TestPairStartCapsPerIP(t *testing.T) {
	h := newHarness(t, true)
	for i := 0; i < MaxPendingPerIP; i++ {
		h.start("192.0.2.50")
	}
	if r := h.do(http.MethodPost, "/api/v1/devices/pair/start", "", "192.0.2.50", nil); r.code != http.StatusTooManyRequests {
		t.Fatalf("6th pending pairing from one IP: %d %s", r.code, r.raw)
	}
	// expired pairings are purged and free the slots
	h.clk.add(CodeTTL + time.Second)
	if r := h.do(http.MethodPost, "/api/v1/devices/pair/start", "", "192.0.2.50", nil); r.code != http.StatusCreated {
		t.Fatalf("after expiry: %d %s", r.code, r.raw)
	}
}

func TestDisabledByDefault(t *testing.T) {
	h := newHarness(t, false)
	if r := h.do(http.MethodPost, "/api/v1/devices/pair/start", "", "", nil); r.code != http.StatusServiceUnavailable {
		t.Fatalf("pair/start while off: %d", r.code)
	}
	if r := h.do(http.MethodGet, "/api/v1/apps/alpha/devices", "owner-a", "", nil); r.code != http.StatusServiceUnavailable {
		t.Fatalf("list while off: %d", r.code)
	}
	_, res, err := h.dial("dk_dev_0123456789abcdef." + strings.Repeat("a", 43))
	if err == nil || res == nil || res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("ws while off: %v %v", err, res)
	}
}

// ---------------------------------------------------------------------------
// WS control channel
// ---------------------------------------------------------------------------

func TestWSHelloConfigStatusCommand(t *testing.T) {
	h := newHarness(t, true)
	id, cred := h.pair("alpha")
	for _, bad := range []string{"", "garbage", cred + "x", strings.Replace(cred, id, "dev_ffffffffffffffff", 1)} {
		if _, res, err := h.dial(bad); err == nil || res == nil || res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("dial with %q: %v %v", bad, err, res)
		}
	}
	c, _, err := h.dial(cred)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	writeFrame(t, c, map[string]any{"type": "hello", "model": "SH-ENC-4", "version": "0.2.0",
		"capabilities": map[string]any{"channels": []any{map[string]any{"id": "1"}}, "encoders": []string{"x264", "nvenc"}}})
	cfg := readFrame(t, c)
	if cfg["type"] != "config" || cfg["device"].(map[string]any)["id"] != id || cfg["device"].(map[string]any)["app"] != "alpha" {
		t.Fatalf("config: %v", cfg)
	}
	writeFrame(t, c, map[string]any{"type": "status", "cpu": 41.5, "gpu": 12,
		"channels": []any{map[string]any{"id": "1", "state": "live", "bitrateKbps": 6000, "fps": 50}}})
	eventually(t, "status persisted", func() bool {
		r := h.do(http.MethodGet, "/api/v1/apps/alpha/devices/"+id+"/status", "owner-a", "", nil)
		st, _ := r.data()["status"].(map[string]any)
		return r.data()["online"] == true && st != nil && st["cpu"] == 41.5 && st["receivedAt"] != nil
	})
	if r := h.do(http.MethodGet, "/api/v1/apps/alpha/devices/"+id, "owner-a", "", nil); r.data()["version"] != "0.2.0" ||
		r.data()["capabilities"].(map[string]any)["encoders"] == nil {
		t.Fatalf("hello not persisted: %s", r.raw)
	}

	// command round trip
	done := make(chan resp, 1)
	go func() {
		done <- h.do(http.MethodPost, "/api/v1/apps/alpha/devices/"+id+"/commands", "owner-a", "", map[string]any{"action": "restart", "channel": "1"})
	}()
	cmd := readFrame(t, c)
	if cmd["type"] != "command" || cmd["action"] != "restart" || cmd["channel"] != "1" || cmd["id"] == "" {
		t.Fatalf("command frame: %v", cmd)
	}
	writeFrame(t, c, map[string]any{"type": "command_result", "id": cmd["id"], "ok": true, "message": "restarted"})
	r := <-done
	if r.code != http.StatusOK || r.data()["ok"] != true || r.data()["message"] != "restarted" {
		t.Fatalf("command: %d %s", r.code, r.raw)
	}
	// validation
	for _, body := range []map[string]any{{"action": "explode"}, {"action": "stop"}, {"action": "reboot"}, {"action": "apply_preset", "channel": "1"}} {
		if r := h.do(http.MethodPost, "/api/v1/apps/alpha/devices/"+id+"/commands", "owner-a", "", body); r.code != http.StatusBadRequest {
			t.Errorf("command %v: %d %s", body, r.code, r.raw)
		}
	}
}

// SECURITY: revoking a device closes its live socket (4401) and its
// credential is refused from then on (replay of the old credential).
func TestRevokedDeviceIsCutOff(t *testing.T) {
	h := newHarness(t, true)
	id, cred := h.pair("alpha")
	c, _, err := h.dial(cred)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	writeFrame(t, c, map[string]any{"type": "hello"})
	readFrame(t, c) // config
	if r := h.do(http.MethodDelete, "/api/v1/apps/alpha/devices/"+id, "owner-a", "", nil); r.code != http.StatusOK || r.data()["revoked"] != true {
		t.Fatalf("revoke: %d %s", r.code, r.raw)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err = c.Read(ctx)
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != CloseRevoked {
		t.Fatalf("live socket after revoke: %v", err)
	}
	if _, res, err := h.dial(cred); err == nil || res == nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked credential replayed: %v %v", err, res)
	}
	if h.gw.IsConnected(id) {
		t.Fatal("still connected")
	}
	// a re-pair mints a NEW credential; the old one stays dead
	id2, cred2 := h.pair("alpha")
	if id2 == id || cred2 == cred {
		t.Fatal("re-pair reused the identity")
	}
	if _, res, err := h.dial(cred); err == nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old credential after re-pair: %v", err)
	}
}

func TestNewerConnectionReplacesOlder(t *testing.T) {
	h := newHarness(t, true)
	_, cred := h.pair("alpha")
	c1, _, err := h.dial(cred)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.CloseNow()
	c2, _, err := h.dial(cred)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err = c1.Read(ctx)
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != CloseReplaced {
		t.Fatalf("older socket: %v", err)
	}
	writeFrame(t, c2, map[string]any{"type": "hello"})
	if f := readFrame(t, c2); f["type"] != "config" {
		t.Fatalf("newer socket: %v", f)
	}
}

func TestCommandToOfflineDevice(t *testing.T) {
	h := newHarness(t, true)
	id, _ := h.pair("alpha")
	if r := h.do(http.MethodPost, "/api/v1/apps/alpha/devices/"+id+"/commands", "owner-a", "", map[string]any{"action": "stop", "channel": "1"}); r.code != http.StatusServiceUnavailable {
		t.Fatalf("offline command: %d %s", r.code, r.raw)
	}
	if r := h.do(http.MethodPatch, "/api/v1/apps/alpha/devices/"+id, "owner-a", "", map[string]any{"name": "Truck 2"}); r.code != http.StatusOK || r.data()["name"] != "Truck 2" {
		t.Fatalf("rename: %d %s", r.code, r.raw)
	}
}
