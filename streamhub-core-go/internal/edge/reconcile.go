package edge

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// ReconcileEvery sweeps every app's edge desired-set.
const ReconcileEvery = 30 * time.Second

// Reconciler is EdgeReconcileService: while ≥1 edge node is connected,
// mirror each app's active streams onto one assignment per (installed,
// enabled, edge-capable plugin × room), revoking those whose stream ended.
type Reconciler struct {
	sched   *Scheduler
	repo    *Repo
	gw      *Gateway
	catalog func() Catalog
	store   *db.Service
	global  *sql.DB
	apps    contracts.AppsService // optional
	log     *slog.Logger
}

// NewReconciler builds the reconciler.
func NewReconciler(sched *Scheduler, repo *Repo, gw *Gateway, catalog func() Catalog, store *db.Service, global *sql.DB, apps contracts.AppsService, log *slog.Logger) *Reconciler {
	return &Reconciler{sched: sched, repo: repo, gw: gw, catalog: catalog, store: store, global: global, apps: apps, log: log}
}

// Start sweeps every 30s until ctx ends.
func (r *Reconciler) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(ReconcileEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				r.ReconcileAll(ctx)
			}
		}
	}()
}

// ReconcileAll reconciles every registered app. Best-effort.
func (r *Reconciler) ReconcileAll(ctx context.Context) {
	if r.edgeNodeCount(ctx) == 0 || r.apps == nil {
		return
	}
	apps, err := r.apps.List(ctx, nil)
	if err != nil {
		return
	}
	for _, a := range apps {
		safe(func() { r.ReconcileApp(ctx, a.Name) })
	}
}

// ReconcileApp mirrors one app (no-op without a connected edge node).
func (r *Reconciler) ReconcileApp(ctx context.Context, app string) {
	if r.edgeNodeCount(ctx) == 0 {
		return
	}
	cat := r.catalog()
	if cat == nil {
		return
	}
	rooms := r.activeRooms(ctx, app)
	for _, row := range cat.Installs(ctx, app) {
		if !row.Enabled {
			continue
		}
		meta := cat.Meta(row.PluginID)
		if meta == nil || meta.Worker == nil || !meta.Worker.Edge {
			continue
		}
		cfg, err := plugins.ValidateConfig(meta, row.Config, true)
		if err != nil {
			continue // missing required config: don't schedule a crash-loop
		}
		r.reconcilePlugin(ctx, app, row.PluginID, rooms, cfg)
	}
}

func (r *Reconciler) reconcilePlugin(ctx context.Context, app, pluginID string, rooms []string, cfg *y.Map) {
	all, err := r.repo.List(ctx, app)
	if err != nil {
		return
	}
	var existing []Assignment
	for _, a := range all {
		if a.PluginID == pluginID && a.Status != StatusRevoked && a.Status != StatusStopped {
			existing = append(existing, a)
		}
	}
	wanted := map[string]bool{}
	for _, room := range rooms {
		wanted[room] = true
		found := false
		for _, a := range existing {
			found = found || (a.StreamID != nil && *a.StreamID == room)
		}
		if found {
			continue
		}
		c := cfg.Clone()
		c.Set("room", room)
		_, _ = r.sched.Schedule(ctx, ScheduleInput{App: app, PluginID: pluginID, StreamID: strPtr(room), Config: c})
	}
	for _, a := range existing {
		if a.StreamID != nil && *a.StreamID != "" && !wanted[*a.StreamID] {
			_, _ = r.sched.Revoke(ctx, a.ID)
		}
	}
}

// edgeNodeCount counts type-edge nodes with a live WS.
func (r *Reconciler) edgeNodeCount(ctx context.Context) int {
	rows, err := r.global.QueryContext(ctx, `SELECT id, type FROM nodes`)
	if err != nil {
		return 0
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id string
		var typ sql.NullString
		if rows.Scan(&id, &typ) == nil && typ.String == "edge" && r.gw.IsConnected(id) {
			n++
		}
	}
	return n
}

// activeRooms are distinct rooms with ≥1 active stream (failure → none).
func (r *Reconciler) activeRooms(ctx context.Context, app string) []string {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return nil
	}
	rows, err := h.QueryContext(ctx, `SELECT DISTINCT room FROM streams WHERE status = 'active' AND room IS NOT NULL AND room != '' ORDER BY room ASC`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var room string
		if rows.Scan(&room) == nil {
			out = append(out, room)
		}
	}
	return out
}
