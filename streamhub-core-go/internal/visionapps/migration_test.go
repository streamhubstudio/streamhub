package visionapps

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// seedVisionDB writes a legacy (pre-2.16 single-file) vision.db.
func seedVisionDB(t *testing.T, file string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	h, err := sql.Open("sqlite", "file:"+file+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	testutil.Exec(t, h, `
    CREATE TABLE occupancy_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, zone TEXT, tag TEXT,
      kind TEXT, node_id TEXT, started_at TEXT DEFAULT (datetime('now')), ended_at TEXT,
      duration_sec REAL, ts TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE count_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, line TEXT, tag TEXT,
      direction TEXT, track_id TEXT, inside INTEGER, ts TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE crowd_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, zone TEXT, tag TEXT,
      count INTEGER, threshold INTEGER, alert INTEGER NOT NULL DEFAULT 0, snapshot_url TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE demography_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, tag TEXT, age REAL,
      age_range TEXT, gender TEXT, emotion TEXT, engine TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE stream_settings (
      room TEXT NOT NULL, model TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (room, model));`)
	testutil.Exec(t, h, `INSERT INTO occupancy_sessions (room, zone) VALUES ('gate','z1')`)
	testutil.Exec(t, h, `INSERT INTO count_events (room, direction) VALUES ('gate','in')`)
	testutil.Exec(t, h, `INSERT INTO stream_settings (room, model, config_json) VALUES ('gate','occupancy','{"zones":[]}')`)
	testutil.Exec(t, h, `INSERT INTO stream_settings (room, model, config_json) VALUES ('gate','counting','{"lines":[],"fps":3.5}')`)
}

type migStack struct {
	mig    *Migration
	repo   *plugins.Repo
	store  *Store
	global *sql.DB
	appDir string
	logs   *recLogs
}

func newMigStack(t *testing.T) *migStack {
	t.Helper()
	dbs, global, dir := testutil.Store(t)
	apps := &fakeApps{dir: dir}
	reg := plugins.NewRegistry(plugins.Paths{VendorRoot: vendorFixtures}, func(string) string { return "" }, testutil.Log())
	reg.Discover()
	st := &migStack{repo: plugins.NewRepo(dbs), store: NewStore(), global: global, appDir: apps.AppDir(app), logs: &recLogs{}}
	t.Cleanup(st.store.CloseAll)
	st.mig = NewMigration(st.store, st.repo, reg, apps, global, st.logs, testutil.Log())

	seedVisionDB(t, filepath.Join(st.appDir, "vision", "vision.db"))
	if err := st.repo.Install(bg, app, "vision", m(t, `{"occupancy_enabled":true,"counting_enabled":true,"crowd_enabled":false,"demography_enabled":false,"device":"cuda","fps":4,"confidence":0.5}`), true); err != nil {
		t.Fatal(err)
	}
	testutil.Exec(t, global, `INSERT INTO edge_assignments (id, node_id, app, plugin_id, stream_id, config_json, status)
           VALUES ('a1','n1',?,'vision','gate','{"model":"occupancy","room":"gate"}','running'),
                  ('a2','n1',?,'vision','x','{"room":"x"}','running')`, app, app)
	return st
}

func (st *migStack) get(t *testing.T, id string) *plugins.Installed {
	t.Helper()
	return must[*plugins.Installed](t)(st.repo.Get(bg, app, id))
}

func TestMigrationInstallsEnabledModels(t *testing.T) {
	st := newMigStack(t)
	if got := st.mig.Migrate(bg); len(got) != 1 || got[0] != app {
		t.Fatalf("migrated %v", got)
	}
	occ, cnt := st.get(t, "occupancy"), st.get(t, "counting")
	if occ == nil || cnt == nil || !occ.Enabled || !cnt.Enabled {
		t.Fatalf("occ=%+v cnt=%+v", occ, cnt)
	}
	if occ.Config.Get("device") != "cuda" || occ.Config.Get("fps") != float64(4) || occ.Config.Get("confidence") != 0.5 {
		t.Fatalf("carried config %s", jstr(t, occ.Config))
	}
	if st.get(t, "crowd") != nil || st.get(t, "demography") != nil || st.get(t, "vision") != nil {
		t.Fatal("crowd/demography must not be installed; vision must be removed")
	}
	if len(st.logs.msgs) != 1 || st.logs.msgs[0] != "migrated app 'live' vision → 4 apps" {
		t.Fatalf("logs %v", st.logs.msgs)
	}
}

func TestMigrationDesiredRunning(t *testing.T) {
	st := newMigStack(t)
	st.mig.Migrate(bg)
	for _, id := range []string{"occupancy", "counting"} {
		if d := st.get(t, id).WorkerDesired; d == nil || *d != "running" {
			t.Fatalf("%s desired %v", id, d)
		}
	}
}

func TestMigrationSplitsData(t *testing.T) {
	st := newMigStack(t)
	st.mig.Migrate(bg)
	if _, err := os.Stat(filepath.Join(st.appDir, "occupancy", "occupancy.db")); err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"occupancy", "counting"} {
		if rows := must[[]VisionEventRow](t)(st.store.RecentEvents(bg, app, st.appDir, model, 10)); len(rows) != 1 {
			t.Fatalf("%s rows %d", model, len(rows))
		}
	}
	eqJSON(t, getCfg(t, st.store, st.appDir, "occupancy", "gate"), `{"zones":[]}`)
	eqJSON(t, getCfg(t, st.store, st.appDir, "counting", "gate"), `{"lines":[],"fps":3.5}`)
}

func TestMigrationAssignments(t *testing.T) {
	st := newMigStack(t)
	st.mig.Migrate(bg)
	row := func(id string) (string, string) {
		var p, s string
		if err := st.global.QueryRow(`SELECT plugin_id, status FROM edge_assignments WHERE id = ?`, id).Scan(&p, &s); err != nil {
			t.Fatal(err)
		}
		return p, s
	}
	if p, s := row("a1"); p != "occupancy" || s != "running" {
		t.Fatalf("a1 %s %s", p, s)
	}
	if p, s := row("a2"); p != "vision" || s != "revoked" {
		t.Fatalf("a2 %s %s", p, s)
	}
}

func TestMigrationIdempotent(t *testing.T) {
	st := newMigStack(t)
	st.mig.Migrate(bg)
	n := len(must[[]VisionEventRow](t)(st.store.RecentEvents(bg, app, st.appDir, "occupancy", 10)))
	if got := st.mig.Migrate(bg); len(got) != 0 {
		t.Fatalf("re-run migrated %v", got)
	}
	if st.get(t, "vision") != nil || !st.get(t, "occupancy").Enabled {
		t.Fatal("state changed on re-run")
	}
	if m := len(must[[]VisionEventRow](t)(st.store.RecentEvents(bg, app, st.appDir, "occupancy", 10))); m != n {
		t.Fatalf("rows %d → %d", n, m)
	}
}

func TestMigrationBackup(t *testing.T) {
	st := newMigStack(t)
	st.mig.Migrate(bg)
	if _, err := os.Stat(filepath.Join(st.appDir, "vision", "vision.db.pre-split.bak")); err != nil {
		t.Fatal(err)
	}
}
