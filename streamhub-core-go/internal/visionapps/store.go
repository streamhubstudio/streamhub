package visionapps

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of vision.store.ts: apps/<app>/<model>/<model>.db, one file per
// (app, model), each with its own event table + stream_settings. DDL is
// verbatim; the event table is bounded history (RetentionDays).

// RetentionDays bounds the event tables.
const RetentionDays = 30

var eventTable = map[string]string{
	"occupancy":  "occupancy_sessions",
	"counting":   "count_events",
	"crowd":      "crowd_events",
	"demography": "demography_events",
}

var eventTableDDL = map[string]string{
	"occupancy": `
CREATE TABLE IF NOT EXISTS occupancy_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  zone        TEXT,
  tag         TEXT,
  kind        TEXT,
  node_id     TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT,
  duration_sec REAL,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_occ_ts ON occupancy_sessions(ts);`,
	"counting": `
CREATE TABLE IF NOT EXISTS count_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  line        TEXT,
  tag         TEXT,
  direction   TEXT,
  track_id    TEXT,
  inside      INTEGER,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_count_ts ON count_events(ts);`,
	"crowd": `
CREATE TABLE IF NOT EXISTS crowd_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  zone        TEXT,
  tag         TEXT,
  count       INTEGER,
  threshold   INTEGER,
  alert       INTEGER NOT NULL DEFAULT 0,
  snapshot_url TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_crowd_ts ON crowd_events(ts);`,
	"demography": `
CREATE TABLE IF NOT EXISTS demography_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  tag         TEXT,
  age         REAL,
  age_range   TEXT,
  gender      TEXT,
  emotion     TEXT,
  engine      TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_demo_ts ON demography_events(ts);`,
}

const streamSettingsDDL = `
CREATE TABLE IF NOT EXISTS stream_settings (
  room        TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room)
);`

// SettingRow is one stored per-room override.
type SettingRow struct {
	Room      string
	Config    *y.Map
	UpdatedAt string
}

// EventRow is a recorded detection event.
type VisionEventRow struct {
	ID    int64   `json:"id"`
	Model string  `json:"model"`
	Event string  `json:"event"`
	Room  string  `json:"room"`
	Tag   *string `json:"tag"`
	TS    string  `json:"ts"`
	Data  *y.Map  `json:"data"`
}

// Store is VisionStore.
type Store struct {
	mu  sync.Mutex
	dbs map[string]*sql.DB
	// FileFor resolves the db path (test seam).
	FileFor func(appDir, model string) string
	now     func() time.Time
}

// NewStore builds the store.
func NewStore() *Store {
	return &Store{dbs: map[string]*sql.DB{}, now: time.Now,
		FileFor: func(appDir, model string) string { return filepath.Join(appDir, model, model+".db") }}
}

// DB opens (create + migrate) and caches the per-(app, model) db.
func (s *Store) DB(ctx context.Context, app, appDir, model string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := app + "::" + model
	if h, ok := s.dbs[key]; ok {
		return h, nil
	}
	file := s.FileFor(appDir, model)
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
	if _, err := h.ExecContext(ctx, eventTableDDL[model]+streamSettingsDDL); err != nil {
		_ = h.Close()
		return nil, err
	}
	s.dbs[key] = h
	return h, nil
}

// Close drops every cached handle of an app.
func (s *Store) Close(app string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range Models {
		if h, ok := s.dbs[app+"::"+m]; ok {
			delete(s.dbs, app+"::"+m)
			_ = h.Close()
		}
	}
}

// CloseAll closes every handle.
func (s *Store) CloseAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, h := range s.dbs {
		_ = h.Close()
		delete(s.dbs, k)
	}
}

