package backups

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// Ports backups.service.spec.ts, backups.controller.spec.ts (service side)
// and backups.scheduler.spec.ts.

type logCall struct {
	level, source, message string
	meta                   any
}

type recLogs struct {
	mu    sync.Mutex
	calls []logCall
}

func (r *recLogs) Write(level, source, message string, meta any, _ *int64) {
	r.mu.Lock()
	r.calls = append(r.calls, logCall{level, source, message, meta})
	r.mu.Unlock()
}

type env struct {
	svc   *Service
	store *db.Service
	g     *sql.DB
	dir   string
	logs  *recLogs
}

func setup(t *testing.T, over map[string]string) env {
	t.Helper()
	for _, k := range []string{"STREAMHUB_BACKUPS_ENABLED", "STREAMHUB_BACKUP_RETENTION_DAYS", "STREAMHUB_BACKUP_DIR", "STREAMHUB_BACKUP_CRON"} {
		t.Setenv(k, "")
	}
	for k, v := range over {
		t.Setenv(k, v)
	}
	store, g, dir := testutil.Store(t)
	testutil.Exec(t, g, `INSERT INTO apps (name) VALUES ('live')`)
	if _, err := store.App(context.Background(), "live"); err != nil {
		t.Fatal(err)
	}
	l := &recLogs{}
	return env{svc: New(ResolveSettings(&config.Config{DataDir: dir}), store, g, l, testutil.Log()), store: store, g: g, dir: dir, logs: l}
}

func (e env) target(t *testing.T, id string) Target {
	t.Helper()
	ts, err := e.svc.Targets(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range ts {
		if x.DB == id {
			return x
		}
	}
	t.Fatalf("no target %s", id)
	return Target{}
}

// openSnapshot gunzips a snapshot to a temp file and opens it read-only.
func openSnapshot(t *testing.T, e env, s SnapshotInfo) *sql.DB {
	t.Helper()
	out := filepath.Join(t.TempDir(), "snap.db")
	if err := gunzipFile(filepath.Join(e.svc.Settings.BackupDir, s.DB, s.File), out); err != nil {
		t.Fatal(err)
	}
	h, err := sql.Open("sqlite", "file:"+out+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	return h
}

func names(t *testing.T, h *sql.DB, q string) []string {
	t.Helper()
	rows, err := h.Query(q)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		out = append(out, s)
	}
	return out
}

func TestSettings(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want Settings
	}{
		{nil, Settings{true, 7, "/d/backups", "30 3 * * *"}},
		{map[string]string{"STREAMHUB_BACKUPS_ENABLED": " OFF ", "STREAMHUB_BACKUP_RETENTION_DAYS": "0", "STREAMHUB_BACKUP_DIR": " /x ", "STREAMHUB_BACKUP_CRON": "0 0 4 * * *"},
			Settings{false, 0, "/x", "0 0 4 * * *"}},
		{map[string]string{"STREAMHUB_BACKUPS_ENABLED": "maybe", "STREAMHUB_BACKUP_RETENTION_DAYS": "-3", "STREAMHUB_BACKUP_CRON": "every day"},
			Settings{true, 7, "/d/backups", "30 3 * * *"}},
		{map[string]string{"STREAMHUB_BACKUP_RETENTION_DAYS": "14days"}, Settings{true, 14, "/d/backups", "30 3 * * *"}},
	}
	for _, c := range cases {
		for _, k := range []string{"STREAMHUB_BACKUPS_ENABLED", "STREAMHUB_BACKUP_RETENTION_DAYS", "STREAMHUB_BACKUP_DIR", "STREAMHUB_BACKUP_CRON"} {
			t.Setenv(k, c.env[k])
		}
		if got := ResolveSettings(&config.Config{DataDir: "/d"}); got != c.want {
			t.Errorf("%v → %+v", c.env, got)
		}
	}
}

func TestTargets(t *testing.T) {
	e := setup(t, nil)
	ts, _ := e.svc.Targets(context.Background())
	if len(ts) != 2 || ts[0].DB != "streamhub" || ts[1].DB != "app-live" || ts[1].Kind != "app" ||
		ts[1].DBPath != filepath.Join(e.dir, "apps", "live", "app.db") {
		t.Fatalf("%+v", ts)
	}
}

