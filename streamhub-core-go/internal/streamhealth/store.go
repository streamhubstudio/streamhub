package streamhealth

import (
	"context"
	"database/sql"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // "sqlite" driver

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// RetentionDays is the health_events history horizon.
const RetentionDays = 30

// ddl is stream-health.store.ts DDL, verbatim.
const ddl = `
CREATE TABLE IF NOT EXISTS health_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  room      TEXT NOT NULL,
  event     TEXT NOT NULL,
  status    TEXT,
  reasons   TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  ts        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_health_events_ts ON health_events(ts);
CREATE INDEX IF NOT EXISTS idx_health_events_room ON health_events(room);
CREATE TABLE IF NOT EXISTS stream_settings (
  room        TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room)
);`

// HealthEventRow is one recorded health.* transition.
type HealthEventRow struct {
	ID      int64   `json:"id"`
	Room    string  `json:"room"`
	Event   string  `json:"event"`
	Status  *string `json:"status"`
	Reasons *string `json:"reasons"`
	Ts      string  `json:"ts"`
	Data    *y.Map  `json:"data"`
}

// SettingRow is one stored per-room override.
type SettingRow struct {
	Room      string
	Override  *y.Map
	UpdatedAt string
}

// RoomSeen is a room of the history with its latest event.
type RoomSeen struct {
	Room, LastEvent, LastTs string
}

// Store is the per-app stream-health.db repository (opened lazily, cached).
type Store struct {
	mu  sync.Mutex
	dbs map[string]*sql.DB
	now func() time.Time
}

// NewStore builds the store.
func NewStore(now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{dbs: map[string]*sql.DB{}, now: now}
}

// FileFor is apps/<app>/stream-health/stream-health.db.
func FileFor(appDir string) string { return filepath.Join(appDir, "stream-health", "stream-health.db") }

// DB opens (create + migrate) and caches the per-app handle.
func (s *Store) DB(app, appDir string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h := s.dbs[app]; h != nil {
		return h, nil
	}
	file := FileFor(appDir)
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
	if _, err := h.Exec(ddl); err != nil {
		_ = h.Close()
		return nil, err
	}
	s.dbs[app] = h
	return h, nil
}

// Close drops one cached handle.
func (s *Store) Close(app string) {
	s.mu.Lock()
	h := s.dbs[app]
	delete(s.dbs, app)
	s.mu.Unlock()
	if h != nil {
		_ = h.Close()
	}
}

// CloseAll drops every handle (shutdown).
func (s *Store) CloseAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, h := range s.dbs {
		_ = h.Close()
		delete(s.dbs, k)
	}
}

// Record stores one health.* event (ts as ISO so cutoffs compare
// like-with-like) and prunes rows older than the retention window.
func (s *Store) Record(ctx context.Context, app, appDir, room, event string, data *y.Map) error {
	h, err := s.DB(app, appDir)
	if err != nil {
		return err
	}
	if data == nil {
		data = y.NewMap()
	}
	var status, reasons any
	if st, ok := data.Get("status").(string); ok {
		status = st
	}
	if arr, ok := data.Get("reasons").([]any); ok {
		parts := make([]string, len(arr))
		for i, r := range arr {
			parts[i] = y.ToString(r)
		}
		reasons = strings.Join(parts, ",")
	}
	enc, err := y.Stringify(data)
	if err != nil {
		enc = "{}"
	}
	now := s.now()
	if _, err := h.ExecContext(ctx, `INSERT INTO health_events (room, event, status, reasons, data_json, ts)
         VALUES (?, ?, ?, ?, ?, ?)`, room, event, status, reasons, enc, jsx.ISO(now)); err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, "DELETE FROM health_events WHERE ts < ?", jsx.ISO(now.Add(-RetentionDays*24*time.Hour)))
	return err
}

