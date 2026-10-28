package streamflow

import (
	"context"
	"database/sql"
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

var bg = context.Background()

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type call struct {
	name string
	args []any
}

type fakeDeps struct {
	mu    sync.Mutex
	calls []call
	deps  *Deps
}

func (f *fakeDeps) rec(name string, args ...any) {
	f.mu.Lock()
	f.calls = append(f.calls, call{name, args})
	f.mu.Unlock()
}

func newFakeDeps() *fakeDeps {
	f := &fakeDeps{}
	f.deps = &Deps{
		Snapshot: func(_ context.Context, app, room string, p *string) (string, string, error) {
			f.rec("snapshot", app, room, p)
			return "snaps/" + room + ".jpg", "https://s3/" + room, nil
		},
		S3Upload: func(_ context.Context, app, key string, body []byte, ct string) (string, string, error) {
			f.rec("s3", key, string(body), ct)
			return key, "https://s3/" + key, nil
		},
		AI: func(_ context.Context, in AIInput) (*AIOutput, error) {
			f.rec("ai", in.Prompt, in.ImageURL)
			return &AIOutput{Text: "ok", UsageTokens: 7, JSON: y.Undefined}, nil
		},
		HTTPPost: func(_ context.Context, url string, body any, h *y.Map) (*HTTPResult, error) {
			f.rec("http", url, str(body), str(h))
			if strings.Contains(url, "fail") {
				return &HTTPResult{OK: false, Status: 500}, nil
			}
			return &HTTPResult{OK: true, Status: 200, Body: obj("ok", true)}, nil
		},
		Emit: func(_ context.Context, app, event string, p *y.Map) error {
			f.rec("emit", event, str(p))
			return nil
		},
		MQTTPublish: func(_ context.Context, app, topic string, p any, qos int, retain bool) error {
			f.rec("mqtt", topic, str(p), qos, retain)
			return nil
		},
		Notify: func(_ context.Context, app, event string, p *y.Map, title string, ch []string) error {
			f.rec("notify", event, title, strings.Join(ch, ","))
			return nil
		},
		PluginEvent: func(_ context.Context, app, plugin, event string, data *y.Map, room, token, url string) (*HTTPResult, error) {
			f.rec("plugin", plugin, event, str(data), room, token)
			return &HTTPResult{OK: true, Status: 202}, nil
		},
		Sleep: func(_ context.Context, d time.Duration) error { f.rec("sleep", d); return nil },
		Now:   func() float64 { return 1700000000000 },
		RunCode: func(_ context.Context, in CodeInput) *y.Map {
			f.rec("code", in.Source, in.Timeout)
			return obj("ok", true, "output", 1.0)
		},
		RunShell: func(_ context.Context, in ShellInput) *y.Map {
			f.rec("shell", in.Command, strings.Join(in.Args, "|"))
			return obj("ok", false, "code", 1.0)
		},
		RunSSH: func(_ context.Context, in SSHInput) *y.Map {
			f.rec("ssh", in.Host, in.Port, in.User, in.PrivateKey, in.Command)
			return obj("ok", true, "code", 0.0)
		},
		RunDB: func(_ context.Context, in DBInput) *y.Map {
			f.rec("db", in.Engine, in.Query, str(in.Params), in.RowLimit)
			return obj("ok", true, "output", []any{}, "rowCount", 0.0)
		},
	}
	return f
}

func (f *fakeDeps) last(name string) []any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i].name == name {
			return f.calls[i].args
		}
	}
	return nil
}

func bctx(t *testing.T, payload string) *BoxContext {
	p := jm(t, payload)
	return &BoxContext{App: "live", AppDir: "/tmp/x", Trigger: Trigger{Event: "plate.detected", Payload: p}, Bag: newBag("plate.detected", p)}
}

func runBox(t *testing.T, typ, config string, bc *BoxContext, f *fakeDeps) (any, string, error) {
	t.Helper()
	return executors[typ](bg, BoxNode{ID: "b1", Type: typ, Config: jm(t, config)}, bc, f.deps)
}

// ---------------------------------------------------------------------------
// boxes/executors.spec.ts
// ---------------------------------------------------------------------------

