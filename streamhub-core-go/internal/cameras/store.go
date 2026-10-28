package cameras

import (
	"context"
	"database/sql"
	"errors"
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

// Per-app persistence in apps/<app>/cameras/cameras.db (its own SQLite file,
// NOT app.db — the Studio App storage), opened lazily and cached per app.

const migration = `
CREATE TABLE IF NOT EXISTS cameras (
  device       TEXT PRIMARY KEY,
  name         TEXT,
  site         TEXT,
  stand        TEXT,
  model        TEXT,
  room         TEXT,
  stream_url   TEXT,
  stream_key   TEXT,
  tags_json    TEXT,
  mqtt_user    TEXT,
  mqtt_pass    TEXT,
  provisioned  INTEGER NOT NULL DEFAULT 0,
  linked_at    TEXT,
  status       TEXT NOT NULL DEFAULT 'unknown',
  status_at    TEXT,
  first_seen   TEXT,
  last_seen    TEXT,
  hello_json   TEXT,
  hello_at     TEXT,
  state_json   TEXT,
  state_at     TEXT,
  boot_id      TEXT,
  last_seq     INTEGER,
  events_lost  INTEGER NOT NULL DEFAULT 0,
  thumb        BLOB,
  thumb_at     TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  rssi        REAL,
  mem_free_kb REAL,
  load1       REAL,
  queue_bytes REAL,
  sd_free_kb  REAL,
  bitrate_kbps REAL
);
CREATE INDEX IF NOT EXISTS idx_hist_device ON state_history(device, id);
CREATE TABLE IF NOT EXISTS commands (
  id          TEXT PRIMARY KEY,
  device      TEXT NOT NULL,
  cmd         TEXT NOT NULL,
  args_json   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  pct         REAL,
  code        TEXT,
  error       TEXT,
  result_json TEXT,
  exp_s       INTEGER NOT NULL,
  long        INTEGER NOT NULL DEFAULT 0,
  boot_id     TEXT,
  actor       TEXT,
  deadline    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cmd_device ON commands(device, created_at);
CREATE INDEX IF NOT EXISTS idx_cmd_open ON commands(status, deadline);
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  device   TEXT NOT NULL,
  ts       TEXT NOT NULL,
  seq      INTEGER,
  boot_id  TEXT,
  level    TEXT NOT NULL,
  src      TEXT,
  event    TEXT,
  msg      TEXT,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_seq ON events(device, boot_id, seq) WHERE seq IS NOT NULL AND boot_id IS NOT NULL;
`

// CameraRow is one inventory row.
type CameraRow struct {
	Device      string
	Name        *string
	Site        *string
	Stand       *string
	Model       *string
	Room        *string
	StreamURL   *string
	StreamKey   *string
	Tags        []string
	MqttUser    *string
	MqttPass    *string
	Provisioned bool
	LinkedAt    *string
	Status      string // online | offline | unknown
	StatusAt    *string
	FirstSeen   *string
	LastSeen    *string
	Hello       *y.Map
	HelloAt     *string
	State       *y.Map
	StateAt     *string
	BootID      *string
	LastSeq     *int64
	EventsLost  int64
	ThumbAt     *string
	CreatedAt   string
}

// HistoryPoint is one state sample.
type CamerasHistoryPoint struct {
	Ts          string   `json:"ts"`
	Rssi        *float64 `json:"rssi"`
	MemFreeKb   *float64 `json:"memFreeKb"`
	Load1       *float64 `json:"load1"`
	QueueBytes  *float64 `json:"queueBytes"`
	SdFreeKb    *float64 `json:"sdFreeKb"`
	BitrateKbps *float64 `json:"bitrateKbps"`
}

// CommandRow is one issued command.
type CamerasCommandRow struct {
	ID         string   `json:"id"`
	Device     string   `json:"device"`
	Cmd        string   `json:"cmd"`
	Args       *y.Map   `json:"args"`
	Status     string   `json:"status" enum:"sent,pending,accepted,progress,done,failed,timeout"`
	Pct        *float64 `json:"pct"`
	Code       *string  `json:"code"`
	Error      *string  `json:"error"`
	Result     any      `json:"result"`
	ExpSec     int64    `json:"expSec"`
	Long       bool     `json:"long"`
	Actor      *string  `json:"actor"`
	Deadline   string   `json:"deadline"`
	CreatedAt  string   `json:"createdAt"`
	UpdatedAt  string   `json:"updatedAt"`
	ResolvedAt *string  `json:"resolvedAt"`
}

// EventRow is one stored event.
type CamerasEventRow struct {
	ID     int64   `json:"id"`
	Device string  `json:"device"`
	Ts     string  `json:"ts"`
	Seq    *int64  `json:"seq"`
	BootID *string `json:"bootId"`
	Level  string  `json:"level"`
	Src    *string `json:"src"`
	Event  *string `json:"event"`
	Msg    *string `json:"msg"`
	Data   *y.Map  `json:"data"`
}

// Store is the per-app cameras.db cache.
type Store struct {
	mu  sync.Mutex
	dbs map[string]*sql.DB
	// FileFor resolves the DB path (default <appDir>/cameras/cameras.db).
	FileFor func(appDir string) string
	now     func() time.Time
}

// NewStore builds an empty store.
func NewStore() *Store {
	return &Store{
		dbs:     map[string]*sql.DB{},
		FileFor: func(appDir string) string { return filepath.Join(appDir, "cameras", "cameras.db") },
		now:     time.Now,
	}
}

func (s *Store) nowISO() string { return jsx.ISO(s.now()) }

// DB opens (create + migrate) and caches the per-app cameras.db.
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

// Close closes every handle.
func (s *Store) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for app, h := range s.dbs {
		_ = h.Close()
		delete(s.dbs, app)
	}
}

