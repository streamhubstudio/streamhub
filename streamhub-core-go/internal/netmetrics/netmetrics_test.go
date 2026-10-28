package netmetrics

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

var (
	now    = time.Date(2026, 7, 11, 14, 30, 0, 0, time.UTC)
	bucket = "2026-07-11T14"
	bg     = context.Background()
)

type logs struct {
	mu    sync.Mutex
	lines []string
}

func (l *logs) Write(level, source, message string, _ map[string]any) {
	l.mu.Lock()
	l.lines = append(l.lines, level+" "+source+" "+message)
	l.mu.Unlock()
}

type mtx struct {
	body string
	err  error
	urls []string
}

func (m *mtx) RoundTrip(r *http.Request) (*http.Response, error) {
	m.urls = append(m.urls, r.URL.String())
	if m.err != nil {
		return nil, m.err
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(m.body)), Header: http.Header{}}, nil
}

func newSvc(t *testing.T) (*Service, func(string) *sql.DB, *mtx) {
	store, _, _ := testutil.Store(t)
	s := New(store.App, true, "http://mtx.test/", &logs{})
	m := &mtx{}
	s.HTTP = &http.Client{Transport: m}
	return s, func(app string) *sql.DB {
		h, err := store.App(bg, app)
		if err != nil {
			t.Fatal(err)
		}
		return h
	}, m
}

type sample struct {
	Bucket, Direction, Source string
	Bytes                     int64
}

func rows(t *testing.T, db *sql.DB) []sample {
	r, err := db.Query("SELECT bucket, direction, source, bytes FROM net_samples ORDER BY direction, source")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	out := []sample{}
	for r.Next() {
		var s sample
		if err := r.Scan(&s.Bucket, &s.Direction, &s.Source, &s.Bytes); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	if string(g) != string(w) {
		t.Fatalf("\n got %s\nwant %s", g, w)
	}
}

// ---------------------------------------------------------------------------
// net-bucket.util.spec.ts
// ---------------------------------------------------------------------------

func TestBuckets(t *testing.T) {
	if HourBucket(time.Date(2026, 7, 11, 14, 37, 5, 0, time.UTC)) != "2026-07-11T14" ||
		HourBucket(time.Date(2026, 1, 2, 3, 59, 59, 999e6, time.UTC)) != "2026-01-02T03" {
		t.Fatal("hourBucket")
	}
	base := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)
	if HourBucket(base) != HourBucket(base.Add(59*time.Minute)) || HourBucket(base.Add(time.Hour)) != "2026-01-01T10" {
		t.Fatal("hour boundary")
	}
	if HourBucket(time.Date(2026, 1, 1, 9, 0, 0, 0, time.FixedZone("x", -3*3600))) != "2026-01-01T12" {
		t.Fatal("bucket must be UTC")
	}
	if WindowStartBucket(now, 24) != "2026-07-10T14" || WindowStartBucket(now, 1) != "2026-07-11T13" ||
		WindowStartBucket(time.Date(2026, 7, 11, 14, 0, 0, 0, time.UTC), -5) != "2026-07-11T14" {
		t.Fatal("windowStartBucket")
	}
	if GBToBytes(1) != GBBytes || GBToBytes(2) != 2*GBBytes || GBToBytes(0) != 0 || GBToBytes(-3) != 0 || GBToBytes(math.NaN()) != 0 {
		t.Fatal("gbToBytes")
	}
}

// ---------------------------------------------------------------------------
// net-metrics.service.spec.ts
// ---------------------------------------------------------------------------

func TestRecordAndFlush(t *testing.T) {
	s, db, _ := newSvc(t)
	s.RecordBytes("live", "out", "hls", 1000)
	s.RecordBytes("live", "out", "hls", 500)
	s.RecordBytes("live", "in", "mediamtx", 200)
	s.FlushOnce(bg, now)
	eq(t, rows(t, db("live")), []sample{{bucket, "in", "mediamtx", 200}, {bucket, "out", "hls", 1500}})

	s.RecordBytes("live", "out", "hls", 250)
	s.FlushOnce(bg, now)
	s.FlushOnce(bg, now) // nothing pending
	eq(t, rows(t, db("live")), []sample{{bucket, "in", "mediamtx", 200}, {bucket, "out", "hls", 1750}})

	for _, b := range []int64{0, -5} {
		s.RecordBytes("other", "out", "hls", b)
	}
	s.RecordBytes("", "out", "hls", 10)
	s.RecordBytes("other", "out", "", 10)
	s.FlushOnce(bg, now)
	eq(t, rows(t, db("other")), []sample{})

	s.CountHLS("cdn", 4096)
	s.FlushOnce(bg, now)
	eq(t, rows(t, db("cdn")), []sample{{bucket, "out", "hls", 4096}})
}

func TestFlushFailureReaccumulates(t *testing.T) {
	s, db, _ := newSvc(t)
	real := s.appDB
	fail := true
	s.appDB = func(ctx context.Context, app string) (*sql.DB, error) {
		if fail {
			return nil, errors.New("app db gone")
		}
		return real(ctx, app)
	}
	s.RecordBytes("live", "out", "hls", 100)
	s.FlushOnce(bg, now)
	fail = false
	s.FlushOnce(bg, now)
	eq(t, rows(t, db("live")), []sample{{bucket, "out", "hls", 100}})
}

