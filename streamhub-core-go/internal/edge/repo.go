package edge

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Repo is EdgeAssignmentsRepository over the global edge_assignments table.
// config_json holds only the user config; the spawn spec is never stored.
type Repo struct{ db *sql.DB }

// NewRepo wraps the global handle.
func NewRepo(global *sql.DB) *Repo { return &Repo{db: global} }

// CreateInput creates an assignment ("" NodeID = unplaced).
type CreateInput struct {
	NodeID   string
	App      string
	PluginID string
	StreamID *string
	Config   *y.Map
	Status   string
}

const selectAssignment = `SELECT id, node_id, app, plugin_id, stream_id, config_json, status, detail, created_at, updated_at FROM edge_assignments`

// Create inserts a row (uuid id) and returns it.
func (r *Repo) Create(ctx context.Context, in CreateInput) (*Assignment, error) {
	id := uuid.NewString()
	cfg := in.Config
	if cfg == nil {
		cfg = y.NewMap()
	}
	js, _ := y.Stringify(cfg)
	if _, err := r.db.ExecContext(ctx, `INSERT INTO edge_assignments
           (id, node_id, app, plugin_id, stream_id, config_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, id, in.NodeID, in.App, in.PluginID, in.StreamID, js, in.Status); err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

// Get is one assignment, or nil.
func (r *Repo) Get(ctx context.Context, id string) (*Assignment, error) {
	a, err := scanAssignment(r.db.QueryRowContext(ctx, selectAssignment+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// List is every assignment (optionally of one app), newest first.
func (r *Repo) List(ctx context.Context, app string) ([]Assignment, error) {
	if app != "" {
		return r.query(ctx, selectAssignment+` WHERE app = ? ORDER BY created_at DESC, id ASC`, app)
	}
	return r.query(ctx, selectAssignment+` ORDER BY created_at DESC, id ASC`)
}

// ListByNode is a node's assignments, optionally filtered by status.
func (r *Repo) ListByNode(ctx context.Context, nodeID string, statuses ...string) ([]Assignment, error) {
	all, err := r.query(ctx, selectAssignment+` WHERE node_id = ?`, nodeID)
	if err != nil || len(statuses) == 0 {
		return all, err
	}
	out := []Assignment{}
	for _, a := range all {
		for _, s := range statuses {
			if a.Status == s {
				out = append(out, a)
				break
			}
		}
	}
	return out, nil
}

// PendingUnplaced is every pending assignment with no node (the retry set).
func (r *Repo) PendingUnplaced(ctx context.Context) ([]Assignment, error) {
	return r.query(ctx, selectAssignment+` WHERE status = 'pending' AND (node_id = '' OR node_id IS NULL) ORDER BY created_at ASC`)
}

// PendingOrOfferedByNode is re-offered when the node reconnects.
func (r *Repo) PendingOrOfferedByNode(ctx context.Context, nodeID string) ([]Assignment, error) {
	return r.ListByNode(ctx, nodeID, StatusPending, StatusOffered)
}

// ActiveByNode is offered + running (the failover set).
func (r *Repo) ActiveByNode(ctx context.Context, nodeID string) ([]Assignment, error) {
	return r.ListByNode(ctx, nodeID, StatusOffered, StatusRunning)
}

// ActiveCountByNode is the capacity numerator.
func (r *Repo) ActiveCountByNode(ctx context.Context, nodeID string) int {
	var n int
	_ = r.db.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM edge_assignments
          WHERE node_id = ? AND status IN ('offered','running')`, nodeID).Scan(&n)
	return n
}

// UpdateStatus sets status + detail (nil = NULL). Unknown id is a no-op.
func (r *Repo) UpdateStatus(ctx context.Context, id, status string, detail *string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE edge_assignments
            SET status = ?, detail = ?, updated_at = datetime('now')
          WHERE id = ?`, status, detail, id)
	return err
}

// Reassign moves a row to another node with a new status (detail cleared).
func (r *Repo) Reassign(ctx context.Context, id, nodeID, status string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE edge_assignments
            SET node_id = ?, status = ?, detail = NULL, updated_at = datetime('now')
          WHERE id = ?`, nodeID, status, id)
	return err
}

func (r *Repo) query(ctx context.Context, q string, args ...any) ([]Assignment, error) {
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Assignment{}
	for rows.Next() {
		a, err := scanAssignment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

type scanner interface{ Scan(...any) error }

func scanAssignment(s scanner) (Assignment, error) {
	var (
		a                   Assignment
		stream, cfg, detail sql.NullString
	)
	if err := s.Scan(&a.ID, &a.NodeID, &a.App, &a.PluginID, &stream, &cfg, &a.Status, &detail, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return a, err
	}
	if stream.Valid {
		a.StreamID = &stream.String
	}
	if detail.Valid {
		a.Detail = &detail.String
	}
	a.Config = parseObject(cfg)
	return a, nil
}

// parseObject is the stored config parsed ({} when absent/corrupt/not an
// object), JS key order kept.
func parseObject(js sql.NullString) *y.Map {
	if js.Valid && js.String != "" {
		if v, err := y.ParseJSON([]byte(js.String)); err == nil {
			if m, ok := v.(*y.Map); ok {
				return m
			}
		}
	}
	return y.NewMap()
}

func strPtr(s string) *string { return &s }
