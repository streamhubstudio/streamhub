// Package dbadmin ports modules/db-admin (GET/POST /apps/:app/db/*,
// GET /system/db/health) and shared/db/db-maintenance.service.ts: PRAGMA
// health snapshots, the optimize tune-up and the side-effect-free purges.
package dbadmin

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"os"
	"sync"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
)

// TableHealth is one table's row count (+ bytes when dbstat is available).
type TableHealth struct {
	Name  string `json:"name"`
	Rows  int64  `json:"rows"`
	Bytes *int64 `json:"bytes,omitempty"`
}

// Health is a SQLite health snapshot of one file.
type Health struct {
	Path             string        `json:"path"`
	SizeBytes        int64         `json:"sizeBytes"`
	WalSizeBytes     int64         `json:"walSizeBytes"`
	PageCount        int64         `json:"pageCount"`
	FreelistCount    int64         `json:"freelistCount"`
	FragmentationPct float64       `json:"fragmentationPct"`
	Tables           []TableHealth `json:"tables"`
}

// Sizes is the before/after block of an optimize run.
type Sizes struct {
	SizeBytes     int64 `json:"sizeBytes"`
	WalSizeBytes  int64 `json:"walSizeBytes"`
	FreelistCount int64 `json:"freelistCount"`
}

// OptimizeResult is DbOptimizeResult.
type OptimizeResult struct {
	Path           string   `json:"path"`
	Steps          []string `json:"steps"`
	Before         Sizes    `json:"before"`
	After          Sizes    `json:"after"`
	ReclaimedBytes int64    `json:"reclaimedBytes"`
}

// Maintenance is DbMaintenanceService.
type Maintenance struct {
	store  *db.Service
	global *sql.DB
	log    *slog.Logger

	mu    sync.Mutex
	locks map[string]*sync.Mutex // one optimize at a time per file
}

// NewMaintenance builds the service.
func NewMaintenance(store *db.Service, global *sql.DB, log *slog.Logger) *Maintenance {
	return &Maintenance{store: store, global: global, log: log, locks: map[string]*sync.Mutex{}}
}

// GlobalHealth is the registry DB snapshot.
func (m *Maintenance) GlobalHealth(ctx context.Context) Health {
	return m.health(ctx, m.global, m.store.GlobalPath())
}

// AppHealth is the app DB snapshot (the DB is created when missing, as
// DbService.appDb does).
func (m *Maintenance) AppHealth(ctx context.Context, app string) (Health, error) {
	h, err := m.store.App(ctx, app)
	if err != nil {
		return Health{}, err
	}
	return m.health(ctx, h, m.store.AppPath(app)), nil
}

func (m *Maintenance) health(ctx context.Context, h *sql.DB, file string) Health {
	pages := pragmaInt(ctx, h, "page_count")
	free := pragmaInt(ctx, h, "freelist_count")
	frag := 0.0
	if pages > 0 {
		frag = math.Round(float64(free)/float64(pages)*10000) / 100
	}
	return Health{
		Path: file, SizeBytes: fileSize(file), WalSizeBytes: fileSize(file + "-wal"),
		PageCount: pages, FreelistCount: free, FragmentationPct: frag, Tables: m.tables(ctx, h),
	}
}

func (m *Maintenance) tables(ctx context.Context, h *sql.DB) []TableHealth {
	rows, err := h.QueryContext(ctx, `SELECT name FROM sqlite_master
               WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
               ORDER BY name`)
	if err != nil {
		m.log.Warn("table enumeration failed: " + err.Error())
		return []TableHealth{}
	}
	var names []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			names = append(names, n)
		}
	}
	rows.Close()

	bytes := tableBytes(ctx, h)
	out := make([]TableHealth, 0, len(names))
	for _, name := range names {
		var n int64
		if err := h.QueryRowContext(ctx, fmt.Sprintf(`SELECT COUNT(*) AS c FROM "%s"`, name)).Scan(&n); err != nil {
			m.log.Warn(fmt.Sprintf("count on %s failed: %s", name, err))
		}
		t := TableHealth{Name: name, Rows: n}
		if bytes != nil {
			if b, ok := bytes[name]; ok {
				t.Bytes = &b
			}
		}
		out = append(out, t)
	}
	return out
}

