package restream

import (
	"context"
	"database/sql"
	"errors"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
)

// Target is a raw restream_targets row (per-app app.db, APP_MIGRATIONS #7).
// URL is the FULL destination (incl. stream key) and never leaves the server.
type Target struct {
	ID        int64
	App       string
	Room      string
	StreamID  sql.NullString
	Name      sql.NullString
	Platform  string
	URL       string
	URLMasked string
	EgressID  sql.NullString
	Status    string
	Error     sql.NullString
	Retries   int64
	StartedAt string
	EndedAt   sql.NullString
}

// Insert is a new destination row.
type Insert struct {
	App, Room, Platform, URL, URLMasked, EgressID string
	StreamID, Name                                *string
}

// Repository is RestreamRepository: every method is app-scoped (the row
// lives in the app's own app.db, so isolation is structural).
type Repository struct {
	store *db.Service
}

// NewRepository builds the repository.
func NewRepository(store *db.Service) *Repository { return &Repository{store: store} }

const cols = `id, app, room, stream_id, name, platform, url, url_masked, egress_id, status, error, retries, started_at, ended_at`

func scan(row interface{ Scan(...any) error }) (*Target, error) {
	var t Target
	err := row.Scan(&t.ID, &t.App, &t.Room, &t.StreamID, &t.Name, &t.Platform, &t.URL, &t.URLMasked,
		&t.EgressID, &t.Status, &t.Error, &t.Retries, &t.StartedAt, &t.EndedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (r *Repository) one(ctx context.Context, app, q string, args ...any) (*Target, error) {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return nil, err
	}
	return scan(h.QueryRowContext(ctx, q, args...))
}

func (r *Repository) exec(ctx context.Context, app, q string, args ...any) error {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, q, args...)
	return err
}

func nullable(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// Insert adds a 'starting' destination and returns the stored row.
func (r *Repository) Insert(ctx context.Context, in Insert) (*Target, error) {
	h, err := r.store.App(ctx, in.App)
	if err != nil {
		return nil, err
	}
	res, err := h.ExecContext(ctx, `INSERT INTO restream_targets
           (app, room, stream_id, name, platform, url, url_masked, egress_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting')`,
		in.App, in.Room, nullable(in.StreamID), nullable(in.Name), in.Platform, in.URL, in.URLMasked, in.EgressID)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return r.ByID(ctx, in.App, id)
}

// ByID returns one row (nil when absent).
func (r *Repository) ByID(ctx context.Context, app string, id int64) (*Target, error) {
	return r.one(ctx, app, `SELECT `+cols+` FROM restream_targets WHERE id = ?`, id)
}

// ByEgressID returns the newest row pointing at egressID.
func (r *Repository) ByEgressID(ctx context.Context, app, egressID string) (*Target, error) {
	return r.one(ctx, app, `SELECT `+cols+` FROM restream_targets WHERE egress_id = ? ORDER BY id DESC`, egressID)
}

// ListByRoom lists the room's non-stopped destinations, newest first.
func (r *Repository) ListByRoom(ctx context.Context, app, room string) ([]*Target, error) {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT `+cols+` FROM restream_targets
          WHERE room = ? AND status != 'stopped'
          ORDER BY id DESC`, room)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Target
	for rows.Next() {
		t, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// FindLiveByURL is a live (starting/active) destination of the room with url.
func (r *Repository) FindLiveByURL(ctx context.Context, app, room, url string) (*Target, error) {
	return r.one(ctx, app, `SELECT `+cols+` FROM restream_targets
          WHERE room = ? AND url = ? AND status IN ('starting','active')
          ORDER BY id DESC`, room, url)
}

// CountLiveByRoom counts the room's starting/active destinations.
func (r *Repository) CountLiveByRoom(ctx context.Context, app, room string) (int, error) {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return 0, err
	}
	var n int
	err = h.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM restream_targets
          WHERE room = ? AND status IN ('starting','active')`, room).Scan(&n)
	return n, err
}

// SetStatus moves a row; stopped/failed also stamp ended_at. errMsg nil = NULL.
func (r *Repository) SetStatus(ctx context.Context, app string, id int64, status string, errMsg *string) error {
	ended := 0
	if status == "stopped" || status == "failed" {
		ended = 1
	}
	return r.exec(ctx, app, `UPDATE restream_targets
            SET status = ?,
                error = ?,
                ended_at = CASE WHEN ? THEN datetime('now') ELSE ended_at END
          WHERE id = ?`, status, nullable(errMsg), ended, id)
}

// SetEgress points a target at a fresh egress after a retry relaunch.
func (r *Repository) SetEgress(ctx context.Context, app string, id int64, egressID string, retries int64) error {
	return r.exec(ctx, app, `UPDATE restream_targets
            SET egress_id = ?, status = 'starting', error = NULL,
                retries = ?, ended_at = NULL
          WHERE id = ?`, egressID, retries, id)
}

// BumpRetries records a failed relaunch attempt.
func (r *Repository) BumpRetries(ctx context.Context, app string, id, retries int64) error {
	return r.exec(ctx, app, `UPDATE restream_targets SET retries = ? WHERE id = ?`, retries, id)
}
