package cameras

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/fleet"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

var bg = context.Background()

const app = "live"

// --- fakes ------------------------------------------------------------------

type published struct {
	topic   string
	payload string
	retain  bool
}

// fakeClient is a connected in-memory fleet.Client (no socket).
type fakeClient struct {
	mu        sync.Mutex
	opts      fleet.ConnectOptions
	ev        fleet.Events
	subs      [][]string
	published []published
	ended     bool
}

func (f *fakeClient) Start(ev fleet.Events) { f.ev = ev }
func (f *fakeClient) Connected() bool       { return true }
func (f *fakeClient) Subscribe(topics []string, _ byte, done func(error)) {
	f.mu.Lock()
	f.subs = append(f.subs, topics)
	f.mu.Unlock()
	done(nil)
}
func (f *fakeClient) Publish(topic string, payload []byte, _ byte, retain bool, done func(error)) {
	f.mu.Lock()
	f.published = append(f.published, published{topic, string(payload), retain})
	f.mu.Unlock()
	done(nil)
}
func (f *fakeClient) SetReconnectPeriod(time.Duration) {}
func (f *fakeClient) End()                             { f.ended = true }
func (f *fakeClient) emit(topic, payload string, retained bool) {
	f.ev.OnMessageRetained(topic, []byte(payload), retained)
}
func (f *fakeClient) last() published {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.published[len(f.published)-1]
}

type fakeApps struct {
	dir  string
	mqtt contracts.MqttConfig
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
	return &contracts.AppConfig{Mqtt: f.mqtt}, nil
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (f *fakeApps) AppDir(string) string { return f.dir }

type fakeRepo struct {
	mu  sync.Mutex
	row *plugins.Installed
}

func (f *fakeRepo) Get(_ context.Context, _, id string) (*plugins.Installed, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id != PluginID {
		return nil, nil
	}
	return f.row, nil
}

type fakeAudit struct {
	mu     sync.Mutex
	events []audit.Event
}

func (f *fakeAudit) RecordCtx(_ context.Context, e audit.Event) {
	f.mu.Lock()
	f.events = append(f.events, e)
	f.mu.Unlock()
}

type fixture struct {
	svc     *Service
	apps    *fakeApps
	repo    *fakeRepo
	audit   *fakeAudit
	created []*fakeClient
	mu      sync.Mutex
	now     time.Time
	offset  time.Duration // added to the real clock (realClock fixtures)
}

func (f *fixture) clock() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *fixture) advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	f.offset += d
	f.mu.Unlock()
}

func (f *fixture) realNow() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return time.Now().Add(f.offset)
}

func newFixture(t *testing.T, factory fleet.Factory, realClock bool) *fixture {
	f := &fixture{now: time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)}
	f.apps = &fakeApps{dir: t.TempDir(), mqtt: contracts.MqttConfig{Enabled: true, URL: "mqtt://broker.test:1883", Username: "core", Password: "core-pass"}}
	f.repo = &fakeRepo{}
	f.setEnabled(true, nil)
	f.audit = &fakeAudit{}
	store := NewStore()
	store.FileFor = func(dir string) string { return filepath.Join(dir, "cameras.db") }
	if factory == nil {
		factory = func(o fleet.ConnectOptions) (fleet.Client, error) {
			c := &fakeClient{opts: o}
			f.created = append(f.created, c)
			return c, nil
		}
	}
	now := f.clock
	if realClock {
		now = f.realNow
	}
	f.svc = New(Deps{Apps: f.apps, Plugins: f.repo, Store: store, Factory: factory, Now: now,
		Audit: func() Audit { return f.audit }})
	t.Cleanup(f.svc.Close)
	return f
}

func (f *fixture) setEnabled(enabled bool, cfg *y.Map) {
	if cfg == nil {
		cfg = y.NewMap()
	}
	f.repo.mu.Lock()
	f.repo.row = &plugins.Installed{PluginID: PluginID, Enabled: enabled, Config: cfg}
	f.repo.mu.Unlock()
}

