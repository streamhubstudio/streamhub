package dbadmin

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// Ports db-maintenance.service.spec.ts and db-admin.controller.spec.ts
// (purge orchestration; the route gates are covered by the parity cases).

func setup(t *testing.T) (*Maintenance, *Module) {
	t.Helper()
	store, g, _ := testutil.Store(t)
	testutil.Exec(t, g, `INSERT INTO apps (name) VALUES ('live')`)
	m := NewMaintenance(store, g, testutil.Log())
	return m, New(m, nil, nil)
}

func insertVods(t *testing.T, m *Maintenance, n int) []int64 {
	t.Helper()
	h, err := m.store.App(context.Background(), "live")
	if err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for i := 0; i < n; i++ {
		res, err := h.Exec(`INSERT INTO vods (app_id, name, file_key) VALUES (1, ?, ?)`, "r.mp4", strings.Repeat("k", 2000))
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		ids = append(ids, id)
	}
	return ids
}

func table(h Health, name string) *TableHealth {
	for _, t := range h.Tables {
		if t.Name == name {
			return &t
		}
	}
	return nil
}

func TestAppHealth(t *testing.T) {
	m, _ := setup(t)
	insertVods(t, m, 2)
	h, err := m.AppHealth(context.Background(), "live")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(h.Path, "/apps/live/app.db") || h.SizeBytes <= 0 || h.PageCount <= 0 || h.FragmentationPct < 0 || h.FragmentationPct > 100 {
		t.Fatalf("%+v", h)
	}
	if v := table(h, "vods"); v == nil || v.Rows != 2 {
		t.Fatal("vods rows")
	}
	if s := table(h, "streams"); s == nil || s.Rows != 0 {
		t.Fatal("streams rows")
	}
	for _, tb := range h.Tables {
		if strings.HasPrefix(tb.Name, "sqlite_") {
			t.Fatal("internal table listed")
		}
	}
	if table(h, "vods").Bytes == nil {
		t.Fatal("dbstat bytes expected (modernc ships the dbstat vtab, as better-sqlite3)")
	}
}

func TestGlobalHealth(t *testing.T) {
	m, _ := setup(t)
	h := m.GlobalHealth(context.Background())
	if !strings.HasSuffix(h.Path, "streamhub.db") || table(h, "apps").Rows != 1 || table(h, "server_logs") == nil {
		t.Fatalf("%+v", h)
	}
}

func TestOptimize(t *testing.T) {
	m, _ := setup(t)
	ids := insertVods(t, m, 50)
	h, _ := m.store.App(context.Background(), "live")
	for _, id := range ids {
		testutil.Exec(t, h, `DELETE FROM vods WHERE id = ?`, id)
	}
	res, err := m.OptimizeApp(context.Background(), "live")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"PRAGMA optimize", "ANALYZE", "REINDEX", "VACUUM", "wal_checkpoint(TRUNCATE)"}
	if strings.Join(res.Steps, "|") != strings.Join(want, "|") {
		t.Fatalf("steps %v", res.Steps)
	}
	if res.After.FreelistCount != 0 || res.After.WalSizeBytes != 0 || res.ReclaimedBytes < 0 || res.Path != m.store.AppPath("live") {
		t.Fatalf("%+v", res)
	}
	// the pooled handle keeps working after the dedicated-connection VACUUM
	testutil.Exec(t, h, `INSERT INTO streams (app_id, stream_id, type, status) VALUES (1, 's', 'rtmp', 'ended')`)
	if g := m.OptimizeGlobal(context.Background()); len(g.Steps) != 5 || strings.Contains(strings.Join(g.Steps, ""), "skipped") {
		t.Fatalf("%+v", g)
	}
}

func TestConcurrentOptimizeSerialized(t *testing.T) {
	m, _ := setup(t)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := m.OptimizeApp(context.Background(), "live")
			if err != nil || strings.Contains(strings.Join(res.Steps, ""), "skipped") {
				t.Errorf("%v %v", err, res.Steps)
			}
		}()
	}
	wg.Wait()
}

