// Package db owns every SQLite handle (SPEC §4), mirroring
// streamhub-core/src/shared/db/db.service.ts.
//
// Layout (decentralized, AntMedia-style):
//   - one global handle, <DATA_DIR>/data/streamhub.db — identity + routing
//     (tenants, users, memberships, api_tokens, quotas, the apps pointer,
//     server_logs, nodes, edge_assignments);
//   - one handle per app, <DATA_DIR>/apps/<name>/app.db — everything
//     app-scoped (streams, vods, ingress_auth, plugins, …). Cached.
//
// The schema is byte-for-byte the Node one (migrations/*.sql were exported
// from migrations.ts), tracked through PRAGMA user_version, so a DATA_DIR
// written by the Node core opens unchanged.
//
// Unlike better-sqlite3 this is not synchronous: database/sql pools
// connections, WAL lets readers run concurrently with the single writer and
// busy_timeout makes concurrent writers wait instead of failing.
package db

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

//go:embed migrations
var migrationFS embed.FS

// ColumnAdd is a column SQLite cannot add with ADD COLUMN IF NOT EXISTS.
type ColumnAdd struct {
	Table  string `json:"table"`
	Column string `json:"column"`
	DDL    string `json:"ddl"`
}

var (
	globalMigrations []string
	appMigrations    []string
	globalColumnAdds []ColumnAdd
	tenancyBackfill  []string
)

func init() {
	globalMigrations = mustLoadDir("migrations/global")
	appMigrations = mustLoadDir("migrations/app")
	mustLoadJSON("migrations/global_column_adds.json", &globalColumnAdds)
	mustLoadJSON("migrations/global_tenancy_backfill.json", &tenancyBackfill)
}

// Service owns the global handle and the per-app handle cache.
type Service struct {
	dataDir string
	log     *slog.Logger

	mu     sync.Mutex
	global *sql.DB
	apps   map[string]*sql.DB
}

// New creates the service; handles open lazily (Open opens the global one).
func New(dataDir string, log *slog.Logger) *Service {
	return &Service{dataDir: dataDir, log: log, apps: map[string]*sql.DB{}}
}

// Open eagerly opens + migrates the global DB (boot step, like onModuleInit).
func (s *Service) Open(ctx context.Context) error {
	_, err := s.Global(ctx)
	return err
}

// Close closes every handle.
func (s *Service) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var errs []error
	for name, h := range s.apps {
		errs = append(errs, h.Close())
		delete(s.apps, name)
	}
	if s.global != nil {
		errs = append(errs, s.global.Close())
		s.global = nil
	}
	return errors.Join(errs...)
}

// GlobalPath is data/streamhub.db under DATA_DIR.
func (s *Service) GlobalPath() string {
	return filepath.Join(s.dataDir, "data", "streamhub.db")
}

// AppPath is apps/<name>/app.db under DATA_DIR.
func (s *Service) AppPath(app string) string {
	return filepath.Join(s.dataDir, "apps", app, "app.db")
}

// Global returns the global registry DB, opening + migrating it on first use.
func (s *Service) Global(ctx context.Context) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.global != nil {
		return s.global, nil
	}
	file := s.GlobalPath()
	h, err := s.open(ctx, file, globalMigrations, "streamhub.db")
	if err != nil {
		return nil, err
	}
	s.applyColumnAdds(ctx, h, "streamhub.db")
	s.runIdempotent(ctx, h, tenancyBackfill, "streamhub.db")
	s.global = h
	s.splitPerApp(ctx, h, file)
	return h, nil
}

// App returns the per-app DB (created + migrated if missing), cached.
func (s *Service) App(ctx context.Context, app string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.appLocked(ctx, app)
}

func (s *Service) appLocked(ctx context.Context, app string) (*sql.DB, error) {
	if h, ok := s.apps[app]; ok {
		return h, nil
	}
	if err := validAppName(app); err != nil {
		return nil, err
	}
	h, err := s.open(ctx, s.AppPath(app), appMigrations, fmt.Sprintf("app.db[%s]", app))
	if err != nil {
		return nil, err
	}
	s.importLegacyVods(ctx, app, h)
	s.apps[app] = h
	return h, nil
}

// CloseApp drops a cached app handle (e.g. on app delete).
func (s *Service) CloseApp(app string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	h, ok := s.apps[app]
	if !ok {
		return nil
	}
	delete(s.apps, app)
	return h.Close()
}

// ReopenApp drops and recreates one cached app handle.
func (s *Service) ReopenApp(ctx context.Context, app string) (*sql.DB, error) {
	if err := s.CloseApp(app); err != nil {
		return nil, err
	}
	return s.App(ctx, app)
}

