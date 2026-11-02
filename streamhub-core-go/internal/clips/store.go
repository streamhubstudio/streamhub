package clips

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// The per-app `clips` table (app migration 015): one row per clip job.

// Clip states.
const (
	StatusQueued  = "queued"
	StatusRunning = "running"
	StatusReady   = "ready"
	StatusFailed  = "failed"
)

// Origin is who asked for a clip: the REST API or a Streamflow action.clip
// box (with the triggering event, so the clip links back to it).
type Origin struct {
	Kind       string          `json:"kind"` // api | streamflow
	Event      string          `json:"event,omitempty"`
	EventTs    *float64        `json:"eventTs,omitempty"` // epoch ms
	WorkflowID string          `json:"workflowId,omitempty"`
	RunID      string          `json:"runId,omitempty"`
	Data       json.RawMessage `json:"data,omitempty"` // the trigger payload (bounded)
}

// Clip is one clip job (the API shape).
type Clip struct {
	ID        string  `json:"id"`
	App       string  `json:"app"`
	StreamID  *string `json:"streamId"`
	Room      string  `json:"room"`
	From      string  `json:"from"`
	To        string  `json:"to"`
	DurationS float64 `json:"durationS"`
	Status    string  `json:"status"`
	VodID     *int64  `json:"vodId"`
	Error     *string `json:"error"`
	Origin    *Origin `json:"origin"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
	// URL is the presigned (or public) MP4 URL once ready (detail only).
	URL *string `json:"url,omitempty"`

	fromMs, toMs float64
}

// Range is the clip's interval.
func (c *Clip) Range() Range { return Range{c.fromMs, c.toMs} }

// AppDBFunc opens an app database (db.Service.App).
type AppDBFunc func(ctx context.Context, app string) (*sql.DB, error)

// Store is the clips table repository.
type Store struct {
	appDB AppDBFunc
	now   func() time.Time
}

// NewStore builds the repository.
func NewStore(appDB AppDBFunc) *Store { return &Store{appDB: appDB, now: time.Now} }

const clipCols = `id, stream_id, room, from_ms, to_ms, status, vod_id, error, origin_json, created_at, updated_at`

func isoMs(ms float64) string {
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
}

func (st *Store) stamp() string { return st.now().UTC().Format("2006-01-02T15:04:05.000Z") }

func scanClip(app string, sc interface{ Scan(...any) error }) (*Clip, error) {
	c := Clip{App: app}
	var sid, errS, origin sql.NullString
	var vod sql.NullInt64
	var from, to int64
	if err := sc.Scan(&c.ID, &sid, &c.Room, &from, &to, &c.Status, &vod, &errS, &origin, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return nil, err
	}
	c.fromMs, c.toMs = float64(from), float64(to)
	c.From, c.To = isoMs(c.fromMs), isoMs(c.toMs)
	c.DurationS = (c.toMs - c.fromMs) / 1000
	if sid.Valid {
		c.StreamID = &sid.String
	}
	if vod.Valid {
		c.VodID = &vod.Int64
	}
	if errS.Valid {
		c.Error = &errS.String
	}
	if origin.Valid && origin.String != "" {
		var o Origin
		if json.Unmarshal([]byte(origin.String), &o) == nil {
			c.Origin = &o
		}
	}
	return &c, nil
}

// Insert adds a queued row.
func (st *Store) Insert(ctx context.Context, app string, c *Clip, origin *Origin) error {
	h, err := st.appDB(ctx, app)
	if err != nil {
		return err
	}
	var oj any
	if origin != nil {
		b, _ := json.Marshal(origin)
		oj = string(b)
	}
	now := st.stamp()
	_, err = h.ExecContext(ctx, `INSERT INTO clips (`+clipCols+`) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
		c.ID, c.StreamID, c.Room, int64(c.fromMs), int64(c.toMs), StatusQueued, oj, now, now)
	return err
}

// SetStatus moves a clip (vodID / errMsg written when non-nil).
func (st *Store) SetStatus(ctx context.Context, app, id, status string, vodID *int64, errMsg *string) error {
	h, err := st.appDB(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `UPDATE clips SET status = ?, vod_id = COALESCE(?, vod_id), error = ?, updated_at = ? WHERE id = ?`,
		status, vodID, errMsg, st.stamp(), id)
	return err
}

// Get returns one clip or nil.
func (st *Store) Get(ctx context.Context, app, id string) (*Clip, error) {
	h, err := st.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	c, err := scanClip(app, h.QueryRowContext(ctx, `SELECT `+clipCols+` FROM clips WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return c, err
}

// List returns the newest clips (optionally of one stream), at most limit.
func (st *Store) List(ctx context.Context, app string, streamID *string, limit int) ([]Clip, error) {
	h, err := st.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	q := `SELECT ` + clipCols + ` FROM clips`
	var args []any
	if streamID != nil {
		q += ` WHERE stream_id = ?`
		args = append(args, *streamID)
	}
	q += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := h.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Clip{}
	for rows.Next() {
		c, err := scanClip(app, rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// CountActive counts queued + running clips of an app.
func (st *Store) CountActive(ctx context.Context, app string) (int, error) {
	h, err := st.appDB(ctx, app)
	if err != nil {
		return 0, err
	}
	var n int
	err = h.QueryRowContext(ctx, `SELECT COUNT(*) FROM clips WHERE status IN ('queued', 'running')`).Scan(&n)
	return n, err
}

// FailInterrupted marks every queued/running clip failed (boot recovery:
// the in-process queue died with the previous core, and by now the range
// may have been pruned from the DVR window). Returns the ids.
func (st *Store) FailInterrupted(ctx context.Context, app, reason string) ([]string, error) {
	h, err := st.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT id FROM clips WHERE status IN ('queued', 'running')`)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		r := reason
		_ = st.SetStatus(ctx, app, id, StatusFailed, nil, &r)
	}
	return ids, nil
}