func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// ensure inserts a bare (discovered) row for device when absent.
func (s *Store) ensure(ctx context.Context, h *sql.DB, device string) error {
	now := s.nowISO()
	_, err := h.ExecContext(ctx, `INSERT INTO cameras (device, first_seen, created_at) VALUES (?, ?, ?)
       ON CONFLICT(device) DO UPDATE SET first_seen = COALESCE(cameras.first_seen, excluded.first_seen)`, device, now, now)
	return err
}

// Inventory are the operator-set fields of an alta / edit (nil = unchanged).
type Inventory struct {
	Name, Site, Stand, Model, Room, StreamURL, StreamKey, MqttUser, MqttPass *string
	Tags                                                                     *[]string
}

// Upsert creates (provisioned) or updates the inventory fields of device.
// created=false when the row already existed.
func (s *Store) Upsert(ctx context.Context, app, appDir, device string, inv Inventory, provision bool) (bool, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return false, err
	}
	var exists int
	_ = h.QueryRowContext(ctx, `SELECT COUNT(*) FROM cameras WHERE device = ?`, device).Scan(&exists)
	if exists == 0 {
		if _, err := h.ExecContext(ctx, `INSERT INTO cameras (device, created_at) VALUES (?, ?)`, device, s.nowISO()); err != nil {
			return false, err
		}
	}
	sets := []string{}
	args := []any{}
	add := func(col string, v *string) {
		if v != nil {
			sets = append(sets, col+" = ?")
			if *v == "" {
				args = append(args, nil)
			} else {
				args = append(args, *v)
			}
		}
	}
	add("name", inv.Name)
	add("site", inv.Site)
	add("stand", inv.Stand)
	add("model", inv.Model)
	add("room", inv.Room)
	add("stream_url", inv.StreamURL)
	add("stream_key", inv.StreamKey)
	add("mqtt_user", inv.MqttUser)
	add("mqtt_pass", inv.MqttPass)
	if inv.Tags != nil {
		raw, _ := jsx.Stringify(*inv.Tags)
		sets = append(sets, "tags_json = ?")
		args = append(args, raw)
	}
	if provision {
		sets = append(sets, "provisioned = 1")
	}
	if len(sets) > 0 {
		args = append(args, device)
		if _, err := h.ExecContext(ctx, `UPDATE cameras SET `+strings.Join(sets, ", ")+` WHERE device = ?`, args...); err != nil {
			return false, err
		}
	}
	return exists == 0, nil
}

// Delete removes a camera and everything it owns.
func (s *Store) Delete(ctx context.Context, app, appDir, device string) (bool, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return false, err
	}
	res, err := h.ExecContext(ctx, `DELETE FROM cameras WHERE device = ?`, device)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	for _, t := range []string{"state_history", "commands", "events"} {
		if _, err := h.ExecContext(ctx, `DELETE FROM `+t+` WHERE device = ?`, device); err != nil {
			return false, err
		}
	}
	return n > 0, nil
}

