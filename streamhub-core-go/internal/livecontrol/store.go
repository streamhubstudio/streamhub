// Package livecontrol is modules/live-control: pause / resume / finish an
// already-live stream behind a cover (image, looping video or text card),
// backing both the `live-control` console app and the
// `live-control-overlay` player overlay. Per-app state lives in
// apps/<app>/live-control/live-control.db; cover assets in the app's S3.
package livecontrol

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Port of live-control.store.ts (DDL verbatim) + live-control.logic.ts.

const migration = `
CREATE TABLE IF NOT EXISTS stream_state (
  stream_id   TEXT PRIMARY KEY,
  state       TEXT NOT NULL DEFAULT 'live',
  mode        TEXT,
  asset_id    INTEGER,
  card_title  TEXT,
  card_text   TEXT,
  card_color  TEXT,
  room        TEXT,
  since       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  s3_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  label        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_settings (
  k TEXT PRIMARY KEY,
  v TEXT
);
`

// StateRow is a per-stream state row (absent row ⇒ live).
type StateRow struct {
	StreamID  string
	State     string // live | paused | finished
	Mode      *string
	AssetID   *int64
	CardTitle *string
	CardText  *string
	CardColor *string
	Room      *string
	Since     string
	UpdatedAt string
}

// Asset is an uploaded cover asset.
type LCAsset struct {
	ID          int64   `json:"id"`
	Kind        string  `json:"kind"`
	S3Key       string  `json:"s3Key"`
	Filename    string  `json:"filename"`
	ContentType string  `json:"contentType"`
	SizeBytes   int64   `json:"sizeBytes"`
	Label       *string `json:"label"`
	CreatedAt   string  `json:"createdAt"`
}

// Override is a partial per-stream cover override: Set* marks a present
// field (an explicit null clears it).
type Override struct {
	Mode, CardTitle, CardText, CardColor           *string
	AssetID                                        *int64
	SetMode, SetAsset, SetTitle, SetText, SetColor bool
}

// Store is LiveControlStore.
type Store struct {
	mu  sync.Mutex
	dbs map[string]*sql.DB
	// FileFor resolves the db path (test seam).
	FileFor func(appDir string) string
	now     func() time.Time
}

// NewStore builds the store.
func NewStore() *Store {
	return &Store{dbs: map[string]*sql.DB{}, now: time.Now,
		FileFor: func(appDir string) string { return filepath.Join(appDir, "live-control", "live-control.db") }}
}

// DB opens (create + migrate) and caches the per-app db.
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

