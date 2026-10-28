package edge

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/cluster"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// staleAfter marks a node stale in the manager view.
const staleAfter = 90 * time.Second

var slugRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// NodeView is a node dressed for the edge manager UI.
type NodeView struct {
	ID         string  `json:"id"`
	Name       *string `json:"name"`
	URL        *string `json:"url"`
	Region     *string `json:"region"`
	Type       string  `json:"type"`
	Weight     float64 `json:"weight"`
	Status     string  `json:"status"`
	Connected  bool    `json:"connected"`
	Stale      bool    `json:"stale"`
	CreatedAt  string  `json:"createdAt"`
	LastSeenAt *string `json:"lastSeenAt"`
	Stats      *y.Map  `json:"stats"`
}

// Module is EdgeController + EdgeAppController.
type Module struct {
	db      *sql.DB
	gw      *Gateway
	sched   *Scheduler
	repo    *Repo
	catalog func() Catalog
	apps    contracts.AppsService // optional
	logs    func() Logs           // late-bound
	now     func() time.Time
	// CommandTimeout / LogTimeout are the request→reply timeouts (5s).
	CommandTimeout, LogTimeout time.Duration
}

// NewModule builds the REST surface.
func NewModule(global *sql.DB, gw *Gateway, sched *Scheduler, repo *Repo, catalog func() Catalog, apps contracts.AppsService, logs func() Logs) *Module {
	return &Module{db: global, gw: gw, sched: sched, repo: repo, catalog: catalog, apps: apps, logs: logs, now: time.Now,
		CommandTimeout: 5 * time.Second, LogTimeout: 5 * time.Second}
}

func op(id, method, path, summary string) *huma.Operation {
	return api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"edge"}})
}