// SetStatus applies an LWT status. Returns the previous status.
func (s *Store) SetStatus(ctx context.Context, app, appDir, device, status string, live bool) (string, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return "", err
	}
	if err := s.ensure(ctx, h, device); err != nil {
		return "", err
	}
	var prev string
	_ = h.QueryRowContext(ctx, `SELECT status FROM cameras WHERE device = ?`, device).Scan(&prev)
	now := s.nowISO()
	_, err = h.ExecContext(ctx, `UPDATE cameras SET status = ?, status_at = ?,
         last_seen = CASE WHEN ? THEN ? ELSE last_seen END WHERE device = ?`, status, now, live && status == "online", now, device)
	return prev, err
}

// Touch marks live traffic: last_seen = now, and online when the status was
// never reported (an api-0 camera with no LWT).
func (s *Store) Touch(ctx context.Context, app, appDir, device string) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	if err := s.ensure(ctx, h, device); err != nil {
		return err
	}
	now := s.nowISO()
	_, err = h.ExecContext(ctx, `UPDATE cameras SET last_seen = ?,
         status = CASE WHEN status = 'unknown' THEN 'online' ELSE status END,
         status_at = CASE WHEN status = 'unknown' THEN ? ELSE status_at END
       WHERE device = ?`, now, now, device)
	return err
}

// SetHello stores a hello. Returns the previous boot id and whether this is
// the first hello of a provisioned camera (it just got linked).
func (s *Store) SetHello(ctx context.Context, app, appDir, device string, hello *y.Map) (prevBoot string, linked bool, err error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return "", false, err
	}
	if err := s.ensure(ctx, h, device); err != nil {
		return "", false, err
	}
	var boot sql.NullString
	var linkedAt sql.NullString
	var prov int
	_ = h.QueryRowContext(ctx, `SELECT boot_id, linked_at, provisioned FROM cameras WHERE device = ?`, device).Scan(&boot, &linkedAt, &prov)
	raw, _ := y.Stringify(hello)
	now := s.nowISO()
	newBoot, _ := hello.Get("boot_id").(string)
	var bootArg any
	if newBoot != "" {
		bootArg = newBoot
	}
	_, err = h.ExecContext(ctx, `UPDATE cameras SET hello_json = ?, hello_at = ?,
         boot_id = COALESCE(?, boot_id),
         linked_at = COALESCE(linked_at, ?)
       WHERE device = ?`, raw, now, bootArg, now, device)
	return boot.String, prov == 1 && !linkedAt.Valid, err
}

