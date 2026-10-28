package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

var bg = context.Background()

const app = "live"

// fakeClient is an in-memory FleetMqttClientLike (connected, no socket).
type fakeClient struct {
	mu         sync.Mutex
	opts       ConnectOptions
	ev         Events
	connected  bool
	subscribed [][]string
	qos        []byte
	published  []published
	period     time.Duration
	ended      bool
}

type published struct {
	topic   string
	payload string
	qos     byte
	retain  bool
}

func (f *fakeClient) Start(ev Events) { f.ev = ev }
func (f *fakeClient) Connected() bool { return f.connected }
func (f *fakeClient) Subscribe(topics []string, qos byte, done func(error)) {
	f.mu.Lock()
	f.subscribed = append(f.subscribed, topics)
	f.qos = append(f.qos, qos)
	f.mu.Unlock()
	done(nil)
}
func (f *fakeClient) Publish(topic string, payload []byte, qos byte, retain bool, done func(error)) {
	f.published = append(f.published, published{topic, string(payload), qos, retain})
	done(nil)
}
func (f *fakeClient) SetReconnectPeriod(d time.Duration) { f.period = d }
func (f *fakeClient) End()                               { f.ended = true }
func (f *fakeClient) emit(topic, payload string)         { f.ev.OnMessage(topic, []byte(payload)) }

type fakeApps struct {
	dir  string
	mqtt contracts.MqttConfig
	err  error
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	return []contracts.AppRecord{{Name: app}}, nil
}
func (f *fakeApps) Get(context.Context, string) (*contracts.AppRecord, error) { return nil, nil }
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &contracts.AppConfig{Mqtt: f.mqtt}, nil
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (f *fakeApps) AppDir(string) string { return f.dir }

type fakeRepo struct{ row *plugins.Installed }

func (f *fakeRepo) Get(_ context.Context, _, id string) (*plugins.Installed, error) {
	if id != "fleet" {
		return nil, nil
	}
	return f.row, nil
}

type fakeLogs struct{ msgs []string }

func (f *fakeLogs) Write(level, _, message string, _ any, _ *int64) {
	f.msgs = append(f.msgs, level+":"+message)
}

type fixture struct {
	svc     *Service
	apps    *fakeApps
	repo    *fakeRepo
	logs    *fakeLogs
	created []*fakeClient
	now     time.Time
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{now: time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)}
	f.apps = &fakeApps{dir: t.TempDir(), mqtt: contracts.MqttConfig{Enabled: true, URL: "mqtt://broker.test:1883"}}
	f.repo = &fakeRepo{}
	f.setFleet(true, nil)
	f.logs = &fakeLogs{}
	store := NewStore()
	store.FileFor = func(dir string) string { return filepath.Join(dir, "fleet.db") }
	f.svc = New(Deps{
		Apps: f.apps, Plugins: f.repo, Store: store, Logs: func() Logs { return f.logs },
		Now: func() time.Time { return f.now },
		Factory: func(o ConnectOptions) (Client, error) {
			c := &fakeClient{opts: o, connected: true}
			f.created = append(f.created, c)
			return c, nil
		},
	})
	t.Cleanup(f.svc.Close)
	return f
}

func (f *fixture) setFleet(enabled bool, cfg *y.Map) {
	if cfg == nil {
		cfg = y.NewMap()
	}
	f.repo.row = &plugins.Installed{PluginID: "fleet", Enabled: enabled, Config: cfg}
}

func (f *fixture) last(t *testing.T) *fakeClient {
	t.Helper()
	if len(f.created) == 0 {
		t.Fatal("no client created")
	}
	return f.created[len(f.created)-1]
}

