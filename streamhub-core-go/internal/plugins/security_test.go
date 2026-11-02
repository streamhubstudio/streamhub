package plugins

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/cluster"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// C4 (3.3.3): streamflow's `dangerousNodes` left the configSchema (the
// operator env STREAMHUB_STREAMFLOW_DANGEROUS replaced it). A tenant PATCH
// carrying it is ignored — not stored, not an error — and an install that
// still has it stored keeps validating.
func TestStreamflowDangerousNodesPatchIgnored(t *testing.T) {
	st := newStack(t)
	st.reg.Discover()
	if _, err := st.svc.Install(bg, "live", "streamflow"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.svc.Patch(bg, "live", "streamflow", Patch{Config: cfg(t, `{"dangerousNodes":true,"max_runs_per_min":5}`)}); err != nil {
		t.Fatalf("patch: %v", err)
	}
	row, _ := st.repo.Get(bg, "live", "streamflow")
	if _, has := row.Config.Lookup("dangerousNodes"); has || row.Config.Get("max_runs_per_min") != 5.0 {
		t.Fatalf("stored config %s", jsonOf(row.Config))
	}
	// a pre-3.3.3 row still carrying the key keeps validating (and drops it)
	if err := st.repo.Update(bg, "live", "streamflow", nil, cfg(t, `{"dangerousNodes":true}`)); err != nil {
		t.Fatal(err)
	}
	v, err := st.svc.Get(bg, "live", "streamflow")
	if err != nil {
		t.Fatalf("legacy row: %v", err)
	}
	if _, has := v.Config.Lookup("dangerousNodes"); has {
		t.Fatal("legacy key surfaced in the view")
	}
	// other plugins still reject unknown keys
	if _, err := ValidateConfig(st.reg.GetMeta("watermark"), cfg(t, `{"dangerousNodes":true}`), false); err == nil {
		t.Fatal("retired key leaked to another plugin")
	}
}

func jsonOf(v any) string { s, _ := stringifyJS(v); return s }

// ---------------------------------------------------------------------------
// C5 (3.3.3): POST /grid/workers ran whatever command/args/env the caller
// sent, on any node holding the cluster token. Now the body names a plugin
// and the node resolves the spawn from its own registry; /grid exists only
// on an edge node.
// ---------------------------------------------------------------------------

type fakeGridNode struct {
	role                   string
	master, nodeID, secret *string
}

func (f fakeGridNode) Role(context.Context) string          { return f.role }
func (f fakeGridNode) MasterURL(context.Context) *string    { return f.master }
func (f fakeGridNode) MasterNodeID(context.Context) *string { return f.nodeID }
func (f fakeGridNode) NodeSecret(context.Context) *string   { return f.secret }

// edgeNode is node-7 of a master whose cluster token is "tok", holding its
// per-node secret (C5.3).
func edgeNode(master string) func() GridNode {
	id, secret := "node-7", cluster.NodeSecret("tok", "node-7")
	return func() GridNode { return fakeGridNode{role: "edge", master: &master, nodeID: &id, secret: &secret} }
}

// gridShellMeta is a grid-placed worker plugin running `sh -c script`.
func gridShellMeta(id, script string) *Meta {
	m := shellMeta(id, script, `[{"key":"room","type":"string","label":"R","default":"r1"}]`)
	m.Worker.Placement = "grid"
	return m
}

func gridServer(t *testing.T, st *stack, node func() GridNode) http.Handler {
	return gridServerLegacy(t, st, node, true)
}

// gridServerLegacy: legacy=false is STREAMHUB_CLUSTER_LEGACY_TOKEN=off (the
// raw "tok" no longer opens /grid; only the node secret does).
func gridServerLegacy(t *testing.T, st *stack, node func() GridNode, legacy bool) http.Handler {
	mux := http.NewServeMux()
	rt := NewRoutes(st.svc, nil, nil, NewAgent(st.workers, st.reg, node), nil, "tok", nil)
	rt.SetNodeAuth(nil, legacy)
	rt.Register(api.New(mux, "test"))
	return httpx.WithRequest(mux)
}

func gridCall(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("content-type", "application/json")
	r.Header.Set("x-cluster-token", "tok")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func TestGridWorkersRejectsResolvedSpec(t *testing.T) {
	st := newStack(t, gridShellMeta("gp", "sleep 30"))
	h := gridServer(t, st, edgeNode("https://m"))
	for _, body := range []string{
		`{"pluginId":"gp","appName":"live","command":"/bin/sh","args":["-c","id"]}`,
		`{"pluginId":"gp","appName":"live","env":{"LD_PRELOAD":"/tmp/x.so"}}`,
		`{"pluginId":"gp","appName":"live","cwd":"/"}`,
	} {
		rec := gridCall(h, "POST", "/api/v1/grid/workers", body)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), "should not exist") {
			t.Errorf("%s → %d %s", body, rec.Code, rec.Body.String())
		}
	}
	if s, ok := st.workers.StatusByKey("gp"); ok {
		t.Fatalf("a worker was started: %+v", s)
	}
}