func TestExecutors(t *testing.T) {
	f := newFakeDeps()
	bc := bctx(t, `{"room":"gate","plate":"ABC","conf":0.9,"tags":["vip"]}`)

	if out, port, _ := runBox(t, "trigger.event", `{}`, bc, f); port != "out" || str(out) != `{"room":"gate","plate":"ABC","conf":0.9,"tags":["vip"]}` {
		t.Fatal("trigger")
	}
	if out, _, _ := runBox(t, "action.snapshot", `{}`, bc, f); str(out) != `{"key":"snaps/gate.jpg","url":"https://s3/gate"}` || f.last("snapshot")[1] != "gate" {
		t.Fatal("snapshot default room")
	}
	if _, _, err := runBox(t, "action.snapshot", `{}`, bctx(t, `{}`), f); err == nil || err.Error() != "action.snapshot: no room (config.room / trigger.room)" {
		t.Fatalf("snapshot err %v", err)
	}
	runBox(t, "action.s3", `{}`, bc, f)
	if a := f.last("s3"); a[0] != "streamflow/b1-1700000000000" || a[1] != "{}" {
		t.Fatalf("s3 default %v", a)
	}
	runBox(t, "action.s3", `{"key":"k/{{trigger.plate}}.txt","content":"QUJD","base64":true,"contentType":"text/plain"}`, bc, f)
	if a := f.last("s3"); a[0] != "k/ABC.txt" || a[1] != "ABC" || a[2] != "text/plain" {
		t.Fatalf("s3 base64 %v", a)
	}
	if _, port, _ := runBox(t, "action.http", `{"url":"https://h/ok","headers":{"x":"{{trigger.plate}}"}}`, bc, f); port != "out" {
		t.Fatal("http out")
	}
	if a := f.last("http"); a[1] != `{"room":"gate","plate":"ABC","conf":0.9,"tags":["vip"]}` || a[2] != `{"x":"ABC"}` {
		t.Fatalf("http body/headers %v", a)
	}
	if _, port, _ := runBox(t, "action.http", `{"url":"https://h/fail","body":{"p":"{{trigger.plate}}"}}`, bc, f); port != "error" || f.last("http")[1] != `{"p":"ABC"}` {
		t.Fatal("http error port")
	}
	if _, _, err := runBox(t, "action.http", `{}`, bc, f); err == nil || err.Error() != "action.http: config.url is required" {
		t.Fatal("http no url")
	}
	if out, _, _ := runBox(t, "action.ai", `{"prompt":"is {{trigger.plate}} ok?","imageUrl":"{{trigger.room}}"}`, bc, f); str(out) != `{"text":"ok","usageTokens":7}` || f.last("ai")[1] != "gate" {
		t.Fatalf("ai %s", str(out))
	}
	if _, _, err := runBox(t, "action.ai", `{}`, bc, f); err == nil || err.Error() != "action.ai: config.prompt is required" {
		t.Fatal("ai no prompt")
	}
	if out, _, _ := runBox(t, "action.emit", `{"event":"evil.thing","payload":{"p":"{{trigger.plate}}"}}`, bc, f); str(out) != `{"event":"streamflow.output"}` || f.last("emit")[1] != `{"p":"ABC"}` {
		t.Fatal("emit normalize")
	}
	runBox(t, "action.mqtt", `{"topic":"gate/{{trigger.plate}}","qos":2,"retain":true}`, bc, f)
	if a := f.last("mqtt"); a[0] != "gate/ABC" || a[2] != 2 || a[3] != true || !strings.Contains(a[1].(string), `"plate":"ABC"`) {
		t.Fatalf("mqtt %v", a)
	}
	if _, _, err := runBox(t, "action.mqtt", `{}`, bc, f); err == nil {
		t.Fatal("mqtt no topic")
	}
	runBox(t, "action.notify", `{"title":"T {{trigger.plate}}","channels":["discord",5]}`, bc, f)
	if a := f.last("notify"); a[0] != "streamflow.output" || a[1] != "T ABC" || a[2] != "discord,5" {
		t.Fatalf("notify %v", a)
	}
	if out, port, _ := runBox(t, "action.plugin", `{"plugin":"lpr","event":"x","data":{"a":1},"token":"tk"}`, bc, f); port != "out" || str(out) != `{"ok":true,"status":202}` || f.last("plugin")[3] != "gate" {
		t.Fatal("plugin")
	}
	if _, _, err := runBox(t, "action.plugin", `{"plugin":"lpr"}`, bc, f); err == nil || err.Error() != "action.plugin: config.plugin and config.event are required" {
		t.Fatal("plugin required")
	}
	if out, port, _ := runBox(t, "logic.condition", `{"rules":[{"field":"trigger.conf","op":"gte","value":0.9}]}`, bc, f); port != "true" || str(out) != `{"matched":true}` {
		t.Fatal("condition")
	}
	if out, _, _ := runBox(t, "logic.delay", `{"seconds":2}`, bc, f); str(out) != `{"delayedMs":2000}` || f.last("sleep")[0] != 2*time.Second {
		t.Fatal("delay")
	}
	if out, _, _ := runBox(t, "logic.delay", `{"ms":999999}`, bc, f); str(out) != `{"delayedMs":60000}` {
		t.Fatal("delay cap")
	}
	if out, _, _ := runBox(t, "logic.setvar", `{"set":{"vars.p":"{{trigger.plate}}"},"assignments":[{"path":"vars.c","value":"{{trigger.conf}}"},{"path":" "}]}`, bc, f); str(out) != `{"vars.p":"ABC","vars.c":0.9}` || str(bc.Bag.Get("vars")) != `{"p":"ABC","c":0.9}` {
		t.Fatalf("setvar %s", str(out))
	}
	if out, port, _ := runBox(t, "logic.switch", `{"field":"trigger.plate","cases":[{"value":"ABC","port":"vip"}]}`, bc, f); port != "vip" || str(out) != `{"port":"vip","value":"ABC"}` {
		t.Fatal("switch")
	}
}

