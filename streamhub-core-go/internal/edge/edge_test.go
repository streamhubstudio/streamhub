package edge

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/notifications"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// Ports edge-scheduler.logic.spec.ts, edge-scheduler.service.spec.ts,
// edge-assignments.repository.spec.ts, edge-watchdog.service.spec.ts,
// edge-capacity-alerter.spec.ts, edge-reconcile.service.spec.ts,
// generic-spawn.resolver.spec.ts, spawn-bundle.spec.ts and the
// edge-app.controller.spec.ts rules.

// ---- pure logic -------------------------------------------------------------

func mulberry32(seed uint32) func() float64 {
	a := seed
	return func() float64 {
		a += 0x6d2b79f5
		t := (a ^ (a >> 15)) * (1 | a)
		t = (t + (t^(t>>7))*(61|t)) ^ t
		return float64(t^(t>>14)) / 4294967296
	}
}

func n(id string, mod ...func(*SchedNode)) SchedNode {
	s := SchedNode{ID: id, Name: id, Type: "edge", Weight: 100, Status: "active", Connected: true}
	for _, m := range mod {
		m(&s)
	}
	return s
}

func f64(v float64) *float64 { return &v }

func grid(free float64) *GridCaps {
	return &GridCaps{GPU: true, VramGb: f64(24), VramFreeMb: f64(free), Capabilities: []string{"cuda"}}
}

func ids(ns []SchedNode) []string {
	out := []string{}
	for _, x := range ns {
		out = append(out, x.ID)
	}
	return out
}

func TestEligibility(t *testing.T) {
	gpuReq := &plugins.GridRequirements{GPU: true}
	nodes := []SchedNode{
		n("ok"),
		n("off", func(s *SchedNode) { s.Connected = false }),
		n("drain", func(s *SchedNode) { s.Status = "draining" }),
		n("dis", func(s *SchedNode) { s.Status = "disabled" }),
		n("common", func(s *SchedNode) { s.Type = "common" }),
	}
	if got := ids(EligibleNodes(nodes, nil, false)); !reflect.DeepEqual(got, []string{"ok"}) {
		t.Fatal(got)
	}
	if got := ids(EligibleNodes(nodes, nil, true)); !reflect.DeepEqual(got, []string{"common", "ok"}) {
		t.Fatal(got)
	}
	if got := ids(EligibleNodes([]SchedNode{n("c"), n("a"), n("b")}, nil, false)); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatal(got)
	}
	if len(EligibleNodes([]SchedNode{n("cpu")}, gpuReq, false)) != 0 {
		t.Fatal("CPU node passed a GPU requirement")
	}
	if !PassesRequirements(n("cpu"), nil) || !PassesRequirements(n("cpu"), &plugins.GridRequirements{}) {
		t.Fatal("CPU node must pass an empty requirement")
	}
	g := n("g", func(s *SchedNode) { s.Grid = grid(24000) })
	if !PassesRequirements(g, &plugins.GridRequirements{GPU: true, MinVramGb: f64(16), Capabilities: []string{"cuda"}}) ||
		PassesRequirements(g, &plugins.GridRequirements{MinVramGb: f64(32)}) ||
		PassesRequirements(g, &plugins.GridRequirements{Capabilities: []string{"tensorrt"}}) {
		t.Fatal("grid matcher")
	}
}

func TestVramGuard(t *testing.T) {
	if VramMaxStreams(n("g", func(s *SchedNode) { s.Grid = grid(1500) })) != 5 || !math.IsInf(VramMaxStreams(n("cpu")), 1) {
		t.Fatal("max streams")
	}
	full := n("g", func(s *SchedNode) { s.Grid = grid(700); s.Load = 1 })
	room := n("h", func(s *SchedNode) { s.Grid = grid(900); s.Load = 1 })
	if got := ids(EligibleNodes([]SchedNode{full, room}, nil, false)); !reflect.DeepEqual(got, []string{"h"}) {
		t.Fatal(got)
	}
}

func TestRoundRobin(t *testing.T) {
	nodes := []SchedNode{n("b"), n("a"), n("c")}
	cursor := 0
	var picks []string
	for i := 0; i < 4; i++ {
		id, next := Place(nodes, PlaceOptions{Policy: PolicyRoundRobin, Cursor: cursor})
		picks, cursor = append(picks, id), next
	}
	if !reflect.DeepEqual(picks, []string{"a", "b", "c", "a"}) || cursor != 4 {
		t.Fatal(picks, cursor)
	}
	if id, c := PickRoundRobin(nil, 7); id != "" || c != 7 {
		t.Fatal("empty set")
	}
	if id, c := Place([]SchedNode{n("x", func(s *SchedNode) { s.Connected = false })}, PlaceOptions{Cursor: 3}); id != "" || c != 3 {
		t.Fatal("nothing eligible")
	}
}