func TestRunBackup(t *testing.T) {
	e := setup(t, nil)
	testutil.Exec(t, e.g, `INSERT INTO apps (name) VALUES ('marker-app')`)
	run := e.svc.RunBackup(context.Background(), "manual", "tester")
	if len(run.Errors) != 0 {
		t.Fatal(run.Errors)
	}
	var dbs []string
	for _, s := range run.Snapshots {
		dbs = append(dbs, s.DB)
		if s.SizeBytes <= 0 || !snapshotRE.MatchString(s.File) || s.PreRestore {
			t.Fatalf("%+v", s)
		}
	}
	sort.Strings(dbs)
	if !reflect.DeepEqual(dbs, []string{"app-live", "app-marker-app", "streamhub"}) {
		t.Fatal(dbs)
	}
	snap := openSnapshot(t, e, run.Snapshots[0])
	var ic string
	_ = snap.QueryRow("PRAGMA integrity_check").Scan(&ic)
	if ic != "ok" || !reflect.DeepEqual(names(t, snap, "SELECT name FROM apps ORDER BY name"), []string{"live", "marker-app"}) {
		t.Fatal("global snapshot content")
	}
	if len(e.logs.calls) != 1 || e.logs.calls[0].level != "info" || !strings.Contains(e.logs.calls[0].message, "backup run (manual): 3 snapshot(s), 0 error(s), 0 pruned") {
		t.Fatalf("%+v", e.logs.calls)
	}
	if m := e.logs.calls[0].meta.(runMeta); m.Reason != "manual" || *m.Actor != "tester" {
		t.Fatalf("%+v", m)
	}
	// no temp leftovers
	entries, _ := os.ReadDir(filepath.Join(e.svc.Settings.BackupDir, "streamhub"))
	for _, x := range entries {
		if strings.HasPrefix(x.Name(), ".tmp-") {
			t.Fatal("temp file left behind")
		}
	}
}

func TestHotBackupIncludesWALRows(t *testing.T) {
	e := setup(t, nil)
	testutil.Exec(t, e.g, `INSERT INTO apps (name) VALUES ('fresh-in-wal')`)
	snap, err := e.svc.backupTarget(context.Background(), e.target(t, "streamhub"), false)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(t, openSnapshot(t, e, snap), "SELECT name FROM apps WHERE name = 'fresh-in-wal'"); len(got) != 1 {
		t.Fatal("WAL row missing from the snapshot")
	}
}

func writeSnap(t *testing.T, e env, dbID, file string, content []byte, age time.Duration) {
	t.Helper()
	dir := filepath.Join(e.svc.Settings.BackupDir, dbID)
	_ = os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, file)
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	_ = os.Chtimes(p, when, when)
}

func TestListingAndPrune(t *testing.T) {
	e := setup(t, nil)
	now := time.Now().UTC()
	stamp := func(d time.Duration) string {
		return strings.NewReplacer(":", "-", ".", "-").Replace(now.Add(-d).Format("2006-01-02T15:04:05.000Z"))
	}
	writeSnap(t, e, "app-live", stamp(10*24*time.Hour)+".db.gz", []byte("old"), 0)
	writeSnap(t, e, "app-live", stamp(time.Hour)+".db.gz", []byte("fresh!"), 0)
	writeSnap(t, e, "app-live", stamp(2*time.Hour)+".pre-restore.db.gz", []byte("pre"), 0)
	writeSnap(t, e, "app-live", "junk.txt", []byte("x"), 0)
	writeSnap(t, e, "app-gone", stamp(9*24*time.Hour)+".db.gz", []byte("orphan"), 0)

	list := e.svc.ListSnapshots("app-live")
	if len(list) != 3 || list[0].SizeBytes != 6 || !list[1].PreRestore || list[0].CreatedAt <= list[1].CreatedAt {
		t.Fatalf("%+v", list)
	}
	ov, _ := e.svc.Overview(context.Background())
	last := ov.Databases[len(ov.Databases)-1]
	if last.DB != "app-gone" || !last.Orphaned || last.App != "gone" || last.LiveSizeBytes != nil || last.DBPath != "" {
		t.Fatalf("%+v", last)
	}
	if ov.Databases[0].App != "" || ov.Databases[0].LiveSizeBytes == nil || ov.Schedule != DefaultCron || !ov.Enabled {
		t.Fatalf("%+v", ov.Databases[0])
	}

	// default 7 days: the 10-day and the orphaned 9-day snapshots go
	run := e.svc.RunBackup(context.Background(), "manual", "")
	if run.PrunedCount != 2 || len(e.svc.ListSnapshots("app-gone")) != 0 || len(e.svc.ListSnapshots("app-live")) != 3 {
		t.Fatalf("pruned %d, left %+v", run.PrunedCount, e.svc.ListSnapshots("app-live"))
	}
}

func TestRetentionZeroKeepsForever(t *testing.T) {
	e := setup(t, map[string]string{"STREAMHUB_BACKUP_RETENTION_DAYS": "0"})
	writeSnap(t, e, "streamhub", "2000-01-01T00-00-00-000Z.db.gz", []byte("x"), 0)
	if n := e.svc.Prune(time.Now()); n != 0 {
		t.Fatal(n)
	}
}