// GetSetting returns a room's override (nil when none).
func (s *Store) GetSetting(ctx context.Context, app, appDir, model, room string) (*SettingRow, error) {
	h, err := s.DB(ctx, app, appDir, model)
	if err != nil {
		return nil, err
	}
	var r SettingRow
	var cfg string
	err = h.QueryRowContext(ctx, `SELECT room, config_json, updated_at FROM stream_settings WHERE room = ?`, room).Scan(&r.Room, &cfg, &r.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Config = y.NewMap()
	if v, err := y.ParseJSON([]byte(cfg)); err == nil {
		if m, ok := v.(*y.Map); ok {
			r.Config = m
		}
	}
	return &r, nil
}

// PutSetting upserts a room override.
func (s *Store) PutSetting(ctx context.Context, app, appDir, model, room string, config *y.Map) (*SettingRow, error) {
	h, err := s.DB(ctx, app, appDir, model)
	if err != nil {
		return nil, err
	}
	if config == nil {
		config = y.NewMap()
	}
	js, _ := y.Stringify(config)
	if _, err := h.ExecContext(ctx, `INSERT INTO stream_settings (room, config_json, updated_at)
           VALUES (?, ?, datetime('now'))
         ON CONFLICT(room) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`, room, js); err != nil {
		return nil, err
	}
	return s.GetSetting(ctx, app, appDir, model, room)
}

// str is `v == null ? null : String(v)`.
func str(v any) any {
	if y.IsNullish(v) {
		return nil
	}
	return y.ToString(v)
}

// numOrNull: booleans → 1/0, numeric strings → numbers, else finite or null.
func numOrNull(v any) any {
	if b, ok := v.(bool); ok {
		if b {
			return 1.0
		}
		return 0.0
	}
	if f, ok := num(v); ok {
		return f
	}
	return nil
}

func (s *Store) record(ctx context.Context, app, appDir, model, q string, args ...any) error {
	h, err := s.DB(ctx, app, appDir, model)
	if err != nil {
		return err
	}
	if _, err := h.ExecContext(ctx, q, args...); err != nil {
		return err
	}
	cutoff := jsx.ISO(s.now().Add(-RetentionDays * 24 * time.Hour))
	_, err = h.ExecContext(ctx, `DELETE FROM `+eventTable[model]+` WHERE ts < ?`, cutoff)
	return err
}

// RecordOccupancy / RecordCount / RecordCrowd / RecordDemography insert one
// event and prune the table.
func (s *Store) RecordOccupancy(ctx context.Context, app, appDir, room, _ string, d *y.Map) error {
	return s.record(ctx, app, appDir, "occupancy", `INSERT INTO occupancy_sessions (room, zone, tag, kind, node_id, duration_sec)
         VALUES (?, ?, ?, ?, ?, ?)`, room, str(d.Get("zone")), str(d.Get("tag")), str(d.Get("kind")), str(d.Get("nodeId")), numOrNull(d.Get("durationSec")))
}

func (s *Store) RecordCount(ctx context.Context, app, appDir, room, event string, d *y.Map) error {
	var direction any
	switch event {
	case "count.in":
		direction = "in"
	case "count.out":
		direction = "out"
	}
	return s.record(ctx, app, appDir, "counting", `INSERT INTO count_events (room, line, tag, direction, track_id, inside)
         VALUES (?, ?, ?, ?, ?, ?)`, room, str(d.Get("line")), str(d.Get("tag")), direction, str(d.Get("trackId")), numOrNull(d.Get("inside")))
}

func (s *Store) RecordCrowd(ctx context.Context, app, appDir, room, event string, d *y.Map) error {
	alert := 0
	if event == "crowd.threshold" {
		alert = 1
	}
	return s.record(ctx, app, appDir, "crowd", `INSERT INTO crowd_events (room, zone, tag, count, threshold, alert, snapshot_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, room, str(d.Get("zone")), str(d.Get("tag")), numOrNull(d.Get("count")), numOrNull(d.Get("threshold")), alert, str(d.Get("snapshotUrl")))
}

func (s *Store) RecordDemography(ctx context.Context, app, appDir, room, _ string, d *y.Map) error {
	return s.record(ctx, app, appDir, "demography", `INSERT INTO demography_events (room, tag, age, age_range, gender, emotion, engine)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, room, str(d.Get("tag")), numOrNull(d.Get("age")), str(d.Get("ageRange")), str(d.Get("gender")), str(d.Get("emotion")), str(d.Get("engine")))
}

// sqlValue is a better-sqlite3 row value (numbers are JS numbers).
func sqlValue(v any) any {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case []byte:
		return string(x)
	}
	return v
}

// RecentEvents returns a model's newest events (capped 1..1000).
func (s *Store) RecentEvents(ctx context.Context, app, appDir, model string, limit int) ([]VisionEventRow, error) {
	h, err := s.DB(ctx, app, appDir, model)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	limit = max(1, min(1000, limit))
	rows, err := h.QueryContext(ctx, `SELECT * FROM `+eventTable[model]+` ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []VisionEventRow{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		out = append(out, mapEvent(model, cols, vals))
	}
	return out, rows.Err()
}

func mapEvent(model string, cols []string, vals []any) VisionEventRow {
	ev := VisionEventRow{Model: model, Data: y.NewMap()}
	var room, ts any
	for i, c := range cols {
		v := sqlValue(vals[i])
		switch c {
		case "id":
			ev.ID = int64(y.ToNumber(v))
		case "room":
			room = v
		case "tag":
			if s, ok := v.(string); ok {
				ev.Tag = &s
			}
		case "ts":
			ts = v
		default:
			ev.Data.Set(c, v)
		}
	}
	ev.Room = y.ToString(y.Coalesce(room, ""))
	ev.TS = y.ToString(y.Coalesce(ts, ""))
	switch model {
	case "counting":
		switch ev.Data.Get("direction") {
		case "in":
			ev.Event = "count.in"
		case "out":
			ev.Event = "count.out"
		default:
			ev.Event = "count.occupancy"
		}
	case "crowd":
		ev.Event = "crowd.count"
		if y.Truthy(ev.Data.Get("alert")) {
			ev.Event = "crowd.threshold"
		}
	case "occupancy":
		ev.Event = "occupancy.session_started"
		if y.Truthy(ev.Data.Get("ended_at")) {
			ev.Event = "occupancy.session_ended"
		}
	default:
		ev.Event = "demography.face"
	}
	return ev
}

// CountSince counts a model's rows since an ISO cutoff.
func (s *Store) CountSince(ctx context.Context, app, appDir, model, sinceISO string) (int64, error) {
	h, err := s.DB(ctx, app, appDir, model)
	if err != nil {
		return 0, err
	}
	var n int64
	err = h.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM `+eventTable[model]+` WHERE ts >= ?`, sinceISO).Scan(&n)
	return n, err
}