// SetState stores the latest state and appends a history sample (pruned to
// historyCap per device).
func (s *Store) SetState(ctx context.Context, app, appDir, device string, st *y.Map, historyCap float64, live bool) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	if err := s.ensure(ctx, h, device); err != nil {
		return err
	}
	raw, _ := y.Stringify(st)
	now := s.nowISO()
	boot, _ := st.Get("boot_id").(string)
	var bootArg any
	if boot != "" {
		bootArg = boot
	}
	if _, err := h.ExecContext(ctx, `UPDATE cameras SET state_json = ?, state_at = ?, boot_id = COALESCE(?, boot_id) WHERE device = ?`,
		raw, now, bootArg, device); err != nil {
		return err
	}
	if !live {
		return nil
	}
	f := func(p *float64) any {
		if p == nil {
			return nil
		}
		return *p
	}
	if _, err := h.ExecContext(ctx, `INSERT INTO state_history (device, ts, rssi, mem_free_kb, load1, queue_bytes, sd_free_kb, bitrate_kbps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, device, now,
		f(digNum(st, "net", "rssi")), f(digNum(st, "health", "mem_free_kb")), f(digNum(st, "health", "load1")),
		f(digNum(st, "queue", "bytes")), f(digNum(st, "sd", "free_kb")), f(digNum(st, "stream", "bitrate_kbps"))); err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `DELETE FROM state_history WHERE device = ? AND id NOT IN (
         SELECT id FROM state_history WHERE device = ? ORDER BY id DESC LIMIT ?)`, device, device, clampInt(historyCap, 1, 5000))
	return err
}

// SetThumb stores the retained thumbnail (bounded by the caller).
func (s *Store) SetThumb(ctx context.Context, app, appDir, device string, jpeg []byte) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	if err := s.ensure(ctx, h, device); err != nil {
		return err
	}
	var at any = s.nowISO()
	var blob any = jpeg
	if len(jpeg) == 0 {
		at, blob = nil, nil
	}
	_, err = h.ExecContext(ctx, `UPDATE cameras SET thumb = ?, thumb_at = ? WHERE device = ?`, blob, at, device)
	return err
}

// Thumb returns the stored thumbnail (nil when none).
func (s *Store) Thumb(ctx context.Context, app, appDir, device string) ([]byte, string, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, "", err
	}
	var b []byte
	var at sql.NullString
	err = h.QueryRowContext(ctx, `SELECT thumb, thumb_at FROM cameras WHERE device = ?`, device).Scan(&b, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", nil
	}
	return b, at.String, err
}

// AddEvent appends an event (deduplicated on (boot_id, seq)), tracks seq
// gaps and prunes to cap per device. Returns the gap (missing events since
// the previous seq of the same boot; 0 = none) and whether it was new.
func (s *Store) AddEvent(ctx context.Context, app, appDir, device string, e *Event, cap float64) (gap int64, inserted bool, err error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return 0, false, err
	}
	if err := s.ensure(ctx, h, device); err != nil {
		return 0, false, err
	}
	ts := e.Ts
	if t, ok := jsx.ParseDate(ts); ok {
		ts = jsx.ISO(t)
	} else {
		ts = ""
	}
	if ts == "" {
		if n, ok := num(e.Raw.Get("ts")); ok && n > 1e9 {
			ts = jsx.ISO(time.Unix(int64(n), 0))
		} else {
			ts = s.nowISO()
		}
	}
	raw, _ := y.Stringify(e.Raw)
	var seq, boot any
	if e.Seq != nil {
		seq = *e.Seq
	}
	if e.BootID != "" {
		boot = e.BootID
	}
	res, err := h.ExecContext(ctx, `INSERT OR IGNORE INTO events (device, ts, seq, boot_id, level, src, event, msg, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, device, ts, seq, boot, e.Level, emptyNil(e.Src), emptyNil(e.Event), emptyNil(e.Msg), raw)
	if err != nil {
		return 0, false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return 0, false, nil
	}
	if e.Seq != nil && e.BootID != "" {
		var lastSeq sql.NullInt64
		var lastBoot sql.NullString
		_ = h.QueryRowContext(ctx, `SELECT last_seq, boot_id FROM cameras WHERE device = ?`, device).Scan(&lastSeq, &lastBoot)
		if lastSeq.Valid && lastBoot.String == e.BootID && *e.Seq > lastSeq.Int64+1 {
			gap = *e.Seq - lastSeq.Int64 - 1
		}
		if !lastSeq.Valid || lastBoot.String != e.BootID || *e.Seq > lastSeq.Int64 {
			if _, err := h.ExecContext(ctx, `UPDATE cameras SET last_seq = ?, boot_id = ?, events_lost = events_lost + ? WHERE device = ?`,
				*e.Seq, e.BootID, gap, device); err != nil {
				return 0, true, err
			}
		}
	}
	_, err = h.ExecContext(ctx, `DELETE FROM events WHERE device = ? AND id NOT IN (
         SELECT id FROM events WHERE device = ? ORDER BY id DESC LIMIT ?)`, device, device, clampInt(cap, 10, 100000))
	return gap, true, err
}

func emptyNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// EventQuery filters the event log.
type EventQuery struct {
	Level  string
	Src    string
	Before int64 // id cursor (0 = newest)
	Limit  int64
}