func TestWeighted(t *testing.T) {
	nodes := []SchedNode{n("a", func(s *SchedNode) { s.Weight = 75 }), n("b", func(s *SchedNode) { s.Weight = 25 })}
	rnd := mulberry32(12345)
	counts := map[string]int{}
	for i := 0; i < 1000; i++ {
		counts[PickWeighted(EligibleNodes(nodes, nil, false), rnd)]++
	}
	if counts["a"] <= 690 || counts["a"] >= 810 || counts["a"]+counts["b"] != 1000 {
		t.Fatal(counts)
	}
	zero := []SchedNode{n("a", func(s *SchedNode) { s.Weight = 0 }), n("b", func(s *SchedNode) { s.Weight = 0 })}
	if id := PickWeighted(zero, func() float64 { return 0.6 }); id != "b" {
		t.Fatal(id)
	}
	if PickWeighted(nil, func() float64 { return 0.5 }) != "" {
		t.Fatal("empty")
	}
}

func TestPlanFailover(t *testing.T) {
	moves, _ := PlanFailover([]string{"x1", "x2", "x3"}, []SchedNode{n("a"), n("b")}, PlaceOptions{Policy: PolicyRoundRobin})
	var targets []string
	for _, m := range moves {
		targets = append(targets, m.ToNodeID)
	}
	if !reflect.DeepEqual(targets, []string{"a", "b", "a"}) {
		t.Fatal(targets)
	}
	moves, _ = PlanFailover([]string{"x1", "x2"}, []SchedNode{n("a", func(s *SchedNode) { s.Connected = false })}, PlaceOptions{})
	if moves[0].ToNodeID != "" || moves[1].ToNodeID != "" {
		t.Fatal("must park")
	}
	moves, _ = PlanFailover([]string{"x1", "x2"}, []SchedNode{
		n("a", func(s *SchedNode) { s.Grid = grid(700) }), n("b", func(s *SchedNode) { s.Grid = grid(100000) }),
	}, PlaceOptions{Policy: PolicyRoundRobin})
	if moves[0].ToNodeID != "a" || moves[1].ToNodeID != "b" {
		t.Fatal(moves)
	}
}

// ---- repository ---------------------------------------------------------------

func TestRepo(t *testing.T) {
	ctx := context.Background()
	_, g, _ := testutil.Store(t)
	r := NewRepo(g)
	cfg := y.NewMap()
	cfg.Set("z", 1.0)
	cfg.Set("a", "x")
	a, err := r.Create(ctx, CreateInput{NodeID: "n1", App: "live", PluginID: "yolo", StreamID: strPtr("cam"), Config: cfg, Status: StatusPending})
	if err != nil || len(a.ID) != 36 || a.Status != "pending" || a.Detail != nil {
		t.Fatal(a, err)
	}
	if js, _ := y.Stringify(a.Config); js != `{"z":1,"a":"x"}` {
		t.Fatal(js)
	}
	for _, st := range []string{StatusOffered, StatusRunning, StatusStopped} {
		_ = r.UpdateStatus(ctx, a.ID, st, nil)
		if got, _ := r.Get(ctx, a.ID); got.Status != st {
			t.Fatal(got.Status)
		}
	}
	_ = r.UpdateStatus(ctx, a.ID, StatusFailed, strPtr("boom"))
	_ = r.Reassign(ctx, a.ID, "n2", StatusOffered)
	if got, _ := r.Get(ctx, a.ID); got.NodeID != "n2" || got.Detail != nil {
		t.Fatal(got)
	}
	b, _ := r.Create(ctx, CreateInput{NodeID: "n2", App: "other", PluginID: "p", Status: StatusRunning})
	c, _ := r.Create(ctx, CreateInput{NodeID: "n2", App: "live", PluginID: "p", Status: StatusPending})
	if l, _ := r.PendingOrOfferedByNode(ctx, "n2"); len(l) != 2 {
		t.Fatal(l)
	}
	if l, _ := r.ActiveByNode(ctx, "n2"); len(l) != 2 || r.ActiveCountByNode(ctx, "n2") != 2 {
		t.Fatal(l)
	}
	if l, _ := r.List(ctx, ""); len(l) != 3 {
		t.Fatal(l)
	}
	if l, _ := r.List(ctx, "other"); len(l) != 1 || l[0].ID != b.ID {
		t.Fatal(l)
	}
	if got, _ := r.Get(ctx, "ghost"); got != nil {
		t.Fatal("unknown id")
	}
	if err := r.UpdateStatus(ctx, "ghost", StatusRunning, nil); err != nil {
		t.Fatal(err)
	}
	testutil.Exec(t, g, `UPDATE edge_assignments SET node_id = '' WHERE id = ?`, c.ID)
	if l, _ := r.PendingUnplaced(ctx); len(l) != 1 || l[0].ID != c.ID {
		t.Fatal(l)
	}
	testutil.Exec(t, g, `UPDATE edge_assignments SET config_json = '[1]' WHERE id = ?`, c.ID)
	if got, _ := r.Get(ctx, c.ID); got.Config.Len() != 0 {
		t.Fatal("non-object config must read as {}")
	}
}

