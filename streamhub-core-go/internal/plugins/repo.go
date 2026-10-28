package plugins

import (
	"context"
	"database/sql"
	"strings"
	"sync"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Ports of app-plugins.repository.ts (per-app app.db `app_plugins`, with the
// `worker_desired` / `worker_version` columns added idempotently) and
// plugin-version-history.repository.ts (`plugin_version_history`).

// Installed is one decoded app_plugins row.
type Installed struct {
	PluginID      string
	Enabled       bool
	Config        *y.Map
	InstalledAt   string
	UpdatedAt     string
	WorkerDesired *string // "running" | "stopped" | nil
	WorkerVersion *string
}

// Repo is AppPluginsRepository.
type Repo struct {
	store   *db.Service
	mu      sync.Mutex
	ensured map[string]bool
}

// NewRepo builds the repository.
func NewRepo(store *db.Service) *Repo { return &Repo{store: store, ensured: map[string]bool{}} }

func (r *Repo) adb(ctx context.Context, app string) (*sql.DB, error) {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ensured[app] {
		return h, nil
	}
	for _, col := range []string{"worker_desired", "worker_version"} {
		if has, err := db.HasColumn(ctx, h, "app_plugins", col); err == nil && !has {
			_, _ = h.ExecContext(ctx, "ALTER TABLE app_plugins ADD COLUMN "+col+" TEXT")
		}
	}
	r.ensured[app] = true
	return h, nil
}

const installedCols = `plugin_id, enabled, config_json, installed_at, updated_at, worker_desired, worker_version`

func scanInstalled(sc interface{ Scan(...any) error }) (*Installed, error) {
	var (
		row                    Installed
		enabled                int64
		cfg, desired, version  sql.NullString
		installedAt, updatedAt sql.NullString
	)
	if err := sc.Scan(&row.PluginID, &enabled, &cfg, &installedAt, &updatedAt, &desired, &version); err != nil {
		return nil, err
	}
	row.Enabled = enabled == 1
	row.InstalledAt, row.UpdatedAt = installedAt.String, updatedAt.String
	row.Config = y.NewMap()
	if cfg.Valid && cfg.String != "" {
		if v, err := y.ParseJSON([]byte(cfg.String)); err == nil {
			if m, ok := v.(*y.Map); ok {
				row.Config = m
			}
		}
	}
	if desired.Valid && (desired.String == "running" || desired.String == "stopped") {
		d := desired.String
		row.WorkerDesired = &d
	}
	if version.Valid {
		v := version.String
		row.WorkerVersion = &v
	}
	return &row, nil
}

// List is every install of an app, oldest first.
func (r *Repo) List(ctx context.Context, app string) ([]*Installed, error) {
	h, err := r.adb(ctx, app)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT `+installedCols+`
           FROM app_plugins ORDER BY installed_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Installed
	for rows.Next() {
		row, err := scanInstalled(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Get returns one install (nil when absent).
func (r *Repo) Get(ctx context.Context, app, pluginID string) (*Installed, error) {
	h, err := r.adb(ctx, app)
	if err != nil {
		return nil, err
	}
	row, err := scanInstalled(h.QueryRowContext(ctx, `SELECT `+installedCols+`
           FROM app_plugins WHERE plugin_id = ?`, pluginID))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return row, err
}

func stringify(v any) string { s, _ := y.Stringify(v); return s }

// Install inserts a fresh install (no-op if present).
func (r *Repo) Install(ctx context.Context, app, pluginID string, config *y.Map, enabled bool) error {
	h, err := r.adb(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `INSERT OR IGNORE INTO app_plugins (plugin_id, enabled, config_json)
           VALUES (?, ?, ?)`, pluginID, boolInt(enabled), stringify(config))
	return err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Update patches enabled and/or config and bumps updated_at.
func (r *Repo) Update(ctx context.Context, app, pluginID string, enabled *bool, config *y.Map) error {
	var sets []string
	var params []any
	if enabled != nil {
		sets, params = append(sets, "enabled = ?"), append(params, boolInt(*enabled))
	}
	if config != nil {
		sets, params = append(sets, "config_json = ?"), append(params, stringify(config))
	}
	if len(sets) == 0 {
		return nil
	}
	sets = append(sets, "updated_at = datetime('now')")
	params = append(params, pluginID)
	h, err := r.adb(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `UPDATE app_plugins SET `+strings.Join(sets, ", ")+` WHERE plugin_id = ?`, params...)
	return err
}

// SetWorkerDesired records the operator intent (no updated_at bump).
func (r *Repo) SetWorkerDesired(ctx context.Context, app, pluginID, desired string) error {
	h, err := r.adb(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `UPDATE app_plugins SET worker_desired = ? WHERE plugin_id = ?`, desired, pluginID)
	return err
}

// SetWorkerVersion pins (or unpins with nil) the appstore version.
func (r *Repo) SetWorkerVersion(ctx context.Context, app, pluginID string, version *string) error {
	h, err := r.adb(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `UPDATE app_plugins SET worker_version = ? WHERE plugin_id = ?`, nullable(version), pluginID)
	return err
}

func nullable(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// Remove deletes an install.
func (r *Repo) Remove(ctx context.Context, app, pluginID string) error {
	h, err := r.adb(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `DELETE FROM app_plugins WHERE plugin_id = ?`, pluginID)
	return err
}

// ---------------------------------------------------------------------------

// VersionChange is one pin-history row.
type VersionChange struct {
	ID       int64   `json:"id"`
	PluginID string  `json:"pluginId"`
	From     *string `json:"from"`
	To       *string `json:"to"`
	At       string  `json:"at"`
}

// History is PluginVersionHistoryRepository.
type History struct {
	store   *db.Service
	mu      sync.Mutex
	ensured map[string]bool
}

// NewHistory builds the repository.
func NewHistory(store *db.Service) *History {
	return &History{store: store, ensured: map[string]bool{}}
}

const historyDDL = `CREATE TABLE IF NOT EXISTS plugin_version_history (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           plugin_id TEXT NOT NULL,
           from_version TEXT,
           to_version TEXT,
           changed_at TEXT NOT NULL DEFAULT (datetime('now'))
         )`

func (r *History) adb(ctx context.Context, app string) (*sql.DB, error) {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.ensured[app] {
		_, _ = h.ExecContext(ctx, historyDDL)
		r.ensured[app] = true
	}
	return h, nil
}

// Record appends a change.
func (r *History) Record(ctx context.Context, app, pluginID string, from, to *string) error {
	h, err := r.adb(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `INSERT INTO plugin_version_history (plugin_id, from_version, to_version)
           VALUES (?, ?, ?)`, pluginID, nullable(from), nullable(to))
	return err
}

// List is an install's history, newest first.
func (r *History) List(ctx context.Context, app, pluginID string, limit int) []VersionChange {
	out := []VersionChange{}
	h, err := r.adb(ctx, app)
	if err != nil {
		return out
	}
	rows, err := h.QueryContext(ctx, `SELECT id, plugin_id, from_version, to_version, changed_at
             FROM plugin_version_history
            WHERE plugin_id = ?
            ORDER BY id DESC
            LIMIT ?`, pluginID, max(1, limit))
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var c VersionChange
		var from, to sql.NullString
		if rows.Scan(&c.ID, &c.PluginID, &from, &to, &c.At) == nil {
			if from.Valid {
				c.From = &from.String
			}
			if to.Valid {
				c.To = &to.String
			}
			out = append(out, c)
		}
	}
	return out
}

// Latest is the most recent change (nil when none).
func (r *History) Latest(ctx context.Context, app, pluginID string) *VersionChange {
	if l := r.List(ctx, app, pluginID, 1); len(l) > 0 {
		return &l[0]
	}
	return nil
}
