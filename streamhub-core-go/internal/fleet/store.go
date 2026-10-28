package fleet

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite" // "sqlite" driver

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of fleet.store.ts: per-app persistence in apps/<app>/fleet/fleet.db
// (its own SQLite file, NOT app.db), opened lazily and cached per app.

// migration is the store DDL, verbatim.
const migration = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id      TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'offline',
  version       TEXT,
  first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
  last_status_at TEXT,
  telemetry_json TEXT
);
CREATE TABLE IF NOT EXISTS telemetry_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id  TEXT NOT NULL,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  cpu       REAL,
  mem       REAL,
  temp      REAL,
  disk      REAL,
  cameras   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hist_agent_ts ON telemetry_history(agent_id, id);
CREATE TABLE IF NOT EXISTS commands (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  command     TEXT NOT NULL,
  args_json   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cmd_agent ON commands(agent_id, created_at);
`

// AgentRow is one registry row.
type AgentRow struct {
	AgentID      string
	Status       string // online | offline
	Version      *string
	FirstSeen    string
	LastSeen     string
	LastStatusAt *string
	Telemetry    *y.Map // nil when absent / corrupt
}

// HistoryPoint is one telemetry sample.
type FleetHistoryPoint struct {
	Ts      string   `json:"ts"`
	Cpu     *float64 `json:"cpu"`
	Mem     *float64 `json:"mem"`
	Temp    *float64 `json:"temp"`
	Disk    *float64 `json:"disk"`
	Cameras *float64 `json:"cameras"`
}

// CommandRow is one issued command.
type FleetCommandRow struct {
	ID         string  `json:"id"`
	AgentID    string  `json:"agentId"`
	Command    string  `json:"command"`
	Args       *y.Map  `json:"args"`
	Status     string  `json:"status"`
	Result     *y.Map  `json:"result"`
	CreatedAt  string  `json:"createdAt"`
	ResolvedAt *string `json:"resolvedAt"`
}

// Store is FleetStore.
type Store struct {
	mu  sync.Mutex
	dbs map[string]*sql.DB
	// FileFor resolves the DB path (default <appDir>/fleet/fleet.db).
	FileFor func(appDir string) string
	now     func() time.Time
}

// NewStore builds an empty store.
func NewStore() *Store {
	return &Store{
		dbs:     map[string]*sql.DB{},
		FileFor: func(appDir string) string { return filepath.Join(appDir, "fleet", "fleet.db") },
		now:     time.Now,
	}
}

func (s *Store) nowISO() string { return jsx.ISO(s.now()) }

// DB opens (create + migrate) and caches the per-app fleet.db.
func (s *Store) DB(ctx context.Context, app, appDir string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h, ok := s.dbs[app]; ok {
		return h, nil
	}
	file := s.FileFor(appDir)
	if err := os.MkdirAll(filepath.Dir(file), 0o777); err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(5000)")
	h, err := sql.Open("sqlite", "file:"+file+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	if _, err := h.ExecContext(ctx, migration); err != nil {
		_ = h.Close()
		return nil, err
	}
	s.dbs[app] = h
	return h, nil
}

// CloseApp drops a cached handle.
func (s *Store) CloseApp(app string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h, ok := s.dbs[app]; ok {
		delete(s.dbs, app)
		_ = h.Close()
	}
}

// Close closes every handle (onModuleDestroy).
func (s *Store) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for app, h := range s.dbs {
		_ = h.Close()
		delete(s.dbs, app)
	}
}

func finite(v any) any {
	if f, ok := v.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
		return f
	}
	return nil
}

// RecordTelemetry upserts the agent (→ online) and appends a history point,
// pruning the agent's history to historyCap (newest kept).
func (s *Store) RecordTelemetry(ctx context.Context, app, appDir, agentID string, t *y.Map, historyCap float64) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	now := s.nowISO()
	var version any
	if v, ok := t.Get("agentVersion").(string); ok {
		version = v
	}
	raw, _ := y.Stringify(t)
	if _, err := h.ExecContext(ctx, `INSERT INTO agents (agent_id, status, version, first_seen, last_seen, telemetry_json)
         VALUES (?, 'online', ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         status = 'online',
         version = COALESCE(excluded.version, agents.version),
         last_seen = excluded.last_seen,
         telemetry_json = excluded.telemetry_json`, agentID, version, now, now, raw); err != nil {
		return err
	}
	if _, err := h.ExecContext(ctx, `INSERT INTO telemetry_history (agent_id, ts, cpu, mem, temp, disk, cameras)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, agentID, now,
		finite(t.Get("cpu")), finite(t.Get("mem")), finite(t.Get("temp")), finite(t.Get("disk")), finite(t.Get("cameras"))); err != nil {
		return err
	}
	cap := int64(math.Max(1, math.Floor(historyCap)))
	_, err = h.ExecContext(ctx, `DELETE FROM telemetry_history
         WHERE agent_id = ?
           AND id NOT IN (
             SELECT id FROM telemetry_history
              WHERE agent_id = ? ORDER BY id DESC LIMIT ?
           )`, agentID, agentID, cap)
	return err
}

