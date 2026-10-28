package logs

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// Ports logs.service.spec.ts, app-logs.controller.spec.ts,
// rotating-file-stream.spec.ts and app-log.service.spec.ts.

func boot(t *testing.T, retentionDays int) (*Service, *sql.DB, string) {
	t.Helper()
	_, g, dir := testutil.Store(t)
	s := New(&config.Config{DataDir: dir, LogRetentionDays: retentionDays}, g, testutil.Log())
	t.Cleanup(s.file.Close)
	return s, g, dir
}

func seedApp(t *testing.T, g *sql.DB, name string) int64 {
	t.Helper()
	res, err := g.Exec(`INSERT INTO apps (name) VALUES (?)`, name)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func latestAppID(t *testing.T, g *sql.DB) *int64 {
	t.Helper()
	var id sql.NullInt64
	if err := g.QueryRow(`SELECT app_id FROM server_logs ORDER BY id DESC LIMIT 1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if !id.Valid {
		return nil
	}
	return &id.Int64
}

func ptr[T any](v T) *T { return &v }

func TestWriteAttribution(t *testing.T) {
	t.Run("resolves meta.app → app_id and caches the lookup", func(t *testing.T) {
		s, g, _ := boot(t, 30)
		live := seedApp(t, g, "live")
		s.Write("info", "test", "first", map[string]any{"app": "live"}, nil)
		if got := latestAppID(t, g); got == nil || *got != live {
			t.Fatalf("first: %v", got)
		}
		// Rename the app: a cached lookup still attributes to the old id.
		testutil.Exec(t, g, `UPDATE apps SET name = 'renamed' WHERE id = ?`, live)
		s.Write("info", "test", "second", map[string]any{"app": "live"}, nil)
		if got := latestAppID(t, g); got == nil || *got != live {
			t.Fatalf("second write missed the cache: %v", got)
		}
	})
	t.Run("explicit appId wins over meta.app", func(t *testing.T) {
		s, g, _ := boot(t, 30)
		seedApp(t, g, "live")
		other := seedApp(t, g, "other")
		s.Write("info", "test", "m", map[string]any{"app": "live"}, &other)
		if got := latestAppID(t, g); got == nil || *got != other {
			t.Fatalf("got %v", got)
		}
	})
	t.Run("unknown meta.app → NULL, miss cached", func(t *testing.T) {
		s, g, _ := boot(t, 30)
		s.Write("info", "test", "one", map[string]any{"app": "ghost"}, nil)
		if latestAppID(t, g) != nil {
			t.Fatal("want NULL")
		}
		seedApp(t, g, "ghost") // the cached miss must still win
		s.Write("info", "test", "two", map[string]any{"app": "ghost"}, nil)
		if latestAppID(t, g) != nil {
			t.Fatal("miss was not cached")
		}
	})
	t.Run("struct meta is attributed too", func(t *testing.T) {
		s, g, _ := boot(t, 30)
		live := seedApp(t, g, "live")
		s.Write("info", "test", "m", struct {
			App string `json:"app"`
		}{"live"}, nil)
		if got := latestAppID(t, g); got == nil || *got != live {
			t.Fatalf("got %v", got)
		}
	})
	t.Run("no meta.app → NULL", func(t *testing.T) {
		s, g, _ := boot(t, 30)
		s.Write("info", "test", "no app here", nil, nil)
		if latestAppID(t, g) != nil {
			t.Fatal("want NULL")
		}
	})
	t.Run("invalid level → info, empty source → app, meta_json as JSON.stringify", func(t *testing.T) {
		s, g, _ := boot(t, 30)
		s.Write("loud", "", "x", map[string]any{"html": "<b>&"}, nil)
		var lvl, src, meta string
		if err := g.QueryRow(`SELECT level, source, meta_json FROM server_logs ORDER BY id DESC LIMIT 1`).Scan(&lvl, &src, &meta); err != nil {
			t.Fatal(err)
		}
		if lvl != "info" || src != "app" || meta != `{"html":"<b>&"}` {
			t.Fatalf("%s %s %s", lvl, src, meta)
		}
	})
}

func TestQueryFilters(t *testing.T) {
	ctx := context.Background()
	messages := func(es []Entry) []string {
		out := []string{}
		for _, e := range es {
			out = append(out, e.Message)
		}
		return out
	}
	s, _, _ := boot(t, 30)
	s.Write("info", "alpha", "from alpha", nil, nil)
	s.Write("info", "beta", "from beta", nil, nil)
	s.Write("info", "test", "progress 100% done", nil, nil)
	s.Write("info", "test", "progress 1000 done", nil, nil)
	s.Write("error", "egress", "egress_ended room=a", nil, nil)
	s.Write("error", "egress", "egress_started room=a", nil, nil)
	s.Write("info", "egress", "egress_ended room=b", nil, nil)

	cases := []struct {
		name string
		f    Filters
		want []string
	}{
		{"exact source", Filters{Source: "alpha"}, []string{"from alpha"}},
		{"q escapes LIKE metacharacters", Filters{Q: "100%"}, []string{"progress 100% done"}},
		{"source + q + level", Filters{Source: "egress", Q: "ended", Level: "error"}, []string{"egress_ended room=a"}},
		{"invalid level is ignored", Filters{Source: "alpha", Level: "loud"}, []string{"from alpha"}},
		{"newest first + limit/offset", Filters{Source: "egress", Limit: ptr(1), Offset: ptr(1)}, []string{"egress_started room=a"}},
		{"limit clamps to ≥1", Filters{Source: "egress", Limit: ptr(0)}, []string{"egress_ended room=b"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := messages(s.Query(ctx, c.f)); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
	if n := s.Count(ctx, Filters{Source: "egress", Limit: ptr(1)}); n != 3 {
		t.Fatalf("count ignores limit: %d", n)
	}
}

func TestAppDataScope(t *testing.T) {
	ctx := context.Background()
	s, g, _ := boot(t, 0)
	seedApp(t, g, "live")
	seedApp(t, g, "other")
	s.Write("info", "stream", "live event", map[string]any{"app": "live"}, nil)
	s.Write("info", "stream", "other event", map[string]any{"app": "other"}, nil)
	s.Write("info", "stream", "global event", nil, nil)

	live := s.page(ctx, Filters{App: "live"})
	if live.Total != 1 || len(live.Data) != 1 || live.Data[0].Message != "live event" || live.Limit != 100 || live.Offset != 0 {
		t.Fatalf("live page: %+v", live)
	}
	other := s.page(ctx, Filters{App: "other"})
	if len(other.Data) != 1 || other.Data[0].Message != "other event" {
		t.Fatalf("other page leaks: %+v", other)
	}
}

func TestPurgeOldLogs(t *testing.T) {
	insertAt := func(g *sql.DB, ts, msg string) {
		testutil.Exec(t, g, `INSERT INTO server_logs (ts, level, source, app_id, message, meta_json) VALUES (?, 'info', 'seed', NULL, ?, NULL)`, ts, msg)
	}
	count := func(g *sql.DB, where string) int {
		var n int
		_ = g.QueryRow(`SELECT COUNT(*) FROM server_logs WHERE ` + where).Scan(&n)
		return n
	}
	t.Run("deletes rows older than the window, keeps recent", func(t *testing.T) {
		s, g, _ := boot(t, 30)
		insertAt(g, "2000-01-01T00:00:00.000Z", "old row 1")
		insertAt(g, "2000-06-01T00:00:00.000Z", "old row 2")
		s.Write("info", "test", "recent row", nil, nil)
		if n := s.PurgeOldLogs(); n != 2 {
			t.Fatalf("deleted %d", n)
		}
		if count(g, `message LIKE 'old row%'`) != 0 || count(g, `message = 'recent row'`) != 1 {
			t.Fatal("wrong rows left")
		}
		if count(g, `message = 'purged 2 expired log rows'`) != 1 {
			t.Fatal("purge not self-logged")
		}
	})
	t.Run("no-op when retention is 0", func(t *testing.T) {
		s, g, _ := boot(t, 0)
		insertAt(g, "2000-01-01T00:00:00.000Z", "old row")
		if n := s.PurgeOldLogs(); n != 0 || count(g, "1=1") != 1 {
			t.Fatalf("deleted %d", n)
		}
	})
}

func TestFileSinkLine(t *testing.T) {
	s, _, dir := boot(t, 30)
	fixed := time.Date(2026, 7, 1, 12, 0, 0, 5e6, time.UTC)
	s.now = func() time.Time { return fixed }
	s.Write("warn", "src", "hello", struct {
		B int    `json:"b"`
		A string `json:"a"`
	}{1, "<x>"}, ptr(int64(7)))
	s.file.Close()
	raw, err := os.ReadFile(filepath.Join(dir, "logs", "streamhub.log"))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"ts":"2026-07-01T12:00:00.005Z","level":"warn","source":"src","appId":7,"message":"hello","meta":{"b":1,"a":"<x>"}}` + "\n"
	if string(raw) != want {
		t.Fatalf("got %q", raw)
	}
}

// ---- rotating file ----------------------------------------------------

func makeFile(t *testing.T, dir, name string, ageDays float64) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-time.Duration(ageDays * float64(24*time.Hour)))
	if err := os.Chtimes(p, when, when); err != nil {
		t.Fatal(err)
	}
}

