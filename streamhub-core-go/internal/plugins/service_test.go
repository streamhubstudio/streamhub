package plugins

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Ports of plugins.service.spec, plugins-public.spec, plugin-livedata.spec,
// plugin-events(.vision).spec, plugin-worker(.events/-endpoints).spec,
// app-plugins.repository.spec and the registry specs.

var bg = context.Background()

func status(err error) int {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

func want(t *testing.T, err error, code int, msg string) {
	t.Helper()
	if status(err) != code || (msg != "" && err.Error() != msg) {
		t.Fatalf("want %d %q, got %v", code, msg, err)
	}
}

func cfg(t *testing.T, j string) *y.Map {
	t.Helper()
	v, err := y.ParseJSON([]byte(j))
	if err != nil {
		t.Fatal(err)
	}
	return v.(*y.Map)
}

const overlayFields = `[
 {"key":"text","type":"string","label":"T","default":"hi"},
 {"key":"apiKey","type":"secret","label":"K","default":""},
 {"key":"callbackUrl","type":"string","label":"C","default":"https://x"},
 {"key":"n","type":"number","label":"N","default":3,"min":1,"max":5}
]`

func overlayMeta(id, ui string) *Meta {
	m := shellMeta(id, "", overlayFields)
	m.NeedsWorker, m.Worker, m.UI = false, nil, ui
	return m
}

func TestServiceCatalogAndInstall(t *testing.T) {
	st := newStack(t, overlayMeta("wm", "player-overlay"), overlayMeta("panel", "app-tab"))
	list, err := st.svc.List(bg, "live", nil)
	if err != nil || len(list) != 2 || list[0].Installed || list[0].Enabled || list[0].InstalledAt != nil {
		t.Fatalf("catalog = %+v, %v", list, err)
	}
	_, err = st.svc.List(bg, "ghost", nil)
	want(t, err, 404, "app 'ghost' not found")
	_, err = st.svc.Get(bg, "live", "nope")
	want(t, err, 404, "plugin 'nope' not found")

	v, err := st.svc.Install(bg, "live", "wm")
	if err != nil || !v.Installed || v.Enabled || v.Config.Get("text") != "hi" {
		t.Fatalf("install = %+v, %v", v, err)
	}
	if _, err := st.svc.Install(bg, "live", "wm"); err != nil {
		t.Fatal("install must be idempotent")
	}
	if got := strings.Join(st.logs.messages(), "|"); got != "installed into app 'live'" {
		t.Errorf("logs = %s", got)
	}

	v, err = st.svc.Patch(bg, "live", "wm", Patch{Enabled: bp(true), Config: cfg(t, `{"apiKey":"s3cr3t","n":"4"}`)})
	if err != nil || !v.Enabled || v.Config.Get("apiKey") != "********" || v.Config.Get("n") != 4.0 {
		t.Fatalf("patch = %+v, %v", v, err)
	}
	_, err = st.svc.Patch(bg, "live", "wm", Patch{Config: cfg(t, `{"bogus":1}`)})
	want(t, err, 400, "unknown config key 'bogus'")
	_, err = st.svc.Patch(bg, "live", "wm", Patch{Config: cfg(t, `{"n":9}`)})
	want(t, err, 400, "field 'n' must be <= 5")
	_, err = st.svc.Patch(bg, "live", "panel", Patch{Enabled: bp(true)})
	want(t, err, 400, "plugin 'panel' is not installed in app 'live'")
	if got := st.logs.messages()[1]; got != `updated in app 'live' ({"enabled":true,"configChanged":true})` {
		t.Errorf("patch log = %s", got)
	}

	// Public overlays: only enabled player slots, sanitized.
	_, _ = st.svc.Install(bg, "live", "panel")
	_, _ = st.svc.Patch(bg, "live", "panel", Patch{Enabled: bp(true)})
	pub, err := st.svc.PublicOverlays(bg, "live", nil)
	if err != nil || len(pub) != 1 || pub[0].ID != "wm" {
		t.Fatalf("public = %+v, %v", pub, err)
	}
	if got, _ := y.Stringify(pub[0].Config); got != `{"text":"hi","n":4}` {
		t.Errorf("sanitized = %s", got)
	}
	_, err = st.svc.PublicOverlays(bg, "ghost", nil)
	want(t, err, 404, "")

	if err := st.svc.Remove(bg, "live", "wm"); err != nil {
		t.Fatal(err)
	}
	if v, _ := st.svc.Get(bg, "live", "wm"); v.Installed {
		t.Error("remove")
	}
	if err := st.svc.Remove(bg, "live", "wm"); err != nil {
		t.Error("remove is idempotent")
	}
}

func TestRequiredFieldBlocksEnable(t *testing.T) {
	m := overlayMeta("req", "panel")
	m.ConfigSchema = cfgList(t, `[{"key":"key","type":"secret","label":"K","default":"","required":true}]`)
	m.Fields = parseFields(m.ConfigSchema)
	st := newStack(t, m)
	_, _ = st.svc.Install(bg, "live", "req")
	_, err := st.svc.Patch(bg, "live", "req", Patch{Enabled: bp(true)})
	want(t, err, 400, "field 'key' is required")
	if _, err := st.svc.Patch(bg, "live", "req", Patch{Enabled: bp(true), Config: cfg(t, `{"key":"x"}`)}); err != nil {
		t.Fatal(err)
	}
}

func cfgList(t *testing.T, j string) []any {
	t.Helper()
	v, err := y.ParseJSON([]byte(j))
	if err != nil {
		t.Fatal(err)
	}
	return v.([]any)
}

func TestWorkerLifecycleThroughService(t *testing.T) {
	st := newStack(t, shellMeta("det", `echo "hello from $PLUGIN_APP tz=$PLUGIN_TZ token=${STREAMHUB_INGEST_TOKEN:+set}"; echo oops >&2; exec sleep 30`, ""))
	if _, err := st.svc.Install(bg, "live", "det"); err != nil {
		t.Fatal(err)
	}
	if st.workers.IsRunning("live", "det") {
		t.Fatal("installed disabled → not running")
	}
	_, err := st.svc.StartWorker(bg, "live", "det")
	want(t, err, 400, "plugin 'det' must be enabled before starting its worker")
	_, err = st.svc.StartWorker(bg, "live", "ghost")
	want(t, err, 404, "")

	if _, err := st.svc.Patch(bg, "live", "det", Patch{Enabled: bp(true)}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "worker output", func() bool { return len(st.workers.Logs("live", "det", 10)) >= 3 })
	row, _ := st.repo.Get(bg, "live", "det")
	if row.WorkerDesired == nil || *row.WorkerDesired != "running" {
		t.Error("enable records desired=running")
	}
	lines := st.workers.Logs("live", "det", 10)
	joined := ""
	for _, l := range lines {
		joined += l.Stream + ":" + l.Line + "\n"
	}
	if !strings.Contains(joined, "stdout:hello from live tz=Europe/Madrid token=set") || !strings.Contains(joined, "stderr:oops") ||
		!strings.Contains(joined, "system:worker started: /bin/sh -c ") {
		t.Errorf("logs:\n%s", joined)
	}
	st0 := st.workers.Status("live", "det")
	if st0.Status != "running" || st0.PID == nil || st0.Placement != "local" {
		t.Errorf("state = %+v", st0)
	}
	logsView, _ := st.svc.GetLogs(bg, "live", "det", 200)
	if len(logsView.WorkerLogs) < 3 || len(logsView.Persisted) == 0 || logsView.Worker == nil {
		t.Errorf("logs view = %+v", logsView)
	}

	// Ingest channel: only the CURRENT token.
	token := st.workers.IngestToken("live", "det")
	_, err = st.svc.IngestLive(bg, "live", "det", "nope", cfg(t, `{"room":"r"}`))
	want(t, err, 401, "invalid or missing ingest token")
	_, err = st.svc.IngestLive(bg, "live", "det", token, cfg(t, `{"x":1}`))
	want(t, err, 400, "live payload must carry a 'room'")
	if _, err := st.svc.IngestLive(bg, "live", "det", token, cfg(t, `{"room":" r ","boxes":[1]}`)); err != nil {
		t.Fatal(err)
	}
	v, _ := st.svc.LiveWorkerData(bg, "live", "det", "r")
	if v.TS == nil || prop(v.Payload, "boxes") == nil {
		t.Errorf("live state = %+v", v)
	}
	_, err = st.svc.LiveOverlayData(bg, "live", "det", "r")
	want(t, err, 404, "plugin 'det' has no public live data for app 'live'")

	// Event channel: declared names only, envelope carries plugin + room.
	_, err = st.svc.IngestEvent(bg, "live", "det", token, cfg(t, `{"event":"vod_ready"}`))
	want(t, err, 400, "plugin 'det' does not declare event 'vod_ready' in its manifest")
	ack, err := st.svc.IngestEvent(bg, "live", "det", token, cfg(t, `{"event":" det.hit ","room":"r","data":{"plate":"AB"}}`))
	if err != nil || ack.Event != "det.hit" {
		t.Fatalf("event = %+v, %v", ack, err)
	}
	eventually(t, "event dispatch", func() bool {
		for _, e := range st.dispatch.list() {
			if e == "live:det.hit" {
				return true
			}
		}
		return false
	})

	// Edge workers authenticate with their scoped assignment token (the
	// edge verifier, bound by the cluster plane) — never a wrong one.
	st.svc.SetEdgeIngest(func(_ context.Context, app, id, tok string) bool {
		return app == "live" && id == "det" && tok == "edge-scoped-token"
	})
	if _, err := st.svc.IngestEvent(bg, "live", "det", "edge-scoped-token", cfg(t, `{"event":"det.hit","room":"r2"}`)); err != nil {
		t.Fatalf("edge token rejected: %v", err)
	}
	_, err = st.svc.IngestEvent(bg, "live", "det", "forged", cfg(t, `{"event":"det.hit"}`))
	want(t, err, 401, "invalid or missing ingest token")
	_, err = st.svc.IngestLive(bg, "live", "det", "", cfg(t, `{"room":"r"}`))
	want(t, err, 401, "invalid or missing ingest token")
	// The vision runtime's batch shape: every item relayed, flat fields = payload.
	before := len(st.dispatch.list())
	ack, err = st.svc.IngestEvent(bg, "live", "det", token, cfg(t, `{"events":[{"event":"det.hit","room":"r","zone":"z1","ts":1.5},{"event":"det.hit","room":"r2"}]}`))
	if err != nil || ack.Event != "det.hit" {
		t.Fatalf("batch = %+v, %v", ack, err)
	}
	eventually(t, "batch dispatch", func() bool { return len(st.dispatch.list()) >= before+2 })
	_, err = st.svc.IngestEvent(bg, "live", "det", token, cfg(t, `{"events":[{"event":"det.hit"},{"event":"vod_ready"}]}`))
	want(t, err, 400, "plugin 'det' does not declare event 'vod_ready' in its manifest")
	_, err = st.svc.IngestEvent(bg, "live", "det", token, cfg(t, `{"events":[1]}`))
	want(t, err, 400, "event payload must be a JSON object")
	st.svc.SetEdgeIngest(nil)

	// Explicit stop → desired stopped, token dead, stopped event.
	if s, _ := st.svc.StopWorker(bg, "live", "det"); s.Status != "stopped" {
		t.Errorf("stop = %+v", s)
	}
	if st.workers.IngestToken("live", "det") != "" {
		t.Error("a stopped worker's token must die")
	}
	eventually(t, "exit", func() bool { return len(st.workers.Status("live", "det").ExitCode) > 0 })
	if s := st.workers.Status("live", "det"); s.Status != "stopped" || string(s.ExitCode) != "null" {
		t.Errorf("after exit = %+v", s)
	}
	row, _ = st.repo.Get(bg, "live", "det")
	if *row.WorkerDesired != "stopped" {
		t.Error("explicit stop records desired=stopped")
	}
	eventually(t, "lifecycle events", func() bool {
		ev := strings.Join(st.dispatch.list(), ",")
		return strings.Contains(ev, "plugin_worker_started") && strings.Contains(ev, "plugin_worker_stopped")
	})

	// Uninstall clears the live feed.
	_ = st.svc.Remove(bg, "live", "det")
	_, err = st.svc.LiveData(bg, "live", "det", "r")
	want(t, err, 404, "plugin 'det' is not installed in app 'live'")
}

func TestWorkerCrashAndSpawnFailure(t *testing.T) {
	st := newStack(t)
	m := shellMeta("crash", "exit 3", "")
	if _, err := st.workers.Start(bg, m, "live", st.dir, y.NewMap(), nil, ""); err != nil {
		t.Fatal(err)
	}
	eventually(t, "crash", func() bool { return st.workers.Status("live", "crash").Status == "crashed" })
	if s := st.workers.Status("live", "crash"); string(s.ExitCode) != "3" {
		t.Errorf("crash state = %+v", s)
	}
	eventually(t, "error event", func() bool { return strings.Contains(strings.Join(st.dispatch.list(), ","), "plugin_worker_error") })

	bad := shellMeta("bad", "", "")
	bad.Worker.Spawn = func(WorkerContext) WorkerSpec { return WorkerSpec{Command: "/nonexistent/xyz"} }
	s, _ := st.workers.Start(bg, bad, "live", st.dir, y.NewMap(), nil, "")
	if s.Status != "crashed" || s.Error != "spawn /nonexistent/xyz ENOENT" {
		t.Errorf("spawn failure = %+v", s)
	}
	if _, err := st.workers.Start(bg, overlayMeta("x", "panel"), "live", st.dir, nil, nil, ""); err == nil || err.Error() != "plugin 'x' has no worker" {
		t.Errorf("no worker = %v", err)
	}
}

func TestRingBufferCap(t *testing.T) {
	st := newStack(t)
	m := shellMeta("spam", "i=0; while [ $i -lt 600 ]; do echo line$i; i=$((i+1)); done; sleep 30", "")
	_, _ = st.workers.Start(bg, m, "live", st.dir, y.NewMap(), nil, "")
	eventually(t, "600 lines", func() bool {
		l := st.workers.Logs("live", "spam", 1000)
		return len(l) > 0 && l[len(l)-1].Line == "line599"
	})
	if n := len(st.workers.Logs("live", "spam", 1000)); n != maxLogLines {
		t.Errorf("buffer = %d", n)
	}
	if n := len(st.workers.Logs("live", "spam", 0)); n != 1 {
		t.Errorf("limit floor = %d", n)
	}
}

func TestBootResume(t *testing.T) {
	st := newStack(t, shellMeta("keep", "exec sleep 30", ""), shellMeta("off", "exec sleep 30", ""), shellMeta("legacy", "exec sleep 30", ""))
	for _, id := range []string{"keep", "off", "legacy"} {
		_ = st.repo.Install(bg, "live", id, y.NewMap(), true)
	}
	_ = st.repo.SetWorkerDesired(bg, "live", "keep", "running")
	_ = st.repo.SetWorkerDesired(bg, "live", "off", "stopped")
	_ = st.repo.Install(bg, "other", "legacy", y.NewMap(), false)
	if n := st.svc.ResumeDesiredWorkers(bg, ""); n != 2 {
		t.Errorf("started %d, want keep + legacy(backfilled)", n)
	}
	if !st.workers.IsRunning("live", "keep") || st.workers.IsRunning("live", "off") || !st.workers.IsRunning("live", "legacy") {
		t.Error("resume set")
	}
	row, _ := st.repo.Get(bg, "other", "legacy")
	if row.WorkerDesired == nil || *row.WorkerDesired != "stopped" || st.workers.IsRunning("other", "legacy") {
		t.Error("a disabled legacy install backfills to stopped")
	}
	if n := st.svc.ResumeDesiredWorkers(bg, ""); n != 0 {
		t.Error("already-running workers are skipped")
	}
}

func TestRepoColumnsAndIsolation(t *testing.T) {
	store, _, _ := testutil.Store(t)
	h, _ := store.App(bg, "live")
	testutil.Exec(t, h, `INSERT INTO app_plugins (plugin_id, enabled, config_json) VALUES ('old', 1, '{"a":1}')`)
	r := NewRepo(store)
	row, err := r.Get(bg, "live", "old")
	if err != nil || row.WorkerDesired != nil || row.WorkerVersion != nil || row.Config.Get("a") != 1.0 {
		t.Fatalf("pre-existing row = %+v, %v", row, err)
	}
	if err := r.SetWorkerDesired(bg, "live", "missing", "running"); err != nil {
		t.Error("unknown plugin is a no-op")
	}
	if l, _ := r.List(bg, "other"); len(l) != 0 {
		t.Error("per-app isolation")
	}
	if err := r.Update(bg, "live", "old", nil, nil); err != nil {
		t.Error("no-op update")
	}
}

func TestRegistryVendorDiscovery(t *testing.T) {
	dir := t.TempDir()
	write := func(id, body string) {
		_ = os.MkdirAll(filepath.Join(dir, id), 0o755)
		_ = os.WriteFile(filepath.Join(dir, id, "streamhub.app.json"), []byte(body), 0o644)
	}
	base := `{"id":"%s","name":"N","description":"","category":"tool","ui":"panel","version":"1.0.0","configSchema":[]}`
	write("good", strings.Replace(base, "%s", "good", 1))
	write("watermark", strings.Replace(base, "%s", "watermark", 1)) // collides with an in-tree id
	write("broken", `{nope`)
	write("wrongid", strings.Replace(base, "%s", "other", 1))
	write("_skip", strings.Replace(base, "%s", "_skip", 1))
	r := NewRegistry(Paths{VendorRoot: dir}, func(string) string { return "" }, testutil.Log())
	r.Discover()
	if r.GetMeta("good") == nil || *r.GetMeta("good").Kind != "app" {
		t.Error("vendored app discovered with kind defaulting to app")
	}
	if r.GetMeta("watermark").Kind != nil {
		t.Error("in-tree plugin wins an id collision")
	}
	if r.Has("other") || r.Has("broken") || r.Has("_skip") {
		t.Error("malformed / mismatched / underscore packages are skipped")
	}
	if len(r.ListManifests()) != 15 {
		t.Errorf("14 built-ins + 1 vendored, got %d", len(r.ListManifests()))
	}
	off := NewRegistry(Paths{VendorRoot: dir}, func(k string) string { return map[string]string{"STREAMHUB_PLUGINS_ENABLE": " Off "}[k] }, testutil.Log())
	off.Discover()
	if len(off.ListManifests()) != 0 {
		t.Error("STREAMHUB_PLUGINS_ENABLE=off empties the catalog")
	}
	missing := NewRegistry(Paths{VendorRoot: filepath.Join(dir, "nope")}, func(string) string { return "" }, testutil.Log())
	missing.Discover()
	if len(missing.ListManifests()) != 14 {
		t.Error("a missing vendor dir is a silent no-op")
	}
}

func TestValidateAppManifest(t *testing.T) {
	cases := []struct {
		json string
		want string
	}{
		{`[]`, "manifest is not an object"},
		{`{}`, "missing string id; missing name; missing description; invalid category 'undefined'; invalid ui slot 'undefined'; invalid version 'undefined' (expected semver); configSchema must be an array"},
		{`{"id":"Bad","name":"n","description":"","category":"tool","ui":"panel","version":"1.0","configSchema":[]}`, "id 'Bad' must be a lowercase slug; invalid version '1.0' (expected semver)"},
		{`{"id":"a","name":"n","description":"","category":"tool","ui":"panel","version":"1.0.0","kind":"plugin","export":{"workerDir":"../x"},"storage":{"db":"a/b"},"events":[1],"configSchema":[{"key":"k","type":"select","label":"L","default":"x"},{"key":"k","type":"string","label":"L","default":""},{"key":"z","type":"nope","label":"L"}]}`,
			"storage.db 'a/b' must be a bare filename; export is only valid on kind 'app'; export.workerDir '../x' must be a bare directory name; events must be an array of strings; select field 'k' needs options; duplicate config key 'k'; field 'z' has invalid type 'nope'"},
		{`{"id":"a","name":"n","description":"","category":"tool","ui":"panel","version":"1.0.0","configSchema":[],"worker":{"needsWorker":true,"env":{"A":1}}}`, "worker needs an 'entry' string or a 'command'"},
		{`{"id":"a","name":"n","description":"","category":"tool","ui":"panel","version":"1.0.0","configSchema":[],"worker":{"entry":"x","env":{"A":1}}}`, "worker.env.A must be a string template"},
		{`{"id":"a","name":"n","description":"","category":"tool","ui":"panel","version":"1.0.0","configSchema":[],"worker":{"entry":"x","grid":{}}}`, "worker.grid requirements need worker.placement 'grid'"},
		{`{"id":"a","name":"n","description":"","category":"tool","ui":"panel","version":"1.0.0","configSchema":[],"worker":{"entry":"x","placement":"moon","edge":"yes"}}`, "invalid worker.placement 'moon' (local|grid)"},
	}
	for _, c := range cases {
		v, _ := y.ParseJSON([]byte(c.json))
		if got := strings.Join(ValidateAppManifest(v, nil), "; "); got != c.want {
			t.Errorf("%s:\n got  %s\n want %s", c.json, got, c.want)
		}
	}
	folder := "x"
	v, _ := y.ParseJSON([]byte(`{"id":"a","name":"n","description":"","category":"tool","ui":"panel","version":"1.0.0","configSchema":[]}`))
	if got := ValidateAppManifest(v, &folder); len(got) != 1 || got[0] != "id 'a' must equal folder name 'x'" {
		t.Errorf("folder check = %v", got)
	}
}

func TestSynthesizeWorkerDir(t *testing.T) {
	m := cfg(t, `{"id":"a","name":"n","description":"","category":"tool","ui":"panel","version":"1.0.0","configSchema":[],
	  "worker":{"needsWorker":true,"entry":"x {{workerDir}}","workerDir":"/abs/w"}}`)
	meta := SynthesizeMeta(m, SynthesizeOptions{PackageDir: "/pkg"})
	if s := meta.Worker.Spawn(WorkerContext{}); s.Args[0] != "/abs/w" || s.Cwd != "/abs/w" {
		t.Errorf("absolute workerDir = %+v", s)
	}
	meta = SynthesizeMeta(m, SynthesizeOptions{PackageDir: "/pkg", WorkerDir: "/override"})
	if s := meta.Worker.Spawn(WorkerContext{}); s.Cwd != "/override" {
		t.Errorf("override = %+v", s)
	}
	m.Get("worker").(*y.Map).Delete("workerDir")
	if s := SynthesizeMeta(m, SynthesizeOptions{PackageDir: "/pkg"}).Worker.Spawn(WorkerContext{}); s.Cwd != "/pkg/worker" {
		t.Errorf("default = %+v", s)
	}
}

func TestSpawnTemplateGrammar(t *testing.T) {
	ctx := WorkerContext{App: "live", Config: cfg(t, `{"cuda":true,"zero":0,"s":"x y","obj":{"a":[1]},"no":false}`), AppDir: "/a", DataDir: "/d", LivekitURL: "ws://lk"}
	env := func(k string) string { return map[string]string{"X": "envx", "PLUGIN_PYTHON": "py"}[k] }
	o := TemplateOptions{WorkerDir: "/w", Env: env}
	for tpl, want := range map[string]string{
		"{{app}}/{{ appDir }}":                 "live//a",
		"{{ config.cuda | ternary:cuda:cpu }}": "cuda",
		"{{ config.zero | ternary:on:off }}":   "off",
		"{{ config.no | ternary:on:off }}":     "off",
		"{{ config.s | map:x y=1,*=d }}":       "1",
		"{{ config.missing | map:a=b }}":       "",
		"{{ config.missing ?? env.X ?? 'z' }}": "envx",
		"{{ config.missing ?? 'a??b' }}":       "a??b",
		"{{ config.obj }}":                     `{"a":[1]}`,
		"{{pluginPython}} {{publicBase}}.":     "py .",
		"{{ config.s | localOnly }}":           "x y",
		"{{ nope }}{{ config.s | bogus:1 }}":   "x y",
		"{{configJson}}":                       `{"cuda":true,"zero":0,"s":"x y","obj":{"a":[1]},"no":false}`,
		"pre{{ 'lit' }}post{{\"q\"}}":          "prelitpostq",
	} {
		if got := RenderTemplate(tpl, ctx, o); got != want {
			t.Errorf("%s = %q, want %q", tpl, got, want)
		}
	}
	remote := ctx
	remote.OriginURL = "https://o"
	if got := RenderTemplate("{{ config.s | localOnly }}", remote, o); got != "" {
		t.Error("localOnly withholds the value on a remote context")
	}
	// entry is tokenized BEFORE substitution: a value never injects an argument.
	spec := InterpretWorkerTemplate(cfg(t, `{"entry":"  {{pluginPython}}  -m w --room {{config.s}} ","env":{"B":"{{app}}","A":"1"}}`), ctx, o)
	if spec.Command != "py" || len(spec.Args) != 4 || spec.Args[3] != "x y" || spec.Cwd != "/w" || spec.Env[0].Key != "B" {
		t.Errorf("spec = %+v", spec)
	}
	spec = InterpretWorkerTemplate(cfg(t, `{"command":"{{workerDir}}/bin","args":["{{app}}"],"cwd":"{{appDir}}"}`), ctx, o)
	if spec.Command != "/w/bin" || spec.Args[0] != "live" || spec.Cwd != "/a" {
		t.Errorf("command form = %+v", spec)
	}
}

func TestLiveDataStore(t *testing.T) {
	l := NewLiveData()
	clock := int64(1000)
	l.Now = func() int64 { return clock }
	if l.Latest("a", "p", "r") != nil {
		t.Fatal("empty")
	}
	l.Push("a", "p", "r", cfg(t, `{"v":1}`))
	clock = 1500
	l.Push("a", "p", "r", cfg(t, `{"v":2}`))
	clock = 1600
	v := l.Latest("a", "p", "r")
	if *v.TS != 1500 || *v.AgeMs != 100 || prop(v.Payload, "v") != 2.0 {
		t.Errorf("latest = %+v", v)
	}
	if l.Push("a", "p", "big", strings.Repeat("x", MaxLivePayloadBytes)) {
		t.Error("over the cap (JSON adds quotes)")
	}
	for i := 0; i < MaxLiveKeys; i++ {
		clock++
		l.Push("a", "q", strings.Repeat("k", i+1), 1.0)
	}
	if l.Latest("a", "p", "r") != nil {
		t.Error("the oldest key is evicted once the key space is full")
	}
	l.Clear("a", "q")
	if l.Latest("a", "q", "k") != nil {
		t.Error("clear")
	}
}

func TestGridMatchAndService(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	s := func(v string) *string { return &v }
	nodes := []GridNodeView{
		{NodeInfo: NodeInfo{ID: "1", Name: "b", Region: s("us")}, GPU: true, VramGb: f(8), Capabilities: []string{"cuda"}},
		{NodeInfo: NodeInfo{ID: "2", Name: "a", Region: s("eu")}, GPU: true, VramGb: f(24), Capabilities: []string{"cuda", "lpr"}},
		{NodeInfo: NodeInfo{ID: "3", Name: "c"}, GPU: false, Capabilities: []string{}},
	}
	if MatchGridNode(nil, nil) != nil {
		t.Error("empty")
	}
	if n := MatchGridNode(nodes, nil); n.ID != "2" {
		t.Errorf("no req → biggest vram first, got %s", n.ID)
	}
	if n := MatchGridNode(nodes, &GridRequirements{Regions: []string{"us"}}); n.ID != "1" {
		t.Error("region preference re-orders")
	}
	if MatchGridNode(nodes, &GridRequirements{MinVramGb: f(32)}) != nil {
		t.Error("minVram is hard")
	}
	if n := MatchGridNode(nodes, &GridRequirements{Capabilities: []string{"lpr"}}); n.ID != "2" {
		t.Error("capabilities are hard")
	}

	_, global, _ := testutil.Store(t)
	testutil.Exec(t, global, `INSERT INTO nodes (id, name, url, region, status, last_seen_at, stats_json) VALUES
	  ('n1','gpu-1','http://n1:3020','eu','active',datetime('now'),'{"grid":{"gpu":true,"vramGb":16,"capabilities":["cuda",5]}}'),
	  ('n2','stale','http://n2','eu','active',datetime('now','-1 hour'),'{"grid":{}}'),
	  ('n3','plain','http://n3','eu','active',datetime('now'),'{"cpu":1}'),
	  ('n4','bad','http://n4','eu','active',datetime('now'),'not json')`)
	g := NewGrid(global, "")
	got := g.ListGridNodes(bg)
	if len(got) != 1 || got[0].ID != "n1" || len(got[0].Capabilities) != 1 || *got[0].VramGb != 16 {
		t.Errorf("grid nodes = %+v", got)
	}
	u := "ftp://x"
	if r := g.Dispatch(bg, NodeInfo{URL: &u}, GridSpawnRequest{}); r.Dispatched || r.Reason != "node has no usable http(s) url" {
		t.Errorf("ssrf guard = %+v", r)
	}
	u = "http://x"
	if r := g.Dispatch(bg, NodeInfo{URL: &u}, GridSpawnRequest{}); r.Reason != "STREAMHUB_CLUSTER_TOKEN unset" {
		t.Errorf("no token = %+v", r)
	}
}

func TestGridDispatchWire(t *testing.T) {
	var gotToken, gotBody string
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("x-cluster-token")
		b := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(b)
		gotBody = string(b)
		switch r.URL.Path {
		case "/api/v1/grid/workers":
			_, _ = w.Write([]byte(`{"data":{"id":"w-1"}}`))
		case "/api/v1/grid/workers/w-1/stop":
			w.WriteHeader(200)
		default:
			w.WriteHeader(500)
		}
	})
	g := NewGrid(nil, "tok")
	node := NodeInfo{ID: "n", Name: "n", URL: &srv}
	env := y.NewMap()
	env.Set("A", "1")
	r := g.Dispatch(bg, node, GridSpawnRequest{PluginID: "p", AppName: "live", Command: "py", Args: []string{"-m"}, Env: env, IngestToken: "it"})
	if !r.Dispatched || r.RemoteID != "w-1" || gotToken != "tok" ||
		gotBody != `{"pluginId":"p","appName":"live","command":"py","args":["-m"],"env":{"A":"1"},"ingestToken":"it"}` {
		t.Errorf("dispatch = %+v token=%s body=%s", r, gotToken, gotBody)
	}
	if !g.StopRemote(bg, node, "w-1") || g.StopRemote(bg, node, "other") {
		t.Error("stopRemote reports the agent ok")
	}
}