func TestGridRoutes404OffEdge(t *testing.T) {
	st := newStack(t, gridShellMeta("gp", "sleep 30"))
	master := "https://m"
	for name, node := range map[string]func() GridNode{
		"master":     func() GridNode { return fakeGridNode{role: "master"} },
		"standalone": func() GridNode { return fakeGridNode{role: "standalone", master: &master} },
		"no role":    nil,
		"nil node":   func() GridNode { return nil },
	} {
		h := gridServer(t, st, node)
		for _, c := range [][3]string{
			{"POST", "/api/v1/grid/workers", `{"pluginId":"gp","appName":"live"}`},
			{"POST", "/api/v1/grid/workers", `{"pluginId":"gp","appName":"live","command":"/bin/sh"}`},
			{"POST", "/api/v1/grid/workers", `{}`},
			{"GET", "/api/v1/grid/workers/x/status", ``},
			{"POST", "/api/v1/grid/workers/x/stop", ``},
			{"GET", "/api/v1/grid/workers/x/logs?limit=5", ``},
		} {
			rec := gridCall(h, c[0], c[1], c[2])
			if rec.Code != 404 || !strings.Contains(rec.Body.String(), "Cannot "+c[0]+" "+c[1]) {
				t.Errorf("%s: %s %s → %d %s", name, c[0], c[1], rec.Code, rec.Body.String())
			}
		}
	}
}

func TestGridSpawnFromLocalRegistry(t *testing.T) {
	notGrid := shellMeta("local-only", "sleep 30", "")
	st := newStack(t, gridShellMeta("gp", "echo room=$ROOM tok=$STREAMHUB_INGEST_TOKEN; sleep 30"), notGrid)
	st.reg.GetMeta("gp").Worker.Spawn = func(ctx WorkerContext) WorkerSpec {
		// the node's builder sees the validated config and the remote context
		return WorkerSpec{Command: "/bin/sh", Args: []string{"-c", "echo room=$ROOM tok=$STREAMHUB_INGEST_TOKEN node=" + ctx.Node.ID + " origin=" + ctx.OriginURL + "; sleep 30"},
			Env: []EnvVar{{"ROOM", StringifyConfigValue(ctx.Config.Get("room"))}}}
	}
	h := gridServer(t, st, edgeNode("https://m"))
	rec := gridCall(h, "POST", "/api/v1/grid/workers", `{"pluginId":"gp","appName":"live","config":{"room":"gate"},"ingestToken":"it"}`)
	if rec.Code != 201 || !strings.Contains(rec.Body.String(), `"status":"running"`) {
		t.Fatalf("spawn %d %s", rec.Code, rec.Body.String())
	}
	id := readWorkerID(decodeJSON(t, rec.Body.Bytes()))
	eventually(t, "worker output", func() bool {
		for _, l := range st.workers.LogsByKey(id, 10) {
			if l.Line == "room=gate tok=it node=node-7 origin=https://m" {
				return true
			}
		}
		return false
	})
	for body, want := range map[string]int{
		`{"pluginId":"nope","appName":"live"}`:                        404,
		`{"pluginId":"local-only","appName":"live"}`:                  400, // not placement:grid
		`{"pluginId":"gp","appName":"../etc"}`:                        400,
		`{"pluginId":"gp","appName":"live","config":{"zzz":1}}`:       400, // validated against the node's schema
		`{"pluginId":"gp","appName":"live","config":{"room":5}}`:      400,
		`{"pluginId":"gp","appName":"live","config":"not an object"}`: 400,
	} {
		if rec := gridCall(h, "POST", "/api/v1/grid/workers", body); rec.Code != want {
			t.Errorf("%s → %d %s", body, rec.Code, rec.Body.String())
		}
	}
	// the cluster token still gates an edge node
	r := httptest.NewRequest("POST", "/api/v1/grid/workers", strings.NewReader(`{"pluginId":"gp","appName":"live"}`))
	r.Header.Set("content-type", "application/json")
	out := httptest.NewRecorder()
	h.ServeHTTP(out, r)
	if out.Code != 401 {
		t.Fatalf("no token → %d", out.Code)
	}
}