func listDir(t *testing.T, dir string) []string {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	out := []string{}
	for _, e := range entries {
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out
}

func TestRotatingRetention(t *testing.T) {
	t.Run("age sweep across both prefixes, active never swept", func(t *testing.T) {
		dir := t.TempDir()
		makeFile(t, dir, "streamhub-2020-01-01T00-00-00-000Z.log", 40)
		makeFile(t, dir, "skyline-2020-02-01T00-00-00-000Z.log", 40)
		makeFile(t, dir, "streamhub-2026-06-30T00-00-00-000Z.log", 1)
		makeFile(t, dir, "streamhub.log", 0)
		NewRotatingFile(RotationOptions{Dir: dir, BaseName: "streamhub", LegacyBaseNames: []string{"skyline"}, MaxFiles: 100, MaxAgeDays: 30}).Sweep()
		if got := listDir(t, dir); !reflect.DeepEqual(got, []string{"streamhub-2026-06-30T00-00-00-000Z.log", "streamhub.log"}) {
			t.Fatal(got)
		}
	})
	t.Run("count cap keeps the newest maxFiles", func(t *testing.T) {
		dir := t.TempDir()
		makeFile(t, dir, "streamhub-a.log", 4)
		makeFile(t, dir, "streamhub-b.log", 3)
		makeFile(t, dir, "streamhub-c.log", 2)
		makeFile(t, dir, "streamhub-d.log", 1)
		NewRotatingFile(RotationOptions{Dir: dir, BaseName: "streamhub", MaxFiles: 2}).Sweep()
		if got := listDir(t, dir); !reflect.DeepEqual(got, []string{"streamhub-c.log", "streamhub-d.log"}) {
			t.Fatal(got)
		}
	})
	t.Run("nothing deleted when both caps hold", func(t *testing.T) {
		dir := t.TempDir()
		makeFile(t, dir, "streamhub-x.log", 1)
		makeFile(t, dir, "streamhub.log", 0)
		NewRotatingFile(RotationOptions{Dir: dir, BaseName: "streamhub", MaxFiles: 10, MaxAgeDays: 30}).Sweep()
		if got := listDir(t, dir); len(got) != 2 {
			t.Fatal(got)
		}
	})
}

func TestRotationBySizeAndDay(t *testing.T) {
	dir := t.TempDir()
	r := NewRotatingFile(RotationOptions{Dir: dir, BaseName: "app", MaxBytes: 20})
	now := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return now }
	r.Write("0123456789\n") // 11 bytes
	now = now.Add(time.Millisecond)
	r.Write("0123456789\n") // would be 22 > 20 → rotate first
	now = now.Add(24 * time.Hour)
	r.Write("x\n") // day changed → rotate again
	r.Close()
	got := listDir(t, dir)
	want := []string{"app-2026-07-01T10-00-00-001Z.log", "app-2026-07-02T10-00-00-001Z.log", "app.log"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestAppLog(t *testing.T) {
	t.Setenv("LOG_MAX_BYTES", "200")
	dir := t.TempDir()
	a := NewAppLog(dir, 30)
	for i := 0; i < 30; i++ {
		a.Record("live", map[string]any{"source": "test", "i": i, "msg": strings.Repeat("x", 60)})
		// each rotation needs a distinct ms stamp
		time.Sleep(2 * time.Millisecond)
	}
	a.Line("live", "a raw line")
	a.Record("alpha", struct {
		M  int    `json:"m"`
		Ts string `json:"ts"`
	}{1, "own"})
	a.Record("beta", map[string]any{"m": 2})
	a.Close()

	files := listDir(t, filepath.Join(dir, "apps", "live", "logs"))
	archives := 0
	for _, f := range files {
		if strings.HasPrefix(f, "app-") && strings.HasSuffix(f, ".log") {
			archives++
		}
	}
	if archives == 0 || !contains(files, "app.log") {
		t.Fatalf("no rotation: %v", files)
	}
	active, _ := os.ReadFile(filepath.Join(dir, "apps", "live", "logs", "app.log"))
	if !strings.Contains(string(active), "a raw line\n") {
		t.Fatal("raw line not verbatim")
	}
	alpha, _ := os.ReadFile(filepath.Join(dir, "apps", "alpha", "logs", "app.log"))
	if string(alpha) != `{"ts":"own","m":1}`+"\n" {
		t.Fatalf("own ts must stay first: %q", alpha)
	}
	beta, _ := os.ReadFile(filepath.Join(dir, "apps", "beta", "logs", "app.log"))
	if !strings.HasPrefix(string(beta), `{"ts":"20`) || !strings.HasSuffix(string(beta), `,"m":2}`+"\n") {
		t.Fatalf("ts not stamped first: %q", beta)
	}
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// ---- query DTO ----------------------------------------------------------

func TestParseQuery(t *testing.T) {
	cases := []struct {
		name    string
		query   string
		withApp bool
		want    []string // nil = valid
	}{
		{"empty", "", true, nil},
		{"all valid", "app=live&level=warn&since=2026-06-30T00:00:00.000Z&until=2026-06-30&source=s&q=x&limit=5&offset=0", true, nil},
		{"app ignored on the per-app DTO", "app=" + strings.Repeat("a", 65), false, nil},
		{"bad level", "level=loud", true, []string{"level must be one of the following values: trace, debug, info, warn, error, fatal"}},
		{"limit NaN", "limit=abc", true, []string{"limit must not be greater than 1000", "limit must not be less than 1", "limit must be an integer number"}},
		{"limit hex is a number", "limit=0x10", true, nil},
		{"offset negative", "offset=-1", true, []string{"offset must not be less than 0"}},
		{"dates", "since=nope&until=2026-13-01", true, []string{"since must be a valid ISO 8601 date string", "until must be a valid ISO 8601 date string"}},
		{"app first", "level=x&app=" + strings.Repeat("a", 65), true, []string{"app must be shorter than or equal to 64 characters", "level must be one of the following values: trace, debug, info, warn, error, fatal"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			q, _ := url.ParseQuery(c.query)
			_, err := parseQuery(q, c.withApp)
			if c.want == nil {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			he, ok := err.(*httpx.Error)
			if !ok {
				t.Fatalf("want validation error, got %v", err)
			}
			if got := he.Body.(httpx.NestBody).Message; !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v", got)
			}
		})
	}
}

// validator.js isISO8601 (default options) vectors, checked against Node:
// node -e 'const v=require("validator"); console.log(valid.filter(s=>!v.isISO8601(s)), invalid.filter(v.isISO8601))'
// (run from streamhub-core/ with the two arrays below) prints [] [].
func TestISO8601(t *testing.T) {
	valid := []string{"2009-12T12:34", "2009", "2009-05-19", "20090519", "2009123", "2009-05", "2009-123", "2009-222",
		"2009-001", "2009-W01-1", "2009-W51-1", "2009-W511", "2009-W33", "2009W511", "2009-05-19T14:39Z",
		"2009-W21-2T01:22", "2009-139", "2007-04-06T00:00", "2007-04-05T24:00", "2010-02-18T16:23:48.5",
		"2010-02-18T16:23:48,444", "2010-02-18T16:23:48,3-06:00", "2010-02-18T16:23.4", "2009-05-19 143922.500",
		"2009-05-19 1439,55", "2009-10-10", "2020-366", "2000-366", "2026-02-30"}
	invalid := []string{"200905", "2009367", "2009-", "2007-04-05T24:50", "2009-000", "2009-M511", "2009M511",
		"2009-05-19T14a39r", "2009-05-19T14:3924", "2009-0519", "2009-05-1914:39", "2009-05-19 14:",
		"2009-05-19r14:39", "2009-05-19 14a39a22", "200912-01", "2009-05-19 14:39:22+06a00", "2009-05-19 146922.500",
		"2010-02-18T16.5:23.35:48", "2010-02-18T16:23.35:48", "2010-02-18T16:23.35:48.45", "2009-05-19 14.5.44",
		"2010-02-18T16:23.33.600", "2010-02-18T16,25:23:48,444", "2010-13-1", "nonsense2021-01-01T00:00:00Z", ""}
	for _, s := range valid {
		if !isISO8601(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range invalid {
		if isISO8601(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
}