func (f *fixture) client(t *testing.T) *fakeClient {
	t.Helper()
	if _, _, err := f.svc.EnsureForApp(bg, app); err != nil {
		t.Fatal(err)
	}
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

// --- protocol -----------------------------------------------------------------

func TestParseTopic(t *testing.T) {
	cases := []struct {
		root, topic, dev, kind, rest string
		ok                           bool
	}{
		{"opencam", "opencam/stand-02/hello", "stand-02", KindHello, "", true},
		{"opencam/", "opencam/stand-02/status", "stand-02", KindStatus, "", true},
		{"opencam", "opencam/stand-02/res/ptz/goto", "stand-02", KindRes, "ptz/goto", true},
		{"opencam", "opencam/stand-02/res/reboot", "stand-02", KindRes, "reboot", true},
		{"shop/cams", "shop/cams/d1/state", "d1", KindState, "", true},
		{"opencam", "opencam/stand-02/cmd/ptz/dir", "", "", "", false},
		{"opencam", "opencam/stand-02/snapshot", "", "", "", false},
		{"opencam", "opencam/stand-02/state/x", "", "", "", false},
		{"opencam", "other/stand-02/state", "", "", "", false},
		{"opencam", "opencam/+/state", "", "", "", false},
	}
	for _, c := range cases {
		dev, kind, rest, ok := ParseTopic(c.root, c.topic)
		if ok != c.ok || dev != c.dev || kind != c.kind || rest != c.rest {
			t.Errorf("%s %s → %q %q %q %v", c.root, c.topic, dev, kind, rest, ok)
		}
	}
	if got := Subscriptions(" /opencam/ "); got[0] != "opencam/+/hello" || got[4] != "opencam/+/res/#" || len(got) != 6 {
		t.Fatal(got)
	}
	if CommandTopic("", "d1", "ptz/dir") != "opencam/d1/cmd/ptz/dir" {
		t.Fatal(CommandTopic("", "d1", "ptz/dir"))
	}
}

func TestValidateCommand(t *testing.T) {
	bad := []struct {
		cmd, args, msg string
	}{
		{"nuke", `{}`, "unknown command 'nuke'"},
		{"ptz/dir", `{"dir":"sideways"}`, "ptz/dir requires dir"},
		{"ptz/preset", `{}`, "ptz/preset requires 'preset'"},
		{"voice/say", `{"key":" "}`, "voice/say requires 'key'"},
		{"firmware/upgrade", `{"url":"ftp://x","sha256":"` + strings.Repeat("a", 64) + `"}`, "http(s) 'url'"},
		{"firmware/upgrade", `{"url":"https://x/fw.bin","sha256":"abc"}`, "64-hex 'sha256'"},
		{"config/import", `{"config":{}}`, "non-empty 'config'"},
		{"sd/format", `{"confirm":"other"}`, "confirm = the device id"},
	}
	for _, c := range bad {
		if _, _, err := ValidateCommand("d1", c.cmd, obj(t, c.args)); err == nil || !strings.Contains(err.Error(), c.msg) {
			t.Errorf("%s %s → %v", c.cmd, c.args, err)
		}
	}
	if _, _, err := ValidateCommand("d1", "status", []any{1}); err == nil {
		t.Fatal("array args accepted")
	}
	spec, args, err := ValidateCommand("d1", "ptz/dir", obj(t, `{"dir":"ul","hold_ms":99999,"id":"x","exp":1,"if_rev":3,"speed":5}`))
	if err != nil || !spec.Ephemeral || spec.Cap != "ptz" {
		t.Fatal(spec, err)
	}
	if args.Get("hold_ms") != 5000.0 || args.Has("id") || args.Has("exp") || args.Has("if_rev") || args.Get("speed") != 5.0 {
		t.Fatal(y.Stringify(args))
	}
	_, args, _ = ValidateCommand("d1", "firmware/upgrade", obj(t, `{"url":"https://x/fw.bin","sha256":"`+strings.Repeat("A", 64)+`"}`))
	if args.Get("sha256") != strings.Repeat("a", 64) {
		t.Fatal("sha not lowercased")
	}
	if s := Commands["system/reboot"]; !s.Long || !s.Dangerous {
		t.Fatal(s)
	}
	if s := Commands["config/import"]; !s.Config {
		t.Fatal(s)
	}
}

func TestParseResponse(t *testing.T) {
	cases := []struct {
		body, phase string
		ok          bool
		code        string
	}{
		{`{"id":"1","cmd":"ptz/goto","ok":true,"phase":"done","result":{"x":1}}`, "done", true, ""},
		{`{"id":"1","ok":false,"code":"conflict","error":"config_rev is 43"}`, "failed", false, "conflict"},
		{`{"id":"1","ok":true,"phase":"accepted"}`, "accepted", true, ""},
		{`{"id":"1","ok":true,"phase":"progress","result":{"pct":40}}`, "progress", true, ""},
		{`{"id":"1","ok":false,"phase":"done"}`, "failed", false, ""},
		// legacy (api 0): no ok/phase, result carries ok:false
		{`{"id":"1","result":{"ok":false,"error":"boom"}}`, "failed", false, ""},
		{`{"id":"1","result":{"x":2}}`, "done", true, ""},
	}
	for _, c := range cases {
		r := ParseResponse("ptz/goto", []byte(c.body))
		if r == nil || r.Phase != c.phase || r.OK != c.ok || r.Code != c.code || r.Cmd == "" {
			t.Errorf("%s → %+v", c.body, r)
		}
	}
	if r := ParseResponse("x", []byte(`{"id":"1","phase":"progress","result":{"pct":40}}`)); r.Pct == nil || *r.Pct != 40 {
		t.Fatal(r)
	}
	if r := ParseResponse("x", []byte(`{"id":"1","result":{"ok":false,"error":"boom"}}`)); r.Error != "boom" {
		t.Fatal(r.Error)
	}
	if ParseResponse("x", []byte(`nope`)) != nil {
		t.Fatal("garbage parsed")
	}
}

func TestParseBroker(t *testing.T) {
	cases := []struct {
		url   string
		tls   bool
		host  string
		port  int
		isTLS bool
		note  bool
	}{
		{"mqtt://broker.local", false, "broker.local", 1883, false, false},
		{"mqtts://broker.local", false, "broker.local", 8883, true, false},
		{"tcp://10.0.0.5:1884", false, "10.0.0.5", 1884, false, false},
		{"mqtt://broker.local", true, "broker.local", 8883, true, false},
		{"wss://broker.local/mqtt", false, "broker.local", 8883, true, true},
		{"broker.local:1999", false, "broker.local", 1999, false, false},
	}
	for _, c := range cases {
		ep, err := ParseBroker(c.url, c.tls)
		if err != nil || ep.Host != c.host || ep.Port != c.port || ep.TLS != c.isTLS || (ep.Note != "") != c.note {
			t.Errorf("%s → %+v %v", c.url, ep, err)
		}
	}
	if _, err := ParseBroker("", false); err == nil {
		t.Fatal("empty accepted")
	}
}

// --- service with a fake client -------------------------------------------------

func TestInactiveWithoutPluginOrBroker(t *testing.T) {
	f := newFixture(t, nil, false)
	f.setEnabled(false, nil)
	if _, active, _ := f.svc.EnsureForApp(bg, app); active || len(f.created) != 0 {
		t.Fatal("active while disabled")
	}
	f.setEnabled(true, nil)
	f.apps.mqtt.Enabled = false
	if _, active, _ := f.svc.EnsureForApp(bg, app); active || len(f.created) != 0 {
		t.Fatal("active without broker")
	}
	f.apps.mqtt.Enabled = true
	root, active, _ := f.svc.EnsureForApp(bg, app)
	if !active || root != "opencam" || len(f.created) != 1 {
		t.Fatal(root, active)
	}
	c := f.created[0]
	if len(c.subs) != 1 || c.subs[0][0] != "opencam/+/hello" || !strings.HasPrefix(c.opts.ClientID, "streamhub-cameras-live-") {
		t.Fatal(c.subs, c.opts.ClientID)
	}
	// a config change of the root re-creates the client
	f.setEnabled(true, obj(t, `{"baseTopic":"shop/cams"}`))
	_, _, _ = f.svc.EnsureForApp(bg, app)
	if len(f.created) != 2 || !f.created[0].ended || f.created[1].subs[0][0] != "shop/cams/+/hello" {
		t.Fatal("not re-created")
	}
}

func TestInventoryFromMQTT(t *testing.T) {
	f := newFixture(t, nil, false)
	c := f.client(t)
	c.emit("opencam/stand-02/status", "online", true)
	c.emit("opencam/stand-02/hello", `{"api":1,"device":"stand-02","fw":"0.3.0","boot_id":"b1","config_rev":42,"caps":["ptz","sd"]}`, true)
	c.emit("opencam/stand-02/state", `{"config_rev":43,"uptime_s":86400,"net":{"ssid":"S","rssi":-61},"stream":{"running":true,"source":1},
	  "sd":{"present":true,"total_kb":100,"free_kb":40},"queue":{"files":2,"bytes":2048},"ptz":{"x":1800,"y":450,"moving":false,"preset":2},
	  "health":{"mem_free_kb":3100,"load1":0.8,"safe_mode":true,"last_reboot":{"reason":"ota"}}}`, false)
	c.emit("opencam/stand-02/thumb", "\xff\xd8jpeg", true)
	c.emit("opencam/stand-02/event", `{"seq":1,"boot_id":"b1","ts":1793196000,"level":"info","src":"stream","event":"started","msg":"rtmp push ok"}`, false)
	c.emit("opencam/garbage/state", `not json`, false)

	list, err := f.svc.List(bg, app, ListFilter{})
	if err != nil || !list.Active || len(list.Cameras) != 1 {
		t.Fatal(list, err)
	}
	v := list.Cameras[0]
	sm := v.Summary
	if !v.Online || *v.Fw != "0.3.0" || !v.CapsKnown || len(v.Caps) != 2 || !v.Linked || v.Provisioned ||
		*sm.Rssi != -61 || !*sm.StreamRunning || *sm.SdFreeKb != 40 || *sm.QueueBytes != 2048 || *sm.PtzPreset != 2 ||
		!*sm.SafeMode || *sm.LastRebootReason != "ota" || *sm.ConfigRev != 43 || v.ThumbAt == nil || v.LastSeen == nil {
		b, _ := json.Marshal(v)
		t.Fatal(string(b))
	}
	d, _ := f.svc.Get(bg, app, "stand-02")
	if len(d.History) != 1 || *d.History[0].Rssi != -61 || len(d.Events) != 1 || *d.Events[0].Event != "started" ||
		d.Events[0].Ts != "2026-10-28T14:00:00.000Z" {
		t.Fatalf("%+v", d)
	}
	thumb, _, _ := f.svc.Thumb(bg, app, "stand-02")
	if string(thumb) != "\xff\xd8jpeg" {
		t.Fatal("thumb")
	}
	// LWT → offline; filters
	c.emit("opencam/stand-02/status", "offline", true)
	off := false
	if l, _ := f.svc.List(bg, app, ListFilter{Online: &off}); len(l.Cameras) != 1 || l.Cameras[0].Status != "offline" {
		t.Fatal(l)
	}
	if l, _ := f.svc.List(bg, app, ListFilter{Site: "nope"}); len(l.Cameras) != 0 {
		t.Fatal("site filter")
	}
	// retained state replay does not count as live traffic
	if l, _ := f.svc.List(bg, app, ListFilter{}); l.Cameras[0].Online {
		t.Fatal("still online")
	}
}

func TestStaleReapAndApi0Camera(t *testing.T) {
	f := newFixture(t, nil, false)
	c := f.client(t)
	// an api-0 camera never sent status: live traffic marks it online
	c.emit("opencam/old-1/state", `{"uptime_s":5}`, false)
	if l, _ := f.svc.List(bg, app, ListFilter{}); !l.Cameras[0].Online || l.Cameras[0].CapsKnown {
		t.Fatal(l.Cameras[0])
	}
	f.advance(181 * time.Second)
	if l, _ := f.svc.List(bg, app, ListFilter{}); l.Cameras[0].Online {
		t.Fatal("not reaped")
	}
}

func TestEventsBoundedDedupAndGap(t *testing.T) {
	f := newFixture(t, nil, false)
	f.setEnabled(true, obj(t, `{"eventsPerCamera":100}`))
	c := f.client(t)
	c.emit("opencam/d1/hello", `{"api":1,"boot_id":"b1"}`, true)
	for i := 1; i <= 120; i++ {
		c.emit("opencam/d1/event", `{"seq":`+itoa(i)+`,"boot_id":"b1","level":"info","src":"t","event":"e"}`, false)
	}
	c.emit("opencam/d1/event", `{"seq":120,"boot_id":"b1","level":"info","src":"t","event":"dup"}`, false)
	evs, _ := f.svc.Events(bg, app, "d1", EventQuery{Limit: 1000})
	if len(evs) != 100 || *evs[0].Seq != 120 || *evs[0].Event != "e" {
		t.Fatal(len(evs), *evs[0].Seq)
	}
	// a gap of 9 → eventsLost + an `events {n}` refill request
	before := len(c.published)
	c.emit("opencam/d1/event", `{"seq":130,"boot_id":"b1","level":"warn","src":"net","event":"offline"}`, false)
	d, _ := f.svc.Get(bg, app, "d1")
	if d.Camera.EventsLost != 9 || len(c.published) != before+1 || c.last().topic != "opencam/d1/cmd/events" || !strings.Contains(c.last().payload, `"n":14`) {
		t.Fatal(d.Camera.EventsLost, c.published[before:])
	}
	// the refill answer is ingested (deduplicated)
	c.emit("opencam/d1/res/events", `{"cmd":"events","ok":true,"phase":"done","result":{"events":[
	  {"seq":125,"boot_id":"b1","level":"info","src":"t","event":"refilled"},{"seq":130,"boot_id":"b1","level":"warn","src":"net","event":"offline"}]}}`, false)
	evs, _ = f.svc.Events(bg, app, "d1", EventQuery{Src: "t", Limit: 5})
	if *evs[0].Event != "refilled" {
		t.Fatal(*evs[0].Event)
	}
	if evs, _ := f.svc.Events(bg, app, "d1", EventQuery{Level: "warn"}); len(evs) != 1 {
		t.Fatal(len(evs))
	}
	// a new boot resets the seq baseline (no gap)
	c.emit("opencam/d1/event", `{"seq":1,"boot_id":"b2","level":"info","src":"system","event":"boot"}`, false)
	if d, _ := f.svc.Get(bg, app, "d1"); d.Camera.EventsLost != 9 {
		t.Fatal(d.Camera.EventsLost)
	}
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

func TestCommandLifecycle(t *testing.T) {
	f := newFixture(t, nil, false)
	c := f.client(t)
	if _, err := f.svc.SendCommand(bg, app, "ghost", CommandRequest{Cmd: "status"}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatal(err)
	}
	c.emit("opencam/d1/hello", `{"api":1,"boot_id":"b1","config_rev":7,"caps":["sd"]}`, true)

	// envelope + topic
	row, err := f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "snapshot/take", Args: obj(t, `{"upload":true}`), Actor: "u1"})
	if err != nil || row.Status != "pending" || row.ExpSec != 30 || *row.Actor != "u1" {
		t.Fatal(row, err)
	}
	p := c.last()
	if p.topic != "opencam/d1/cmd/snapshot/take" || p.retain {
		t.Fatal(p)
	}
	env := obj(t, p.payload)
	if env.Get("id") != row.ID || env.Get("exp") != 30.0 || env.Get("upload") != true || env.Has("if_rev") || env.Keys()[0] != "id" {
		t.Fatal(p.payload)
	}
	c.emit("opencam/d1/res/snapshot/take", `{"id":"`+row.ID+`","cmd":"snapshot/take","ok":true,"phase":"done","result":{"file":"a.jpg"}}`, false)
	got, _ := f.svc.GetCommand(bg, app, "d1", row.ID)
	if got.Status != "done" || got.ResolvedAt == nil || got.Result.(*y.Map).Get("file") != "a.jpg" {
		t.Fatal(got)
	}
	// a late duplicate does not reopen it
	c.emit("opencam/d1/res/snapshot/take", `{"id":"`+row.ID+`","ok":false,"code":"io"}`, false)
	if got, _ := f.svc.GetCommand(bg, app, "d1", row.ID); got.Status != "done" {
		t.Fatal(got.Status)
	}

	// config: if_rev from the known config_rev; conflict code surfaces
	row, _ = f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "config/import", Args: obj(t, `{"config":{"stream":{"source":1}}}`)})
	if obj(t, c.last().payload).Get("if_rev") != 7.0 {
		t.Fatal(c.last().payload)
	}
	c.emit("opencam/d1/res/config/import", `{"id":"`+row.ID+`","cmd":"config/import","ok":false,"code":"conflict","error":"config_rev is 8"}`, false)
	if got, _ := f.svc.GetCommand(bg, app, "d1", row.ID); got.Status != "failed" || *got.Code != "conflict" || *got.Error != "config_rev is 8" {
		t.Fatal(got)
	}
	rev := 3.0
	_, _ = f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "config/set", Args: obj(t, `{"key":"a","value":1}`), IfRev: &rev})
	if obj(t, c.last().payload).Get("if_rev") != 3.0 {
		t.Fatal(c.last().payload)
	}

	// caps: no 'ptz' in hello.caps → 409; PTZ dir is ephemeral when allowed
	if _, err := f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "ptz/stop"}); err == nil || !strings.Contains(err.Error(), "does not support") {
		t.Fatal(err)
	}
	c.emit("opencam/d1/hello", `{"api":1,"boot_id":"b1","caps":["ptz"]}`, true)
	row, _ = f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "ptz/dir", Args: obj(t, `{"dir":"left","hold_ms":500}`)})
	if row.Status != "sent" || row.ExpSec != 2 || obj(t, c.last().payload).Get("hold_ms") != 500.0 {
		t.Fatal(row)
	}
	if got, _ := f.svc.GetCommand(bg, app, "d1", row.ID); got != nil {
		t.Fatal("ephemeral persisted")
	}

	// dangerous: confirm required + audited
	if _, err := f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "queue/purge"}); err == nil || !strings.Contains(err.Error(), "confirm") {
		t.Fatal(err)
	}
	if _, err := f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "queue/purge", Confirm: true}); err != nil || len(f.audit.events) != 1 || f.audit.events[0].Action != "cameras.command" {
		t.Fatal(err, f.audit.events)
	}

	// timeout: no answer within exp + 10 s
	row, _ = f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "status"})
	f.advance(39 * time.Second)
	f.svc.Sweep(bg)
	if got, _ := f.svc.GetCommand(bg, app, "d1", row.ID); got.Status != "pending" {
		t.Fatal(got.Status)
	}
	f.advance(2 * time.Second)
	f.svc.Sweep(bg)
	if got, _ := f.svc.GetCommand(bg, app, "d1", row.ID); got.Status != "timeout" || *got.Code != "timeout" {
		t.Fatal(got.Status)
	}
	// a late answer still lands
	c.emit("opencam/d1/res/status", `{"id":"`+row.ID+`","ok":true,"phase":"done"}`, false)
	if got, _ := f.svc.GetCommand(bg, app, "d1", row.ID); got.Status != "done" {
		t.Fatal(got.Status)
	}
}

