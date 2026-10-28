package livekit

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/livekit/protocol/livekit"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// fakeApps is a contracts.AppsService over in-memory configs.
type fakeApps struct {
	cfgs map[string]*contracts.AppConfig
	dir  string
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	var out []contracts.AppRecord
	for n, c := range f.cfgs {
		out = append(out, contracts.AppRecord{Name: n, LivekitRoomPrefix: prefixOf(c, n)})
	}
	return out, nil
}
func (f *fakeApps) Get(_ context.Context, n string) (*contracts.AppRecord, error) {
	if c, ok := f.cfgs[n]; ok {
		return &contracts.AppRecord{Name: n, LivekitRoomPrefix: prefixOf(c, n)}, nil
	}
	return nil, nil
}
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(_ context.Context, n string) (*contracts.AppConfig, error) {
	if c, ok := f.cfgs[n]; ok {
		return c, nil
	}
	return nil, httpx.NotFound(`app "` + n + `" not found`)
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (f *fakeApps) AppDir(n string) string { return f.dir + "/apps/" + n }

// appCfg is a public app with default features.
func appCfg(prefix string) *contracts.AppConfig {
	return &contracts.AppConfig{RoomPrefix: prefix, Features: contracts.AppFeatures{PublicPlayback: true, Chat: true, Reactions: true}}
}

type fakeQuotas struct{ calls []string }

func (q *fakeQuotas) EnforceConcurrentStreams(context.Context, *auth.Principal) error {
	q.calls = append(q.calls, "tenant")
	return nil
}
func (q *fakeQuotas) EnforceAppConcurrentStreams(_ context.Context, app string, limit float64, _ *auth.Principal) error {
	q.calls = append(q.calls, "app:"+app)
	return nil
}

type fakeAudit struct{ events []audit.Event }

func (a *fakeAudit) Record(_ context.Context, e audit.Event) { a.events = append(a.events, e) }

type logLine struct{ Level, Source, Msg string }

type fakeLogs struct {
	mu    sync.Mutex
	lines []logLine
}

func (l *fakeLogs) Write(level, source, msg string, _ any, _ *int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, logLine{level, source, msg})
}

func (l *fakeLogs) has(source, prefix string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, x := range l.lines {
		if x.Source == source && strings.HasPrefix(x.Msg, prefix) {
			return true
		}
	}
	return false
}

type dispatched struct {
	App, Event string
	Payload    map[string]any
}

type fakeCallbacks struct {
	events []dispatched
	fail   bool
}

func (c *fakeCallbacks) Dispatch(_ context.Context, app, event string, payload any) error {
	b, _ := json.Marshal(payload)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	c.events = append(c.events, dispatched{app, event, m})
	if c.fail {
		return io.ErrUnexpectedEOF
	}
	return nil
}

func (c *fakeCallbacks) named(event string) []dispatched {
	var out []dispatched
	for _, e := range c.events {
		if e.Event == event {
			out = append(out, e)
		}
	}
	return out
}

type fakeStreams struct {
	upserts []string // app|id|type|room|participant
	ended   []string
	rooms   map[string]string
	fail    bool
}

func (s *fakeStreams) Upsert(_ context.Context, app, id, typ, room, participant string) error {
	s.upserts = append(s.upserts, strings.Join([]string{app, id, typ, room, participant}, "|"))
	if s.fail {
		return io.ErrUnexpectedEOF
	}
	return nil
}
func (s *fakeStreams) End(_ context.Context, app, id string) error {
	s.ended = append(s.ended, app+"|"+id)
	return nil
}
func (s *fakeStreams) StreamRoom(_ context.Context, _, id string) (string, error) {
	return s.rooms[id], nil
}

type fakeRecording struct {
	egress   []string
	started  []string
	startErr error
}

func (r *fakeRecording) OnEgressEvent(_ context.Context, id, status string, _ *livekit.WebhookEvent) error {
	r.egress = append(r.egress, id+"|"+status)
	return nil
}
func (r *fakeRecording) Start(_ context.Context, app, room string) (int64, string, error) {
	r.started = append(r.started, app+"|"+room)
	return 7, "EG_auto", r.startErr
}

type fakePassthrough struct {
	created []string
	removed []string
	rows    []PassthroughInfo
}