// ---- scheduler service (real WS connections) ----------------------------------

type recLogs struct {
	mu    sync.Mutex
	calls []string
}

func (l *recLogs) Write(level, source, msg string, meta any, _ *int64) {
	js, _ := json.Marshal(meta)
	l.mu.Lock()
	l.calls = append(l.calls, level+"|"+source+"|"+msg+"|"+string(js))
	l.mu.Unlock()
}

func (l *recLogs) has(prefix string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, c := range l.calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

type recNotifier struct {
	mu     sync.Mutex
	events []string
}

func (r *recNotifier) Notify(_ context.Context, event string, p *y.Map) {
	js, _ := y.Stringify(p)
	r.mu.Lock()
	r.events = append(r.events, event+" "+js)
	r.mu.Unlock()
}

func (r *recNotifier) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

type schedEnv struct {
	*stack
	sched *Scheduler
	repo  *Repo
	db    *sql.DB
	logs  *recLogs
	notes *recNotifier
}

func newSchedEnv(t *testing.T) *schedEnv {
	t.Helper()
	s := newStack(t, "tok")
	g := s.gw.db
	logs, notes := &recLogs{}, &recNotifier{}
	repo := s.gw.repo
	sched := NewScheduler(&config.Config{}, g, s.gw, repo, s.gw.framer, NewAlerter(notes, logs, testutil.Log()), logs, testutil.Log())
	return &schedEnv{stack: s, sched: sched, repo: repo, db: g, logs: logs, notes: notes}
}

func (e *schedEnv) addNode(t *testing.T, id, typ string) {
	t.Helper()
	testutil.Exec(t, e.db, `INSERT INTO nodes (id, name, type, status, last_seen_at) VALUES (?, ?, ?, 'active', datetime('now'))`, id, id, typ)
}

func (e *schedEnv) connect(t *testing.T, id string) *client {
	t.Helper()
	c := dialEdge(t, e.stack, "?nodeId="+id+"&token=tok", nil)
	deadline := time.Now().Add(2 * time.Second)
	for !e.gw.IsConnected(id) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	return c
}

func TestScheduleOffersToConnectedEdge(t *testing.T) {
	ctx := context.Background()
	e := newSchedEnv(t)
	e.addNode(t, "edge-1", "edge")
	c := e.connect(t, "edge-1")
	a, err := e.sched.Schedule(ctx, ScheduleInput{App: "live", PluginID: "yolo"})
	if err != nil || a.Status != StatusOffered || a.NodeID != "edge-1" {
		t.Fatal(a, err)
	}
	if f := c.next(t, true); !strings.HasPrefix(f, `{"type":"assign","assignment":{"id":"`+a.ID+`"`) {
		t.Fatal(f)
	}
	if !e.logs.has("info|edge|scheduled live/yolo → edge-1|") {
		t.Fatal(e.logs.calls)
	}
}

func TestSchedulePendingAlerts(t *testing.T) {
	ctx := context.Background()
	e := newSchedEnv(t)
	e.addNode(t, "edge-1", "edge") // registered but not connected
	a, _ := e.sched.Schedule(ctx, ScheduleInput{App: "live", PluginID: "yolo"})
	if a.Status != StatusPending || a.NodeID != "" {
		t.Fatal(a)
	}
	if !e.logs.has(`warn|edge|no eligible node for live/yolo|{"assignmentId":"`+a.ID+`","app":"live","pluginId":"yolo","policy":"round_robin"}`) ||
		!e.logs.has(`warn|edge|cluster capacity: no-eligible-node|{"reason":"no-eligible-node","app":"live","pluginId":"yolo"}`) {
		t.Fatal(e.logs.calls)
	}
	// RetryPending: still nothing → no second alert within the cooldown
	if e.sched.RetryPending(ctx) != 0 || strings.Count(strings.Join(e.logs.calls, "\n"), "cluster capacity") != 1 {
		t.Fatal(e.logs.calls)
	}
	// once a node connects, the parked work is offered
	c := e.connect(t, "edge-1")
	if e.sched.RetryPending(ctx) != 1 {
		t.Fatal("not re-placed")
	}
	if got, _ := e.repo.Get(ctx, a.ID); got.Status != StatusOffered || got.NodeID != "edge-1" {
		t.Fatal(got)
	}
	if f := c.next(t, true); !strings.Contains(f, a.ID) {
		t.Fatal(f)
	}
	time.Sleep(50 * time.Millisecond)
	if ev := e.notes.list(); len(ev) != 1 || !strings.HasPrefix(ev[0], `cluster.capacity {"reason":"no-eligible-node"`) {
		t.Fatal(ev)
	}
}

func TestRevokeAndFailover(t *testing.T) {
	ctx := context.Background()
	e := newSchedEnv(t)
	e.addNode(t, "a", "edge")
	e.addNode(t, "b", "edge")
	ca := e.connect(t, "a")
	a1, _ := e.sched.Schedule(ctx, ScheduleInput{App: "live", PluginID: "p"})
	_ = ca.next(t, true)
	if got, _ := e.sched.Revoke(ctx, a1.ID); got.Status != StatusRevoked {
		t.Fatal(got)
	}
	if f := ca.next(t, true); f != `{"type":"revoke","id":"`+a1.ID+`"}` {
		t.Fatal(f)
	}
	if got, _ := e.sched.Revoke(ctx, "ghost"); got != nil {
		t.Fatal("unknown")
	}

	// node a goes down with running work; b survives
	a2, _ := e.repo.Create(ctx, CreateInput{NodeID: "a", App: "live", PluginID: "p", Status: StatusRunning})
	cb := e.connect(t, "b")
	e.sched.HandleNodeDown(ctx, "a")
	if got, _ := e.repo.Get(ctx, a2.ID); got.NodeID != "b" || got.Status != StatusOffered {
		t.Fatal(got)
	}
	if f := cb.next(t, true); !strings.Contains(f, a2.ID) {
		t.Fatal(f)
	}
	if e.logs.has("warn|edge|cluster capacity: failover-parked") {
		t.Fatal("no alert when every orphan found a survivor")
	}

	// no survivor → parked + failover-parked alert
	a3, _ := e.repo.Create(ctx, CreateInput{NodeID: "b", App: "live", PluginID: "p", Status: StatusRunning})
	e.gw.Disconnect("a")
	e.gw.Disconnect("b")
	e.sched.HandleNodeDown(ctx, "b")
	if got, _ := e.repo.Get(ctx, a3.ID); got.Status != StatusPending || *got.Detail != "no eligible node for failover" {
		t.Fatal(got)
	}
	if !e.logs.has(`warn|edge|cluster capacity: failover-parked|{"reason":"failover-parked","nodeId":"b","parked":`) {
		t.Fatal(e.logs.calls)
	}
}

func TestFailbackGrace(t *testing.T) {
	e := newSchedEnv(t)
	e.addNode(t, "a", "edge")
	e.connect(t, "a")
	if !e.sched.eligibleConnected("a") {
		t.Fatal("never flapped: eligible at once")
	}
	e.gw.Disconnect("a")
	e.connect(t, "a")
	if e.sched.eligibleConnected("a") {
		t.Fatal("flapped node must wait the failback grace")
	}
	e.sched.now = func() time.Time { return time.Now().Add(FailbackGrace + time.Second) }
	if !e.sched.eligibleConnected("a") {
		t.Fatal("grace elapsed")
	}
}

func TestGPUPlacement(t *testing.T) {
	ctx := context.Background()
	e := newSchedEnv(t)
	e.addNode(t, "gpu", "edge")
	testutil.Exec(t, e.db, `UPDATE nodes SET stats_json = '{"grid":{"gpu":true,"vramGb":24,"vramFreeMb":1500,"capabilities":["cuda"]}}' WHERE id = 'gpu'`)
	e.addNode(t, "cpu", "edge")
	e.connect(t, "gpu")
	e.connect(t, "cpu")
	a, _ := e.sched.Schedule(ctx, ScheduleInput{App: "live", PluginID: "p", Req: &plugins.GridRequirements{GPU: true}})
	if a.NodeID != "gpu" {
		t.Fatal(a.NodeID)
	}
}

// ---- watchdog ----------------------------------------------------------------

func TestWatchdog(t *testing.T) {
	ctx := context.Background()
	e := newSchedEnv(t)
	e.addNode(t, "a", "edge")
	w := NewWatchdog(e.db, e.gw, e.sched, e.notes)
	e.connect(t, "a")
	w.Tick(ctx) // baseline: silent
	if len(e.notes.list()) != 0 {
		t.Fatal("baseline must be silent")
	}
	// WS drops but the HTTP heartbeat keeps it fresh → no flip
	e.gw.Disconnect("a")
	w.Tick(ctx)
	if len(e.notes.list()) != 0 {
		t.Fatal("fresh heartbeat must keep it online")
	}
	testutil.Exec(t, e.db, `UPDATE nodes SET last_seen_at = datetime('now', '-200 seconds') WHERE id = 'a'`)
	w.Tick(ctx)
	ev := e.notes.list()
	if len(ev) != 1 || !strings.HasPrefix(ev[0], `node.offline {"nodeId":"a","name":"a","type":"edge","at":"`) {
		t.Fatal(ev)
	}
	e.connect(t, "a")
	w.Tick(ctx)
	if ev := e.notes.list(); len(ev) != 2 || !strings.HasPrefix(ev[1], "node.online ") {
		t.Fatal(ev)
	}
}

func TestWatchdogFailoverGrace(t *testing.T) {
	ctx := context.Background()
	e := newSchedEnv(t)
	e.addNode(t, "a", "edge")
	w := NewWatchdog(e.db, e.gw, e.sched, e.notes)
	e.connect(t, "a")
	a, _ := e.repo.Create(ctx, CreateInput{NodeID: "a", App: "live", PluginID: "p", Status: StatusRunning})
	e.gw.Disconnect("a")
	w.Tick(ctx) // inside the grace
	if got, _ := e.repo.Get(ctx, a.ID); got.Status != StatusRunning {
		t.Fatal("failed over inside the grace")
	}
	w.now = func() time.Time { return time.Now().Add(FailoverGrace + time.Second) }
	w.Tick(ctx)
	if got, _ := e.repo.Get(ctx, a.ID); got.Status != StatusPending {
		t.Fatal(got)
	}
}

// ---- alerter + notifier ----------------------------------------------------------

func TestAlerterCooldown(t *testing.T) {
	logs, notes := &recLogs{}, &recNotifier{}
	now := time.Unix(1000, 0)
	a := NewAlerter(notes, logs, testutil.Log())
	a.now = func() time.Time { return now }
	p := y.NewMap()
	p.Set("pending", 2.0)
	if !a.Alert("no-eligible-node", p) || a.Alert("no-eligible-node", nil) {
		t.Fatal("cooldown")
	}
	if !a.Alert("failover-parked", nil) {
		t.Fatal("each reason has its own key")
	}
	now = now.Add(AlertCooldown)
	if !a.Alert("no-eligible-node", nil) {
		t.Fatal("cooldown elapsed")
	}
	if !logs.has(`warn|edge|cluster capacity: no-eligible-node|{"reason":"no-eligible-node","pending":2}`) {
		t.Fatal(logs.calls)
	}
	time.Sleep(50 * time.Millisecond)
	if len(notes.list()) != 3 {
		t.Fatal(notes.list())
	}
	if !NewAlerter(nil, nil, testutil.Log()).Alert("x", nil) {
		t.Fatal("no sinks must not fail")
	}
}

type recFanOut struct {
	mu     sync.Mutex
	global []string
	apps   []string
}

func (f *recFanOut) Notify(_ context.Context, app, event string, _ any, _ *notifications.Options) {
	f.mu.Lock()
	f.apps = append(f.apps, app+":"+event)
	f.mu.Unlock()
}
func (f *recFanOut) NotifyGlobal(_ context.Context, event string, _ any, _ *notifications.Options) {
	f.mu.Lock()
	f.global = append(f.global, event)
	f.mu.Unlock()
}

type recCallbacks struct{ apps []string }

func (r *recCallbacks) Dispatch(_ context.Context, app, event string, _ any) error {
	r.apps = append(r.apps, app+":"+event)
	return nil
}

func TestDefaultNotifier(t *testing.T) {
	ctx := context.Background()
	_, g, dir := testutil.Store(t)
	for _, app := range []string{"yes", "str", "no", "none"} {
		testutil.Exec(t, g, `INSERT INTO apps (name) VALUES (?)`, app)
	}
	write := func(app, yaml string) {
		_ = os.MkdirAll(filepath.Join(dir, "apps", app), 0o755)
		_ = os.WriteFile(filepath.Join(dir, "apps", app, "config.yaml"), []byte(yaml), 0o644)
	}
	write("yes", "cluster:\n  notify: true\n")
	write("str", "cluster:\n  notify: ' On '\n")
	write("no", "cluster:\n  notify: 0\n")
	nt := NewDefaultNotifier(g, dir, testutil.Log())
	logs, fan := &recLogs{}, &recFanOut{}
	nt.Bind(logs, fan, nil)
	p := y.NewMap()
	p.Set("nodeId", "a")
	nt.Notify(ctx, "node.offline", p)
	if !logs.has(`info|edge|cluster node.offline|{"nodeId":"a"}`) || !reflect.DeepEqual(fan.global, []string{"node.offline"}) ||
		!reflect.DeepEqual(fan.apps, []string{"str:node.offline", "yes:node.offline"}) {
		t.Fatal(logs.calls, fan.global, fan.apps)
	}
	nt.Notify(ctx, "node.weird", p) // log-only
	if len(fan.global) != 1 {
		t.Fatal("non-fanout event fanned out")
	}
	cb := &recCallbacks{}
	nt.Bind(nil, nil, cb)
	nt.Notify(ctx, "cluster.capacity", p)
	if !reflect.DeepEqual(cb.apps, []string{"str:cluster.capacity", "yes:cluster.capacity"}) {
		t.Fatal(cb.apps)
	}
}

// ---- spawn resolver ----------------------------------------------------------------

type fakeCatalog struct {
	metas    map[string]*plugins.Meta
	installs map[string]*plugins.Installed // app/plugin
	sha      map[string]string
}

func (f *fakeCatalog) Meta(id string) *plugins.Meta { return f.metas[id] }
func (f *fakeCatalog) Install(_ context.Context, app, id string) *plugins.Installed {
	return f.installs[app+"/"+id]
}
func (f *fakeCatalog) Installs(_ context.Context, app string) []*plugins.Installed {
	var out []*plugins.Installed
	for k, v := range f.installs {
		if strings.HasPrefix(k, app+"/") {
			out = append(out, v)
		}
	}
	return out
}
func (f *fakeCatalog) VersionSha256(id, v string) string { return f.sha[id+"@"+v] }

type dirs struct{}

func (dirs) AppDir(name string) string { return "/data/apps/" + name }

func lprMeta() *plugins.Meta {
	return &plugins.Meta{ID: "lpr", Worker: &plugins.WorkerDescriptor{Edge: true, Spawn: func(ctx plugins.WorkerContext) plugins.WorkerSpec {
		return plugins.WorkerSpec{Command: "python3", Args: []string{"-m", "lpr", ctx.Config.Get("room").(string), ctx.OriginURL, ctx.AppDir},
			Env: []plugins.EnvVar{{Key: "LPR_MODE", Value: "edge"}, {Key: "STREAMHUB_APP", Value: "override"}}}
	}}}
}

// GO-DIVERGENCE (Node bug fixed): an edge worker posts its events / live data
// with STREAMHUB_INGEST_TOKEN = HMAC(cluster token, app:plugin:room); the
// master must accept exactly the tokens of its offered/running assignments.
func TestIngestVerifier(t *testing.T) {
	ctx := context.Background()
	_, g, _ := testutil.Store(t)
	repo := NewRepo(g)
	cat := &fakeCatalog{metas: map[string]*plugins.Meta{"lpr": lprMeta()}, installs: map[string]*plugins.Installed{}, sha: map[string]string{}}
	res := NewGenericResolver(&config.Config{ClusterToken: "secret", PublicBaseURL: "https://o"}, func() Catalog { return cat }, dirs{})
	v := IngestVerifier{Resolver: res, Repo: repo}
	byRoom := y.NewMap()
	byRoom.Set("room", "gate cam")
	byStream := y.NewMap()
	byStream.Set("streamId", "cam2")
	a1, _ := repo.Create(ctx, CreateInput{NodeID: "n1", App: "my app", PluginID: "lpr", Config: byRoom, Status: StatusOffered})
	a2, _ := repo.Create(ctx, CreateInput{NodeID: "n1", App: "my app", PluginID: "lpr", Config: byStream, Status: StatusRunning})
	// the token the edge received in its assign frame (same as TestGenericResolver's Node vector)
	tok1 := res.Resolve("my app", "lpr", byRoom).Env.Get("STREAMHUB_INGEST_TOKEN").(string)
	tok2 := res.ingestToken("my app", "lpr", assignmentRoom(byStream)) // room ← config.streamId
	if tok1 != "3e9696224612a90d337c1f1ad41bb32ec6fcffabf226db2fdd02e01f24c76743" {
		t.Fatal(tok1)
	}
	for _, c := range []struct {
		app, plugin, token string
		want               bool
	}{
		{"my app", "lpr", tok1, true},
		{"my app", "lpr", tok2, true},
		{"my app", "yolo", tok1, false}, // other plugin
		{"other", "lpr", tok1, false},   // other app
		{"my app", "lpr", "nope", false},
		{"my app", "lpr", "", false},
	} {
		if got := v.Valid(ctx, c.app, c.plugin, c.token); got != c.want {
			t.Errorf("%+v → %v", c, got)
		}
	}
	// revoked / stopped assignments stop authorizing
	_ = repo.UpdateStatus(ctx, a1.ID, StatusRevoked, nil)
	_ = repo.UpdateStatus(ctx, a2.ID, StatusStopped, nil)
	if v.Valid(ctx, "my app", "lpr", tok1) || v.Valid(ctx, "my app", "lpr", tok2) {
		t.Fatal("inactive assignment still authorizes")
	}
	// without a cluster token the edge tokens are random → never verifiable
	_ = repo.UpdateStatus(ctx, a1.ID, StatusRunning, nil)
	noSecret := IngestVerifier{Resolver: NewGenericResolver(&config.Config{}, func() Catalog { return cat }, nil), Repo: repo}
	if noSecret.Valid(ctx, "my app", "lpr", tok1) {
		t.Fatal("verified without a cluster token")
	}
}

func TestGenericResolver(t *testing.T) {
	cat := &fakeCatalog{metas: map[string]*plugins.Meta{"lpr": lprMeta()}, installs: map[string]*plugins.Installed{}, sha: map[string]string{}}
	cfg := &config.Config{ClusterToken: "secret", PublicBaseURL: "https://origin.example.com/", DataDir: "/data"}
	r := NewGenericResolver(cfg, func() Catalog { return cat }, dirs{})
	c := y.NewMap()
	c.Set("room", "gate cam")
	spec := r.Resolve("my app", "lpr", c)
	env, _ := y.Stringify(spec.Env)
	// HMAC-SHA256("secret", "my app:lpr:gate cam") from node:crypto:
	// node -e 'console.log(require("crypto").createHmac("sha256","secret").update("my app:lpr:gate cam").digest("hex"))'
	if spec.Command != "python3" || !reflect.DeepEqual(spec.Args, []string{"-m", "lpr", "gate cam", "https://origin.example.com/", "/data/apps/my app"}) ||
		env != `{"STREAMHUB_APP":"override","STREAMHUB_PLUGIN_ID":"lpr","STREAMHUB_INGEST_TOKEN":"3e9696224612a90d337c1f1ad41bb32ec6fcffabf226db2fdd02e01f24c76743","STREAMHUB_INGEST_URL":"https://origin.example.com/api/v1/apps/my%20app/plugins/lpr/live","STREAMHUB_EVENTS_URL":"https://origin.example.com/api/v1/apps/my%20app/plugins/lpr/events","LPR_MODE":"edge"}` {
		t.Fatalf("%+v %s", spec, env)
	}
	if again := r.Resolve("my app", "lpr", c); again.Env.Get("STREAMHUB_INGEST_TOKEN") != spec.Env.Get("STREAMHUB_INGEST_TOKEN") {
		t.Fatal("token must be stable across re-offers")
	}
	if e := r.Resolve("live", "ghost", y.NewMap()); e.Command != "" || len(e.Args) != 0 || e.Env.Len() != 0 {
		t.Fatal("unknown plugin → empty spec")
	}
	// no cluster secret → ephemeral random token
	r2 := NewGenericResolver(&config.Config{}, func() Catalog { return cat }, nil)
	tok := r2.Resolve("a", "lpr", c).Env.Get("STREAMHUB_INGEST_TOKEN").(string)
	if !strings.HasPrefix(tok, r2.ephemeral+":") {
		t.Fatal(tok)
	}

	// bundle seam
	if r.ResolveBundle("live", "lpr") != nil {
		t.Fatal("no install → no bundle")
	}
	v := "1.2.0"
	cat.installs["live/lpr"] = &plugins.Installed{PluginID: "lpr", WorkerVersion: &v}
	if r.ResolveBundle("live", "lpr") != nil {
		t.Fatal("vanished version → no bundle")
	}
	cat.sha["lpr@1.2.0"] = "abc"
	b := r.ResolveBundle("live", "lpr")
	if b == nil || *b != (BundleRef{"lpr", "1.2.0", "abc", "https://origin.example.com/api/v1/plugins/lpr/versions/1.2.0/bundle"}) {
		t.Fatal(b)
	}
	f := (&Framer{Resolver: r}).AssignFrame(Assignment{ID: "x", App: "live", PluginID: "lpr", Config: c})
	js, _ := json.Marshal(f)
	if !strings.HasSuffix(string(js), `"bundle":{"pluginId":"lpr","version":"1.2.0","sha256":"abc","url":"https://origin.example.com/api/v1/plugins/lpr/versions/1.2.0/bundle"}}}`) {
		t.Fatal(string(js))
	}
	f2 := (&Framer{}).AssignFrame(Assignment{ID: "x", App: "live", PluginID: "lpr"})
	js2, _ := json.Marshal(f2)
	if string(js2) != `{"type":"assign","assignment":{"id":"x","app":"live","pluginId":"lpr","streamId":null,"config":{},"spawn":{"command":"","args":[],"env":{}}}}` {
		t.Fatal(string(js2))
	}
}

// ---- reconcile ---------------------------------------------------------------------

func TestReconcile(t *testing.T) {
	ctx := context.Background()
	e := newSchedEnv(t)
	cat := &fakeCatalog{metas: map[string]*plugins.Meta{"lpr": lprMeta(), "local": {ID: "local", Worker: &plugins.WorkerDescriptor{}}},
		installs: map[string]*plugins.Installed{
			"live/lpr":   {PluginID: "lpr", Enabled: true, Config: y.NewMap()},
			"live/local": {PluginID: "local", Enabled: true, Config: y.NewMap()},
		}}
	rc := NewReconciler(e.sched, e.repo, e.gw, func() Catalog { return cat }, e.store, e.db, nil, testutil.Log())

	adb, _ := e.store.App(ctx, "live")
	testutil.Exec(t, adb, `INSERT INTO streams (app_id, stream_id, type, status, room) VALUES (1, 's1', 'rtmp', 'active', 'cam1'), (1, 's2', 'rtmp', 'active', 'cam2'), (1, 's3', 'rtmp', 'ended', 'cam3')`)

	rc.ReconcileApp(ctx, "live") // no edge connected → nothing
	if l, _ := e.repo.List(ctx, "live"); len(l) != 0 {
		t.Fatal(l)
	}
	e.addNode(t, "edge-1", "edge")
	e.connect(t, "edge-1")
	rc.ReconcileApp(ctx, "live")
	l, _ := e.repo.List(ctx, "live")
	rooms := map[string]string{}
	for _, a := range l {
		if a.PluginID != "lpr" {
			t.Fatal("non-edge plugin mirrored")
		}
		rooms[*a.StreamID] = a.Config.Get("room").(string)
	}
	if !reflect.DeepEqual(rooms, map[string]string{"cam1": "cam1", "cam2": "cam2"}) {
		t.Fatal(rooms)
	}
	rc.ReconcileApp(ctx, "live") // idempotent
	if l2, _ := e.repo.List(ctx, "live"); len(l2) != 2 {
		t.Fatal("re-scheduled an existing stream")
	}
	testutil.Exec(t, adb, `UPDATE streams SET status = 'ended' WHERE room = 'cam2'`)
	rc.ReconcileApp(ctx, "live")
	for _, a := range func() []Assignment { l, _ := e.repo.List(ctx, "live"); return l }() {
		if (*a.StreamID == "cam2") != (a.Status == StatusRevoked) {
			t.Fatalf("%s %s", *a.StreamID, a.Status)
		}
	}
}

// ---- app-scoped rules ---------------------------------------------------------------

func TestRequireEdgePlugin(t *testing.T) {
	ctx := context.Background()
	cat := &fakeCatalog{metas: map[string]*plugins.Meta{"lpr": lprMeta(), "plain": {ID: "plain"}}, installs: map[string]*plugins.Installed{}}
	m := &Module{catalog: func() Catalog { return cat }}
	cases := []struct {
		plugin, msg string
		status      int
	}{
		{"ghost", "plugin 'ghost' not found", 404},
		{"plain", "plugin 'plain' is not edge-capable (worker.edge)", 400},
		{"lpr", "plugin 'lpr' is not installed in app 'live'", 400},
	}
	for _, c := range cases {
		err := m.requireEdgePlugin(ctx, "live", c.plugin)
		if err == nil || !strings.Contains(err.Error(), c.msg) {
			t.Errorf("%s: %v", c.plugin, err)
		}
	}
	cat.installs["live/lpr"] = &plugins.Installed{PluginID: "lpr"}
	if err := m.requireEdgePlugin(ctx, "live", "lpr"); err != nil {
		t.Fatal(err)
	}
	if err := (&Module{catalog: func() Catalog { return nil }}).requireEdgePlugin(ctx, "live", "lpr"); err == nil {
		t.Fatal("no plugins module → not found")
	}
}