func TestRestoreApp(t *testing.T) {
	ctx := context.Background()
	e := setup(t, nil)
	adb, _ := e.store.App(ctx, "live")
	testutil.Exec(t, adb, `INSERT INTO streams (app_id, stream_id, type, status) VALUES (1, 'keep-me', 'rtmp', 'ended')`)
	snap, err := e.svc.backupTarget(ctx, e.target(t, "app-live"), false)
	if err != nil {
		t.Fatal(err)
	}
	testutil.Exec(t, adb, `INSERT INTO streams (app_id, stream_id, type, status) VALUES (1, 'lose-me', 'rtmp', 'ended')`)

	res, err := e.svc.Restore(ctx, "app-live", snap.File, "tester")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Restored || res.Integrity != "ok" || res.RestartRecommended || res.Snapshot != snap.File {
		t.Fatalf("%+v", res)
	}
	adb, _ = e.store.App(ctx, "live")
	if got := names(t, adb, "SELECT stream_id FROM streams ORDER BY stream_id"); !reflect.DeepEqual(got, []string{"keep-me"}) {
		t.Fatal(got)
	}
	var pre *SnapshotInfo
	for _, s := range e.svc.ListSnapshots("app-live") {
		if s.File == res.PreRestoreSnapshot {
			pre = &s
		}
	}
	if pre == nil || !pre.PreRestore || !strings.HasSuffix(pre.File, ".pre-restore.db.gz") {
		t.Fatal("safety copy missing")
	}
	if got := names(t, openSnapshot(t, e, *pre), "SELECT stream_id FROM streams ORDER BY stream_id"); !reflect.DeepEqual(got, []string{"keep-me", "lose-me"}) {
		t.Fatal(got)
	}
	last := e.logs.calls[len(e.logs.calls)-1]
	if last.level != "warn" || !strings.Contains(last.message, "RESTORED app-live") || last.meta.(restoreMeta).Snapshot != snap.File || *last.meta.(restoreMeta).Actor != "tester" {
		t.Fatalf("%+v", last)
	}
	// no restore temp files left next to the live DB
	entries, _ := os.ReadDir(filepath.Join(e.dir, "apps", "live"))
	for _, x := range entries {
		if strings.HasPrefix(x.Name(), ".restore-") {
			t.Fatal("restore temp left")
		}
	}
}

func TestRestoreGlobal(t *testing.T) {
	ctx := context.Background()
	e := setup(t, nil)
	snap, err := e.svc.backupTarget(ctx, e.target(t, "streamhub"), false)
	if err != nil {
		t.Fatal(err)
	}
	testutil.Exec(t, e.g, `INSERT INTO apps (name) VALUES ('added-after-snap')`)
	res, err := e.svc.Restore(ctx, "streamhub", snap.File, "")
	if err != nil {
		t.Fatal(err)
	}
	if !res.RestartRecommended {
		t.Fatal("global restore recommends a restart")
	}
	// The shared handle serves the restored content and stays writable.
	if got := names(t, e.g, "SELECT name FROM apps ORDER BY name"); !reflect.DeepEqual(got, []string{"live"}) {
		t.Fatal(got)
	}
	testutil.Exec(t, e.g, `INSERT INTO apps (name) VALUES ('post')`)
	var n int
	_ = e.g.QueryRow(`SELECT COUNT(*) FROM apps`).Scan(&n)
	if n != 2 {
		t.Fatal(n)
	}
}