// Events returns a device's events, newest first.
func (s *Store) Events(ctx context.Context, app, appDir, device string, q EventQuery) ([]CamerasEventRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	where := []string{"device = ?"}
	args := []any{device}
	if q.Level != "" {
		where = append(where, "level = ?")
		args = append(args, q.Level)
	}
	if q.Src != "" {
		where = append(where, "src = ?")
		args = append(args, q.Src)
	}
	if q.Before > 0 {
		where = append(where, "id < ?")
		args = append(args, q.Before)
	}
	limit := q.Limit
	if limit < 1 {
		limit = 100
	} else if limit > 1000 {
		limit = 1000
	}
	args = append(args, limit)
	rows, err := h.QueryContext(ctx, `SELECT id, device, ts, seq, boot_id, level, src, event, msg, raw_json FROM events
         WHERE `+strings.Join(where, " AND ")+` ORDER BY id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CamerasEventRow{}
	for rows.Next() {
		var r CamerasEventRow
		var seq sql.NullInt64
		var boot, src, ev, msg, raw sql.NullString
		if err := rows.Scan(&r.ID, &r.Device, &r.Ts, &seq, &boot, &r.Level, &src, &ev, &msg, &raw); err != nil {
			return nil, err
		}
		if seq.Valid {
			v := seq.Int64
			r.Seq = &v
		}
		r.BootID, r.Src, r.Event, r.Msg = strPtr(boot), strPtr(src), strPtr(ev), strPtr(msg)
		r.Data = parseObj(raw)
		out = append(out, r)
	}
	return out, rows.Err()
}

func strPtr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	s := n.String
	return &s
}

func parseObj(raw sql.NullString) *y.Map {
	if raw.Valid && raw.String != "" {
		if v, err := y.ParseJSON([]byte(raw.String)); err == nil {
			if m, ok := v.(*y.Map); ok && m != nil {
				return m
			}
		}
	}
	return nil
}

// ReapStale flips online cameras whose last_seen is older than staleMs to
// offline; returns the devices flipped.
func (s *Store) ReapStale(ctx context.Context, app, appDir string, staleMs float64) ([]string, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	cutoff := jsx.ISO(s.now().Add(-time.Duration(math.Max(1000, staleMs)) * time.Millisecond))
	rows, err := h.QueryContext(ctx, `SELECT device FROM cameras WHERE status = 'online' AND last_seen IS NOT NULL AND last_seen < ?`, cutoff)
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
		if _, err := h.ExecContext(ctx, `UPDATE cameras SET status = 'offline', status_at = ? WHERE status = 'online' AND last_seen IS NOT NULL AND last_seen < ?`,
			s.nowISO(), cutoff); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

const cameraCols = `device, name, site, stand, model, room, stream_url, stream_key, tags_json, mqtt_user, mqtt_pass,
  provisioned, linked_at, status, status_at, first_seen, last_seen, hello_json, hello_at, state_json, state_at,
  boot_id, last_seq, events_lost, thumb_at, created_at`

func scanCamera(sc interface{ Scan(...any) error }) (*CameraRow, error) {
	var r CameraRow
	var name, site, stand, model, room, surl, skey, tags, mu, mp, linked, statusAt, first, last, hello, helloAt, state, stateAt, boot, thumbAt sql.NullString
	var prov int
	var lastSeq sql.NullInt64
	if err := sc.Scan(&r.Device, &name, &site, &stand, &model, &room, &surl, &skey, &tags, &mu, &mp,
		&prov, &linked, &r.Status, &statusAt, &first, &last, &hello, &helloAt, &state, &stateAt,
		&boot, &lastSeq, &r.EventsLost, &thumbAt, &r.CreatedAt); err != nil {
		return nil, err
	}
	r.Name, r.Site, r.Stand, r.Model, r.Room = strPtr(name), strPtr(site), strPtr(stand), strPtr(model), strPtr(room)
	r.StreamURL, r.StreamKey, r.MqttUser, r.MqttPass = strPtr(surl), strPtr(skey), strPtr(mu), strPtr(mp)
	r.Provisioned = prov == 1
	r.LinkedAt, r.StatusAt, r.FirstSeen, r.LastSeen = strPtr(linked), strPtr(statusAt), strPtr(first), strPtr(last)
	r.Hello, r.HelloAt, r.State, r.StateAt = parseObj(hello), strPtr(helloAt), parseObj(state), strPtr(stateAt)
	r.BootID, r.ThumbAt = strPtr(boot), strPtr(thumbAt)
	if lastSeq.Valid {
		v := lastSeq.Int64
		r.LastSeq = &v
	}
	r.Tags = []string{}
	if tags.Valid && tags.String != "" {
		if v, err := y.ParseJSON([]byte(tags.String)); err == nil {
			if arr, ok := v.([]any); ok {
				for _, t := range arr {
					if s, ok := t.(string); ok {
						r.Tags = append(r.Tags, s)
					}
				}
			}
		}
	}
	switch r.Status {
	case "online", "offline":
	default:
		r.Status = "unknown"
	}
	return &r, nil
}

// List returns every camera, by device.
func (s *Store) List(ctx context.Context, app, appDir string) ([]CameraRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT `+cameraCols+` FROM cameras ORDER BY device ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CameraRow{}
	for rows.Next() {
		r, err := scanCamera(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// Get returns one camera (nil when absent).
func (s *Store) Get(ctx context.Context, app, appDir, device string) (*CameraRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	r, err := scanCamera(h.QueryRowContext(ctx, `SELECT `+cameraCols+` FROM cameras WHERE device = ?`, device))
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

// History returns the newest `limit` samples, oldest→newest.
func (s *Store) History(ctx context.Context, app, appDir, device string, limit float64) ([]CamerasHistoryPoint, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT ts, rssi, mem_free_kb, load1, queue_bytes, sd_free_kb, bitrate_kbps FROM state_history
           WHERE device = ? ORDER BY id DESC LIMIT ?`, device, clampInt(limit, 1, 5000))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pts []CamerasHistoryPoint
	for rows.Next() {
		var p CamerasHistoryPoint
		var a, b, c, d, e, f sql.NullFloat64
		if err := rows.Scan(&p.Ts, &a, &b, &c, &d, &e, &f); err != nil {
			return nil, err
		}
		p.Rssi, p.MemFreeKb, p.Load1, p.QueueBytes, p.SdFreeKb, p.BitrateKbps = nullFloat(a), nullFloat(b), nullFloat(c), nullFloat(d), nullFloat(e), nullFloat(f)
		pts = append(pts, p)
	}
	out := make([]CamerasHistoryPoint, 0, len(pts))
	for i := len(pts) - 1; i >= 0; i-- {
		out = append(out, pts[i])
	}
	return out, rows.Err()
}