func obj(t *testing.T, s string) *y.Map {
	t.Helper()
	v, err := y.ParseJSON([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v.(*y.Map)
}

func js(v any) string { s, _ := y.Stringify(v); return s }

// ---------------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------------

func TestTopics(t *testing.T) {
	if got := Subscriptions("streamhub/live"); !reflect.DeepEqual(got, []string{
		"streamhub/live/agents/+/telemetry", "streamhub/live/agents/+/status", "streamhub/live/agents/+/cmd/result",
	}) {
		t.Fatal(got)
	}
	if AgentsRoot("streamhub/live/") != "streamhub/live/agents/" || CommandTopic("streamhub/live//", "a1") != "streamhub/live/agents/a1/cmd" {
		t.Fatal("prefix normalization")
	}
	for topic, want := range map[string][2]string{
		"streamhub/live/agents/a1/telemetry":   {"a1", KindTelemetry},
		"streamhub/live/agents/a1/status":      {"a1", KindStatus},
		"streamhub/live/agents/a1/cmd/result":  {"a1", KindCmdResult},
		"streamhub/other/agents/a1/telemetry":  {},
		"streamhub/live/agents/a1/cmd":         {},
		"streamhub/live/agents//telemetry":     {},
		"streamhub/live/vod/x":                 {},
		"streamhub/live/agents/a1/telemetry/x": {},
	} {
		id, kind, ok := ParseTopic("streamhub/live", topic)
		if ok != (want[0] != "") || id != want[0] || kind != want[1] {
			t.Errorf("%s → %s %s %v", topic, id, kind, ok)
		}
	}
}

func TestValidateCommand(t *testing.T) {
	if !reflect.DeepEqual(Commands, []string{"restart", "ota", "config", "ping"}) {
		t.Fatal(Commands)
	}
	sha := "A"
	for len(sha) < 64 {
		sha += "A"
	}
	lower := "a"
	for len(lower) < 64 {
		lower += "a"
	}
	ok := []struct {
		cmd  any
		args string
		want string
	}{
		{"restart", "", `{}`},
		{"ping", `{"junk":1}`, `{}`},
		{"ota", `{"url":" https://assets.example.com/agent/1.13/streamhub-agent ","version":"1.13","sha256":"` + sha + `","x":1}`,
			`{"url":"https://assets.example.com/agent/1.13/streamhub-agent","version":"1.13","sha256":"` + lower + `"}`},
		{"config", `{"config":{"fps":3,"a":[1]}}`, `{"config":{"fps":3,"a":[1]}}`},
		{"config", `{"fps":3}`, `{"config":{"fps":3}}`},
		{"config", `{"config":[1],"z":2}`, `{"config":{"config":[1],"z":2}}`},
	}
	for _, c := range ok {
		var args any
		if c.args != "" {
			args = obj(t, c.args)
		}
		name, out, err := ValidateCommand(c.cmd, args)
		if err != nil || name != c.cmd || js(out) != c.want {
			t.Errorf("%v %s → %s %v", c.cmd, c.args, js(out), err)
		}
	}
	good := `"url":"https://x/y","version":"1.13","sha256":"` + lower + `"`
	bad := []struct {
		cmd  any
		args string
		msg  string
	}{
		{"rmrf", `{}`, "unknown command 'rmrf' (allowed: restart, ota, config, ping)"},
		{42.0, `{}`, "unknown command '42' (allowed: restart, ota, config, ping)"},
		{nil, `{}`, "unknown command 'null' (allowed: restart, ota, config, ping)"},
		{"ota", `{"version":"1","sha256":"x"}`, "ota requires 'url'"},
		{"ota", `{` + good + `,"url":"ftp://x/y"}`, "ota url must be http(s)"},
		{"ota", `{` + good + `,"version":""}`, "ota requires 'version'"},
		{"ota", `{` + good + `,"sha256":"nope"}`, "ota requires a 64-hex sha256"},
		{"config", `{}`, "config requires a non-empty object"},
		{"config", `{"config":{}}`, "config requires a non-empty object"},
	}
	for _, c := range bad {
		_, _, err := ValidateCommand(c.cmd, obj(t, c.args))
		var ce *CommandError
		if !errors.As(err, &ce) || ce.Error() != c.msg {
			t.Errorf("%v %s → %v", c.cmd, c.args, err)
		}
	}
}

func TestParseTelemetry(t *testing.T) {
	cases := map[string]string{
		`{"cpu":150,"mem":-5,"temp":47.2,"uptime":3600,"cameras":2,"disk":61,"battery":42,"agentVersion":"1.12","relay":"running"}`: `{"cpu":100,"mem":0,"temp":47.2,"uptime":3600,"cameras":2,"disk":61,"battery":42,"agentVersion":"1.12","relay":"running"}`,
		// battery: omitted on an AC-only host; clamped 0–100 like the other percents
		`{"cpu":10,"mem":20}`:                `{"cpu":10,"mem":20}`,
		`{"battery":142}`:                    `{"battery":100}`,
		`{"data":{"cpu":"10","extra":true}}`: `{"cpu":10,"extra":true}`,
		`{"x":1,"disk":"x","relay":5}`:       `{"x":1}`,
		`{"cpu":"","uptime":-3}`:             `{"cpu":0,"uptime":0}`,
	}
	for in, want := range cases {
		if got := js(ParseTelemetry(in)); got != want {
			t.Errorf("%s → %s want %s", in, got, want)
		}
	}
	for _, in := range []string{"not json", "[1,2,3]", "null", `"s"`} {
		if ParseTelemetry(in) != nil {
			t.Errorf("%s should be nil", in)
		}
	}
	if n, ok := Num("12.5", 0, 100); !ok || n != 12.5 {
		t.Fatal(n)
	}
	if n, _ := Num(200.0, 0, 100); n != 100 {
		t.Fatal(n)
	}
	if _, ok := Num("x", math.Inf(-1), math.Inf(1)); ok {
		t.Fatal("x is not a number")
	}
}

func TestParseStatusAndResult(t *testing.T) {
	for in, want := range map[string][2]string{
		`{"status":"online","agentVersion":"2"}`: {"online", "2"},
		`{"status":"weird"}`:                     {"offline", ""},
		" ONLINE ":                               {"online", ""},
		"offline":                                {"offline", ""},
		"null":                                   {"offline", ""},
		`"online"`:                               {"offline", ""},
	} {
		s, v := parseStatus(in)
		if s != want[0] || v != want[1] {
			t.Errorf("%q → %s %s", in, s, v)
		}
	}
	if got := js(parseResult(`{"z":1,"id":"c1","ok":"yes","message":3}`)); got != `{"z":1,"id":"c1","ok":false}` {
		t.Fatal(got)
	}
	if got := js(parseResult(`{"ok":true,"id":"c1","command":"restart"}`)); got != `{"ok":true,"id":"c1","command":"restart"}` {
		t.Fatal(got)
	}
	for _, in := range []string{`{"id":5}`, `[1]`, `x`} {
		if parseResult(in) != nil {
			t.Errorf("%s should be nil", in)
		}
	}
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

func TestEnsureForApp(t *testing.T) {
	f := newFixture(t)
	prefix, active, err := f.svc.EnsureForApp(bg, app)
	if err != nil || !active || prefix != "streamhub/live" || len(f.created) != 1 {
		t.Fatalf("%s %v %v", prefix, active, err)
	}
	if got := f.last(t).subscribed[0]; !reflect.DeepEqual(got, Subscriptions("streamhub/live")) {
		t.Fatal(got)
	}
	if f.last(t).opts.ReconnectPeriod != time.Second || f.last(t).opts.ConnectTimeout != 10*time.Second {
		t.Fatal(f.last(t).opts)
	}
	// Reads reuse the client (stable fingerprint).
	_, _ = f.svc.GetData(bg, app)
	_, _ = f.svc.GetData(bg, app)
	if len(f.created) != 1 {
		t.Fatal("client recreated")
	}
	// A config change replaces it; a custom prefix (trailing slash) is normalized.
	f.apps.mqtt.TopicPrefix = " acme/fleet/ "
	f.apps.mqtt.Qos = 2
	prefix, _, _ = f.svc.EnsureForApp(bg, app)
	if prefix != "acme/fleet" || len(f.created) != 2 || !f.created[0].ended || f.last(t).qos[0] != 2 {
		t.Fatal(prefix)
	}
	// Plugin disabled → drop, no client.
	f.setFleet(false, nil)
	if _, active, _ := f.svc.EnsureForApp(bg, app); active || !f.last(t).ended {
		t.Fatal("should drop")
	}
}

func TestNoClientWhenInactive(t *testing.T) {
	for name, mut := range map[string]func(f *fixture){
		"plugin disabled":   func(f *fixture) { f.setFleet(false, nil) },
		"plugin missing":    func(f *fixture) { f.repo.row = nil },
		"mqtt disabled":     func(f *fixture) { f.apps.mqtt.Enabled = false },
		"blank url":         func(f *fixture) { f.apps.mqtt.URL = "   " },
		"unreadable config": func(f *fixture) { f.apps.err = errors.New("boom") },
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			mut(f)
			if _, active, err := f.svc.EnsureForApp(bg, app); active || err != nil || len(f.created) != 0 {
				t.Fatal("should be inactive")
			}
		})
	}
}

func TestTelemetryIngest(t *testing.T) {
	f := newFixture(t)
	_, _, _ = f.svc.EnsureForApp(bg, app)
	c := f.last(t)
	c.emit("streamhub/live/agents/b09994/telemetry", `{"cpu":12,"mem":40,"temp":45,"uptime":7200,"cameras":3,"disk":55,"agentVersion":"1.12","relay":"running"}`)
	f.now = f.now.Add(1500 * time.Millisecond)
	d, err := f.svc.GetData(bg, app)
	if err != nil || len(d.Agents) != 1 {
		t.Fatalf("%+v %v", d, err)
	}
	b, _ := json.Marshal(d.Agents[0])
	want := `{"agentId":"b09994","online":true,"status":"online","version":"1.12","lastSeen":"2026-10-27T12:00:00.000Z","ageMs":1500,"metrics":{"cpu":12,"mem":40,"temp":45,"uptime":7200,"cameras":3,"disk":55,"battery":null,"relay":"running"}}`
	if string(b) != want {
		t.Fatal(string(b))
	}
	det, _ := f.svc.GetAgent(bg, app, "b09994")
	if det.Agent == nil || !det.Agent.Online || len(det.History) != 1 || *det.History[0].Cpu != 12 {
		t.Fatalf("%+v", det)
	}
	// Status LWT → offline; last_seen untouched.
	c.emit("streamhub/live/agents/b09994/status", `{"status":"offline"}`)
	d, _ = f.svc.GetData(bg, app)
	if d.Agents[0].Online || d.Agents[0].LastSeen != "2026-10-27T12:00:00.000Z" {
		t.Fatalf("%+v", d.Agents[0])
	}
	// Unknown agent: null agent, empty history/commands.
	det, _ = f.svc.GetAgent(bg, app, "nope")
	if b, _ := json.Marshal(det); string(b) != `{"agent":null,"history":[],"commands":[]}` {
		t.Fatal(string(b))
	}
}

func TestHistoryCapAndStaleReap(t *testing.T) {
	f := newFixture(t)
	f.setFleet(true, obj(t, `{"historyPoints":3,"offlineAfterSec":"60"}`))
	_, _, _ = f.svc.EnsureForApp(bg, app)
	c := f.last(t)
	for i := 0; i < 6; i++ {
		c.emit("streamhub/live/agents/a1/telemetry", `{"cpu":`+string(rune('0'+i))+`}`)
	}
	det, _ := f.svc.GetAgent(bg, app, "a1")
	var cpus []float64
	for _, h := range det.History {
		cpus = append(cpus, *h.Cpu)
	}
	if !reflect.DeepEqual(cpus, []float64{3, 4, 5}) {
		t.Fatal(cpus)
	}
	f.now = f.now.Add(61 * time.Second)
	_, _, _ = f.svc.EnsureForApp(bg, app)
	d, _ := f.svc.GetData(bg, app)
	if d.Agents[0].Online {
		t.Fatal("stale agent should be offline")
	}
	if f.logs.msgs[len(f.logs.msgs)-1] != "info:agent 'a1' went offline (stale)" {
		t.Fatal(f.logs.msgs)
	}
}

func TestGarbageNeverFails(t *testing.T) {
	f := newFixture(t)
	_, _, _ = f.svc.EnsureForApp(bg, app)
	c := f.last(t)
	c.emit("streamhub/live/vod/x", "{}")
	c.emit("streamhub/live/agents/a1/telemetry", "not json")
	c.emit("streamhub/live/agents/a1/cmd/result", `{"ok":true}`)
	if d, _ := f.svc.GetData(bg, app); len(d.Agents) != 0 {
		t.Fatal(d.Agents)
	}
}

func TestCommands(t *testing.T) {
	f := newFixture(t)
	rec, err := f.svc.SendCommand(bg, app, "b09994", "ping", obj(t, `{}`))
	if err != nil || rec.Status != "pending" || rec.Command != "ping" || rec.Result != nil || rec.ResolvedAt != nil {
		t.Fatalf("%+v %v", rec, err)
	}
	p := f.last(t).published[0]
	if p.topic != "streamhub/live/agents/b09994/cmd" || p.qos != 1 || p.retain {
		t.Fatalf("%+v", p)
	}
	if want := `{"id":"` + rec.ID + `","command":"ping","args":{},"ts":"2026-10-27T12:00:00.000Z"}`; p.payload != want {
		t.Fatal(p.payload)
	}

	sha := ""
	for len(sha) < 64 {
		sha += "a"
	}
	ota, _ := f.svc.SendCommand(bg, app, "a1", "ota", obj(t, `{"url":"https://assets.example.com/agent/1.13/streamhub-agent","version":"1.13","sha256":"`+sha+`"}`))
	if want := `{"id":"` + ota.ID + `","command":"ota","args":{"url":"https://assets.example.com/agent/1.13/streamhub-agent","version":"1.13","sha256":"` + sha + `"},"ts":"2026-10-27T12:00:00.000Z"}`; f.last(t).published[1].payload != want {
		t.Fatal(f.last(t).published[1].payload)
	}

	// cmd/result resolves the pending command.
	rs, _ := f.svc.SendCommand(bg, app, "a1", "restart", nil)
	f.last(t).emit("streamhub/live/agents/a1/cmd/result", `{"id":"`+rs.ID+`","command":"restart","ok":true,"message":"restarting"}`)
	det, _ := f.svc.GetAgent(bg, app, "a1")
	var got *FleetCommandRow
	for i := range det.Commands {
		if det.Commands[i].ID == rs.ID {
			got = &det.Commands[i]
		}
	}
	if got == nil || got.Status != "ok" || js(got.Result) != `{"id":"`+rs.ID+`","command":"restart","ok":true,"message":"restarting"}` || got.ResolvedAt == nil {
		t.Fatalf("%+v", got)
	}

	// Validation + inactive guard.
	var ce *CommandError
	if _, err := f.svc.SendCommand(bg, app, "a1", "nuke", nil); !errors.As(err, &ce) {
		t.Fatal(err)
	}
	if _, err := f.svc.SendCommand(bg, app, "a1", "ota", obj(t, `{"url":"https://x/y","version":"1"}`)); !errors.As(err, &ce) {
		t.Fatal(err)
	}
	g := newFixture(t)
	g.setFleet(false, nil)
	var ie *InactiveError
	if _, err := g.svc.SendCommand(bg, app, "a1", "ping", nil); !errors.As(err, &ie) ||
		ie.Error() != "fleet is not active for app 'live' (install+enable the fleet plugin and configure mqtt)" || len(g.created) != 0 {
		t.Fatal(err)
	}
	// Factory rejection (unsafe broker) → no subscriber → inactive.
	h := newFixture(t)
	h.svc.factory = func(ConnectOptions) (Client, error) { return nil, errors.New("private address") }
	if _, err := h.svc.SendCommand(bg, app, "a1", "ping", nil); !errors.As(err, &ie) {
		t.Fatal(err)
	}
}

func TestReconnectBackoff(t *testing.T) {
	f := newFixture(t)
	_, _, _ = f.svc.EnsureForApp(bg, app)
	c := f.last(t)
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second}
	for i, w := range want {
		c.ev.OnClose()
		if c.period != w {
			t.Fatalf("close %d → %v want %v", i+1, c.period, w)
		}
	}
	c.ev.OnConnect()
	if c.period != time.Second || len(c.subscribed) != 2 {
		t.Fatal("connect resets backoff and resubscribes")
	}
	c.ev.OnError(errors.New("e1"))
	c.ev.OnError(errors.New("e2"))
	n := 0
	for _, m := range f.logs.msgs {
		if m == "warn:fleet broker connection error" {
			n++
		}
	}
	if n != 1 {
		t.Fatal("error logged once per connection")
	}
}