func TestPurgeLowLevel(t *testing.T) {
	ctx := context.Background()
	m, _ := setup(t)
	h, _ := m.store.App(ctx, "live")
	testutil.Exec(t, h, `INSERT INTO streams (app_id, stream_id, type, status) VALUES (1, 'a', 'rtmp', 'ended'), (1, 'b', 'rtmp', 'ended')`)
	if n, err := m.PurgeAppStreams(ctx, "live"); err != nil || n != 2 {
		t.Fatal(n, err)
	}
	testutil.Exec(t, m.global, `INSERT INTO apps (name) VALUES ('other')`)
	testutil.Exec(t, m.global, `INSERT INTO server_logs (ts, level, source, app_id, message) VALUES ('t','info','x',1,'live'),('t','info','x',2,'other'),('t','info','x',NULL,'global')`)
	if n, _ := m.PurgeAppLogs(ctx, "live"); n != 1 {
		t.Fatal(n)
	}
	var left int
	_ = m.global.QueryRow(`SELECT COUNT(*) FROM server_logs`).Scan(&left)
	if left != 2 {
		t.Fatal("purged another app's logs")
	}
	if n, err := m.PurgeAppLogs(ctx, "ghost"); n != 0 || err != nil {
		t.Fatal("unknown app")
	}
}

type fakeVods struct {
	pages   [][]int64
	listed  int
	deleted []int64
	failOn  map[int64]bool
}

func (f *fakeVods) ListVodIDs(_ context.Context, _ string, limit, offset int) ([]int64, error) {
	if limit != purgePage || offset != 0 {
		return nil, errors.New("bad paging")
	}
	if f.listed >= len(f.pages) {
		return nil, nil
	}
	p := f.pages[f.listed]
	f.listed++
	return p, nil
}

func (f *fakeVods) DeleteVod(_ context.Context, _ string, id int64) (int64, bool, error) {
	if f.failOn[id] {
		return 0, false, errors.New("vanished")
	}
	f.deleted = append(f.deleted, id)
	return 2, id%2 == 0, nil
}

func TestPurgeScopes(t *testing.T) {
	ctx := context.Background()
	t.Run("logs only", func(t *testing.T) {
		_, d := setup(t)
		v := &fakeVods{pages: [][]int64{{1}}}
		d.SetVods(v)
		r, err := d.Purge(ctx, "live", "logs")
		if err != nil || r.VodsDeleted != 0 || r.StreamsDeleted != 0 || len(v.deleted) != 0 || r.Scope != "logs" {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("vods cascade + counters, drains pages", func(t *testing.T) {
		_, d := setup(t)
		v := &fakeVods{pages: [][]int64{{1, 2, 3}, {4}}, failOn: map[int64]bool{3: true}}
		d.SetVods(v)
		r, _ := d.Purge(ctx, "live", "vods")
		if r != (PurgeResult{Scope: "vods", VodsDeleted: 3, S3Deleted: 6, LocalDeleted: 2}) || v.listed != 2 {
			t.Fatalf("%+v listed=%d", r, v.listed)
		}
	})
	t.Run("stops when a page makes no progress", func(t *testing.T) {
		_, d := setup(t)
		v := &fakeVods{pages: [][]int64{{9}, {9}, {9}}, failOn: map[int64]bool{9: true}}
		d.SetVods(v)
		if r, _ := d.Purge(ctx, "live", "vods"); r.VodsDeleted != 0 || v.listed != 1 {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("all: vods + streams + logs", func(t *testing.T) {
		m, d := setup(t)
		h, _ := m.store.App(ctx, "live")
		testutil.Exec(t, h, `INSERT INTO streams (app_id, stream_id, type, status) VALUES (1, 'a', 'rtmp', 'ended')`)
		testutil.Exec(t, m.global, `INSERT INTO server_logs (ts, level, source, app_id, message) VALUES ('t','info','x',1,'m')`)
		d.SetVods(&fakeVods{pages: [][]int64{{2}}})
		r, _ := d.Purge(ctx, "live", "all")
		if r != (PurgeResult{Scope: "all", VodsDeleted: 1, StreamsDeleted: 1, LogsDeleted: 1, S3Deleted: 2, LocalDeleted: 1}) {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("no recording wired: vods purge deletes nothing", func(t *testing.T) {
		_, d := setup(t)
		if r, _ := d.Purge(ctx, "live", "vods"); r.VodsDeleted != 0 {
			t.Fatal(r)
		}
	})
}