// tableBytes aggregates dbstat pages per table; nil when dbstat is absent.
func tableBytes(ctx context.Context, h *sql.DB) map[string]int64 {
	rows, err := h.QueryContext(ctx, `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var (
			name  string
			bytes sql.NullInt64
		)
		if rows.Scan(&name, &bytes) == nil {
			out[name] = bytes.Int64
		}
	}
	if rows.Err() != nil {
		return nil
	}
	return out
}

// OptimizeGlobal tunes up the registry DB.
func (m *Maintenance) OptimizeGlobal(ctx context.Context) OptimizeResult {
	return m.optimize(ctx, m.store.GlobalPath())
}

// OptimizeApp tunes up an app DB (created when missing, as Node).
func (m *Maintenance) OptimizeApp(ctx context.Context, app string) (OptimizeResult, error) {
	if _, err := m.store.App(ctx, app); err != nil {
		return OptimizeResult{}, err
	}
	return m.optimize(ctx, m.store.AppPath(app)), nil
}

// optimize runs PRAGMA optimize → ANALYZE → REINDEX → VACUUM →
// wal_checkpoint(TRUNCATE) on a DEDICATED connection, in a background
// goroutine detached from the request context (an aborted request never
// interrupts a VACUUM halfway). The pooled handles keep serving meanwhile
// (WAL); the caller waits for the before/after report.
func (m *Maintenance) optimize(ctx context.Context, file string) OptimizeResult {
	lock := m.lockFor(file)
	done := make(chan OptimizeResult, 1)
	go func() {
		lock.Lock()
		defer lock.Unlock()
		done <- m.runOptimize(context.WithoutCancel(ctx), file)
	}()
	return <-done
}

func (m *Maintenance) runOptimize(ctx context.Context, file string) OptimizeResult {
	h, err := sql.Open("sqlite", dedicatedDSN(file))
	steps := []string{}
	if err != nil {
		for _, l := range optimizeSteps {
			steps = append(steps, fmt.Sprintf("%s (skipped: %s)", l.label, err))
		}
		return OptimizeResult{Path: file, Steps: steps}
	}
	defer h.Close()
	h.SetMaxOpenConns(1)

	before := sizes(ctx, h, file)
	for _, st := range optimizeSteps {
		if _, err := h.ExecContext(ctx, st.sql); err != nil {
			m.log.Warn(fmt.Sprintf("optimize step %q failed: %s", st.label, err))
			steps = append(steps, fmt.Sprintf("%s (skipped: %s)", st.label, err))
			continue
		}
		steps = append(steps, st.label)
	}
	after := sizes(ctx, h, file)
	return OptimizeResult{Path: file, Steps: steps, Before: before, After: after, ReclaimedBytes: max(0, before.SizeBytes-after.SizeBytes)}
}

var optimizeSteps = []struct{ label, sql string }{
	{"PRAGMA optimize", "PRAGMA optimize"},
	{"ANALYZE", "ANALYZE"},
	{"REINDEX", "REINDEX"},
	{"VACUUM", "VACUUM"},
	{"wal_checkpoint(TRUNCATE)", "PRAGMA wal_checkpoint(TRUNCATE)"},
}

func (m *Maintenance) lockFor(file string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.locks[file]
	if !ok {
		l = &sync.Mutex{}
		m.locks[file] = l
	}
	return l
}

// dedicatedDSN mirrors the pooled handles' per-connection pragmas.
func dedicatedDSN(file string) string {
	q := url.Values{}
	for _, p := range []string{"journal_mode(WAL)", "foreign_keys(1)", "busy_timeout(5000)", "synchronous(NORMAL)"} {
		q.Add("_pragma", p)
	}
	return "file:" + file + "?" + q.Encode()
}

func sizes(ctx context.Context, h *sql.DB, file string) Sizes {
	return Sizes{SizeBytes: fileSize(file), WalSizeBytes: fileSize(file + "-wal"), FreelistCount: pragmaInt(ctx, h, "freelist_count")}
}

// PurgeAppStreams deletes every streams row of the app DB.
func (m *Maintenance) PurgeAppStreams(ctx context.Context, app string) (int64, error) {
	h, err := m.store.App(ctx, app)
	if err != nil {
		return 0, err
	}
	res, err := h.ExecContext(ctx, `DELETE FROM streams`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// PurgeAppLogs deletes the app's server_logs rows (global DB, by app_id).
func (m *Maintenance) PurgeAppLogs(ctx context.Context, app string) (int64, error) {
	var id int64
	err := m.global.QueryRowContext(ctx, `SELECT id FROM apps WHERE name = ?`, app).Scan(&id)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	res, err := m.global.ExecContext(ctx, `DELETE FROM server_logs WHERE app_id = ?`, id)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func pragmaInt(ctx context.Context, h *sql.DB, name string) int64 {
	var n sql.NullInt64
	if err := h.QueryRowContext(ctx, "PRAGMA "+name).Scan(&n); err != nil {
		return 0
	}
	return n.Int64
}

func fileSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}