func TestDangerousExecutors(t *testing.T) {
	f := newFakeDeps()
	bc := bctx(t, `{"host":"db1"}`)
	for typ, cfg := range map[string]string{
		"action.code": `{"source":"output=1"}`, "action.shell": `{"command":"ls"}`,
		"action.ssh": `{"host":"h","user":"u","command":"c","key":"k"}`, "action.db": `{"dsn":"x","query":"select 1"}`,
	} {
		if _, _, err := runBox(t, typ, cfg, bc, f); err == nil || err.Error() != typ+": execution nodes are disabled (enable streamflow.dangerousNodes)" {
			t.Errorf("%s not refused: %v", typ, err)
		}
	}
	bc.DangerousEnabled = true
	if _, port, _ := runBox(t, "action.code", `{"source":"output = 1","timeoutMs":99999}`, bc, f); port != "out" || f.last("code")[1] != 5*time.Second {
		t.Fatal("code bounded timeout")
	}
	if _, port, _ := runBox(t, "action.shell", `{"command":"echo","args":["a;rm -rf /","{{trigger.host}}"]}`, bc, f); port != "error" || f.last("shell")[1] != "a;rm -rf /|db1" {
		t.Fatal("shell argv")
	}
	runBox(t, "action.ssh", `{"host":"{{trigger.host}}","user":"u","command":"uptime","key":"PRIVATE","port":"2222"}`, bc, f)
	if a := f.last("ssh"); a[0] != "db1" || a[1] != 2222 || a[3] != "PRIVATE" {
		t.Fatalf("ssh %v", a)
	}
	if _, _, err := runBox(t, "action.ssh", `{"host":"h","user":"u","command":"c"}`, bc, f); err == nil || !strings.Contains(err.Error(), "config.key") {
		t.Fatal("ssh key required")
	}
	runBox(t, "action.db", `{"engine":"mysql","dsn":"d","query":"select ? as x","params":["{{trigger.host}}"],"rowLimit":99999}`, bc, f)
	if a := f.last("db"); a[0] != "mysql" || a[1] != "select ? as x" || a[2] != `["db1"]` || a[3] != 10000 {
		t.Fatalf("db %v", a)
	}
	f.deps.RunCode = nil
	if _, _, err := runBox(t, "action.code", `{"source":"x"}`, bc, f); err == nil || err.Error() != "action.code: sandbox not available" {
		t.Fatal("sandbox missing")
	}
}

func TestTriggerMatching(t *testing.T) {
	p := jm(t, `{"room":"gate","tags":["vip"],"tag":"x","conf":0.95,"topic":"site/cam1/temp"}`)
	cases := map[string]bool{
		`{"event":"plate.detected"}`: true, `{"event":"plate.*"}`: true, `{"event":""}`: true, `{"event":"all"}`: true,
		`{"event":"plate.other"}`: false, `{"event":"*","room":"other"}`: false, `{"room":" gate "}`: true,
		`{"tags":["staff","x"]}`: true, `{"tags":["staff"]}`: false,
		`{"predicate":{"rules":[{"field":"trigger.conf","op":"gt","value":0.9}]}}`: true,
		`{"predicate":{"rules":[{"field":"event","op":"eq","value":"nope"}]}}`:     false,
	}
	for cfg, want := range cases {
		if got := matchesEventTrigger(jm(t, cfg), "plate.detected", p); got != want {
			t.Errorf("%s → %v", cfg, got)
		}
	}
	for filter, want := range map[string]bool{"": true, "#": true, "site/+/temp": true, "site/#": true, "site/*": true, "site/cam2/temp": false, "site/+": false} {
		if got := matchesMqttTrigger(obj("topic", filter), p); got != want {
			t.Errorf("mqtt %q → %v", filter, got)
		}
	}
	if matchesMqttTrigger(obj("topic", "a"), y.NewMap()) || !topicMatches("a/b", "a/b") || topicMatches("a/+/c", "a/b") {
		t.Fatal("topicMatches")
	}
	if normalizeEmitEvent("streamflow.run_failed") != "streamflow.run_failed" || normalizeEmitEvent(5.0) != "streamflow.output" {
		t.Fatal("normalizeEmitEvent")
	}
}