func global(ctx context.Context) error { return api.RequireGlobal(ctx, api.GlobalScopeMessage) }

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	huma.Register(a, *op("EdgeController_listNodes", http.MethodGet, "/edge/nodes",
		"List cluster nodes with type/weight, live WS liveness and last stats."),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[[]NodeView]], error) {
			if err := global(ctx); err != nil {
				return nil, err
			}
			views, err := m.nodeViews(ctx, "")
			if err != nil {
				return nil, err
			}
			return api.OK(views), nil
		})

	type idBody struct {
		ID      string `path:"id"`
		RawBody []byte
	}
	huma.Register(a, *op("EdgeController_patchNode", http.MethodPatch, "/edge/nodes/{id}",
		"Set a node's type and/or scheduling weight."),
		func(ctx context.Context, in *idBody) (*api.Out[api.Envelope[NodeView]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Optional("type").IsIn("common", "edge")
			b.Optional("weight").Max(100000).Min(0).IsInt()
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := global(ctx); err != nil {
				return nil, err
			}
			var one int
			if err := m.db.QueryRowContext(ctx, `SELECT 1 FROM nodes WHERE id = ?`, in.ID).Scan(&one); err != nil {
				return nil, cluster.ObjErr(http.StatusNotFound, "unknown node")
			}
			sets, vals := "", []any{}
			if t := b.StringPtr("type"); t != nil {
				sets, vals = "type = ?", append(vals, *t)
			}
			if w := b.Float("weight"); w != nil {
				if sets != "" {
					sets += ", "
				}
				sets += "weight = ?"
				vals = append(vals, *w)
			}
			if sets != "" {
				if _, err := m.db.ExecContext(ctx, `UPDATE nodes SET `+sets+` WHERE id = ?`, append(vals, in.ID)...); err != nil {
					return nil, err
				}
			}
			views, err := m.nodeViews(ctx, in.ID)
			if err != nil || len(views) == 0 {
				return nil, cluster.ObjErr(http.StatusNotFound, "unknown node")
			}
			return api.OK(views[0]), nil
		})

	type cmdMeta struct {
		NodeID  string `json:"nodeId"`
		Command string `json:"command"`
		By      string `json:"by"`
	}
	huma.Register(a, *op("EdgeController_command", http.MethodPost, "/edge/nodes/{id}/command",
		"Send a command (restart|reboot|ping) to a connected node over the WS channel."),
		func(ctx context.Context, in *idBody) (*statusOut[api.Envelope[CommandResult]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Field("command").IsIn("restart", "reboot", "ping")
			b.Optional("args").IsObject()
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := global(ctx); err != nil {
				return nil, err
			}
			by := "unknown"
			if p := auth.From(ctx); p != nil && p.UserID != "" {
				by = p.UserID
			}
			if l := m.logs(); l != nil {
				l.Write("info", "edge", fmt.Sprintf("node command '%s'", b.String("command")), cmdMeta{in.ID, b.String("command"), by}, nil)
			}
			res, err := m.gw.Command(in.ID, b.String("command"), orderedObject(in.RawBody, "args"), m.CommandTimeout)
			if err != nil {
				return nil, err
			}
			return &statusOut[api.Envelope[CommandResult]]{Status: http.StatusCreated, Body: api.Envelope[CommandResult]{Data: res}}, nil
		})

	type logsIn struct {
		ID string `path:"id"`
	}
	type nodeLogLines struct {
		Lines []string `json:"lines"`
	}
	huma.Register(a, *op("EdgeController_logs_", http.MethodGet, "/edge/nodes/{id}/logs",
		"Tail a connected node's edge-runtime log over the WS channel."),
		func(ctx context.Context, in *logsIn) (*api.Out[api.Envelope[nodeLogLines]], error) {
			if err := global(ctx); err != nil {
				return nil, err
			}
			raw := "200"
			if vs, ok := api.Request(ctx).URL.Query()["lines"]; ok && len(vs) > 0 {
				raw = vs[0]
			}
			n, ok := config.ParseIntPrefix(raw)
			if !ok || n == 0 {
				n = 200
			}
			n = min(max(n, 1), 2000)
			lines, err := m.gw.LogTail(in.ID, n, m.LogTimeout)
			if err != nil {
				return nil, err
			}
			return api.OK(nodeLogLines{lines}), nil
		})

	type listIn struct {
		App string `query:"app"`
	}
	huma.Register(a, *op("EdgeController_listAssignments", http.MethodGet, "/edge/assignments",
		"List edge assignments (optionally by app)."),
		func(ctx context.Context, in *listIn) (*api.Out[api.Envelope[[]Assignment]], error) {
			if err := global(ctx); err != nil {
				return nil, err
			}
			list, err := m.repo.List(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, *op("EdgeController_createAssignment", http.MethodPost, "/edge/assignments",
		"Schedule a worker workload onto an edge node."),
		func(ctx context.Context, in *api.RawBodyInput) (*statusOut[api.Envelope[*Assignment]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Field("app").Matches(slugRE, "app must be a slug").IsString()
			validateAssignmentBody(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := global(ctx); err != nil {
				return nil, err
			}
			a, err := m.sched.Schedule(ctx, ScheduleInput{App: b.String("app"), PluginID: b.String("pluginId"),
				StreamID: b.StringPtr("streamId"), Config: orderedObject(in.RawBody, "config"), Policy: b.String("policy")})
			if err != nil {
				return nil, err
			}
			return created(a), nil
		})

	type assignmentRevoked struct {
		ID      string `json:"id"`
		Revoked bool   `json:"revoked"`
	}
	type idIn struct {
		ID string `path:"id"`
	}
	huma.Register(a, *op("EdgeController_revokeAssignment", http.MethodDelete, "/edge/assignments/{id}",
		"Revoke an assignment."),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[assignmentRevoked]], error) {
			if err := global(ctx); err != nil {
				return nil, err
			}
			a, err := m.sched.Revoke(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			if a == nil {
				return nil, cluster.ObjErr(http.StatusNotFound, "unknown assignment")
			}
			return api.OK(assignmentRevoked{in.ID, true}), nil
		})

	// ---- app-scoped (/apps/:app/edge/assignments) ----

	type appIn struct {
		App string `path:"app"`
	}
	appOp := func(id, method, path, summary, action string) huma.Operation {
		o := api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"edge"}})
		return *authz.Require(o, "config", action)
	}
	huma.Register(a, appOp("EdgeAppController_list", http.MethodGet, "/apps/{app}/edge/assignments",
		"List this app's edge assignments.", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]Assignment]], error) {
			if err := m.requireApp(ctx, in.App); err != nil {
				return nil, err
			}
			list, err := m.repo.List(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	type appBody struct {
		App     string `path:"app"`
		RawBody []byte
	}
	huma.Register(a, appOp("EdgeAppController_create", http.MethodPost, "/apps/{app}/edge/assignments",
		"Schedule an edge-capable plugin workload onto an edge node.", "write"),
		func(ctx context.Context, in *appBody) (*statusOut[api.Envelope[*Assignment]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			validateAssignmentBody(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := m.requireApp(ctx, in.App); err != nil {
				return nil, err
			}
			pluginID := b.String("pluginId")
			if err := m.requireEdgePlugin(ctx, in.App, pluginID); err != nil {
				return nil, err
			}
			cfg := orderedObject(in.RawBody, "config")
			a, err := m.sched.Schedule(ctx, ScheduleInput{App: in.App, PluginID: pluginID, StreamID: b.StringPtr("streamId"), Config: cfg, Policy: b.String("policy")})
			if err != nil {
				return nil, err
			}
			return created(a), nil
		})

	type appIDIn struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}
	huma.Register(a, appOp("EdgeAppController_revoke", http.MethodDelete, "/apps/{app}/edge/assignments/{id}",
		"Revoke one of this app’s edge assignments.", "write"),
		func(ctx context.Context, in *appIDIn) (*api.Out[api.Envelope[assignmentRevoked]], error) {
			if err := m.requireApp(ctx, in.App); err != nil {
				return nil, err
			}
			existing, err := m.repo.Get(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			if existing == nil || existing.App != in.App {
				return nil, httpx.NotFound("unknown assignment for this app")
			}
			a, err := m.sched.Revoke(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			if a == nil {
				return nil, httpx.NotFound("unknown assignment for this app")
			}
			return api.OK(assignmentRevoked{in.ID, true}), nil
		})
}

// validateAssignmentBody is the shared part of CreateAssignmentDto /
// CreateAppAssignmentDto (pluginId, streamId, config, policy).
func validateAssignmentBody(b *validate.Body) {
	b.Field("pluginId").Matches(slugRE, "pluginId must be a slug").IsString()
	b.Optional("streamId").Length(1, 255).IsString()
	b.Optional("config").IsObject()
	b.Optional("policy").IsIn(PolicyRoundRobin, PolicyWeighted)
}

// statusOut carries an explicit status (POST without @HttpCode → 201).
type statusOut[T any] struct {
	Status int
	Body   T
}

func created(a *Assignment) *statusOut[api.Envelope[*Assignment]] {
	return &statusOut[api.Envelope[*Assignment]]{Status: http.StatusCreated, Body: api.Envelope[*Assignment]{Data: a}}
}

func (m *Module) requireApp(ctx context.Context, app string) error {
	if m.apps == nil {
		return httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	rec, err := m.apps.Get(ctx, app)
	if err != nil {
		return err
	}
	if rec == nil {
		return httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	return nil
}

func (m *Module) requireEdgePlugin(ctx context.Context, app, pluginID string) error {
	cat := m.catalog()
	if cat == nil {
		return httpx.NotFound(fmt.Sprintf("plugin '%s' not found", pluginID))
	}
	meta := cat.Meta(pluginID)
	if meta == nil {
		return httpx.NotFound(fmt.Sprintf("plugin '%s' not found", pluginID))
	}
	if meta.Worker == nil || !meta.Worker.Edge {
		return httpx.BadRequest(fmt.Sprintf("plugin '%s' is not edge-capable (worker.edge)", pluginID))
	}
	if cat.Install(ctx, app, pluginID) == nil {
		return httpx.BadRequest(fmt.Sprintf("plugin '%s' is not installed in app '%s'", pluginID, app))
	}
	return nil
}

// nodeViews lists nodes (id "" = all, oldest first) as manager views.
func (m *Module) nodeViews(ctx context.Context, id string) ([]NodeView, error) {
	q := `SELECT id, name, url, region, type, weight, status, created_at,
                last_seen_at, stats_json
           FROM nodes ORDER BY created_at ASC, name ASC`
	args := []any{}
	if id != "" {
		q = `SELECT id, name, url, region, type, weight, status, created_at,
                last_seen_at, stats_json FROM nodes WHERE id = ?`
		args = append(args, id)
	}
	rows, err := m.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NodeView{}
	for rows.Next() {
		var (
			v                                   NodeView
			name, url, region, typ, seen, stats sql.NullString
			weight                              sql.NullFloat64
		)
		if err := rows.Scan(&v.ID, &name, &url, &region, &typ, &weight, &v.Status, &v.CreatedAt, &seen, &stats); err != nil {
			return nil, err
		}
		v.Name, v.URL, v.Region, v.LastSeenAt = nptr(name), nptr(url), nptr(region), nptr(seen)
		v.Type = "common"
		if typ.String == "edge" {
			v.Type = "edge"
		}
		v.Weight = 100
		if weight.Valid {
			v.Weight = weight.Float64
		}
		v.Connected = m.gw.IsConnected(v.ID)
		v.Stale = !v.Connected && m.isStale(seen)
		v.Stats = cluster.ParseStats(stats)
		out = append(out, v)
	}
	return out, rows.Err()
}

func (m *Module) isStale(seen sql.NullString) bool {
	t, ok := parseSQLiteUTC(seen)
	if !ok {
		return true
	}
	return m.now().Sub(t) > staleAfter
}

func nptr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	return &n.String
}

// orderedObject re-reads a top-level object property of a JSON body with JS
// key order (nil when absent / not an object).
func orderedObject(raw []byte, key string) *y.Map {
	v, err := y.ParseJSON(raw)
	if err != nil {
		return nil
	}
	root, ok := v.(*y.Map)
	if !ok {
		return nil
	}
	obj, _ := root.Get(key).(*y.Map)
	return obj
}