// The master's dispatcher sends the new body, and a real edge agent runs it.
func TestGridDispatchEndToEnd(t *testing.T) {
	edge := newStack(t, gridShellMeta("gp", "echo up; sleep 30"))
	// strict edge (legacy off): only the master's per-node signature opens it
	srv := httptest.NewServer(gridServerLegacy(t, edge, edgeNode("https://master"), false))
	t.Cleanup(srv.Close)

	master := newStack(t, gridShellMeta("gp", "echo LOCAL; sleep 30"))
	_, global, _ := testutil.Store(t)
	testutil.Exec(t, global, `INSERT INTO nodes (id, name, url, region, status, last_seen_at, stats_json) VALUES
	  ('node-7','gpu-1',?,'eu','active',datetime('now'),'{"grid":{"gpu":true}}')`, srv.URL)
	master.workers.SetGrid(NewGrid(global, "tok"))
	if _, err := master.workers.Start(bg, master.reg.GetMeta("gp"), "live", master.dir, cfg(t, `{"room":"r9"}`), nil, ""); err != nil {
		t.Fatal(err)
	}
	eventually(t, "grid placement", func() bool {
		s := master.workers.Status("live", "gp")
		return s.Placement == "grid" && s.RemoteID != ""
	})
	remote := master.workers.Status("live", "gp").RemoteID
	if s, ok := edge.workers.StatusByKey(remote); !ok || s.Status != "running" || s.PluginID != "gp" {
		t.Fatalf("edge worker %+v %v", s, ok)
	}
}

func decodeJSON(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// ---------------------------------------------------------------------------
// C5.3 (3.3.4): per-node credential. The master signs grid calls with the
// target node's secret; a node only accepts ITS secret (the raw cluster
// token only in legacy mode).
// ---------------------------------------------------------------------------

func gridStatus(h http.Handler, headers map[string]string) int {
	r := httptest.NewRequest("GET", "/api/v1/grid/workers/nope/status", nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Code
}

func TestGridGateNodeSecret(t *testing.T) {
	st := newStack(t, gridShellMeta("gp", "sleep 30"))
	own, other := cluster.NodeSecret("tok", "node-7"), cluster.NodeSecret("tok", "node-8")
	// 404 = past the gate (unknown worker); 401 = refused
	for _, legacy := range []bool{true, false} {
		h := gridServerLegacy(t, st, edgeNode("https://m"), legacy)
		shared := 401
		if legacy {
			shared = 404
		}
		for name, c := range map[string]struct {
			h    map[string]string
			want int
		}{
			"own secret":                {map[string]string{cluster.NodeSecretHeader: own}, 404},
			"own secret in cluster hdr": {map[string]string{"x-cluster-token": own}, 404},
			"another node's secret":     {map[string]string{cluster.NodeSecretHeader: other}, 401},
			"shared cluster token":      {map[string]string{"x-cluster-token": "tok"}, shared},
			"shared token as secret":    {map[string]string{cluster.NodeSecretHeader: "tok"}, 401},
			"nothing":                   {nil, 401},
		} {
			if got := gridStatus(h, c.h); got != c.want {
				t.Errorf("legacy=%v %s → %d, want %d", legacy, name, got, c.want)
			}
		}
	}
	// a node holding no credential at all: 503
	id, master := "node-7", "https://m"
	bare := func() GridNode { return fakeGridNode{role: "edge", master: &master, nodeID: &id} }
	if got := gridStatus(gridServerLegacy(t, st, bare, false), map[string]string{"x-cluster-token": "tok"}); got != 503 {
		t.Fatalf("no credential → %d", got)
	}
	// …but a pre-3.3.4 node (no secret, legacy on) still takes the raw token
	if got := gridStatus(gridServerLegacy(t, st, bare, true), map[string]string{"x-cluster-token": "tok"}); got != 404 {
		t.Fatalf("legacy node → %d", got)
	}
}