func TestGridFallbackAndRemote(t *testing.T) {
	st := newStack(t)
	m := shellMeta("gp", "exec sleep 30", "")
	m.Worker.Placement = "grid"
	_, global, _ := testutil.Store(t)
	st.workers.SetGrid(NewGrid(global, "tok"))
	s, _ := st.workers.Start(bg, m, "live", st.dir, y.NewMap(), nil, "")
	if s.Placement != "local" {
		t.Errorf("no eligible node → local: %+v", s)
	}
	if !strings.Contains(st.workers.Logs("live", "gp", 5)[0].Line, "falling back to local spawn") {
		t.Error("fall-back recorded")
	}
}

func TestAgentAndClusterGate(t *testing.T) {
	st := newStack(t)
	a := NewAgent(st.workers)
	env := y.NewMap()
	env.Set("A", "1")
	env.Set("N", 5.0)
	v := a.Spawn(GridWorkerInput{PluginID: "p", AppName: "live", Command: "/bin/sh", Args: []string{"-c", "echo $STREAMHUB_INGEST_TOKEN-$A-$N; sleep 30"}, Env: env, IngestToken: "itok"})
	if v.ID == "" || v.Status != "running" || v.PID == nil {
		t.Fatalf("spawn = %+v", v)
	}
	eventually(t, "agent output", func() bool {
		l, _ := a.Logs(v.ID, 10)
		for _, x := range l {
			if x.Line == "itok-1-" {
				return true
			}
		}
		return false
	})
	if s, _ := a.Stop(v.ID); s.Status != "stopped" {
		t.Error("stop")
	}
	_, err := a.Status("nope")
	want(t, err, 404, "grid worker 'nope' not found")

	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	if err := AssertClusterToken(r, "", "off"); status(err) != 503 {
		t.Error("503 when unset")
	}
	if err := AssertClusterToken(r, "t", "off"); status(err) != 401 {
		t.Error("401 when absent")
	}
	r.Header.Set("x-cluster-token", "t")
	if AssertClusterToken(r, "t", "off") != nil || ClusterTokenMatches("", "") {
		t.Error("match")
	}
}