func TestLongCommandRebootResolvesOnNewBoot(t *testing.T) {
	f := newFixture(t, nil, false)
	c := f.client(t)
	c.emit("opencam/d1/hello", `{"api":1,"boot_id":"b1"}`, true)
	row, err := f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "system/reboot", Args: obj(t, `{"reason":"test"}`), Confirm: true})
	if err != nil || !row.Long {
		t.Fatal(row, err)
	}
	c.emit("opencam/d1/res/system/reboot", `{"id":"`+row.ID+`","cmd":"system/reboot","ok":true,"phase":"accepted"}`, false)
	got, _ := f.svc.GetCommand(bg, app, "d1", row.ID)
	if got.Status != "accepted" {
		t.Fatal(got.Status)
	}
	// accepted extends the deadline to longCommandTimeoutSec
	f.advance(60 * time.Second)
	f.svc.Sweep(bg)
	if got, _ := f.svc.GetCommand(bg, app, "d1", row.ID); got.Status != "accepted" {
		t.Fatal(got.Status)
	}
	// a retained replay of the old hello is not a reboot; a live new boot is
	c.emit("opencam/d1/hello", `{"api":1,"boot_id":"b1"}`, true)
	c.emit("opencam/d1/status", "offline", false)
	c.emit("opencam/d1/hello", `{"api":1,"boot_id":"b2"}`, false)
	got, _ = f.svc.GetCommand(bg, app, "d1", row.ID)
	if got.Status != "done" || *got.Pct != 100 || got.Result.(*y.Map).Get("bootId") != "b2" {
		t.Fatal(got)
	}
	// progress pct on a firmware upgrade
	row, _ = f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "firmware/upgrade", Confirm: true,
		Args: obj(t, `{"url":"https://x/fw.bin","sha256":"`+strings.Repeat("b", 64)+`"}`)})
	c.emit("opencam/d1/res/firmware/upgrade", `{"id":"`+row.ID+`","ok":true,"phase":"progress","result":{"pct":40}}`, false)
	if got, _ := f.svc.GetCommand(bg, app, "d1", row.ID); got.Status != "progress" || *got.Pct != 40 {
		t.Fatal(got)
	}
	c.emit("opencam/d1/res/firmware/upgrade", `{"id":"`+row.ID+`","ok":false,"phase":"failed","code":"network","error":"download"}`, false)
	if got, _ := f.svc.GetCommand(bg, app, "d1", row.ID); got.Status != "failed" || *got.Code != "network" {
		t.Fatal(got)
	}
}

