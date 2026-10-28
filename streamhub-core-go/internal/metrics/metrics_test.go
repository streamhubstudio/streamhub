package metrics

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
)

func ptr[T any](v T) *T { return &v }

// ---------------------------------------------------------------------------
// cluster-metrics.spec.ts
// ---------------------------------------------------------------------------

var clusterNow = time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC)

const fullStats = `{"role":"edge","cores":8,"loadavg1":2,"cpu":0.25,"memTotal":16000,"memFree":4000,"memUsedRatio":0.75,"disk":{"total":100,"free":20,"usedRatio":0.8},"grid":{"gpu":true,"vramGb":24,"vramFreeMb":20000,"gpuName":"T4","capabilities":["vision"]}}`

func row(mut func(*RawNodeRow)) RawNodeRow {
	r := RawNodeRow{Name: "edge-1", Type: ptr("edge"), Weight: ptr(100.0), Status: "active", LastSeenAt: ptr("2026-07-11 11:59:30"), StatsJSON: ptr(fullStats)}
	if mut != nil {
		mut(&r)
	}
	return r
}

func TestParseStatsBlob(t *testing.T) {
	if m := ParseStatsBlob(ptr(`{"a":1}`)); m == nil || m["a"] != 1.0 {
		t.Fatalf("%v", m)
	}
	for _, s := range []*string{ptr("[1,2,3]"), ptr("not json {{{"), ptr(""), nil, ptr("42")} {
		if ParseStatsBlob(s) != nil {
			t.Errorf("%v not rejected", s)
		}
	}
}

func TestNodeUp(t *testing.T) {
	cases := []struct {
		at   *string
		want bool
	}{{ptr("2026-07-11 11:59:30"), true}, {ptr("2026-07-11 11:58:00"), false}, {nil, false}, {ptr("garbage"), false}}
	for _, c := range cases {
		if got := NodeUp(c.at, clusterNow); got != c.want {
			t.Errorf("%v → %v", c.at, got)
		}
	}
}

func TestProjectNode(t *testing.T) {
	m := ProjectNode(row(nil), clusterNow)
	if m.Node != "edge-1" || m.Type != "edge" || m.Up != 1 || *m.CPURatio != 0.25 || *m.MemUsedRatio != 0.75 ||
		*m.DiskUsedRatio != 0.8 || m.GPU != 1 || *m.VramFreeMb != 20000 || m.Weight != 100 || !m.Active {
		t.Fatalf("%+v", m)
	}
	g := ProjectNode(row(func(r *RawNodeRow) { r.StatsJSON = ptr("<<not json>>") }), clusterNow)
	if g.CPURatio != nil || g.MemUsedRatio != nil || g.DiskUsedRatio != nil || g.VramFreeMb != nil || g.GPU != 0 || g.Up != 1 {
		t.Fatalf("garbage %+v", g)
	}
	p := ProjectNode(row(func(r *RawNodeRow) { r.StatsJSON = ptr(`{"cpu":"high","grid":[1,2],"disk":null}`) }), clusterNow)
	if p.CPURatio != nil || p.GPU != 0 || p.DiskUsedRatio != nil || p.VramFreeMb != nil {
		t.Fatalf("partial %+v", p)
	}
	w := ProjectNode(row(func(r *RawNodeRow) { r.Weight = nil; r.Type = ptr("origin") }), clusterNow)
	if w.Weight != 100 || w.Type != "common" {
		t.Fatalf("defaults %+v", w)
	}
	if ProjectNode(row(func(r *RawNodeRow) { r.LastSeenAt = ptr("2026-07-11 11:00:00") }), clusterNow).Up != 0 {
		t.Fatal("stale node up")
	}
}

func TestEligibleAndAssignments(t *testing.T) {
	n := func(name, typ string, up, gpu float64, active bool) NodeMetrics {
		return NodeMetrics{Node: name, Type: typ, Up: up, GPU: gpu, Active: active, Weight: 100}
	}
	nodes := []NodeMetrics{n("g1", "edge", 1, 1, true), n("c1", "edge", 1, 0, true), n("down", "edge", 0, 1, true), n("drain", "edge", 1, 1, false)}
	if e := Eligible(nodes, false); e != (EligibleCounts{1, 1}) {
		t.Fatalf("%+v", e)
	}
	common := []NodeMetrics{n("c", "common", 1, 1, true)}
	if Eligible(common, false) != (EligibleCounts{}) || Eligible(common, true) != (EligibleCounts{1, 0}) {
		t.Fatal("allowCommon")
	}
	by, pending := AssignmentCounts([]string{"pending", "running", "running", "", "pending"})
	if by["pending"] != 2 || by["running"] != 2 || by["unknown"] != 1 || pending != 2 {
		t.Fatalf("%v %d", by, pending)
	}
	if _, p := AssignmentCounts([]string{"running"}); p != 0 {
		t.Fatal("pending must be 0")
	}
}