func (p *fakePassthrough) ParseMpegtsSource(in MpegtsSource) (string, error) {
	if !strings.HasPrefix(in.URL, "udp://@") {
		return "", io.EOF
	}
	return in.URL + "?fifo_size=1", nil
}
func (p *fakePassthrough) Create(_ context.Context, app, room, transport, src string) (*PassthroughInfo, error) {
	p.created = append(p.created, strings.Join([]string{app, room, transport, src}, "|"))
	info := &PassthroughInfo{Mode: "passthrough", IngressID: "pti_1", App: app, Room: room, StreamKey: "ptk_1",
		HlsURL: "/hls/" + app + "/" + room + "/index.m3u8", Capabilities: map[string]any{"webrtc": false}}
	switch transport {
	case "srt":
		info.InputType, info.SrtURL = "srt", "srt://h:9000?streamid=ptk_1"
	case "mpegts":
		info.InputType, info.SourceURL = "mpegts", src
	default:
		info.RtmpURL = "rtmp://h:1937/" + app + "/ptk_1"
	}
	return info, nil
}
func (p *fakePassthrough) List(context.Context, string) ([]PassthroughInfo, error) {
	return p.rows, nil
}
func (p *fakePassthrough) Remove(_ context.Context, app, id string) bool {
	p.removed = append(p.removed, app+"|"+id)
	return true
}

// harness is the module behind a real mux (WithRequest + huma), no auth guard.
type harness struct {
	t    *testing.T
	m    *Module
	lk   *fakeLK
	apps *fakeApps
	q    *fakeQuotas
	aud  *fakeAudit
	logs *fakeLogs
	cb   *fakeCallbacks
	st   *fakeStreams
	rec  *fakeRecording
	pt   *fakePassthrough // nil = plane unavailable
	srv  *httptest.Server
	ptOn bool
	cfg  func()
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	store, _, dir := testutil.Store(t)
	h := &harness{t: t, lk: &fakeLK{}, q: &fakeQuotas{}, aud: &fakeAudit{}, logs: &fakeLogs{}, cb: &fakeCallbacks{},
		st: &fakeStreams{rooms: map[string]string{}}, rec: &fakeRecording{}, pt: &fakePassthrough{}}
	h.apps = &fakeApps{dir: dir, cfgs: map[string]*contracts.AppConfig{"live": appCfg("live")}}
	cfg := testConfig("livekit")
	cfg.DataDir = dir
	h.m = New(Deps{
		Config: cfg, Store: store, Apps: h.apps, Quotas: h.q, Audit: h.aud, Log: testutil.Log(), Clients: h.lk.clients(),
		Resolve: func(context.Context, string) ([]string, error) { return []string{"93.184.216.34"}, nil },
		Optional: Optional{
			Logs:      func() Logs { return h.logs },
			Callbacks: func() Callbacks { return h.cb },
			Streams:   func() Streams { return h.st },
			Recording: func() Recording { return h.rec },
			Passthrough: func() Passthrough {
				if h.ptOn {
					return h.pt
				}
				return nil
			},
		},
	})
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	h.m.Register(a)
	h.srv = httptest.NewServer(httpx.WithRequest(mux))
	t.Cleanup(h.srv.Close)
	return h
}

type resp struct {
	Status int
	Header http.Header
	Body   map[string]any
	Raw    string
}

func (h *harness) do(method, path string, body any, headers ...string) resp {
	h.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		rd = strings.NewReader(b)
	default:
		j, _ := json.Marshal(b)
		rd = strings.NewReader(string(j))
	}
	req, _ := http.NewRequest(method, h.srv.URL+"/api/v1"+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{Status: res.StatusCode, Header: res.Header, Raw: string(raw)}
	_ = json.Unmarshal(raw, &out.Body)
	return out
}

func (r resp) data() map[string]any { d, _ := r.Body["data"].(map[string]any); return d }

func (r resp) message() string { s, _ := r.Body["message"].(string); return s }

// jwtClaims decodes a token payload.
func jwtClaims(t *testing.T, tok string) map[string]any {
	t.Helper()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("not a jwt: %q", tok)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func expect(t *testing.T, r resp, status int) {
	t.Helper()
	if r.Status != status {
		t.Fatalf("status %d (want %d): %s", r.Status, status, r.Raw)
	}
}

func newMux() *http.ServeMux { return http.NewServeMux() }

func decodeB64(t *testing.T, s string) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }

func structMap(t *testing.T, v any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(v)
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}