func TestUpsertAndConfigIni(t *testing.T) {
	f := newFixture(t, nil, false)
	f.setEnabled(true, obj(t, `{"brokerPublicUrl":"mqtts://mqtt.example.com","rtmpPublicUrl":"rtmp://media.example.com/live"}`))
	name, site, key := "Stand 2", "abasto", "ptk_abc"
	v, created, err := f.svc.Upsert(bg, app, "stand-02", Inventory{Name: &name, Site: &site, StreamKey: &key}, true)
	if err != nil || !created || !v.Provisioned || *v.MqttUser != "cam-stand-02" || v.Linked || !v.HasStreamKey {
		t.Fatal(v, err)
	}
	if _, _, err := f.svc.Upsert(bg, app, "stand-02", Inventory{}, true); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatal(err)
	}
	if _, _, err := f.svc.Upsert(bg, app, "bad/id", Inventory{}, true); err == nil {
		t.Fatal("bad id accepted")
	}
	if _, _, err := f.svc.Upsert(bg, app, "nope", Inventory{Name: &name}, false); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatal(err)
	}
	ini, err := f.svc.ConfigIni(bg, app, "stand-02")
	if err != nil {
		t.Fatal(err)
	}
	cam, _ := f.svc.store.Get(bg, app, f.apps.dir, "stand-02")
	for _, want := range []string{"[device]\nid = stand-02\n", "host = mqtt.example.com\n", "port = 8883\n", "tls = 1\n",
		"user = cam-stand-02\n", "pass = " + *cam.MqttPass + "\n", "base_topic = opencam/%device\n",
		"url = rtmp://media.example.com/live\n", "key = ptk_abc\n", "autostart = 1\n", "[streamhub]\napi = 1\napp = live\n"} {
		if !strings.Contains(ini, want) {
			t.Errorf("missing %q in\n%s", want, ini)
		}
	}
	if len(*cam.MqttPass) < 20 {
		t.Fatal("weak password")
	}
	// lab mode: the app's broker credentials
	f.setEnabled(true, obj(t, `{"iniUseAppBrokerCredentials":true}`))
	ini, _ = f.svc.ConfigIni(bg, app, "stand-02")
	if !strings.Contains(ini, "user = core\npass = core-pass\n") || !strings.Contains(ini, "host = broker.test\nport = 1883\ntls = 0\n") {
		t.Fatal(ini)
	}
	// first hello links it
	c := f.client(t)
	c.emit("opencam/stand-02/hello", `{"api":1,"boot_id":"x"}`, false)
	if l, _ := f.svc.List(bg, app, ListFilter{Site: "abasto"}); len(l.Cameras) != 1 || !l.Cameras[0].Linked {
		t.Fatal(l)
	}
	if ok, _ := f.svc.Delete(bg, app, "stand-02"); !ok {
		t.Fatal("delete")
	}
}