// ---------------------------------------------------------------------------
// boxes/danger-exec.spec.ts (real sandbox + shell; no network)
// ---------------------------------------------------------------------------

func code(src string, input string, timeout time.Duration, max int) *y.Map {
	var in any = y.NewMap()
	if input != "" {
		in, _ = y.ParseJSON([]byte(input))
	}
	return RunCode(bg, CodeInput{Source: src, Input: in, Timeout: timeout, MaxOutputBytes: max})
}

func TestRunCode(t *testing.T) {
	if r := code("output = input.a + input.b", `{"a":2,"b":3}`, time.Second, 1024); r.Get("ok") != true || r.Get("output") != 5.0 {
		t.Fatalf("basic %s", str(r))
	}
	for src, want := range map[string]string{
		`output = require("fs")`: "require", `output = process.env`: "process",
	} {
		if r := code(src, "", time.Second, 1024); r.Get("ok") != false || !strings.Contains(y.ToString(r.Get("error")), want) {
			t.Errorf("%s → %s", src, str(r))
		}
	}
	for _, src := range []string{
		`output = this.constructor.constructor("return process")()`,
		`output = (function(){}).constructor("return 1")()`,
		`output = eval("1")`, `output = Function("return 1")()`,
	} {
		if r := code(src, "", time.Second, 1024); r.Get("ok") != false {
			t.Errorf("escape not blocked: %s → %s", src, str(r))
		}
	}
	if r := code("while (true) {}", "", 50*time.Millisecond, 1024); r.Get("ok") != false || !strings.Contains(y.ToString(r.Get("error")), "timed out") {
		t.Fatalf("timeout %s", str(r))
	}
	if r := code(`output = "x".repeat(1000)`, "", time.Second, 100); r.Get("error") != "output too large" {
		t.Fatalf("cap %s", str(r))
	}
	if r := code("output = {}; output.self = output", "", time.Second, 1024); r.Get("error") != "output is not JSON-serialisable" {
		t.Fatalf("circular %s", str(r))
	}
	if r := code("try { input.a = 9 } catch (e) {} output = input.a", `{"a":1}`, time.Second, 1024); r.Get("output") != 1.0 {
		t.Fatalf("frozen %s", str(r))
	}
	if r := code("output = {b: 2, a: [1, 'x']}", "", time.Second, 1024); str(r) != `{"ok":true,"output":{"b":2,"a":[1,"x"]}}` {
		t.Fatalf("order %s", str(r))
	}
}

func TestRunShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix only")
	}
	echo, err := exec.LookPath("echo")
	if err != nil {
		t.Skip("no echo")
	}
	r := RunShell(bg, ShellInput{Command: echo, Args: []string{"-n", "hi;$(id)"}, Timeout: 5 * time.Second, MaxOutputBytes: 1024})
	if r.Get("ok") != true || r.Get("code") != 0.0 || r.Get("stdout") != "hi;$(id)" {
		t.Fatalf("argv %s", str(r))
	}
	if r := RunShell(bg, ShellInput{Command: "definitely-not-a-real-command-xyz", Timeout: time.Second, MaxOutputBytes: 1024}); r.Get("ok") != false || r.Get("code") != nil {
		t.Fatalf("unknown %s", str(r))
	}
	if sh, err := exec.LookPath("false"); err == nil {
		if r := RunShell(bg, ShellInput{Command: sh, Timeout: time.Second, MaxOutputBytes: 1024}); r.Get("ok") != false || r.Get("code") != 1.0 {
			t.Fatalf("exit code %s", str(r))
		}
	}
}

func TestDBAndSSHFailClosed(t *testing.T) {
	if r := RunDB(bg, DBInput{Engine: "postgres", DSN: "::not a dsn::", Query: "select 1", Timeout: time.Second}); r.Get("ok") != false {
		t.Fatalf("pg bad dsn %s", str(r))
	}
	if d, err := mysqlDSN("mysql://u:p%40ss@db.example/app"); err != nil || d != "u:p@ss@tcp(db.example:3306)/app" {
		t.Fatalf("mysql dsn %q %v", d, err)
	}
	if r := RunSSH(bg, SSHInput{Host: "h", Port: 22, User: "u", PrivateKey: "not a key", Command: "x", Timeout: time.Second}); r.Get("ok") != false {
		t.Fatalf("ssh bad key %s", str(r))
	}
	if mysqlValue("DECIMAL", sql.RawBytes("1.50")) != "1.50" || mysqlValue("INT", sql.RawBytes("7")) != 7.0 || mysqlValue("VARCHAR", nil) != nil {
		t.Fatal("mysql value mapping")
	}
}

// ---------------------------------------------------------------------------
// store / secrets / runner / service
// ---------------------------------------------------------------------------

