// Package scheduledlive is src/modules/scheduled-live: the per-app agenda of
// scheduled live-stream premieres (scheduled_events in app.db), with a
// real-time LiveKit data push on every agenda mutation.
package scheduledlive

import (
	"context"
	"database/sql"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
)

// ScheduledEventView is ScheduledEventView (camelCase, boolean enabled).
type ScheduledEventView struct {
	ID        int64   `json:"id"`
	Room      *string `json:"room"`
	Title     *string `json:"title"`
	StartAt   int64   `json:"startAt"`
	Timezone  string  `json:"timezone"`
	Message   *string `json:"message"`
	Enabled   bool    `json:"enabled"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

// Insert is a validated new event.
type Insert struct {
	Room, Title, Message *string
	StartAt              int64
	Timezone             string
	Enabled              bool
}

// Patch is a partial update; Set* flags mark present fields (a present nil
// pointer writes NULL).
type Patch struct {
	SetRoom, SetTitle, SetMessage bool
	Room, Title, Message          *string
	StartAt                       *int64
	Timezone                      *string
	Enabled                       *bool
}

// Repository is ScheduledLiveRepository (app-scoped by construction).
type Repository struct{ store *db.Service }

// NewRepository wraps the db service.
func NewRepository(store *db.Service) *Repository { return &Repository{store: store} }

const cols = `id, room, title, start_at, timezone, message, enabled, created_at, updated_at`

func scan(rows interface{ Scan(...any) error }) (ScheduledEventView, error) {
	var v ScheduledEventView
	var room, title, msg sql.NullString
	var enabled int64
	if err := rows.Scan(&v.ID, &room, &title, &v.StartAt, &v.Timezone, &msg, &enabled, &v.CreatedAt, &v.UpdatedAt); err != nil {
		return v, err
	}
	v.Room, v.Title, v.Message = nullable(room), nullable(title), nullable(msg)
	v.Enabled = enabled == 1
	return v, nil
}

func nullable(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

func (r *Repository) query(ctx context.Context, app, q string, args ...any) ([]ScheduledEventView, error) {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ScheduledEventView{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// List is every event of the app, soonest first.
func (r *Repository) List(ctx context.Context, app string) ([]ScheduledEventView, error) {
	return r.query(ctx, app, `SELECT `+cols+` FROM scheduled_events ORDER BY start_at ASC`)
}

// ListPublic is enabled events with start_at >= sinceMs, for room (room
// match OR room IS NULL) or every room when room is "".
func (r *Repository) ListPublic(ctx context.Context, app, room string, sinceMs float64) ([]ScheduledEventView, error) {
	if room != "" {
		return r.query(ctx, app, `SELECT `+cols+` FROM scheduled_events
              WHERE enabled = 1 AND start_at >= ?
                AND (room IS NULL OR room = ?)
              ORDER BY start_at ASC`, sinceMs, room)
	}
	return r.query(ctx, app, `SELECT `+cols+` FROM scheduled_events
              WHERE enabled = 1 AND start_at >= ?
              ORDER BY start_at ASC`, sinceMs)
}

// Get returns one event or nil.
func (r *Repository) Get(ctx context.Context, app string, id int64) (*ScheduledEventView, error) {
	list, err := r.query(ctx, app, `SELECT `+cols+` FROM scheduled_events WHERE id = ?`, id)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return &list[0], nil
}

func strArg(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// Create inserts an event and returns it.
func (r *Repository) Create(ctx context.Context, app string, in Insert) (*ScheduledEventView, error) {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return nil, err
	}
	en := 0
	if in.Enabled {
		en = 1
	}
	res, err := h.ExecContext(ctx, `INSERT INTO scheduled_events
           (app, room, title, start_at, timezone, message, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, app, strArg(in.Room), strArg(in.Title), in.StartAt, in.Timezone, strArg(in.Message), en)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return r.Get(ctx, app, id)
}

// Update applies a partial patch; returns the updated row (nil if unknown).
func (r *Repository) Update(ctx context.Context, app string, id int64, p Patch) (*ScheduledEventView, error) {
	var sets []string
	var args []any
	if p.SetRoom {
		sets, args = append(sets, "room = ?"), append(args, strArg(p.Room))
	}
	if p.SetTitle {
		sets, args = append(sets, "title = ?"), append(args, strArg(p.Title))
	}
	if p.StartAt != nil {
		sets, args = append(sets, "start_at = ?"), append(args, *p.StartAt)
	}
	if p.Timezone != nil {
		sets, args = append(sets, "timezone = ?"), append(args, *p.Timezone)
	}
	if p.SetMessage {
		sets, args = append(sets, "message = ?"), append(args, strArg(p.Message))
	}
	if p.Enabled != nil {
		en := 0
		if *p.Enabled {
			en = 1
		}
		sets, args = append(sets, "enabled = ?"), append(args, en)
	}
	if len(sets) > 0 {
		h, err := r.store.App(ctx, app)
		if err != nil {
			return nil, err
		}
		sets = append(sets, "updated_at = datetime('now')")
		if _, err := h.ExecContext(ctx, `UPDATE scheduled_events SET `+strings.Join(sets, ", ")+` WHERE id = ?`, append(args, id)...); err != nil {
			return nil, err
		}
	}
	return r.Get(ctx, app, id)
}

// Remove deletes an event; true when a row was removed.
func (r *Repository) Remove(ctx context.Context, app string, id int64) (bool, error) {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return false, err
	}
	res, err := h.ExecContext(ctx, `DELETE FROM scheduled_events WHERE id = ?`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