func TestFrameworkEnvAndMerge(t *testing.T) {
	got := FrameworkEnv(3020, "my app", "lpr", "tok")
	if got[2].Value != "http://127.0.0.1:3020/api/v1/apps/my%20app/plugins/lpr/live" || got[3].Value != "http://127.0.0.1:3020/api/v1/apps/my%20app/plugins/lpr/events" {
		t.Errorf("framework env = %+v", got)
	}
	merged := mergeEnv([]string{"PATH=/bin", "STREAMHUB_APP=x"}, got, []EnvVar{{"PATH", "/p"}})
	if merged[0] != "PATH=/p" || merged[1] != "STREAMHUB_APP=my app" {
		t.Errorf("merge order/override = %v", merged)
	}
}

func TestWorkerParentEnvDropsSecrets(t *testing.T) {
	parent := []string{
		"PATH=/usr/bin", "HOME=/home/ploi", "LC_ALL=C.UTF-8", "HF_HOME=/hf",
		"JWT_SECRET=j", "SMTP_PASS=s", "LIVEKIT_API_SECRET=l", "STREAMHUB_API_TOKEN=sk_x",
		"ADMIN_PASS=a", "AWS_SECRET_ACCESS_KEY=k", "MY_EXTRA=1", "BROKEN",
	}
	got := strings.Join(workerParentEnv(parent, " MY_EXTRA ,"), " ")
	if got != "PATH=/usr/bin HOME=/home/ploi LC_ALL=C.UTF-8 HF_HOME=/hf MY_EXTRA=1" {
		t.Fatalf("worker env = %q", got)
	}
}

func TestManagerSpawnEnvIsFiltered(t *testing.T) {
	m := NewManager(ManagerConfig{
		Port:    3020,
		Env:     func(string) string { return "" },
		Environ: func() []string { return []string{"PATH=/bin", "JWT_SECRET=j"} },
	}, nil)
	env := strings.Join(mergeEnv(m.parentEnv(), []EnvVar{{"X", "1"}}), " ")
	if env != "PATH=/bin X=1" {
		t.Fatalf("env = %q", env)
	}
}