type fakeApps struct {
	dir  string
	apps map[string]bool
}

func (a *fakeApps) Get(_ context.Context, n string) (*contracts.AppRecord, error) {
	if !a.apps[n] {
		return nil, nil
	}
	return &contracts.AppRecord{Name: n}, nil
}
func (a *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	var out []contracts.AppRecord
	for n := range a.apps {
		out = append(out, contracts.AppRecord{Name: n})
	}
	return out, nil
}
func (a *fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	return &contracts.AppConfig{}, nil
}
func (a *fakeApps) AppDir(n string) string { return a.dir + "/" + n }

type fakeCallbacks struct {
	mu     sync.Mutex
	events []string
}

func (f *fakeCallbacks) Dispatch(_ context.Context, _, event string, _ any) error {
	f.mu.Lock()
	f.events = append(f.events, event)
	f.mu.Unlock()
	return nil
}

func (f *fakeCallbacks) has(e string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, x := range f.events {
		if x == e {
			return true
		}
	}
	return false
}

type world struct {
	store   *Store
	apps    *fakeApps
	cb      *fakeCallbacks
	runner  *Runner
	svc     *Service
	secrets *Secrets
	plugin  struct {
		installed, enabled bool
		config             *y.Map
	}
}

func newWorld(t *testing.T) *world {
	w := &world{store: NewStore(), apps: &fakeApps{dir: t.TempDir(), apps: map[string]bool{"live": true, "other": true}}, cb: &fakeCallbacks{}}
	t.Cleanup(w.store.CloseAll)
	w.plugin.installed, w.plugin.enabled, w.plugin.config = true, true, y.NewMap()
	plugin := func(context.Context, string) (bool, bool, *y.Map) {
		return w.plugin.installed, w.plugin.enabled, w.plugin.config
	}
	w.secrets = NewSecrets(w.store, w.apps, "jwt-x")
	w.runner = NewRunner(RunnerDeps{Store: w.store, Apps: w.apps, Plugin: plugin, Callbacks: w.cb, Secrets: w.secrets,
		Snapshot: func(context.Context, string, string, *string) (string, string, error) {
			return "", "", errors.New("camera down")
		}})
	w.svc = NewService(w.store, w.runner, w.apps, plugin, nil)
	return w
}

// runNow executes queued jobs inline (the worker loop, synchronously).
func (w *world) runNow() {
	for {
		select {
		case j := <-w.runner.queue:
			w.runner.Execute(bg, j)
		default:
			return
		}
	}
}

func (w *world) wf(t *testing.T, graph string) *Workflow {
	wf, err := w.store.CreateWorkflow(bg, "live", w.apps.AppDir("live"), "Flow", nil, js(t, graph))
	if err != nil {
		t.Fatal(err)
	}
	return wf
}

func TestStore(t *testing.T) {
	w := newWorld(t)
	dir := w.apps.AppDir("live")
	f := false
	wf, _ := w.store.CreateWorkflow(bg, "live", dir, "A", &f, nil)
	if wf.Enabled || str(wf.Graph) != `{"boxes":[],"edges":[]}` || wf.CreatedAt == "" {
		t.Fatalf("create %+v", wf)
	}
	up, _ := w.store.UpdateWorkflow(bg, "live", dir, wf.ID, WorkflowPatch{Name: nil, HasName: true, Enabled: true, HasEnabled: true, Graph: js(t, `{"z":1,"a":2}`), HasGraph: true})
	if up.Name != "null" || !up.Enabled || str(up.Graph) != `{"z":1,"a":2}` {
		t.Fatalf("update %+v", up)
	}
	run, _ := w.store.CreateRun(bg, "live", dir, wf.ID, "x", "")
	ms := 12.6
	_ = w.store.RecordStep(bg, "live", dir, StepRecord{RunID: run.ID, BoxID: "b", BoxType: "t", Status: "ok", Input: obj("a", 1.0), Output: y.Undefined, Ms: &ms, Seq: 1})
	_ = w.store.RecordStep(bg, "live", dir, StepRecord{RunID: run.ID, BoxID: "a", BoxType: "t", Status: "weird", Input: y.Undefined, Output: "o", Seq: 0})
	steps, _ := w.store.ListSteps(bg, "live", dir, run.ID)
	if len(steps) != 2 || steps[0].BoxID != "a" || steps[0].Input != nil || steps[0].Status != "ok" || *steps[1].Ms != 13 || steps[1].Output != nil {
		t.Fatalf("steps %+v", steps)
	}
	for i := 0; i < 3; i++ {
		_, _ = w.store.CreateRun(bg, "live", dir, "other-wf", "x", "")
	}
	one := 1.0
	if runs, _ := w.store.ListRuns(bg, "live", dir, "other-wf", &one); len(runs) != 1 {
		t.Fatal("limit")
	}
	if runs, _ := w.store.ListRuns(bg, "live", dir, "", nil); len(runs) != 4 {
		t.Fatal("all runs")
	}
	h, _ := w.store.DB(bg, "live", dir)
	_, _ = h.Exec(`UPDATE runs SET started_at = datetime('now','-40 days') WHERE id = ?`, run.ID)
	if n, _ := w.store.PruneHistory(bg, "live", dir, 30); n != 1 {
		t.Fatalf("prune %d", n)
	}
	if steps, _ := w.store.ListSteps(bg, "live", dir, run.ID); len(steps) != 0 {
		t.Fatal("steps not cascaded")
	}
	ok, _ := w.store.DeleteWorkflow(bg, "live", dir, wf.ID)
	again, _ := w.store.DeleteWorkflow(bg, "live", dir, wf.ID)
	if !ok || again {
		t.Fatal("delete")
	}
	month := "2026-10"
	_ = w.store.AddUsage(bg, "live", dir, 100, 0.5, month)
	_ = w.store.AddUsage(bg, "live", dir, 50, 0.25, month)
	if w.store.MonthlyUSD(bg, "live", dir, month) != 0.75 || w.store.MonthlyUSD(bg, "live", dir, "1999-01") != 0 {
		t.Fatal("usage")
	}
}