func gz(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

func status(err error) int {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

func TestRestoreRefusals(t *testing.T) {
	ctx := context.Background()
	e := setup(t, nil)
	good, err := e.svc.backupTarget(ctx, e.target(t, "app-live"), false)
	if err != nil {
		t.Fatal(err)
	}
	corrupt := "2020-01-01T00-00-00-000Z.db.gz"
	writeSnap(t, e, "app-live", corrupt, gz([]byte("this is not a sqlite database at all")), 0)
	live := filepath.Join(e.dir, "apps", "live", "app.db")
	before, _ := os.ReadFile(live)

	_, err = e.svc.Restore(ctx, "app-live", corrupt, "")
	if status(err) != 400 || !strings.Contains(err.Error(), "failed integrity validation — restore aborted, live DB untouched (file is not a database)") {
		t.Fatalf("%v", err)
	}
	after, _ := os.ReadFile(live)
	if !bytes.Equal(before, after) {
		t.Fatal("live DB touched")
	}
	for _, s := range e.svc.ListSnapshots("app-live") {
		if s.PreRestore {
			t.Fatal("no safety copy before the integrity gate passes")
		}
	}
	if _, err := e.svc.Restore(ctx, "app-live", good.File, ""); err != nil {
		t.Fatal(err)
	}

	writeSnap(t, e, "streamhub", "2020-01-01T00-00-00-000Z.db.gz", []byte("plain text, no gzip magic"), 0)
	_, err = e.svc.Restore(ctx, "streamhub", "2020-01-01T00-00-00-000Z.db.gz", "")
	if status(err) != 400 || err.Error() != "snapshot '2020-01-01T00-00-00-000Z.db.gz' is not a valid gzip file: incorrect header check" {
		t.Fatal(err)
	}

	cases := []struct {
		db, file string
		status   int
		msg      string
	}{
		{"app-nope", "x.db.gz", 404, "unknown database 'app-nope' — restore only targets the global registry ('streamhub') or a registered app ('app-<name>')"},
		{"streamhub", "../../../etc/passwd", 400, "invalid snapshot name '../../../etc/passwd'"},
		{"streamhub", "not-a-stamp.db.gz", 400, "invalid snapshot name 'not-a-stamp.db.gz'"},
		{"streamhub", "2099-01-01T00-00-00-000Z.db.gz", 404, "snapshot '2099-01-01T00-00-00-000Z.db.gz' not found for 'streamhub'"},
	}
	for _, c := range cases {
		_, err := e.svc.Restore(ctx, c.db, c.file, "")
		if status(err) != c.status || err.Error() != c.msg {
			t.Errorf("%s/%s: %v", c.db, c.file, err)
		}
	}
}

func TestNewestSnapshotAgeAndDirOverride(t *testing.T) {
	custom := filepath.Join(t.TempDir(), "elsewhere")
	e := setup(t, map[string]string{"STREAMHUB_BACKUP_DIR": custom})
	if e.svc.Settings.BackupDir != custom {
		t.Fatal(e.svc.Settings.BackupDir)
	}
	if e.svc.NewestSnapshotAge(time.Now()) < CatchUpAfter*1000 {
		t.Fatal("no snapshot = +Inf")
	}
	e.svc.RunBackup(context.Background(), "manual", "")
	if age := e.svc.NewestSnapshotAge(time.Now()); age > time.Minute {
		t.Fatal(age)
	}
	if _, err := os.Stat(filepath.Join(custom, "streamhub")); err != nil {
		t.Fatal(err)
	}
}

func TestSchedulerCatchUpAndDisable(t *testing.T) {
	t.Run("boot catch-up when stale, job name in the audit log", func(t *testing.T) {
		e := setup(t, nil)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		NewScheduler(e.svc).Start(ctx)
		deadline := time.Now().Add(10 * time.Second)
		for {
			e.logs.mu.Lock()
			n := len(e.logs.calls)
			e.logs.mu.Unlock()
			if n > 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("catch-up never ran")
			}
			time.Sleep(20 * time.Millisecond)
		}
		e.logs.mu.Lock()
		defer e.logs.mu.Unlock()
		if e.logs.calls[0].meta.(runMeta).Reason != "catch-up" || len(e.svc.ListSnapshots("app-live")) != 1 {
			t.Fatalf("%+v", e.logs.calls[0])
		}
	})
	t.Run("disabled entirely", func(t *testing.T) {
		e := setup(t, map[string]string{"STREAMHUB_BACKUPS_ENABLED": "false"})
		NewScheduler(e.svc).Start(context.Background())
		time.Sleep(50 * time.Millisecond)
		if len(e.logs.calls) != 0 {
			t.Fatal("ran while disabled")
		}
	})
	t.Run("fresh snapshot: no catch-up", func(t *testing.T) {
		e := setup(t, nil)
		e.svc.RunBackup(context.Background(), "manual", "")
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		NewScheduler(e.svc).Start(ctx)
		time.Sleep(50 * time.Millisecond)
		if len(e.logs.calls) != 1 {
			t.Fatal("catch-up ran despite a fresh snapshot")
		}
	})
	t.Run("cron forms", func(t *testing.T) {
		for _, c := range []string{DefaultCron, "0 30 3 * * *", "*/5 * * * *"} {
			if _, err := cronParser.Parse(c); err != nil {
				t.Errorf("%s: %v", c, err)
			}
		}
		s, _ := cronParser.Parse(DefaultCron)
		from := time.Date(2026, 7, 6, 4, 0, 0, 0, time.Local)
		if next := s.Next(from); next != time.Date(2026, 7, 7, 3, 30, 0, 0, time.Local) {
			t.Fatal(next)
		}
	})
}
