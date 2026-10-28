package wsingest

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

const testApp = "live"

var bg = context.Background()

type inMsg struct {
	binary bool
	data   []byte
}

// fakeConn is a scripted socket: the test pushes inbound messages, the
// service's writes/closes are recorded.
type fakeConn struct {
	in         chan inMsg
	done       chan struct{}
	once       sync.Once
	mu         sync.Mutex
	texts      []string
	bins       [][]byte
	closeCode  int
	closeWhy   string
	terminated bool
	pongs      bool
	sent       chan struct{}
}

func newFakeConn() *fakeConn {
	return &fakeConn{in: make(chan inMsg, 64), done: make(chan struct{}), pongs: true, sent: make(chan struct{}, 256)}
}

func (f *fakeConn) Read(ctx context.Context) (bool, []byte, error) {
	select {
	case m := <-f.in:
		return m.binary, m.data, nil
	case <-f.done:
		return false, nil, errors.New("closed")
	case <-ctx.Done():
		return false, nil, ctx.Err()
	}
}
func (f *fakeConn) WriteText(_ context.Context, b []byte) error {
	f.mu.Lock()
	f.texts = append(f.texts, string(b))
	f.mu.Unlock()
	f.sent <- struct{}{}
	return nil
}
func (f *fakeConn) WriteBinary(_ context.Context, b []byte) error {
	f.mu.Lock()
	f.bins = append(f.bins, b)
	f.mu.Unlock()
	f.sent <- struct{}{}
	return nil
}
func (f *fakeConn) Close(code int, reason string) {
	f.mu.Lock()
	if f.closeCode == 0 {
		f.closeCode, f.closeWhy = code, reason
	}
	f.mu.Unlock()
	f.once.Do(func() { close(f.done) })
}
func (f *fakeConn) Terminate() {
	f.mu.Lock()
	f.terminated = true
	f.mu.Unlock()
	f.once.Do(func() { close(f.done) })
}
func (f *fakeConn) Ping(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pongs {
		return nil
	}
	return errors.New("no pong")
}

func (f *fakeConn) code() int { f.mu.Lock(); defer f.mu.Unlock(); return f.closeCode }

// messages decodes every text frame sent so far.
func (f *fakeConn) messages() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, t := range f.texts {
		var m map[string]any
		_ = json.Unmarshal([]byte(t), &m)
		out = append(out, m)
	}
	return out
}

func (f *fakeConn) ready() map[string]any {
	for _, m := range f.messages() {
		if m["type"] == "ready" {
			return m
		}
	}
	return nil
}

type fakeStreams struct {
	mu       sync.Mutex
	upserts  []string
	ends     []string
	upserted chan struct{}
}

func (f *fakeStreams) Upsert(_ context.Context, _, id, typ, _, _ string) error {
	f.mu.Lock()
	f.upserts = append(f.upserts, id+"|"+typ)
	f.mu.Unlock()
	return nil
}
func (f *fakeStreams) End(_ context.Context, _, id string) error {
	f.mu.Lock()
	f.ends = append(f.ends, id)
	f.mu.Unlock()
	return nil
}
func (f *fakeStreams) endCount() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.ends) }

type event struct {
	app, name string
	payload   any
}

type fakeCallbacks struct {
	mu     sync.Mutex
	events []event
}

func (f *fakeCallbacks) Dispatch(_ context.Context, app, ev string, p any) error {
	f.mu.Lock()
	f.events = append(f.events, event{app, ev, p})
	f.mu.Unlock()
	return nil
}
func (f *fakeCallbacks) names() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, e := range f.events {
		out = append(out, e.name)
	}
	return out
}

type fakeQuotas struct{ err error }

func (f *fakeQuotas) EnforceConcurrentStreams(context.Context, *auth.Principal) error { return f.err }

type fakeApps struct {
	dataDir string
	cfg     contracts.AppConfig
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Get(context.Context, string) (*contracts.AppRecord, error) { return nil, nil }
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(_ context.Context, name string) (*contracts.AppConfig, error) {
	if name != testApp {
		return nil, errors.New("app not found")
	}
	c := f.cfg
	return &c, nil
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (f *fakeApps) AppDir(n string) string { return filepath.Join(f.dataDir, "apps", n) }

func defaultCfg() contracts.AppConfig {
	return contracts.AppConfig{Name: testApp, RoomPrefix: testApp, Features: contracts.AppFeatures{
		PublicPlayback: true,
		WsIngest:       &contracts.WsIngestFeatures{Enabled: true, MaxFps: 15, MaxFrameKb: 256, MaxDataBytes: DefaultMaxDataBytes, MaxDataPerSec: DefaultMaxDataPerSec},
	}}
}

type fixture struct {
	t       *testing.T
	svc     *Service
	auth    *livekit.IngressAuth
	streams *fakeStreams
	cb      *fakeCallbacks
	quotas  *fakeQuotas
	apps    *fakeApps
	clock   *clock
	dir     string
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func newFixture(t *testing.T) *fixture {
	store, g, dir := testutil.Store(t)
	testutil.Exec(t, g, "INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)", testApp, testApp)
	f := &fixture{t: t, auth: livekit.NewIngressAuth(store.App), streams: &fakeStreams{}, cb: &fakeCallbacks{},
		quotas: &fakeQuotas{}, apps: &fakeApps{dataDir: dir, cfg: defaultCfg()}, clock: &clock{t: time.Unix(1_800_000_000, 0)}, dir: dir}
	f.svc = New(Deps{
		Global: g, AppDB: store.App, DataDir: dir, LivekitKey: "devkey", LivekitSecret: "devsecret-devsecret-devsecret-0123",
		IngressAuth: f.auth, Apps: f.apps,
		Quotas:    func() Quotas { return f.quotas },
		Streams:   func() Streams { return f.streams },
		Callbacks: func() Callbacks { return f.cb },
		Log:       testutil.Log(), Now: f.clock.now,
	})
	return f
}

func (f *fixture) mint(room string) string {
	_, key, err := f.auth.RegisterWsIngest(bg, testApp, room)
	if err != nil {
		f.t.Fatal(err)
	}
	return key
}

// connect runs HandleIngest in the background and waits for its first
// outbound message (ready or the rejection error).
func (f *fixture) connect(url, authz, ip string) (*fakeConn, chan struct{}) {
	c := newFakeConn()
	ended := make(chan struct{})
	go func() {
		f.svc.HandleIngest(bg, c, UpgradeInfo{URL: url, Authorization: authz, IP: ip})
		close(ended)
	}()
	select {
	case <-c.sent:
	case <-time.After(2 * time.Second):
		f.t.Fatal("no handshake reply")
	}
	return c, ended
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func jpeg(n int) []byte {
	b := make([]byte, n)
	b[0], b[1], b[2], b[3] = 0xff, 0xd8, 0xff, 0xe0
	return b
}

// signJWT builds an HS256 JWT (LiveKit AccessToken shape) for tests.
func signJWT(t *testing.T, key, secret string, claims map[string]any) string {
	t.Helper()
	enc := base64.RawURLEncoding
	h := enc.EncodeToString([]byte(`{"alg":"HS256"}`))
	b, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	p := enc.EncodeToString(b)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(h + "." + p))
	_ = key
	return h + "." + p + "." + enc.EncodeToString(mac.Sum(nil))
}
