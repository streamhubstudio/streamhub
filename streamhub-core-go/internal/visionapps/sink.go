package visionapps

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// AppLog is the rotated per-app app.log (logs.AppLog).
type AppLog interface {
	Record(app string, rec any)
}

// Sink is VisionSinkService: every vision-family event lands in the
// rotated app.log and its model's per-app db. Never fails.
type Sink struct {
	store  *Store
	appLog AppLog
	apps   contracts.AppsService
}

// NewSink builds the sink (appLog may be nil).
func NewSink(store *Store, appLog AppLog, apps contracts.AppsService) *Sink {
	return &Sink{store: store, appLog: appLog, apps: apps}
}

var _ plugins.VisionSink = (*Sink)(nil)

// Record implements plugins.VisionSink.
func (s *Sink) Record(app, event string, payload *y.Map) {
	model := EventModel(event)
	if model == "" {
		return
	}
	if payload == nil {
		payload = y.NewMap()
	}
	if s.appLog != nil {
		line := y.NewMap()
		line.Set("source", "vision")
		line.Set("event", event)
		s.appLog.Record(app, y.Assign(line, payload))
	}
	ctx := context.Background()
	dir := s.apps.AppDir(app)
	room, _ := payload.Get("room").(string)
	switch model {
	case "occupancy":
		_ = s.store.RecordOccupancy(ctx, app, dir, room, event, payload)
	case "counting":
		_ = s.store.RecordCount(ctx, app, dir, room, event, payload)
	case "crowd":
		_ = s.store.RecordCrowd(ctx, app, dir, room, event, payload)
	case "demography":
		_ = s.store.RecordDemography(ctx, app, dir, room, event, payload)
	}
}

// ---------------------------------------------------------------------------
// vision-migration.service.ts — the idempotent vision → 4 apps split
// ---------------------------------------------------------------------------

// Migration is VisionMigrationService.
type Migration struct {
	store    *Store
	installs *plugins.Repo
	registry *plugins.Registry
	apps     contracts.AppsService
	global   *sql.DB
	logs     plugins.LogWriter
	log      *slog.Logger
}

// NewMigration builds the migration (logs may be nil).
func NewMigration(store *Store, installs *plugins.Repo, registry *plugins.Registry, apps contracts.AppsService, global *sql.DB, logs plugins.LogWriter, log *slog.Logger) *Migration {
	return &Migration{store: store, installs: installs, registry: registry, apps: apps, global: global, logs: logs, log: log}
}

var enableFlag = map[string]string{
	"occupancy": "occupancy_enabled", "counting": "counting_enabled",
	"crowd": "crowd_enabled", "demography": "demography_enabled",
}

// Migrate splits every app still carrying a `vision` install; returns the
// migrated app names. Each app is isolated; nothing here fails boot.
func (m *Migration) Migrate(ctx context.Context) []string {
	list, err := m.apps.List(ctx, nil)
	if err != nil {
		return nil
	}
	var migrated []string
	for _, a := range list {
		ok, err := m.migrateApp(ctx, a.Name)
		if err != nil {
			m.log.Error(fmt.Sprintf("vision→apps migration for '%s' failed: %s", a.Name, err))
			continue
		}
		if ok {
			migrated = append(migrated, a.Name)
		}
	}
	if len(migrated) > 0 {
		m.log.Info(fmt.Sprintf("vision→apps migration complete for %d app(s)", len(migrated)))
	}
	return migrated
}

type appMeta struct {
	App string `json:"app"`
}

func (m *Migration) migrateApp(ctx context.Context, app string) (bool, error) {
	vision, err := m.installs.Get(ctx, app, "vision")
	if err != nil || vision == nil {
		return false, err
	}
	appDir := m.apps.AppDir(app)
	visionDB := filepath.Join(appDir, "vision", "vision.db")
	m.backup(ctx, visionDB)
	m.splitData(ctx, app, appDir, visionDB)
	if err := m.installModelApps(ctx, app, vision.Config, vision.Enabled); err != nil {
		return false, err
	}
	m.migrateAssignments(ctx, app)
	if err := m.installs.Remove(ctx, app, "vision"); err != nil {
		return false, err
	}
	if m.logs != nil {
		m.logs.Write("info", "vision-migration", fmt.Sprintf("migrated app '%s' vision → 4 apps", app), appMeta{app}, nil)
	}
	return true, nil
}