func TestPollMediamtx(t *testing.T) {
	s, db, m := newSvc(t)
	m.body = `{"pageCount":1,"items":[{"name":"demo/cam1","bytesReceived":1000,"bytesSent":200}]}`
	s.PollMediamtxOnce(bg)
	s.FlushOnce(bg, now)
	eq(t, rows(t, db("demo")), []sample{})
	if m.urls[0] != "http://mtx.test/v3/paths/list?page=0&itemsPerPage=100" {
		t.Fatalf("url %s", m.urls[0])
	}
	m.body = `{"pageCount":1,"items":[{"name":"demo/cam1","bytesReceived":1500,"bytesSent":250}]}`
	s.PollMediamtxOnce(bg)
	s.FlushOnce(bg, now)
	eq(t, rows(t, db("demo")), []sample{{bucket, "in", "mediamtx", 500}, {bucket, "out", "mediamtx", 50}})

	// counter reset (republish) → the fresh cumulative is the delta
	s2, db2, m2 := newSvc(t)
	m2.body = `{"items":[{"name":"demo/cam1","bytesReceived":5000,"bytesSent":0}],"pageCount":1}`
	s2.PollMediamtxOnce(bg)
	m2.body = `{"items":[{"name":"demo/cam1","bytesReceived":300,"bytesSent":0}],"pageCount":1}`
	s2.PollMediamtxOnce(bg)
	s2.FlushOnce(bg, now)
	eq(t, rows(t, db2("demo")), []sample{{bucket, "in", "mediamtx", 300}})

	// livekit-plane paths are not app-attributable; live/ptk_ is passthrough
	s3, db3, m3 := newSvc(t)
	m3.body = `{"items":[{"name":"live/sk_abc","bytesReceived":1000,"bytesSent":1000},{"name":"live/ptk_x","bytesReceived":1,"bytesSent":1}]}`
	s3.PollMediamtxOnce(bg)
	m3.body = `{"items":[{"name":"live/sk_abc","bytesReceived":2000,"bytesSent":2000},{"name":"live/ptk_x","bytesReceived":11,"bytesSent":"6"}]}`
	s3.PollMediamtxOnce(bg)
	s3.FlushOnce(bg, now)
	eq(t, rows(t, db3("live")), []sample{{bucket, "in", "mediamtx", 10}, {bucket, "out", "mediamtx", 5}})

	// unreachable API never fails
	s4, _, m4 := newSvc(t)
	m4.err = errors.New("ECONNREFUSED")
	s4.PollMediamtxOnce(bg)

	// paging
	s5, _, m5 := newSvc(t)
	m5.body = `{"pageCount":3,"items":[]}`
	s5.PollMediamtxOnce(bg)
	if len(m5.urls) != 3 || !strings.Contains(m5.urls[2], "page=2") {
		t.Fatalf("pages %v", m5.urls)
	}
}

func TestPassthroughClassifier(t *testing.T) {
	for path, want := range map[string]string{
		"demo/cam1": "demo", "/demo/cam1": "demo", "live/ptk_abc": "live", "live/sk_abc": "", "live/a/b": "", "solo": "", "a/b/c": "",
	} {
		got, ok := passthroughApp(path)
		if got != want || ok != (want != "") {
			t.Errorf("%s → %q %v", path, got, ok)
		}
	}
}

func seed(t *testing.T, db *sql.DB, b, dir, src string, bytes int64) {
	testutil.Exec(t, db, "INSERT INTO net_samples (bucket, direction, source, bytes) VALUES (?, ?, ?, ?)", b, dir, src, bytes)
}

func TestSummaryAndHistory(t *testing.T) {
	s, db, _ := newSvc(t)
	live := db("live")
	seed(t, live, bucket, "out", "hls", 1000)
	seed(t, live, bucket, "in", "mediamtx", 400)
	seed(t, live, HourBucket(now.Add(-30*time.Hour)), "out", "hls", 5000)
	seed(t, live, HourBucket(now.Add(-240*time.Hour)), "out", "hls", 9)
	sum := s.Summary(bg, "live", now, 0)
	eq(t, sum.Today, Window{400, 1000, 1400})
	eq(t, sum.Last24h, Window{400, 1000, 1400})
	eq(t, sum.Last7d, Window{400, 6000, 6400})
	eq(t, sum.BySource, []SourceRow{{"hls", 0, 1000}, {"mediamtx", 400, 0}})
	if b, _ := json.Marshal(sum.Threshold); string(b) != `{"gbPerDay":0,"thresholdBytes":0,"usage24hBytes":1400,"percent":null,"exceeded":false}` {
		t.Fatalf("threshold %s", b)
	}

	s2, db2, _ := newSvc(t)
	seed(t, db2("live"), bucket, "out", "hls", 2*GBBytes)
	under := s2.Summary(bg, "live", now, 5)
	if under.Threshold.Exceeded || under.Threshold.ThresholdBytes != 5*GBBytes || math.Abs(*under.Threshold.Percent-40) > 0.05 {
		t.Fatalf("under %+v", under.Threshold)
	}
	over := s2.Summary(bg, "live", now, 1)
	if !over.Threshold.Exceeded || math.Abs(*over.Threshold.Percent-200) > 0.05 {
		t.Fatalf("over %+v", over.Threshold)
	}

	s3, db3, _ := newSvc(t)
	h := db3("live")
	seed(t, h, "2026-07-11T12", "in", "mediamtx", 100)
	seed(t, h, "2026-07-11T12", "out", "hls", 200)
	seed(t, h, "2026-07-11T14", "out", "hls", 300)
	eq(t, s3.History(bg, "live", 48, now), []HistoryBucket{{"2026-07-11T12", 100, 200}, {"2026-07-11T14", 0, 300}})
	eq(t, s3.History(bg, "live", 1.9, now), []HistoryBucket{{"2026-07-11T14", 0, 300}}) // floor(1.9)=1 → from T13
	eq(t, s3.History(bg, "empty", 48, now), []HistoryBucket{})
}