// NewCommand is a command about to be published.
type NewCommand struct {
	ID, Device, Cmd string
	Args            *y.Map
	ExpSec          int64
	Long            bool
	BootID          string
	Actor           string
	Deadline        time.Time
}

// RecordCommand inserts a pending command.
func (s *Store) RecordCommand(ctx context.Context, app, appDir string, c NewCommand) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	raw, _ := y.Stringify(c.Args)
	now := s.nowISO()
	long := 0
	if c.Long {
		long = 1
	}
	_, err = h.ExecContext(ctx, `INSERT INTO commands (id, device, cmd, args_json, status, exp_s, long, boot_id, actor, deadline, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`, c.ID, c.Device, c.Cmd, raw, c.ExpSec, long,
		emptyNil(c.BootID), emptyNil(c.Actor), jsx.ISO(c.Deadline), now, now)
	return err
}

// ApplyResponse moves an open command along its phases. A final phase on a
// closed (timed-out) command still records the late result. Returns the
// updated row (nil when the id is unknown) and whether anything changed.
func (s *Store) ApplyResponse(ctx context.Context, app, appDir string, r *Response, longDeadline time.Time) (*CamerasCommandRow, bool, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, false, err
	}
	cur, err := s.getCommand(ctx, h, r.ID)
	if err != nil || cur == nil {
		return nil, false, err
	}
	now := s.nowISO()
	var result any
	if r.Result != nil {
		raw, _ := y.Stringify(r.Result)
		result = raw
	}
	var pct any
	if r.Pct != nil {
		pct = *r.Pct
	} else if r.Phase == "done" && cur.Long {
		pct = 100.0
	}
	switch r.Phase {
	case "accepted", "progress":
		if cur.Status != "pending" && cur.Status != "accepted" && cur.Status != "progress" {
			return cur, false, nil
		}
		_, err = h.ExecContext(ctx, `UPDATE commands SET status = ?, pct = COALESCE(?, pct), result_json = COALESCE(?, result_json),
             updated_at = ?, deadline = ? WHERE id = ?`, r.Phase, pct, result, now, jsx.ISO(longDeadline), r.ID)
	default: // done | failed
		if cur.Status == "done" || cur.Status == "failed" {
			return cur, false, nil
		}
		_, err = h.ExecContext(ctx, `UPDATE commands SET status = ?, pct = COALESCE(?, pct), code = ?, error = ?, result_json = COALESCE(?, result_json),
             updated_at = ?, resolved_at = ? WHERE id = ?`, r.Phase, pct, emptyNil(r.Code), emptyNil(r.Error), result, now, now, r.ID)
	}
	if err != nil {
		return nil, false, err
	}
	row, err := s.getCommand(ctx, h, r.ID)
	return row, true, err
}