func sqlPath(p string) string { return strings.ReplaceAll(p, "'", "''") }

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// backup VACUUMs vision.db INTO a one-shot .pre-split.bak (best-effort).
func (m *Migration) backup(ctx context.Context, visionDB string) {
	bak := visionDB + ".pre-split.bak"
	if !exists(visionDB) || exists(bak) {
		return
	}
	h, err := sql.Open("sqlite", "file:"+visionDB)
	if err != nil {
		return
	}
	defer h.Close()
	if _, err := h.ExecContext(ctx, `VACUUM INTO '`+sqlPath(bak)+`'`); err != nil {
		m.log.Warn("vision.db backup failed (continuing): " + err.Error())
		return
	}
	m.log.Info("vision.db backed up to " + bak)
}

// splitData copies each model's events + settings out of vision.db.
func (m *Migration) splitData(ctx context.Context, app, appDir, visionDB string) {
	if !exists(visionDB) {
		return
	}
	for _, model := range Models {
		if err := m.splitModel(ctx, app, appDir, visionDB, model); err != nil {
			m.log.Warn(fmt.Sprintf("vision.db split for '%s/%s' failed: %s", app, model, err))
		}
	}
}

func (m *Migration) splitModel(ctx context.Context, app, appDir, visionDB, model string) error {
	h, err := m.store.DB(ctx, app, appDir, model)
	if err != nil {
		return err
	}
	conn, err := h.Conn(ctx) // ATTACH is per connection
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `ATTACH '`+sqlPath(visionDB)+`' AS old`); err != nil {
		return err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), `DETACH old`) }()
	table := eventTable[model]
	if _, err := conn.ExecContext(ctx, `INSERT OR IGNORE INTO `+table+` SELECT * FROM old.`+table); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, `INSERT OR IGNORE INTO stream_settings (room, config_json, updated_at)
               SELECT room, config_json, updated_at FROM old.stream_settings WHERE model = ?`, model)
	return err
}

// installModelApps installs the flagged model-apps carrying the shared knobs.
func (m *Migration) installModelApps(ctx context.Context, app string, cfg *y.Map, visionEnabled bool) error {
	for _, model := range Models {
		flag := cfg.Get(enableFlag[model]) == true
		if model == "occupancy" {
			flag = cfg.Get(enableFlag[model]) != false
		}
		if !flag {
			continue
		}
		if row, _ := m.installs.Get(ctx, app, model); row != nil {
			continue
		}
		meta := m.registry.GetMeta(model)
		if meta == nil {
			continue
		}
		merged := plugins.DefaultConfig(meta).Clone()
		device := "cpu"
		if cfg.Get("device") == "cuda" {
			device = "cuda"
		}
		merged.Set("device", device)
		for _, k := range []string{"fps", "confidence"} {
			if f, ok := cfg.Get(k).(float64); ok {
				merged.Set(k, f)
			}
		}
		if model == "demography" {
			for _, k := range []string{"engine", "ai_api_key"} {
				if s, ok := cfg.Get(k).(string); ok {
					merged.Set(k, s)
				}
			}
		}
		final, err := plugins.ValidateConfig(meta, merged, false)
		if err != nil {
			final = plugins.DefaultConfig(meta)
		}
		enabled := visionEnabled && flag
		if err := m.installs.Install(ctx, app, model, final, enabled); err != nil {
			return err
		}
		desired := "stopped"
		if enabled {
			desired = "running"
		}
		if err := m.installs.SetWorkerDesired(ctx, app, model, desired); err != nil {
			return err
		}
	}
	return nil
}

// migrateAssignments re-points (or revokes) plugin_id 'vision' edge rows.
func (m *Migration) migrateAssignments(ctx context.Context, app string) {
	rows, err := m.global.QueryContext(ctx, `SELECT id, config_json FROM edge_assignments WHERE app = ? AND plugin_id = 'vision'`, app)
	if err != nil {
		return
	}
	type row struct {
		id  string
		cfg sql.NullString
	}
	var list []row
	for rows.Next() {
		var r row
		if rows.Scan(&r.id, &r.cfg) == nil {
			list = append(list, r)
		}
	}
	rows.Close()
	for _, r := range list {
		model := ""
		if r.cfg.Valid {
			if v, err := y.ParseJSON([]byte(r.cfg.String)); err == nil {
				if s, ok := prop(v, "model").(string); ok && IsModel(s) {
					model = s
				}
			}
		}
		if model != "" {
			_, _ = m.global.ExecContext(ctx, `UPDATE edge_assignments SET plugin_id = ?, updated_at = datetime('now') WHERE id = ?`, model, r.id)
		} else {
			_, _ = m.global.ExecContext(ctx, `UPDATE edge_assignments SET status = 'revoked', updated_at = datetime('now') WHERE id = ?`, r.id)
		}
	}
}

func prop(v any, k string) any {
	if m, ok := v.(*y.Map); ok && m != nil {
		return m.Get(k)
	}
	return y.Undefined
}