func TestWaitForResolution(t *testing.T) {
	f := newFixture(t, nil, true)
	c := f.client(t)
	c.emit("opencam/d1/hello", `{"api":1,"boot_id":"b1"}`, true)
	go func() {
		// answer once the command is published
		for i := 0; i < 200; i++ {
			c.mu.Lock()
			var last *published
			if n := len(c.published); n > 0 {
				p := c.published[n-1]
				last = &p
			}
			c.mu.Unlock()
			if last != nil && strings.HasSuffix(last.topic, "/cmd/status") {
				id := obj(t, last.payload).Get("id").(string)
				c.emit("opencam/d1/res/status", `{"id":"`+id+`","ok":true,"phase":"done","result":{"uptime_s":1}}`, false)
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	row, err := f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "status", Wait: 3 * time.Second})
	if err != nil || row.Status != "done" {
		t.Fatal(row, err)
	}
	start := time.Now()
	row, _ = f.svc.SendCommand(bg, app, "d1", CommandRequest{Cmd: "hello", Wait: 150 * time.Millisecond})
	if row.Status != "pending" || time.Since(start) < 140*time.Millisecond {
		t.Fatal(row.Status)
	}
}

// --- routes -----------------------------------------------------------------------

func TestRoutes(t *testing.T) {
	f := newFixture(t, nil, false)
	_, api := humatest.New(t)
	httpx.InstallHumaErrors()
	f.svc.Register(api)
	c := f.client(t)
	c.emit("opencam/d1/hello", `{"api":1,"boot_id":"b1","caps":["ptz","voice"]}`, true)
	c.emit("opencam/d1/status", "online", true)

	r := api.Get("/api/v1/apps/live/plugins/cameras/cameras?online=true")
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"device":"d1"`) || !strings.Contains(r.Body.String(), `"active":true`) {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := api.Get("/api/v1/apps/live/plugins/cameras/cameras/d1"); r.Code != 200 || !strings.Contains(r.Body.String(), `"commands":[]`) {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := api.Get("/api/v1/apps/live/plugins/cameras/cameras/zz"); r.Code != 404 {
		t.Fatal(r.Code)
	}
	post := func(path, body string) (int, string) {
		r := api.Post("/api/v1/apps/live/plugins/cameras/cameras"+path, strings.NewReader(body))
		return r.Code, r.Body.String()
	}
	// alta
	if code, body := post("", `{"device":"stand-09","site":"abasto","tags":["norte"]}`); code != 201 || !strings.Contains(body, `"provisioned":true`) || !strings.Contains(body, `"tags":["norte"]`) {
		t.Fatal(code, body)
	}
	for _, c := range []struct{ body, msg string }{
		{`{}`, "body must carry a 'device'"},
		{`[1]`, "body must be a JSON object"},
		{`{"device":"x","site":5}`, "'site' must be a string"},
		{`{"device":"x","tags":"a"}`, "'tags' must be an array"},
		{`{"device":"a/b"}`, "device must match"},
	} {
		if code, body := post("", c.body); code != 400 || !strings.Contains(body, c.msg) {
			t.Errorf("%s → %d %s", c.body, code, body)
		}
	}
	if code, body := post("", `{"device":"stand-09"}`); code != 409 {
		t.Fatal(code, body)
	}
	if r := api.Patch("/api/v1/apps/live/plugins/cameras/cameras/stand-09", strings.NewReader(`{"stand":"S9","room":"stand-09"}`)); r.Code != 200 ||
		!strings.Contains(r.Body.String(), `"hlsPath":"/hls/live/stand-09/index.m3u8"`) {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := api.Get("/api/v1/apps/live/plugins/cameras/cameras/stand-09/config.ini"); r.Code != 200 ||
		r.Header().Get("Content-Disposition") != `attachment; filename="config.ini"` || !strings.Contains(r.Body.String(), "id = stand-09") {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := api.Get("/api/v1/apps/live/plugins/cameras/cameras/d1/thumb"); r.Code != 404 {
		t.Fatal(r.Code)
	}
	c.emit("opencam/d1/thumb", "\xff\xd8x", true)
	if r := api.Get("/api/v1/apps/live/plugins/cameras/cameras/d1/thumb"); r.Code != 200 || r.Header().Get("Content-Type") != "image/jpeg" || r.Body.String() != "\xff\xd8x" {
		t.Fatal(r.Code, r.Header())
	}

	// commands
	cases := []struct {
		path, body string
		code       int
		msg, topic string
	}{
		{"/d1/command", `{"cmd":"status"}`, 201, `"status":"pending"`, "opencam/d1/cmd/status"},
		{"/d1/command", `{}`, 400, "body must carry a 'cmd'", ""},
		{"/d1/command", `{"cmd":"nuke"}`, 400, "unknown command 'nuke'", ""},
		{"/d1/command", `{"cmd":"system/reboot"}`, 400, "dangerous", ""},
		{"/d1/command", `{"cmd":"status","exp":"x"}`, 400, "'exp' must be a number", ""},
		{"/d1/command", `{"cmd":"sd/status"}`, 409, "does not support", ""},
		{"/zz/command", `{"cmd":"status"}`, 404, "camera 'zz' not found", ""},
		{"/d1/ptz/move", `{"dir":"up","speed":3}`, 201, `"status":"sent"`, "opencam/d1/cmd/ptz/dir"},
		{"/d1/ptz/move", `{"dir":"nowhere"}`, 400, "ptz/dir requires dir", ""},
		{"/d1/ptz/stop", ``, 201, `"cmd":"ptz/stop"`, "opencam/d1/cmd/ptz/stop"},
		{"/d1/ptz/home", `{}`, 201, `"cmd":"ptz/home"`, "opencam/d1/cmd/ptz/home"},
		{"/d1/ptz/preset", `{"preset":2}`, 201, `"cmd":"ptz/preset"`, "opencam/d1/cmd/ptz/preset"},
		{"/d1/stream/start", ``, 201, `"cmd":"stream/start"`, "opencam/d1/cmd/stream/start"},
		{"/d1/stream/stop", ``, 201, `"cmd":"stream/stop"`, "opencam/d1/cmd/stream/stop"},
		{"/d1/snapshot", ``, 201, `"cmd":"snapshot/take"`, "opencam/d1/cmd/snapshot/take"},
		{"/d1/voice/test", ``, 201, `"key":"network_offline"`, "opencam/d1/cmd/voice/say"},
		{"/d1/reboot", `{"reason":"ops"}`, 201, `"cmd":"system/reboot"`, "opencam/d1/cmd/system/reboot"},
		{"/d1/stream/hd", `{"on":true,"minutes":2}`, 201, `"hdUntil":"2026-10-28T12:02:00.000Z"`, "opencam/d1/cmd/stream/set"},
		{"/d1/stream/hd", `{}`, 400, "'on' (boolean)", ""},
	}
	for _, tc := range cases {
		before := len(c.published)
		code, body := post(tc.path, tc.body)
		if code != tc.code || !strings.Contains(body, tc.msg) {
			t.Errorf("%s %s → %d %s", tc.path, tc.body, code, body)
			continue
		}
		if tc.topic != "" && (len(c.published) != before+1 || c.last().topic != tc.topic) {
			t.Errorf("%s: published %v", tc.path, c.published[before:])
		}
	}
	if !strings.Contains(c.last().payload, `"source":0`) {
		t.Fatal(c.last().payload)
	}
	if d, _ := f.svc.Get(bg, app, "d1"); d.Camera.HdUntil == nil {
		t.Fatal("hdUntil")
	}
	_, body := post("/d1/stream/hd", `{"on":false}`)
	if !strings.Contains(body, `"hdUntil":null`) || !strings.Contains(c.last().payload, `"source":1`) {
		t.Fatal(body)
	}
	cmdID := obj(t, c.published[len(c.published)-1].payload).Get("id").(string)
	if r := api.Get("/api/v1/apps/live/plugins/cameras/cameras/d1/commands/" + cmdID); r.Code != 200 {
		t.Fatal(r.Code)
	}
	if r := api.Get("/api/v1/apps/live/plugins/cameras/cameras/d1/commands/nope"); r.Code != 404 {
		t.Fatal(r.Code)
	}
	if r := api.Get("/api/v1/apps/live/plugins/cameras/cameras/d1/events?limit=5"); r.Code != 200 || !strings.Contains(r.Body.String(), `"events":[]`) {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := api.Delete("/api/v1/apps/live/plugins/cameras/cameras/stand-09"); r.Code != 200 {
		t.Fatal(r.Code)
	}
	// inactive → 409
	f.setEnabled(false, nil)
	if code, body := post("/d1/command", `{"cmd":"status"}`); code != 409 || !strings.Contains(body, "cameras is not active for app 'live'") {
		t.Fatal(code, body)
	}
	if r := api.Get("/api/v1/apps/live/plugins/cameras/cameras"); r.Code != 200 || !strings.Contains(r.Body.String(), `"active":false`) {
		t.Fatal(r.Code, r.Body.String())
	}
}
