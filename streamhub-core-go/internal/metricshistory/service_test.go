package metricshistory

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

func f(v float64) *float64 { return &v }

// ---------------------------------------------------------------------------
// host-sampler.util.spec.ts
// ---------------------------------------------------------------------------

const procNetDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 123456     100    0    0    0     0          0         0  123456     100    0    0    0     0       0          0
  eth0: 1000     10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
  eth1:  500      5    0    0    0     0          0         0      700       7    0    0    0     0       0          0
veth9a: 999     99    0    0    0     0          0         0      999      99    0    0    0     0       0          0
docker0: 888    88    0    0    0     0          0         0      888      88    0    0    0     0       0          0`

func TestParseProcNetDev(t *testing.T) {
	if n := ParseProcNetDev(procNetDev); n != (NetReading{1500, 2700}) {
		t.Fatalf("%+v", n)
	}
	for _, s := range []string{"", "Inter-|  Receive\n face |bytes"} {
		if n := ParseProcNetDev(s); n != (NetReading{}) {
			t.Fatalf("%q → %+v", s, n)
		}
	}
}

func TestCPUPercent(t *testing.T) {
	cases := []struct {
		prev *CPUTimes
		cur  CPUTimes
		load *float64
		want *float64
	}{
		{&CPUTimes{1000, 800}, CPUTimes{2000, 1300}, nil, f(50)},
		{nil, CPUTimes{10, 5}, f(42), f(42)},
		{nil, CPUTimes{10, 5}, nil, nil},
		{&CPUTimes{5000, 4000}, CPUTimes{1000, 900}, f(7), f(7)},
		{&CPUTimes{0, 0}, CPUTimes{100, 0}, nil, f(100)},
	}
	for i, c := range cases {
		got := CPUPercent(c.prev, c.cur, c.load)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("case %d: %v", i, got)
		}
	}
}

func TestToSample(t *testing.T) {
	base := HostReading{CPU: CPUTimes{2000, 1000}, Mem: Usage{4000, 8000}, Disk: &Usage{50, 100}, Net: &NetReading{10, 20}, LoadPercent: f(33)}
	s := ToSample(base, &CPUTimes{1000, 800})
	if s.MemUsedBytes != 4000 || s.MemTotalBytes != 8000 || *s.DiskUsedBytes != 50 || *s.DiskTotalBytes != 100 ||
		*s.NetRxBytes != 10 || *s.NetTxBytes != 20 || *s.CPUPercent != 80 {
		t.Fatalf("%+v", s)
	}
	base.Disk, base.Net = nil, nil
	s = ToSample(base, nil)
	if s.DiskUsedBytes != nil || s.DiskTotalBytes != nil || s.NetRxBytes != nil || s.NetTxBytes != nil || *s.CPUPercent != 33 {
		t.Fatalf("degraded %+v", s)
	}
}

func TestRealReaders(t *testing.T) {
	r := ReadHost(t.TempDir())
	if r.CPU.TotalMs < 0 || r.CPU.IdleMs < 0 || r.Mem.UsedBytes < 0 {
		t.Fatalf("%+v", r)
	}
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
		if r.Mem.TotalBytes <= 0 || r.Disk == nil || r.Disk.TotalBytes <= 0 {
			t.Fatalf("mem/disk unreadable: %+v", r)
		}
	}
	if runtime.GOOS != "linux" && r.Net != nil {
		t.Fatal("net must be nil off Linux")
	}
	if readDisk("/definitely/not/here") != nil {
		t.Fatal("readDisk on a missing dir must be nil")
	}
}

// ---------------------------------------------------------------------------
// metrics-history.service.spec.ts
// ---------------------------------------------------------------------------

const hour = int64(3_600_000)
const day = 24 * hour

func utc(y int, m time.Month, d, h, min int) int64 {
	return time.Date(y, m, d, h, min, 0, 0, time.UTC).UnixMilli()
}

func build(t *testing.T, env map[string]string) (*Service, *sql.DB) {
	_, global, dir := testutil.Store(t)
	s := New(global, dir, func(k string) string { return env[k] }, testutil.Log())
	s.Init(context.Background())
	return s, global
}

type ins struct {
	ts                                    int64
	cpu, memU, memT, diskU, diskT, rx, tx any
}

func insert(t *testing.T, g *sql.DB, r ins) {
	testutil.Exec(t, g, `INSERT INTO resource_samples (ts, cpu_pct, mem_used_bytes, mem_total_bytes, disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes) VALUES (?,?,?,?,?,?,?,?)`,
		r.ts, r.cpu, r.memU, r.memT, r.diskU, r.diskT, r.rx, r.tx)
}

func count(t *testing.T, g *sql.DB) int {
	var n int
	if err := g.QueryRow("SELECT COUNT(*) FROM resource_samples").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestBucketFor(t *testing.T) {
	now := time.Date(2026, 1, 15, 10, 37, 42, 5e8, time.UTC).UnixMilli()
	if b := BucketFor(now); b != utc(2026, 1, 15, 10, 0) || b%hour != 0 {
		t.Fatalf("%d", b)
	}
}

func TestSampleUpsertsHourRow(t *testing.T) {
	s, g := build(t, nil)
	s.Read = func(string) HostReading {
		return HostReading{CPU: CPUTimes{2000, 1000}, Mem: Usage{4000, 8000}, LoadPercent: f(12.5)}
	}
	now := utc(2026, 1, 15, 10, 30)
	res := s.Sample(context.Background(), now)
	if res == nil || count(t, g) != 1 {
		t.Fatal("no row")
	}
	var ts, memT int64
	var cpu sql.NullFloat64
	var disk sql.NullInt64
	var created string
	if err := g.QueryRow("SELECT ts, mem_total_bytes, cpu_pct, disk_used_bytes, created_at FROM resource_samples").Scan(&ts, &memT, &cpu, &disk, &created); err != nil {
		t.Fatal(err)
	}
	if ts != BucketFor(now) || memT != 8000 || cpu.Float64 != 12.5 || disk.Valid || created == "" {
		t.Fatalf("row %d %d %v %v %q", ts, memT, cpu, disk, created)
	}
	var typ string
	_ = g.QueryRow("SELECT typeof(mem_total_bytes) FROM resource_samples").Scan(&typ)
	if typ != "integer" {
		t.Fatalf("mem_total_bytes stored as %s", typ)
	}

	tt := utc(2026, 1, 15, 10, 5)
	s.Sample(context.Background(), tt+20*60*1000)
	if count(t, g) != 1 {
		t.Fatal("same hour must upsert")
	}
	s.Sample(context.Background(), tt+hour)
	if count(t, g) != 2 {
		t.Fatal("next hour adds a row")
	}
	// The 2nd sample used the 1st reading as CPU baseline: identical
	// cumulative times → zero delta → load fallback.
}

func TestPrune(t *testing.T) {
	s, g := build(t, nil)
	now := utc(2026, 1, 31, 12, 0)
	for _, d := range []int64{40, 10, 1} {
		insert(t, g, ins{ts: now - d*day, memU: 1, memT: 2})
	}
	if n := s.Prune(context.Background(), now); n != 1 || count(t, g) != 2 {
		t.Fatalf("pruned %d", n)
	}
	var oldest int64
	_ = g.QueryRow("SELECT MIN(ts) FROM resource_samples").Scan(&oldest)
	if oldest != now-10*day {
		t.Fatal("wrong row pruned")
	}

	s0, g0 := build(t, map[string]string{"STREAMHUB_METRICS_HISTORY_RETENTION_DAYS": "0"})
	insert(t, g0, ins{ts: now - 400*day, memU: 1, memT: 2})
	if s0.Settings.RetentionDays != 0 || s0.Prune(context.Background(), now) != 0 || count(t, g0) != 1 {
		t.Fatal("retention 0 must disable pruning")
	}
}

func jsonOf(t *testing.T, v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestHistory(t *testing.T) {
	s, g := build(t, nil)
	t0 := utc(2026, 1, 15, 8, 0)
	insert(t, g, ins{t0, 12, 40, 100, 25, 50, 100, 10})
	insert(t, g, ins{t0 + hour, 30, 60, 100, 30, 50, 300, 30})
	insert(t, g, ins{t0 + 2*hour, 45, 80, 100, 40, 50, 700, 90})
	res := s.History(context.Background(), "30d", "", t0+2*hour+1)
	if res.Range != "30d" || res.RetentionDays != 30 || res.BucketMs != hour {
		t.Fatalf("%+v", res)
	}
	if got := jsonOf(t, res.Series.CPU); got != `[{"ts":1768464000000,"value":12},{"ts":1768467600000,"value":30},{"ts":1768471200000,"value":45}]` {
		t.Fatalf("cpu %s", got)
	}
	if got := jsonOf(t, (*res.Series.Mem)[0]); got != `{"ts":1768464000000,"used":40,"total":100,"pct":40}` {
		t.Fatalf("mem %s", got)
	}
	if got := jsonOf(t, (*res.Series.Disk)[2]); got != `{"ts":1768471200000,"value":80}` {
		t.Fatalf("disk %s", got)
	}
	if got := jsonOf(t, res.Series.Net); got != `[{"ts":1768464000000,"rx":null,"tx":null},{"ts":1768467600000,"rx":200,"tx":20},{"ts":1768471200000,"rx":400,"tx":60}]` {
		t.Fatalf("net %s", got)
	}

	s2, g2 := build(t, nil)
	insert(t, g2, ins{ts: t0, rx: 5000, tx: 5000})
	insert(t, g2, ins{ts: t0 + hour, rx: 100, tx: 100})
	if got := jsonOf(t, s2.History(context.Background(), "24h", "net", t0+hour+1).Series); got != `{"net":[{"ts":1768464000000,"rx":null,"tx":null},{"ts":1768467600000,"rx":null,"tx":null}]}` {
		t.Fatalf("reset %s", got)
	}
}

func TestHistoryFilterWindowNulls(t *testing.T) {
	s, g := build(t, nil)
	t0 := utc(2026, 1, 15, 8, 0)
	insert(t, g, ins{ts: t0, cpu: 20, memU: 1, memT: 2, rx: 1, tx: 1})
	if got := jsonOf(t, s.History(context.Background(), "24h", "cpu", t0+1).Series); got != `{"cpu":[{"ts":1768464000000,"value":20}]}` {
		t.Fatalf("filter %s", got)
	}

	s, g = build(t, nil)
	now := utc(2026, 1, 31, 12, 0)
	insert(t, g, ins{ts: now - 10*day, cpu: 1})
	insert(t, g, ins{ts: now - 2*hour, cpu: 2})
	if cpu := *s.History(context.Background(), "24h", "cpu", now).Series.CPU; len(cpu) != 1 || cpu[0].Ts != now-2*hour {
		t.Fatalf("window %+v", cpu)
	}

	s, g = build(t, nil)
	insert(t, g, ins{ts: t0, cpu: 5, memU: 1, memT: 2})
	res := s.History(context.Background(), "24h", "", t0+1)
	if jsonOf(t, (*res.Series.Disk)[0]) != `{"ts":1768464000000,"value":null}` || jsonOf(t, (*res.Series.Net)[0]) != `{"ts":1768464000000,"rx":null,"tx":null}` ||
		jsonOf(t, (*res.Series.Mem)[0]) != `{"ts":1768464000000,"used":1,"total":2,"pct":50}` {
		t.Fatalf("nulls %s", jsonOf(t, res.Series))
	}
	if r := s.History(context.Background(), "bogus", "", t0+1); r.Range != "30d" {
		t.Fatalf("unknown range → %s", r.Range)
	}
	empty, _ := build(t, nil)
	if got := jsonOf(t, empty.History(context.Background(), "7d", "", 0).Series); got != `{"cpu":[],"mem":[],"disk":[],"net":[]}` {
		t.Fatalf("empty %s", got)
	}
}

func TestNewestSampleAge(t *testing.T) {
	s, g := build(t, nil)
	if _, ok := s.NewestSampleAge(context.Background(), 1000); ok {
		t.Fatal("empty table must be Infinity")
	}
	insert(t, g, ins{ts: 1000})
	insert(t, g, ins{ts: 4000})
	if age, ok := s.NewestSampleAge(context.Background(), 10_000); !ok || age != 6000 {
		t.Fatalf("%d %v", age, ok)
	}
}

// ---------------------------------------------------------------------------
// metrics-history-settings + scheduler spec
// ---------------------------------------------------------------------------

func TestSettings(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want Settings
	}{
		{nil, Settings{true, 30, "0 * * * *"}},
		{map[string]string{"STREAMHUB_METRICS_HISTORY_ENABLED": " OFF "}, Settings{false, 30, DefaultCron}},
		{map[string]string{"STREAMHUB_METRICS_HISTORY_ENABLED": "garbage"}, Settings{true, 30, DefaultCron}},
		{map[string]string{"STREAMHUB_METRICS_HISTORY_RETENTION_DAYS": "7days"}, Settings{true, 7, DefaultCron}},
		{map[string]string{"STREAMHUB_METRICS_HISTORY_RETENTION_DAYS": "-3"}, Settings{true, 30, DefaultCron}},
		{map[string]string{"STREAMHUB_METRICS_HISTORY_RETENTION_DAYS": "x"}, Settings{true, 30, DefaultCron}},
		{map[string]string{"STREAMHUB_METRICS_HISTORY_CRON": "not a cron"}, Settings{true, 30, DefaultCron}},
		{map[string]string{"STREAMHUB_METRICS_HISTORY_CRON": " 0 */2 * * * "}, Settings{true, 30, "0 */2 * * *"}},
		{map[string]string{"STREAMHUB_METRICS_HISTORY_CRON": "0 0 * * * *"}, Settings{true, 30, "0 0 * * * *"}},
	}
	for i, c := range cases {
		if got := ResolveSettings(func(k string) string { return c.env[k] }); got != c.want {
			t.Errorf("case %d: %+v", i, got)
		}
	}
	for _, expr := range []string{DefaultCron, "0 0 * * * *", "*/5 * * * *"} {
		if _, err := cronParser.Parse(expr); err != nil {
			t.Errorf("%s: %v", expr, err)
		}
	}
}

func TestSchedulerCatchUpAndDisabled(t *testing.T) {
	s, g := build(t, nil)
	s.Read = func(string) HostReading { return HostReading{Mem: Usage{1, 2}} }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx) // empty table → stale → catch-up sample
	deadline := time.Now().Add(2 * time.Second)
	for count(t, g) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if count(t, g) != 1 {
		t.Fatal("no catch-up sample at boot")
	}

	off, g2 := build(t, map[string]string{"STREAMHUB_METRICS_HISTORY_ENABLED": "false"})
	off.Start(ctx)
	time.Sleep(50 * time.Millisecond)
	if count(t, g2) != 0 {
		t.Fatal("disabled sampler wrote a row")
	}
}

// ---------------------------------------------------------------------------
// metrics-history.controller.spec.ts
// ---------------------------------------------------------------------------

func TestControllerScope(t *testing.T) {
	s, _ := build(t, nil)
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	s.Register(a)
	h := httpx.WithRequest(mux)
	get := func(target string, p *auth.Principal) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", target, nil)
		if p != nil {
			r = r.WithContext(auth.WithPrincipal(r.Context(), p))
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	global := &auth.Principal{Scope: auth.ScopeGlobal}
	w := get("/api/v1/system/metrics/history", global)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"range":"30d"`) || !strings.HasSuffix(strings.TrimSpace(w.Body.String()), `"error":null}`) {
		t.Fatalf("global %d %s", w.Code, w.Body)
	}
	if w := get("/api/v1/system/metrics/history", &auth.Principal{Scope: "app", IsSuperadmin: true}); w.Code != 200 {
		t.Fatalf("superadmin %d", w.Code)
	}
	w = get("/api/v1/system/metrics/history", &auth.Principal{Scope: "app"})
	if w.Code != 403 || !strings.Contains(w.Body.String(), api.GlobalScopeMessage) {
		t.Fatalf("app scope %d %s", w.Code, w.Body)
	}
	if w := get("/api/v1/system/metrics/history", nil); w.Code != 200 {
		t.Fatalf("no auth bound %d", w.Code)
	}
	w = get("/api/v1/system/metrics/history?metric=net&range=7d", global)
	if !strings.Contains(w.Body.String(), `"series":{"net":[]}`) || !strings.Contains(w.Body.String(), `"range":"7d"`) {
		t.Fatalf("metric filter %s", w.Body)
	}
	w = get("/api/v1/system/metrics/history?metric=bogus&range=1y", global)
	if !strings.Contains(w.Body.String(), `"series":{"cpu":[],"mem":[],"disk":[],"net":[]}`) || !strings.Contains(w.Body.String(), `"range":"30d"`) {
		t.Fatalf("defaults %s", w.Body)
	}
}