// Close drops a cached handle.
func (s *Store) Close(app string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h, ok := s.dbs[app]; ok {
		delete(s.dbs, app)
		_ = h.Close()
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

func normMode(v sql.NullString) *string {
	if v.Valid && (v.String == "image" || v.String == "video" || v.String == "text") {
		s := v.String
		return &s
	}
	return nil
}

func nstr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func scanState(sc interface{ Scan(...any) error }) (*StateRow, error) {
	var r StateRow
	var state string
	var mode, title, text, color, room sql.NullString
	var asset sql.NullInt64
	if err := sc.Scan(&r.StreamID, &state, &mode, &asset, &title, &text, &color, &room, &r.Since, &r.UpdatedAt); err != nil {
		return nil, err
	}
	switch state {
	case "paused", "finished":
		r.State = state
	default:
		r.State = "live"
	}
	r.Mode, r.CardTitle, r.CardText, r.CardColor, r.Room = normMode(mode), nstr(title), nstr(text), nstr(color), nstr(room)
	if asset.Valid {
		a := asset.Int64
		r.AssetID = &a
	}
	return &r, nil
}

const stateCols = `stream_id, state, mode, asset_id, card_title, card_text, card_color, room, since, updated_at`

// GetState is a stream's row (nil = never acted on = live).
func (s *Store) GetState(ctx context.Context, app, appDir, streamID string) (*StateRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	r, err := scanState(h.QueryRowContext(ctx, `SELECT `+stateCols+` FROM stream_state WHERE stream_id = ?`, streamID))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return r, err
}

func pickStr(set bool, v *string, fallback *string) any {
	if set {
		if v == nil {
			return nil
		}
		return *v
	}
	if fallback == nil {
		return nil
	}
	return *fallback
}

// SetState upserts a transition, keeping absent override fields.
func (s *Store) SetState(ctx context.Context, app, appDir, streamID, state string, room *string, o Override) (*StateRow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	now := jsx.ISO(s.now())
	existing, err := s.GetState(ctx, app, appDir, streamID)
	if err != nil {
		return nil, err
	}
	var prev StateRow
	if existing != nil {
		prev = *existing
	}
	var asset any
	switch {
	case o.SetAsset && o.AssetID != nil:
		asset = *o.AssetID
	case o.SetAsset:
	case prev.AssetID != nil:
		asset = *prev.AssetID
	}
	var roomV any
	switch {
	case room != nil:
		roomV = *room
	case prev.Room != nil:
		roomV = *prev.Room
	}
	since := now
	if existing != nil && existing.State == state {
		since = existing.Since
	}
	if _, err := h.ExecContext(ctx, `INSERT INTO stream_state
         (stream_id, state, mode, asset_id, card_title, card_text, card_color, room, since, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET
         state = excluded.state,
         mode = excluded.mode,
         asset_id = excluded.asset_id,
         card_title = excluded.card_title,
         card_text = excluded.card_text,
         card_color = excluded.card_color,
         room = excluded.room,
         since = excluded.since,
         updated_at = excluded.updated_at`,
		streamID, state, pickStr(o.SetMode, o.Mode, prev.Mode), asset,
		pickStr(o.SetTitle, o.CardTitle, prev.CardTitle), pickStr(o.SetText, o.CardText, prev.CardText),
		pickStr(o.SetColor, o.CardColor, prev.CardColor), roomV, since, now); err != nil {
		return nil, err
	}
	return s.GetState(ctx, app, appDir, streamID)
}

const assetCols = `id, kind, s3_key, filename, content_type, size_bytes, label, created_at`

func scanAsset(sc interface{ Scan(...any) error }) (*LCAsset, error) {
	var a LCAsset
	var label sql.NullString
	if err := sc.Scan(&a.ID, &a.Kind, &a.S3Key, &a.Filename, &a.ContentType, &a.SizeBytes, &label, &a.CreatedAt); err != nil {
		return nil, err
	}
	if a.Kind != "video" {
		a.Kind = "image"
	}
	a.Label = nstr(label)
	return &a, nil
}

// ListAssets lists assets newest first.
func (s *Store) ListAssets(ctx context.Context, app, appDir string) ([]LCAsset, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT `+assetCols+` FROM assets ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LCAsset{}
	for rows.Next() {
		a, err := scanAsset(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// GetAsset returns one asset (nil when absent).
func (s *Store) GetAsset(ctx context.Context, app, appDir string, id int64) (*LCAsset, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	a, err := scanAsset(h.QueryRowContext(ctx, `SELECT `+assetCols+` FROM assets WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return a, err
}

// AddAsset records an uploaded asset.
func (s *Store) AddAsset(ctx context.Context, app, appDir string, a LCAsset) (*LCAsset, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	var label any
	if a.Label != nil {
		label = *a.Label
	}
	res, err := h.ExecContext(ctx, `INSERT INTO assets (kind, s3_key, filename, content_type, size_bytes, label)
           VALUES (?, ?, ?, ?, ?, ?)`, a.Kind, a.S3Key, a.Filename, a.ContentType, a.SizeBytes, label)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetAsset(ctx, app, appDir, id)
}

// RemoveAsset deletes an asset and returns it (nil when absent).
func (s *Store) RemoveAsset(ctx context.Context, app, appDir string, id int64) (*LCAsset, error) {
	a, err := s.GetAsset(ctx, app, appDir, id)
	if err != nil || a == nil {
		return nil, err
	}
	h, _ := s.DB(ctx, app, appDir)
	_, err = h.ExecContext(ctx, `DELETE FROM assets WHERE id = ?`, id)
	return a, err
}

// Settings is the app_settings KV.
func (s *Store) Settings(ctx context.Context, app, appDir string) (map[string]string, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT k, v FROM app_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k string
		var v sql.NullString
		if rows.Scan(&k, &v) == nil {
			out[k] = v.String
		}
	}
	return out, rows.Err()
}

// SetSetting writes (or, for nil, deletes) one KV entry.
func (s *Store) SetSetting(ctx context.Context, app, appDir, key string, value *string) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	if value == nil {
		_, err = h.ExecContext(ctx, `DELETE FROM app_settings WHERE k = ?`, key)
		return err
	}
	_, err = h.ExecContext(ctx, `INSERT INTO app_settings (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`, key, *value)
	return err
}

// ---------------------------------------------------------------------------
// live-control.logic.ts
// ---------------------------------------------------------------------------

// OpTarget maps an op (pause | resume | finish) to its target state.
func OpTarget(op string) string {
	switch op {
	case "pause":
		return "paused"
	case "finish":
		return "finished"
	}
	return "live"
}

var transitions = map[string][]string{
	"live":     {"paused", "finished"},
	"paused":   {"live", "finished", "paused"},
	"finished": {"live", "paused"},
}

// CanTransition: same-state is a no-op except re-pause.
func CanTransition(from, to string) bool {
	if from == to {
		return to == "paused"
	}
	for _, t := range transitions[from] {
		if t == to {
			return true
		}
	}
	return false
}

// IsCovered reports a state that hides the feed.
func IsCovered(state string) bool { return state == "paused" || state == "finished" }

// AppDefaults feed ResolveCover.
type AppDefaults struct {
	DefaultMode, DefaultCardTitle, DefaultCardText, DefaultCardColor string
	DefaultPauseAssetID, DefaultFinishAssetID                        *int64
}

// Cover is a resolved cover (before the signed URL is attached).
type LCCover struct {
	Mode      string  `json:"mode"`
	AssetID   *int64  `json:"assetId"`
	CardTitle *string `json:"cardTitle"`
	CardText  *string `json:"cardText"`
	CardColor string  `json:"cardColor"`
}

// ResolveCover: the per-stream override wins, else the phase default; an
// image/video cover without an asset degrades to the text card.
func ResolveCover(state string, o StateRow, d AppDefaults) *LCCover {
	if !IsCovered(state) {
		return nil
	}
	mode := d.DefaultMode
	if o.Mode != nil {
		mode = *o.Mode
	}
	asset := d.DefaultPauseAssetID
	if state == "finished" {
		asset = d.DefaultFinishAssetID
	}
	if o.AssetID != nil {
		asset = o.AssetID
	}
	or := func(v *string, f string) *string {
		if v != nil {
			return v
		}
		return &f
	}
	title, text := or(o.CardTitle, d.DefaultCardTitle), or(o.CardText, d.DefaultCardText)
	color := d.DefaultCardColor
	if o.CardColor != nil {
		color = *o.CardColor
	}
	if (mode == "image" || mode == "video") && asset == nil {
		return &LCCover{Mode: "text", CardTitle: title, CardText: text, CardColor: color}
	}
	if mode == "text" {
		asset = nil
	}
	return &LCCover{Mode: mode, AssetID: asset, CardTitle: title, CardText: text, CardColor: color}
}