// RecentEvents is newest first (capped 1..1000), optionally one room.
func (s *Store) RecentEvents(ctx context.Context, app, appDir string, limit float64, room string) ([]HealthEventRow, error) {
	f := math.Floor(limit) // Math.floor(limit) || 50
	if math.IsNaN(f) || f == 0 {
		f = 50
	}
	capN := int(math.Max(1, math.Min(1000, f)))
	h, err := s.DB(app, appDir)
	if err != nil {
		return nil, err
	}
	var rows *sql.Rows
	const cols = "SELECT id, room, event, status, reasons, data_json, ts FROM health_events"
	if room != "" {
		rows, err = h.QueryContext(ctx, cols+" WHERE room = ? ORDER BY id DESC LIMIT ?", room, capN)
	} else {
		rows, err = h.QueryContext(ctx, cols+" ORDER BY id DESC LIMIT ?", capN)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HealthEventRow{}
	for rows.Next() {
		var r HealthEventRow
		var status, reasons, data sql.NullString
		if err := rows.Scan(&r.ID, &r.Room, &r.Event, &status, &reasons, &data, &r.Ts); err != nil {
			return nil, err
		}
		if status.Valid {
			r.Status = &status.String
		}
		if reasons.Valid {
			r.Reasons = &reasons.String
		}
		r.Data = parseObject(data.String)
		out = append(out, r)
	}
	return out, rows.Err()
}

// CountSince counts events since an ISO cutoff.
func (s *Store) CountSince(ctx context.Context, app, appDir, since string) (int64, error) {
	h, err := s.DB(app, appDir)
	if err != nil {
		return 0, err
	}
	var n int64
	err = h.QueryRowContext(ctx, "SELECT COUNT(*) AS n FROM health_events WHERE ts >= ?", since).Scan(&n)
	return n, err
}

// RoomsSince lists rooms seen since a cutoff with their latest event.
func (s *Store) RoomsSince(ctx context.Context, app, appDir, since string) ([]RoomSeen, error) {
	h, err := s.DB(app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT room, event AS lastEvent, ts AS lastTs FROM health_events
          WHERE id IN (SELECT MAX(id) FROM health_events WHERE ts >= ? GROUP BY room)
          ORDER BY room`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RoomSeen
	for rows.Next() {
		var r RoomSeen
		if err := rows.Scan(&r.Room, &r.LastEvent, &r.LastTs); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetSetting is one room's override (nil when none).
func (s *Store) GetSetting(ctx context.Context, app, appDir, room string) (*SettingRow, error) {
	h, err := s.DB(app, appDir)
	if err != nil {
		return nil, err
	}
	var r SettingRow
	var cfg string
	err = h.QueryRowContext(ctx, "SELECT room, config_json, updated_at FROM stream_settings WHERE room = ?", room).Scan(&r.Room, &cfg, &r.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Override = parseObject(cfg)
	return &r, nil
}

// PutSetting upserts a room's override ({} clears it).
func (s *Store) PutSetting(ctx context.Context, app, appDir, room string, override *y.Map) (*SettingRow, error) {
	h, err := s.DB(app, appDir)
	if err != nil {
		return nil, err
	}
	if override == nil {
		override = y.NewMap()
	}
	enc, _ := y.Stringify(override)
	if _, err := h.ExecContext(ctx, `INSERT INTO stream_settings (room, config_json, updated_at)
           VALUES (?, ?, ?)
         ON CONFLICT(room) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`, room, enc, jsx.ISO(s.now())); err != nil {
		return nil, err
	}
	return s.GetSetting(ctx, app, appDir, room)
}

// ListSettings lists every room with an override.
func (s *Store) ListSettings(ctx context.Context, app, appDir string) ([]SettingRow, error) {
	h, err := s.DB(app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, "SELECT room, config_json, updated_at FROM stream_settings ORDER BY room")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SettingRow
	for rows.Next() {
		var r SettingRow
		var cfg string
		if err := rows.Scan(&r.Room, &cfg, &r.UpdatedAt); err != nil {
			return nil, err
		}
		r.Override = parseObject(cfg)
		out = append(out, r)
	}
	return out, rows.Err()
}

// parseObject is the corrupt-cell-tolerant JSON object parse ({} otherwise).
func parseObject(s string) *y.Map {
	if s == "" {
		s = "{}"
	}
	if v, err := y.ParseJSON([]byte(s)); err == nil {
		if m, ok := v.(*y.Map); ok {
			return m
		}
	}
	return y.NewMap()
}