func TestSecretsService(t *testing.T) {
	w := newWorld(t)
	meta, err := w.secrets.Put(bg, "live", " TOKEN ", "shh-secret-value")
	if err != nil || meta.Name != "TOKEN" || meta.Last4 != "alue" {
		t.Fatalf("put %+v %v", meta, err)
	}
	h, _ := w.store.DB(bg, "live", w.apps.AppDir("live"))
	var enc string
	_ = h.QueryRow(`SELECT value_enc FROM secrets`).Scan(&enc)
	if strings.Contains(enc, "shh") || !strings.HasPrefix(enc, "aesgcm$") {
		t.Fatal("plaintext at rest")
	}
	list, _ := w.secrets.List(bg, "live")
	if len(list) != 1 || list[0].Last4 != "alue" || list[0].CreatedAt == "" {
		t.Fatalf("list %+v", list)
	}
	for _, c := range []struct{ name, value, msg string }{
		{"bad-name", "v", "secret name must be UPPER_SNAKE_CASE (A–Z, 0–9, _), 1–64 chars"},
		{"OK", "  ", "secret value is required"},
		{"OK", "sk-…abcd", "refusing to store a masked value"},
	} {
		if _, err := w.secrets.Put(bg, "live", c.name, c.value); err == nil || err.Error() != c.msg {
			t.Errorf("%+v → %v", c, err)
		}
	}
	if _, err := w.secrets.Put(bg, "nope", "X", "v"); err == nil || err.Error() != "app 'nope' not found" {
		t.Fatal("unknown app")
	}
	cfg, used := w.secrets.expandConfig(bg, "live", w.apps.AppDir("live"), jm(t, `{"a":"Bearer {{ secret.TOKEN }}","b":["{{secret.MISSING}}"],"c":1}`))
	if str(cfg) != `{"a":"Bearer shh-secret-value","b":[""],"c":1}` || len(used) != 1 {
		t.Fatalf("expand %s %v", str(cfg), used)
	}
	if res, _ := w.secrets.Remove(bg, "live", "TOKEN"); !res["deleted"] {
		t.Fatal("remove")
	}
	if _, err := w.secrets.Remove(bg, "live", "TOKEN"); err == nil || err.Error() != "secret 'TOKEN' not found" {
		t.Fatal("remove 404")
	}
	noKey := NewSecrets(w.store, w.apps, "")
	if _, err := noKey.Put(bg, "live", "X", "value"); err == nil || !strings.Contains(err.Error(), "STREAMHUB_JWT_SECRET") {
		t.Fatal("no jwt secret")
	}
}