// validAppName blocks path traversal through the app segment.
func validAppName(app string) error {
	if app == "" || app == "." || app == ".." || strings.ContainsAny(app, `/\`) {
		return fmt.Errorf("invalid app name %q", app)
	}
	return nil
}

// ---------------------------------------------------------------------------
// open + migrate
// ---------------------------------------------------------------------------

// maxIdleConns is the warm-connection pool per SQLite handle.
const maxIdleConns = 32

// dsn sets the per-connection pragmas (they must apply to every pooled conn).
func dsn(file string) string {
	q := url.Values{}
	for _, p := range []string{
		"journal_mode(WAL)",
		"foreign_keys(1)",
		"busy_timeout(5000)",
		"synchronous(NORMAL)",
	} {
		q.Add("_pragma", p)
	}
	q.Set("_txlock", "immediate")
	return "file:" + file + "?" + q.Encode()
}

func (s *Service) open(ctx context.Context, file string, migrations []string, label string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(file), 0o775); err != nil {
		return nil, fmt.Errorf("%s: mkdir: %w", label, err)
	}
	h, err := sql.Open("sqlite", dsn(file))
	if err != nil {
		return nil, fmt.Errorf("%s: open: %w", label, err)
	}
	// database/sql keeps only 2 idle conns by default: above 2 concurrent
	// queries every returned conn is closed and the next request reopens one,
	// re-running the DSN pragmas (journal_mode re-parses the whole schema in
	// pure Go). Under load that churn ate >50% CPU and collapsed the API at
	// ~2.6k RPS (internal design notes).
	h.SetMaxIdleConns(maxIdleConns)
	h.SetConnMaxIdleTime(5 * time.Minute)
	if err := s.migrate(ctx, h, migrations, label); err != nil {
		h.Close()
		return nil, err
	}
	return h, nil
}

func (s *Service) migrate(ctx context.Context, h *sql.DB, migrations []string, label string) error {
	var current int
	if err := h.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("%s: user_version: %w", label, err)
	}
	if current >= len(migrations) {
		return nil
	}
	tx, err := h.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i := current; i < len(migrations); i++ {
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			return fmt.Errorf("%s: migration %d: %w", label, i+1, err)
		}
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", len(migrations))); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.log.Info("migrated", "db", label, "from", current, "to", len(migrations))
	return nil
}

// applyColumnAdds adds missing columns; failures are logged, never fatal.
func (s *Service) applyColumnAdds(ctx context.Context, h *sql.DB, label string) {
	for _, c := range globalColumnAdds {
		has, err := HasColumn(ctx, h, c.Table, c.Column)
		if err == nil && has {
			continue
		}
		if err == nil {
			_, err = h.ExecContext(ctx, c.DDL)
		}
		if err != nil {
			s.log.Error("column add failed", "db", label, "table", c.Table, "column", c.Column, "err", err)
			continue
		}
		s.log.Info("migrated: added column", "db", label, "table", c.Table, "column", c.Column)
	}
}

// HasColumn reports whether table has column (PRAGMA table_info).
func HasColumn(ctx context.Context, h *sql.DB, table, column string) (bool, error) {
	rows, err := h.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid     int
			name    string
			typ     string
			notnull int
			dflt    sql.NullString
			pk      int
		)
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (s *Service) runIdempotent(ctx context.Context, h *sql.DB, stmts []string, label string) {
	for _, q := range stmts {
		if _, err := h.ExecContext(ctx, q); err != nil {
			s.log.Error("idempotent step failed", "db", label, "err", err)
		}
	}
}

// ---------------------------------------------------------------------------
// one-shot data migrations (idempotent, non-destructive)
// ---------------------------------------------------------------------------

// splitPerApp ensures every registered app has its app.db and copies its
// ingress_auth rows there. Guarded by a _streamhub_meta flag; never fatal.
// Called with s.mu held.
func (s *Service) splitPerApp(ctx context.Context, g *sql.DB, globalFile string) {
	if v, _ := GetMeta(ctx, g, "per_app_split_done"); v == "1" {
		return
	}
	s.backupGlobal(ctx, g, globalFile)

	rows, err := g.QueryContext(ctx, "SELECT name FROM apps")
	if err != nil {
		s.log.Error("per-app split skipped", "err", err)
		return
	}
	var names []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			names = append(names, n)
		}
	}
	rows.Close()

	for _, name := range names {
		adb, err := s.appLocked(ctx, name)
		if err == nil {
			err = s.copyIngressAuth(ctx, name, adb, globalFile)
		}
		if err != nil {
			s.log.Error("per-app split failed", "app", name, "err", err)
		}
	}
	if err := SetMeta(ctx, g, "per_app_split_done", "1"); err != nil {
		s.log.Error("per-app split flag", "err", err)
		return
	}
	s.log.Info("per-app split complete", "apps", len(names))
}

func (s *Service) backupGlobal(ctx context.Context, g *sql.DB, globalFile string) {
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	bak := globalFile + ".bak-" + stamp
	if _, err := os.Stat(bak); err == nil {
		return
	}
	if _, err := g.ExecContext(ctx, fmt.Sprintf("VACUUM INTO '%s'", sqlPath(bak))); err != nil {
		s.log.Warn("global DB backup failed (continuing)", "err", err)
		return
	}
	_ = SetMeta(ctx, g, "per_app_split_backup", bak)
	s.log.Info("global DB backed up", "file", bak)
}

// importLegacyVods pulls rows from a legacy apps/<name>/vods.db once.
func (s *Service) importLegacyVods(ctx context.Context, app string, adb *sql.DB) {
	if v, _ := GetMeta(ctx, adb, "vods_import_done"); v == "1" {
		return
	}
	legacy := filepath.Join(s.dataDir, "apps", app, "vods.db")
	if _, err := os.Stat(legacy); err == nil {
		err := withAttached(ctx, adb, legacy, "legacy", func(c *sql.Conn) error {
			_, err := c.ExecContext(ctx, `
INSERT OR IGNORE INTO streams
  (id, app_id, stream_id, type, room, participant, status, started_at, ended_at, last_stats_json)
SELECT id, app_id, stream_id, type, room, participant, status, started_at, ended_at, last_stats_json
FROM legacy.streams;
INSERT OR IGNORE INTO vods
  (id, app_id, stream_id, room, name, file_key, s3_url, public_url, size_bytes, duration_s, width,
   height, format, status, local_path, started_at, ended_at, metatags_json, snapshot_key)
SELECT id, app_id, stream_id, room, name, file_key, s3_url, public_url, size_bytes, duration_s, width,
   height, format, status, local_path, started_at, ended_at, metatags_json, snapshot_key
FROM legacy.vods;`)
			return err
		})
		if err != nil {
			s.log.Error("legacy vods import failed", "app", app, "err", err)
			return
		}
		s.log.Info("imported legacy vods.db", "app", app)
	}
	if err := SetMeta(ctx, adb, "vods_import_done", "1"); err != nil {
		s.log.Error("legacy vods import flag", "app", app, "err", err)
	}
}

func (s *Service) copyIngressAuth(ctx context.Context, app string, adb *sql.DB, globalFile string) error {
	if v, _ := GetMeta(ctx, adb, "ingress_import_done"); v == "1" {
		return nil
	}
	err := withAttached(ctx, adb, globalFile, "g", func(c *sql.Conn) error {
		_, err := c.ExecContext(ctx, `
INSERT OR IGNORE INTO ingress_auth
  (ingress_id, app, room, stream_key, password_hash, password_salt, requires_password, validated_at, created_at)
SELECT ingress_id, app, room, stream_key, password_hash, password_salt, requires_password, validated_at, created_at
FROM g.ingress_auth WHERE app = ?`, app)
		return err
	})
	if err != nil {
		return err
	}
	return SetMeta(ctx, adb, "ingress_import_done", "1")
}

// withAttached runs fn on one pinned connection with file ATTACHed as alias
// (ATTACH is per-connection, so it cannot go through the pool).
func withAttached(ctx context.Context, h *sql.DB, file, alias string, fn func(*sql.Conn) error) error {
	c, err := h.Conn(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	if _, err := c.ExecContext(ctx, fmt.Sprintf("ATTACH '%s' AS %s", sqlPath(file), alias)); err != nil {
		return err
	}
	defer c.ExecContext(context.Background(), "DETACH "+alias)
	return fn(c)
}

// GetMeta reads a _streamhub_meta value ("" when missing or table absent).
func GetMeta(ctx context.Context, h *sql.DB, key string) (string, error) {
	var v sql.NullString
	err := h.QueryRowContext(ctx, "SELECT value FROM _streamhub_meta WHERE key = ?", key).Scan(&v)
	if err != nil {
		return "", err
	}
	return v.String, nil
}

// SetMeta upserts a _streamhub_meta value.
func SetMeta(ctx context.Context, h *sql.DB, key, value string) error {
	_, err := h.ExecContext(ctx, `
INSERT INTO _streamhub_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, key, value)
	return err
}

func sqlPath(p string) string { return strings.ReplaceAll(p, "'", "''") }

// ---------------------------------------------------------------------------
// embedded migration loading
// ---------------------------------------------------------------------------

func mustLoadDir(dir string) []string {
	entries, err := fs.ReadDir(migrationFS, dir)
	if err != nil {
		panic(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	out := make([]string, 0, len(names))
	for _, n := range names {
		b, err := migrationFS.ReadFile(dir + "/" + n)
		if err != nil {
			panic(err)
		}
		out = append(out, string(b))
	}
	return out
}

func mustLoadJSON(file string, v any) {
	b, err := migrationFS.ReadFile(file)
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		panic(fmt.Errorf("%s: %w", file, err))
	}
}