func TestReconcileDropsVanishedApps(t *testing.T) {
	f := newFixture(t)
	_, _, _ = f.svc.EnsureForApp(bg, "gone")
	f.svc.Reconcile(bg)
	if !f.created[0].ended || len(f.created) != 2 {
		t.Fatal("vanished app subscriber must be dropped")
	}
}

func TestDefaultFactoryRejectsUnsafeBroker(t *testing.T) {
	t.Setenv("STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER", "")
	for _, u := range []string{"mqtt://127.0.0.1:1883", "http://broker.example:80", "mqtt://10.0.0.5"} {
		if _, err := DefaultFactory(ConnectOptions{URL: u}); err == nil {
			t.Errorf("%s should be rejected", u)
		}
	}
	c, err := DefaultFactory(ConnectOptions{URL: "mqtt://broker.example.com:1883"})
	if err != nil || c.Connected() {
		t.Fatal(err)
	}
	c.End() // never started: no socket
}

// TestCommandRoute pins the Go divergence: POST command applies the
// documented { agentId, command, args } body (Node's whitelisted DTO always
// answered 400 "body must carry an 'agentId'").
func TestCommandRoute(t *testing.T) {
	f := newFixture(t)
	_, api := humatest.New(t)
	httpx.InstallHumaErrors()
	f.svc.Register(api)
	post := func(svc *Service, body string) (int, string) {
		r := api.Post("/api/v1/apps/live/plugins/fleet/command", strings.NewReader(body))
		return r.Code, r.Body.String()
	}
	code, body := post(f.svc, `{"agentId":" b09994 ","command":"ping","args":{},"extra":1}`)
	if code != 201 || !strings.Contains(body, `"command":"ping"`) || !strings.Contains(body, `"agentId":"b09994"`) || !strings.Contains(body, `"status":"pending"`) {
		t.Fatal(code, body)
	}
	if p := f.last(t).published; len(p) != 1 || p[0].topic != "streamhub/live/agents/b09994/cmd" {
		t.Fatalf("%+v", p)
	}
	cases := []struct {
		body   string
		status int
		msg    string
	}{
		{``, 400, "body must carry an 'agentId'"},
		{`{"command":"ping"}`, 400, "body must carry an 'agentId'"},
		{`{"agentId":"  ","command":"ping"}`, 400, "body must carry an 'agentId'"},
		{`{"agentId":5,"command":"ping"}`, 400, "body must carry an 'agentId'"},
		{`[1]`, 400, "body must carry an 'agentId'"},
		{`{"agentId":"a1","command":"nuke"}`, 400, "unknown command 'nuke' (allowed: "},
		{`{"agentId":"a1","command":"ota","args":{"url":"ftp://x"}}`, 400, "ota url must be http(s)"},
	}
	for _, c := range cases {
		code, body := post(f.svc, c.body)
		if code != c.status || !strings.Contains(body, c.msg) {
			t.Errorf("%s → %d %s", c.body, code, body)
		}
	}
	f.setFleet(false, nil)
	f.svc.Close()
	if code, body := post(f.svc, `{"agentId":"a1","command":"ping"}`); code != 409 || !strings.Contains(body, "fleet is not active for app 'live'") {
		t.Fatal(code, body)
	}
}