func TestReadThresholdGBDay(t *testing.T) {
	cases := map[string]float64{
		"network:\n  threshold_gb_day: 100\n":   100,
		"network:\n  threshold_gb_day: '2.5'\n": 2.5,
		"network:\n  threshold_gb_day: 0\n":     0,
		"network:\n  threshold_gb_day: -1\n":    0,
		"network:\n  threshold_gb_day: abc\n":   0,
		"network: nope\n":                       0,
		"name: live\n":                          0,
		"network: [\n":                          0,
	}
	for yaml, want := range cases {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(yaml), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := ReadThresholdGBDay(dir); got != want {
			t.Errorf("%q → %v, want %v", yaml, got, want)
		}
	}
	if ReadThresholdGBDay(filepath.Join(t.TempDir(), "missing")) != 0 {
		t.Error("missing file")
	}
}

// ---------------------------------------------------------------------------
// net-threshold-monitor.service.spec.ts
// ---------------------------------------------------------------------------

type fakeUsage struct{ total float64 }

func (f *fakeUsage) Summary(context.Context, string, time.Time, float64) Summary {
	return Summary{Last24h: Window{Total: int64(f.total)}}
}

type dispatcher struct {
	events   []string
	payloads []string
}

func (d *dispatcher) Dispatch(_ context.Context, _ string, event string, payload any) error {
	s, _ := yamljs.Stringify(payload)
	d.events = append(d.events, event)
	d.payloads = append(d.payloads, s)
	return nil
}

func newMonitor() (*ThresholdMonitor, *fakeUsage, *dispatcher, *float64, *error) {
	u := &fakeUsage{}
	d := &dispatcher{}
	gb := 1.0
	var listErr error
	m := &ThresholdMonitor{
		Net: u, Callbacks: d, Logs: &logs{},
		ListApps: func(context.Context) ([]contracts.AppRecord, error) {
			return []contracts.AppRecord{{Name: "live"}}, listErr
		},
		Threshold: func(string) float64 { return gb },
	}
	return m, u, d, &gb, &listErr
}

func TestThresholdMonitor(t *testing.T) {
	m, u, d, _, _ := newMonitor()
	u.total = 1.2 * GBBytes
	m.TickOnce(bg, now)
	m.TickOnce(bg, now)
	if strings.Join(d.events, ",") != "network.threshold_exceeded" {
		t.Fatalf("%v", d.events)
	}
	if d.payloads[0] != `{"usageBytes":1288490188,"thresholdBytes":1073741824,"thresholdGbDay":1,"windowHours":24}` {
		t.Fatalf("payload %s", d.payloads[0])
	}

	m, u, d, _, _ = newMonitor()
	u.total = 1.2 * GBBytes
	m.TickOnce(bg, now)
	u.total = 0.95 * GBBytes
	m.TickOnce(bg, now)
	if len(d.events) != 1 {
		t.Fatalf("flapped %v", d.events)
	}
	u.total = 0.8 * GBBytes
	m.TickOnce(bg, now)
	m.TickOnce(bg, now)
	if strings.Join(d.events, ",") != "network.threshold_exceeded,network.threshold_recovered" {
		t.Fatalf("%v", d.events)
	}

	m, u, d, _, _ = newMonitor()
	u.total = 0.5 * GBBytes
	m.TickOnce(bg, now)
	if len(d.events) != 0 {
		t.Fatal("fired below threshold")
	}

	m, u, d, gb, _ := newMonitor()
	u.total = 5 * GBBytes
	m.TickOnce(bg, now)
	*gb = 0 // threshold removed → forget, no recovered
	m.TickOnce(bg, now)
	if strings.Join(d.events, ",") != "network.threshold_exceeded" || len(m.breached) != 0 {
		t.Fatalf("%v %v", d.events, m.breached)
	}

	m, _, _, _, listErr := newMonitor()
	*listErr = errors.New("db gone")
	m.TickOnce(bg, now) // never panics
}