// ResolveRebooted marks the open reboot-like commands of device as done
// once the camera came back with a different boot id. Returns their ids.
func (s *Store) ResolveRebooted(ctx context.Context, app, appDir, device, bootID string) ([]string, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT id, cmd, boot_id FROM commands WHERE device = ? AND status IN ('accepted','progress')`, device)
	if err != nil {
		return nil, err
	}
	type open struct{ id, cmd, boot string }
	var list []open
	for rows.Next() {
		var o open
		var b sql.NullString
		if err := rows.Scan(&o.id, &o.cmd, &b); err != nil {
			rows.Close()
			return nil, err
		}
		o.boot = b.String
		list = append(list, o)
	}
	rows.Close()
	var ids []string
	now := s.nowISO()
	for _, o := range list {
		if !rebootLike[o.cmd] || (o.boot != "" && o.boot == bootID) {
			continue
		}
		res, _ := jsx.Stringify(map[string]any{"rebooted": true, "bootId": bootID})
		if _, err := h.ExecContext(ctx, `UPDATE commands SET status = 'done', pct = 100, result_json = ?, updated_at = ?, resolved_at = ? WHERE id = ?`,
			res, now, now, o.id); err != nil {
			return ids, err
		}
		ids = append(ids, o.id)
	}
	return ids, nil
}

// ExpireOpen marks open commands past their deadline as timeout.
func (s *Store) ExpireOpen(ctx context.Context, app, appDir string) ([]string, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	now := s.nowISO()
	rows, err := h.QueryContext(ctx, `SELECT id FROM commands WHERE status IN ('pending','accepted','progress') AND deadline < ?`, now)
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
		if _, err := h.ExecContext(ctx, `UPDATE commands SET status = 'timeout', code = 'timeout', updated_at = ?, resolved_at = ?
             WHERE status IN ('pending','accepted','progress') AND deadline < ?`, now, now, now); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

const commandCols = `id, device, cmd, args_json, status, pct, code, error, result_json, exp_s, long, actor, deadline, created_at, updated_at, resolved_at`

func scanCommand(sc interface{ Scan(...any) error }) (*CamerasCommandRow, error) {
	var r CamerasCommandRow
	var args, code, errS, result, actor, resolved sql.NullString
	var pct sql.NullFloat64
	var long int
	if err := sc.Scan(&r.ID, &r.Device, &r.Cmd, &args, &r.Status, &pct, &code, &errS, &result, &r.ExpSec, &long,
		&actor, &r.Deadline, &r.CreatedAt, &r.UpdatedAt, &resolved); err != nil {
		return nil, err
	}
	r.Args = parseObj(args)
	if r.Args == nil {
		r.Args = y.NewMap()
	}
	r.Pct, r.Code, r.Error, r.Actor, r.ResolvedAt = nullFloat(pct), strPtr(code), strPtr(errS), strPtr(actor), strPtr(resolved)
	r.Long = long == 1
	if result.Valid && result.String != "" {
		if v, err := y.ParseJSON([]byte(result.String)); err == nil {
			r.Result = v
		}
	}
	return &r, nil
}

func (s *Store) getCommand(ctx context.Context, h *sql.DB, id string) (*CamerasCommandRow, error) {
	r, err := scanCommand(h.QueryRowContext(ctx, `SELECT `+commandCols+` FROM commands WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

// GetCommand returns one command (nil when absent).
func (s *Store) GetCommand(ctx context.Context, app, appDir, id string) (*CamerasCommandRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	return s.getCommand(ctx, h, id)
}

// CommandsFor returns a device's newest commands (limit 1..200).
func (s *Store) CommandsFor(ctx context.Context, app, appDir, device string, limit int64) ([]CamerasCommandRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = 1
	} else if limit > 200 {
		limit = 200
	}
	rows, err := h.QueryContext(ctx, `SELECT `+commandCols+` FROM commands WHERE device = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, device, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CamerasCommandRow{}
	for rows.Next() {
		r, err := scanCommand(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}