func TestRunnerExecute(t *testing.T) {
	w := newWorld(t)
	dir := w.apps.AppDir("live")
	wf := w.wf(t, `{"boxes":[{"id":"t","type":"trigger.manual","config":{}},{"id":"c","type":"logic.condition","config":{"rules":[{"field":"trigger.n","op":"gt","value":1}]}},{"id":"yes","type":"action.emit","config":{"event":"streamflow.output"}},{"id":"no","type":"logic.setvar","config":{"set":{"vars.no":true}}},{"id":"u","type":"custom.unknown"}],"edges":[{"from":"t","to":"c"},{"from":"c","fromPort":"true","to":"yes"},{"from":"c:false","to":"no"},{"from":"yes","to":"u"}]}`)
	runID, _ := w.runner.Enqueue(bg, "live", EnqueueInput{WorkflowID: wf.ID, Trigger: Trigger{Event: "trigger.manual", Payload: obj("n", 5.0)}, TriggerBoxID: "t"})
	if r, _ := w.store.GetRun(bg, "live", dir, runID); r.Status != "queued" {
		t.Fatal("not queued")
	}
	w.runNow()
	r, _ := w.store.GetRun(bg, "live", dir, runID)
	steps, _ := w.store.ListSteps(bg, "live", dir, runID)
	var ids []string
	for _, s := range steps {
		ids = append(ids, s.BoxID+":"+s.Status)
	}
	if r.Status != "ok" || r.EndedAt == nil || strings.Join(ids, ",") != "t:ok,c:ok,yes:ok,u:skipped" {
		t.Fatalf("run %+v steps %v", r, ids)
	}
	time.Sleep(50 * time.Millisecond)
	if !w.cb.has("streamflow.run_started") || !w.cb.has("streamflow.run_finished") || !w.cb.has("streamflow.output") {
		t.Fatalf("events %v", w.cb.events)
	}

	// secrets: step input keeps the ref, output is scrubbed
	_, _ = w.secrets.Put(bg, "live", "TOKEN", "shh-secret-value")
	wf2 := w.wf(t, `{"boxes":[{"id":"t","type":"trigger.manual","config":{}},{"id":"v","type":"logic.setvar","config":{"set":{"vars.k":"{{secret.TOKEN}}"}}}],"edges":[{"from":"t","to":"v"}]}`)
	runID, _ = w.runner.Enqueue(bg, "live", EnqueueInput{WorkflowID: wf2.ID, Trigger: Trigger{Event: "trigger.manual", Payload: y.NewMap()}, TriggerBoxID: "t"})
	w.runNow()
	steps, _ = w.store.ListSteps(bg, "live", dir, runID)
	in, out := str(steps[1].Input), str(steps[1].Output)
	if !strings.Contains(in, "{{secret.TOKEN}}") || strings.Contains(in, "shh") || strings.Contains(out, "shh") || !strings.Contains(out, "[redacted]") {
		t.Fatalf("secret handling in=%s out=%s", in, out)
	}

	// a throwing box fails the run with the step error
	wf3 := w.wf(t, `{"boxes":[{"id":"t","type":"trigger.event","config":{}},{"id":"s","type":"action.snapshot","config":{"room":"gate"}}],"edges":[{"from":"t","to":"s"}]}`)
	runID, _ = w.runner.Enqueue(bg, "live", EnqueueInput{WorkflowID: wf3.ID, Trigger: Trigger{Event: "perimeter.intrusion", Payload: obj("room", "gate")}, TriggerBoxID: "t"})
	w.runNow()
	r, _ = w.store.GetRun(bg, "live", dir, runID)
	steps, _ = w.store.ListSteps(bg, "live", dir, runID)
	if r.Status != "failed" || *r.Error != "camera down" || steps[1].Status != "failed" || *steps[1].Error != "camera down" {
		t.Fatalf("failed run %+v", r)
	}
	time.Sleep(50 * time.Millisecond)
	if !w.cb.has("streamflow.run_failed") {
		t.Fatal("run_failed not dispatched")
	}

	// missing workflow / no trigger box
	runID, _ = w.runner.Enqueue(bg, "live", EnqueueInput{WorkflowID: "gone", Trigger: Trigger{Event: "x", Payload: y.NewMap()}})
	w.runNow()
	if r, _ := w.store.GetRun(bg, "live", dir, runID); r.Status != "failed" || *r.Error != "workflow not found" {
		t.Fatal("workflow not found")
	}
	empty := w.wf(t, `{"boxes":[]}`)
	runID, _ = w.runner.Enqueue(bg, "live", EnqueueInput{WorkflowID: empty.ID, Trigger: Trigger{Event: "x", Payload: y.NewMap()}})
	w.runNow()
	if r, _ := w.store.GetRun(bg, "live", dir, runID); *r.Error != "no trigger box in workflow" {
		t.Fatal("no trigger box")
	}
}