// SetStatus applies an explicit status message (version "" = none).
func (s *Store) SetStatus(ctx context.Context, app, appDir, agentID, status, version string) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	now := s.nowISO()
	var ver any
	if version != "" {
		ver = version
	}
	_, err = h.ExecContext(ctx, `INSERT INTO agents (agent_id, status, version, first_seen, last_seen, last_status_at)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         status = excluded.status,
         version = COALESCE(excluded.version, agents.version),
         last_status_at = excluded.last_status_at,
         last_seen = CASE WHEN excluded.status = 'online'
                          THEN excluded.last_seen ELSE agents.last_seen END`, agentID, status, ver, now, now, now)
	return err
}

// ReapStale flips online agents whose last_seen is older than staleMs
// (min 1 s) to offline; returns the ids flipped.
func (s *Store) ReapStale(ctx context.Context, app, appDir string, staleMs float64) ([]string, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	cutoff := jsx.ISO(s.now().Add(-time.Duration(math.Max(1000, staleMs)) * time.Millisecond))
	rows, err := h.QueryContext(ctx, `SELECT agent_id FROM agents WHERE status = 'online' AND last_seen < ?`, cutoff)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) > 0 {
		if _, err := h.ExecContext(ctx, `UPDATE agents SET status = 'offline' WHERE status = 'online' AND last_seen < ?`, cutoff); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

const agentCols = `agent_id, status, version, first_seen, last_seen, last_status_at, telemetry_json`

func scanAgent(sc interface{ Scan(...any) error }) (*AgentRow, error) {
	var r AgentRow
	var version, lastStatus, tel sql.NullString
	if err := sc.Scan(&r.AgentID, &r.Status, &version, &r.FirstSeen, &r.LastSeen, &lastStatus, &tel); err != nil {
		return nil, err
	}
	if r.Status != "online" {
		r.Status = "offline"
	}
	if version.Valid {
		r.Version = &version.String
	}
	if lastStatus.Valid {
		r.LastStatusAt = &lastStatus.String
	}
	if tel.Valid && tel.String != "" {
		if v, err := y.ParseJSON([]byte(tel.String)); err == nil {
			r.Telemetry, _ = v.(*y.Map)
		}
	}
	return &r, nil
}

// ListAgents returns every agent, by agent_id.
func (s *Store) ListAgents(ctx context.Context, app, appDir string) ([]AgentRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT `+agentCols+` FROM agents ORDER BY agent_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AgentRow{}
	for rows.Next() {
		r, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// GetAgent returns one agent (nil when absent).
func (s *Store) GetAgent(ctx context.Context, app, appDir, agentID string) (*AgentRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	r, err := scanAgent(h.QueryRowContext(ctx, `SELECT `+agentCols+` FROM agents WHERE agent_id = ?`, agentID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

func clampInt(v float64, min, max int64) int64 {
	n := int64(math.Floor(v))
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

func nullFloat(n sql.NullFloat64) *float64 {
	if !n.Valid {
		return nil
	}
	f := n.Float64
	return &f
}

// History returns the newest `limit` samples (1..1000), oldest→newest.
func (s *Store) History(ctx context.Context, app, appDir, agentID string, limit float64) ([]FleetHistoryPoint, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT ts, cpu, mem, temp, disk, cameras FROM telemetry_history
           WHERE agent_id = ? ORDER BY id DESC LIMIT ?`, agentID, clampInt(limit, 1, 1000))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pts []FleetHistoryPoint
	for rows.Next() {
		var p FleetHistoryPoint
		var cpu, mem, temp, disk, cams sql.NullFloat64
		if err := rows.Scan(&p.Ts, &cpu, &mem, &temp, &disk, &cams); err != nil {
			return nil, err
		}
		p.Cpu, p.Mem, p.Temp, p.Disk, p.Cameras = nullFloat(cpu), nullFloat(mem), nullFloat(temp), nullFloat(disk), nullFloat(cams)
		pts = append(pts, p)
	}
	out := make([]FleetHistoryPoint, 0, len(pts))
	for i := len(pts) - 1; i >= 0; i-- {
		out = append(out, pts[i])
	}
	return out, rows.Err()
}

// RecordCommand inserts a pending command.
func (s *Store) RecordCommand(ctx context.Context, app, appDir, id, agentID, command string, args *y.Map) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	raw, _ := y.Stringify(args)
	_, err = h.ExecContext(ctx, `INSERT INTO commands (id, agent_id, command, args_json, status)
           VALUES (?, ?, ?, ?, 'pending')`, id, agentID, command, raw)
	return err
}

// ResolveCommand resolves a pending command from a cmd/result body.
func (s *Store) ResolveCommand(ctx context.Context, app, appDir string, result *y.Map) (bool, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return false, err
	}
	status := "error"
	if result.Get("ok") == true {
		status = "ok"
	}
	raw, _ := y.Stringify(result)
	id, _ := result.Get("id").(string)
	res, err := h.ExecContext(ctx, `UPDATE commands
            SET status = ?, result_json = ?, resolved_at = ?
          WHERE id = ? AND status = 'pending'`, status, raw, s.nowISO(), id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

const commandCols = `id, agent_id, command, args_json, status, result_json, created_at, resolved_at`

func parseObj(raw sql.NullString) *y.Map {
	if raw.Valid && raw.String != "" {
		if v, err := y.ParseJSON([]byte(raw.String)); err == nil {
			if m, ok := v.(*y.Map); ok && m != nil {
				return m
			}
		}
	}
	return y.NewMap()
}

func scanCommand(sc interface{ Scan(...any) error }) (*FleetCommandRow, error) {
	var r FleetCommandRow
	var args, result, resolved sql.NullString
	if err := sc.Scan(&r.ID, &r.AgentID, &r.Command, &args, &r.Status, &result, &r.CreatedAt, &resolved); err != nil {
		return nil, err
	}
	if r.Status != "ok" && r.Status != "error" {
		r.Status = "pending"
	}
	r.Args = parseObj(args)
	if result.Valid && result.String != "" {
		r.Result = parseObj(result)
	}
	if resolved.Valid {
		r.ResolvedAt = &resolved.String
	}
	return &r, nil
}

// GetCommand returns one command (nil when absent).
func (s *Store) GetCommand(ctx context.Context, app, appDir, id string) (*FleetCommandRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	r, err := scanCommand(h.QueryRowContext(ctx, `SELECT `+commandCols+` FROM commands WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

// CommandsFor returns an agent's newest commands (limit 1..200).
func (s *Store) CommandsFor(ctx context.Context, app, appDir, agentID string, limit int64) ([]FleetCommandRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = 1
	} else if limit > 200 {
		limit = 200
	}
	rows, err := h.QueryContext(ctx, `SELECT `+commandCols+` FROM commands WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FleetCommandRow{}
	for rows.Next() {
		r, err := scanCommand(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}