// ---------------------------------------------------------------------------
// metrics.service.cluster.spec.ts + DB gauges
// ---------------------------------------------------------------------------

type fakeUsage struct{}

func (fakeUsage) GetUsage(_ context.Context, tenant string) quotas.UsageReport {
	return quotas.UsageReport{TenantID: tenant, Quotas: quotas.TenantQuotas{MaxApps: 2, MaxConcurrentStreams: 2, MaxRecordingMinutesMonth: 300, MaxEgressGBMonth: 5, MaxStorageGB: -1},
		Usage: quotas.TenantUsage{Apps: 1, ConcurrentStreams: 1, StorageGB: 0.5}}
}

func newService(t *testing.T, env map[string]string, withQuotas bool) (*Service, *sql.DB, func(string) *sql.DB) {
	store, global, dir := testutil.Store(t)
	d := Deps{
		Global: global, AppDB: store.App, DataDir: dir, Log: testutil.Log(),
		Env: func(k string) string { return env[k] },
	}
	if withQuotas {
		d.Quotas = fakeUsage{}
	}
	s := New(d)
	return s, global, func(app string) *sql.DB {
		h, err := store.App(context.Background(), app)
		if err != nil {
			t.Fatal(err)
		}
		return h
	}
}

func scrape(t *testing.T, s *Service) string {
	t.Helper()
	b, err := s.Scrape(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mustMatch(t *testing.T, out string, patterns ...string) {
	t.Helper()
	for _, p := range patterns {
		if !regexp.MustCompile(`(?m)` + p).MatchString(out) {
			t.Errorf("missing /%s/", p)
		}
	}
}

func TestClusterGauges(t *testing.T) {
	s, global, _ := newService(t, map[string]string{"METRICS_DEFAULT_METRICS": "off"}, false)
	gpuStats := `{"cpu":0.25,"memUsedRatio":0.6,"disk":{"usedRatio":0.4},"grid":{"gpu":true,"vramFreeMb":20000}}`
	ins := func(id, typ, status string, age int, stats any) {
		testutil.Exec(t, global, "INSERT INTO nodes (id, name, type, weight, status, last_seen_at, stats_json) VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?)",
			id, id, typ, map[string]int{"edge-gpu": 200}[id], status, "-"+strconv.Itoa(age)+" seconds", stats)
	}
	ins("edge-gpu", "edge", "active", 10, gpuStats)
	ins("edge-dead", "edge", "active", 600, nil)
	ins("edge-garbage", "edge", "draining", 5, "<<not json>>")
	testutil.Exec(t, global, "INSERT INTO edge_assignments (id, node_id, app, plugin_id, status) VALUES ('a1', '', 'live', 'yolo', 'pending'), ('a2', 'edge-gpu', 'live', 'yolo', 'running')")

	out := scrape(t, s)
	mustMatch(t, out,
		`^streamhub_cluster_node_up\{node="edge-gpu",type="edge"\} 1$`,
		`^streamhub_cluster_node_up\{node="edge-dead",type="edge"\} 0$`,
		`^streamhub_cluster_node_cpu_ratio\{node="edge-gpu"\} 0\.25$`,
		`^streamhub_cluster_node_gpu\{node="edge-gpu"\} 1$`,
		`^streamhub_cluster_node_vram_free_mb\{node="edge-gpu"\} 20000$`,
		`^streamhub_cluster_node_weight\{node="edge-gpu"\} 200$`,
		`^streamhub_cluster_node_up\{node="edge-garbage",type="edge"\} 1$`,
		`^streamhub_cluster_node_gpu\{node="edge-garbage"\} 0$`,
		`^streamhub_edge_assignments\{status="pending"\} 1$`,
		`^streamhub_edge_assignments\{status="running"\} 1$`,
		`^streamhub_edge_pending_assignments 1$`,
		`^streamhub_edge_eligible_nodes\{gpu="true"\} 1$`,
		`^streamhub_edge_eligible_nodes\{gpu="false"\} 0$`,
	)
	if strings.Contains(out, `cpu_ratio{node="edge-garbage"}`) {
		t.Error("garbage blob produced a resource series")
	}
	if strings.Contains(out, "go_goroutines") {
		t.Error("METRICS_DEFAULT_METRICS=off must drop the runtime collectors")
	}

	empty, _, _ := newService(t, nil, false)
	out = scrape(t, empty)
	mustMatch(t, out, `^streamhub_edge_pending_assignments 0$`, `^go_goroutines `, `^process_`)
}

func TestDBGauges(t *testing.T) {
	s, global, appDB := newService(t, map[string]string{"METRICS_DEFAULT_METRICS": "off"}, true)
	testutil.Exec(t, global, "INSERT INTO apps (name, display_name, livekit_room_prefix, tenant_id) VALUES ('live', 'Live', 'live_', 'platform'), ('ghost', 'Ghost', 'ghost_', NULL)")
	adb := appDB("live")
	testutil.Exec(t, adb, "INSERT INTO streams (app_id, stream_id, type, room, status) VALUES (1, 's1', 'webrtc', 'r', 'active'), (1, 's2', 'rtmp', 'r', 'ended')")
	testutil.Exec(t, adb, "INSERT INTO vods (app_id, stream_id, name, status) VALUES (1, 's1', 'k1', 'ready'), (1, 's1', 'k2', 'uploading'), (1, 's1', 'k3', 'recording')")
	s.SetViewers("live", "r", 3) // reset at scrape (mirrors DB state only)
	out := scrape(t, s)
	mustMatch(t, out,
		`^streamhub_active_streams\{app="live"\} 1$`,
		`^streamhub_active_streams\{app="ghost"\} 0$`,
		`^streamhub_vods\{app="live",status="ready"\} 1$`,
		`^streamhub_upload_queue_depth\{app="live"\} 2$`,
		`^streamhub_apps\{tenant="platform"\} 1$`,
		`^streamhub_apps\{tenant="unknown"\} 1$`,
		`^streamhub_tenant_quota\{metric="maxStorageGb",tenant="platform"\} -1$`,
		`^streamhub_tenant_usage\{metric="storageGb",tenant="platform"\} 0\.5$`,
		`^streamhub_http_requests_in_flight 0$`,
	)
	if strings.Contains(out, `tenant="unknown",metric`) || strings.Contains(out, "stream_viewers{") {
		t.Errorf("unknown tenant quotas or stale viewers exported:\n%s", out)
	}
}

func TestEventHooks(t *testing.T) {
	s, _, _ := newService(t, map[string]string{"METRICS_DEFAULT_METRICS": "off"}, false)
	s.StreamStopped("live")
	s.SnapshotTaken("live")
	s.RecordingStarted("live")
	s.VodGenerated("live")
	s.RecordingFailed("live", "")
	s.S3Upload("", true, 1024)
	s.S3Upload("aws", false, 0)
	s.S3Error("")
	s.CallbackResult("live", "vod_ready", "dropped")
	s.RecordTranscode("egress", "gpu", "")
	s.SetGPUAvailable(true, "nvidia")
	s.HTTPStart()
	s.ObserveHTTP("GET", "/api/v1/health", 503, 0.01)
	out := scrape(t, s)
	mustMatch(t, out,
		`^streamhub_stream_events_total\{app="live",event="stopped"\} 1$`,
		`^streamhub_stream_events_total\{app="live",event="snapshot"\} 1$`,
		`^streamhub_recording_failures_total\{app="live",reason="unknown"\} 1$`,
		`^streamhub_s3_uploads_total\{provider="unknown",result="ok"\} 1$`,
		`^streamhub_s3_upload_bytes_total\{provider="unknown"\} 1024$`,
		`^streamhub_s3_errors_total\{op="upload"\} 1$`,
		`^streamhub_s3_errors_total\{op="unknown"\} 1$`,
		`^streamhub_callbacks_total\{app="live",event="vod_ready",result="dropped"\} 1$`,
		`^streamhub_media_transcode_total\{accel="gpu",kind="egress",type="none"\} 1$`,
		`^streamhub_gpu_available\{type="nvidia"\} 1$`,
		`^streamhub_gpu_available\{type="none"\} 0$`,
		`^streamhub_errors_total\{code="503",source="http"\} 1$`,
		`^streamhub_http_request_duration_seconds_bucket\{method="GET",route="/api/v1/health",status="503",le="0.01"\} 1$`,
		`^# HELP streamhub_http_requests_total Total HTTP requests handled by streamhub-core\.$`,
		`^# TYPE streamhub_http_request_duration_seconds histogram$`,
	)
	s.SetGPUAvailable(false, "vaapi")
	mustMatch(t, scrape(t, s), `^streamhub_gpu_available\{type="vaapi"\} 0$`, `^streamhub_gpu_available\{type="none"\} 1$`)

	var nilSvc *Service // @Optional(): a nil service no-ops
	nilSvc.CallbackResult("a", "b", "c")
	nilSvc.ObserveHTTP("GET", "/", 200, 0)
}

// ---------------------------------------------------------------------------
// metrics.controller.spec.ts (M8 default-deny) + interceptor
// ---------------------------------------------------------------------------

func newAPI(t *testing.T, token string) (*Service, http.Handler) {
	s, _, _ := newService(t, map[string]string{"METRICS_TOKEN": token, "METRICS_DEFAULT_METRICS": "off"}, false)
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	s.Install(a)
	s.Register(a)
	huma.Register(a, huma.Operation{OperationID: "x_get", Method: http.MethodGet, Path: api.Prefix + "/apps/{name}"},
		func(_ context.Context, in *struct {
			Name string `path:"name"`
		}) (*struct{}, error) {
			if in.Name == "nope" {
				return nil, httpx.NotFound(`app "nope" not found`)
			}
			return nil, nil
		})
	huma.Register(a, huma.Operation{OperationID: "x_create", Method: http.MethodPost, Path: api.Prefix + "/apps", DefaultStatus: 201},
		func(context.Context, *struct{}) (*struct{}, error) { return nil, httpx.BadRequest("bad") })
	return s, httpx.WithRequest(mux)
}

func do(h http.Handler, method, target, auth string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestScrapeEndpointAuth(t *testing.T) {
	_, off := newAPI(t, "")
	if w := do(off, "GET", "/metrics", ""); w.Code != 404 || strings.TrimSpace(w.Body.String()) != `{"statusCode":404,"message":"Not Found"}` {
		t.Fatalf("no token: %d %s", w.Code, w.Body)
	}
	_, h := newAPI(t, "s3cret-token")
	for _, c := range []struct {
		target, auth string
		code         int
	}{
		{"/metrics", "", 403},
		{"/metrics", "Bearer wrong", 403},
		{"/metrics?token=wrong", "", 403},
		{"/metrics", "Bearer s3cret-token", 200},
		{"/metrics?token=s3cret-token", "", 200},
	} {
		w := do(h, "GET", c.target, c.auth)
		if w.Code != c.code {
			t.Fatalf("%s %q: %d", c.target, c.auth, w.Code)
		}
		if c.code == 403 && strings.TrimSpace(w.Body.String()) != `{"statusCode":403,"message":"invalid metrics token","error":"Forbidden"}` {
			t.Fatalf("403 body %s", w.Body)
		}
		if c.code == 200 {
			if w.Header().Get("Content-Type") != ContentType || w.Header().Get("Cache-Control") != "no-cache, no-store, must-revalidate" {
				t.Fatalf("headers %v", w.Header())
			}
			if !strings.Contains(w.Body.String(), "# TYPE streamhub_http_requests_total counter") {
				t.Fatal("no exposition body")
			}
		}
	}
}

func TestInterceptorLabels(t *testing.T) {
	s, h := newAPI(t, "tok")
	do(h, "GET", "/api/v1/apps/live", "")
	do(h, "GET", "/api/v1/apps/nope", "") // 404 thrown → labelled with the success status (Node finalize quirk)
	do(h, "POST", "/api/v1/apps", "")     // 400 thrown on a create → 201
	do(h, "GET", "/metrics?token=tok", "")
	out := scrape(t, s)
	mustMatch(t, out,
		`^streamhub_http_requests_total\{method="GET",route="/api/v1/apps/:name",status="204"\} 2$`,
		`^streamhub_http_requests_total\{method="POST",route="/api/v1/apps",status="201"\} 1$`,
		`^streamhub_http_requests_total\{method="GET",route="/metrics",status="200"\} 1$`,
		`^streamhub_http_requests_in_flight 0$`,
	)
	if strings.Contains(out, "streamhub_errors_total{") {
		t.Error("thrown errors must not feed errors_total")
	}
}

func TestRouteLabel(t *testing.T) {
	for in, want := range map[string]string{
		"/api/v1/apps/{app}/streams/{id}": "/api/v1/apps/:app/streams/:id",
		"/metrics":                        "/metrics",
		"/api/v1/files/{path...}":         "/api/v1/files/*",
	} {
		if got := routeLabel(&huma.Operation{Path: in}); got != want {
			t.Errorf("%s → %s", in, got)
		}
	}
	if routeLabel(nil) != "unmatched" {
		t.Error("nil op")
	}
}