func TestServiceTriggers(t *testing.T) {
	w := newWorld(t)
	dir := w.apps.AppDir("live")
	w.wf(t, `{"boxes":[{"id":"t","type":"trigger.event","config":{"event":"plate.*"}}]}`)
	w.wf(t, `{"boxes":[{"id":"m","type":"trigger.mqtt","config":{"topic":"site/+/temp"}}]}`)
	disabled := w.wf(t, `{"boxes":[{"id":"t","type":"trigger.event","config":{"event":"plate.*"}}]}`)
	_, _ = w.store.UpdateWorkflow(bg, "live", dir, disabled.ID, WorkflowPatch{Enabled: false, HasEnabled: true})
	count := func() int { r, _ := w.store.ListRuns(bg, "live", dir, "", nil); return len(r) }

	w.svc.OnEvent(bg, "live", "plate.detected", map[string]any{"plate": "ABC"})
	if count() != 1 {
		t.Fatalf("match: %d runs", count())
	}
	w.svc.OnEvent(bg, "live", "iot.data", obj("topic", "site/c1/temp"))
	w.svc.OnEvent(bg, "live", "iot.data", obj("topic", "other/c1/temp"))
	w.svc.OnEvent(bg, "live", "stream_started", obj())
	w.svc.OnEvent(bg, "live", "streamflow.output", obj()) // loop guard
	if count() != 2 {
		t.Fatalf("iot/no-match/loop guard: %d runs", count())
	}
	w.svc.OnEvent(bg, "other", "plate.detected", obj()) // app scoping: other app has no workflows
	if count() != 2 {
		t.Fatal("cross-app trigger")
	}
	w.plugin.enabled = false
	w.svc.OnEvent(bg, "live", "plate.detected", obj())
	if count() != 2 {
		t.Fatal("plugin disabled still triggers")
	}
	w.plugin.enabled = true
	w.plugin.config = obj("max_runs_per_min", "1")
	w.svc.rate = map[string][]time.Time{}
	w.svc.OnEvent(bg, "live", "plate.detected", obj())
	w.svc.OnEvent(bg, "live", "plate.detected", obj())
	if count() != 3 {
		t.Fatalf("rate limit: %d runs", count())
	}
}

func TestServiceCRUDAndBoxes(t *testing.T) {
	w := newWorld(t)
	if _, err := w.svc.ListWorkflows(bg, "nope"); err == nil || err.Error() != "app 'nope' not found" {
		t.Fatal("requireApp")
	}
	if len(w.svc.Boxes(bg, "live")) != len(boxSpecs) {
		t.Fatal("dangerous shown by default")
	}
	w.plugin.config = obj("dangerousNodes", true)
	if len(w.svc.Boxes(bg, "live")) != len(boxSpecs)+len(dangerousSpecs) {
		t.Fatal("dangerous hidden when enabled")
	}
	wf := w.wf(t, `{"boxes":[{"id":"x","type":"logic.delay"},{"id":"m","type":"trigger.manual"}],"edges":[{"from":"m","to":"x"}]}`)
	run, err := w.svc.ManualRun(bg, "live", wf.ID, obj("a", 1.0))
	if err != nil || run.Status != "queued" || run.TriggerEvent != "trigger.manual" {
		t.Fatalf("manual run %+v %v", run, err)
	}
	if _, err := w.svc.ManualRun(bg, "live", "nope", nil); err == nil || err.Error() != "workflow 'nope' not found" {
		t.Fatal("manual 404")
	}
	if _, err := w.svc.GetRun(bg, "live", "nope"); err == nil || err.Error() != "run 'nope' not found" {
		t.Fatal("run 404")
	}
	imp, err := w.svc.ImportWorkflow(bg, "live", js(t, `{"name":"N","graph":{"boxes":[{"id":"a","type":"action.db"}]}}`), "  Override ")
	if err != nil || imp.Name != "Override" {
		t.Fatalf("import %+v %v", imp, err)
	}
	if _, err := w.svc.ImportWorkflow(bg, "live", js(t, `{"graph":{"boxes":[{"id":"a","type":"zzz"}]}}`), nil); err == nil || err.Error() != "unknown box type: zzz" {
		t.Fatal("import 400")
	}
}

func TestScheduler(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithCancel(bg)
	defer cancel()
	w.svc.sched.start(ctx)
	w.wf(t, `{"boxes":[{"id":"s","type":"trigger.schedule","config":{"everySeconds":0.05}}]}`)
	w.wf(t, `{"boxes":[{"id":"c","type":"trigger.schedule","config":{"cron":"not a cron"}}]}`)
	w.wf(t, `{"boxes":[{"id":"c","type":"trigger.schedule","config":{"cron":"0 0 1 1 *"}}]}`)
	w.svc.Reconcile(ctx)
	if len(w.svc.sched.jobs) != 2 {
		t.Fatalf("jobs %d", len(w.svc.sched.jobs))
	}
	time.Sleep(200 * time.Millisecond)
	runs, _ := w.store.ListRuns(bg, "live", w.apps.AppDir("live"), "", nil)
	if len(runs) == 0 || runs[0].TriggerEvent != "trigger.schedule" {
		t.Fatalf("schedule did not fire: %+v", runs)
	}
	w.plugin.enabled = false
	w.svc.Reconcile(ctx)
	if len(w.svc.sched.jobs) != 0 {
		t.Fatal("schedules not dropped with the plugin disabled")
	}
	if _, ok := scheduleFor("a", "w", js(t, `{"id":"x","config":{"everySeconds":0}}`)); ok {
		t.Fatal("zero interval scheduled")
	}
}
