package streamflow

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Routes is StreamflowController: /apps/:app/plugins/streamflow/… gated by
// @RequirePermission('config', read|write).
type Routes struct {
	Svc     *Service
	Secrets *Secrets
}

const base = "/apps/{app}/plugins/streamflow"

func op(id, method, path, summary, action string) huma.Operation {
	o := api.Bearer(&huma.Operation{
		OperationID: "StreamflowController_" + id, Method: method, Path: api.Prefix + base + path,
		Summary: summary, Tags: []string{"streamflow"},
	})
	if method == http.MethodPost {
		o.DefaultStatus = http.StatusCreated
	}
	return *authz.Require(o, "config", action)
}

// dto validates a raw body (ValidationPipe) and returns the ordered object.
func dto(raw []byte, rules func(*validate.Body)) (*y.Map, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, err
	}
	rules(b)
	if err := b.Err(); err != nil {
		return nil, err
	}
	v, _ := y.ParseJSON(raw)
	return asObject(v), nil
}

type appIn struct {
	App string `path:"app"`
}

type idIn struct {
	App string `path:"app"`
	ID  string `path:"id"`
}

type idBody struct {
	App     string `path:"app"`
	ID      string `path:"id"`
	RawBody []byte
}

type appBody struct {
	App     string `path:"app"`
	RawBody []byte
}

// lookup is body[key] with presence (whitelisted DTO property).
func lookup(m *y.Map, key string) (any, bool) {
	v, ok := m.Lookup(key)
	if ok && y.IsUndefined(v) {
		return nil, false
	}
	return v, ok
}

// Register implements api.Module.
func (r *Routes) Register(a huma.API) {
	huma.Register(a, op("boxes", http.MethodGet, "/boxes", "Box-type catalogue (palette + config schema) for the UI.", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]json.RawMessage]], error) {
			return api.OK(r.Svc.Boxes(ctx, in.App)), nil
		})
	// GO-DIVERGENCE: in the Node core VisionAppsController's
	// `apps/:app/plugins/:model/events` is registered first and shadows this
	// route (404 "unknown vision model 'streamflow'"), leaving the trigger
	// picker without its event catalogue. Go mounts it: the literal
	// `streamflow` segment is more specific than `{model}` in ServeMux.
	r.registerEvents(a)

	// --- Workflows ------------------------------------------------------------
	huma.Register(a, op("listWorkflows", http.MethodGet, "/workflows", "List this app’s workflows.", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]Workflow]], error) {
			list, err := r.Svc.ListWorkflows(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})
	huma.Register(a, op("createWorkflow", http.MethodPost, "/workflows", "Create a workflow.", "write"),
		func(ctx context.Context, in *appBody) (*api.Out[api.Envelope[*Workflow]], error) {
			b, err := dto(in.RawBody, func(v *validate.Body) {
				v.Field("name").IsString()
				v.Optional("enabled").IsBoolean()
				v.Optional("graph").IsObject()
			})
			if err != nil {
				return nil, err
			}
			name, _ := b.Get("name").(string)
			if name = strings.TrimSpace(name); name == "" {
				return nil, httpx.BadRequest("body must carry a 'name'")
			}
			var enabled *bool
			if e, ok := b.Get("enabled").(bool); ok {
				enabled = &e
			}
			graph, _ := lookup(b, "graph")
			wf, err := r.Svc.CreateWorkflow(ctx, in.App, name, enabled, graph)
			if err != nil {
				return nil, err
			}
			return api.OK(wf), nil
		})
	huma.Register(a, op("importWorkflow", http.MethodPost, "/workflows/import", "Import a workflow from portable JSON (validated).", "write"),
		func(ctx context.Context, in *appBody) (*api.Out[api.Envelope[*Workflow]], error) {
			b, err := dto(in.RawBody, func(v *validate.Body) {
				v.Field("workflow").IsObject()
				v.Optional("name").IsString()
			})
			if err != nil {
				return nil, err
			}
			wfRaw, ok := b.Get("workflow").(*y.Map)
			if !ok || wfRaw == nil {
				return nil, httpx.BadRequest("body must carry a 'workflow' object")
			}
			wf, err := r.Svc.ImportWorkflow(ctx, in.App, wfRaw, b.Get("name"))
			if err != nil {
				return nil, err
			}
			return api.OK(wf), nil
		})
	huma.Register(a, op("getWorkflow", http.MethodGet, "/workflows/{id}", "Get one workflow (with its graph).", "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*Workflow]], error) {
			wf, err := r.Svc.GetWorkflow(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(wf), nil
		})
	huma.Register(a, op("exportWorkflow", http.MethodGet, "/workflows/{id}/export", "Export a workflow as portable JSON (secret-safe).", "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*y.Map]], error) {
			out, err := r.Svc.ExportWorkflow(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(out), nil
		})
	huma.Register(a, op("updateWorkflow", http.MethodPut, "/workflows/{id}", "Update a workflow (name / enabled / graph).", "write"),
		func(ctx context.Context, in *idBody) (*api.Out[api.Envelope[*Workflow]], error) {
			b, err := dto(in.RawBody, func(v *validate.Body) {
				v.Optional("name").IsString()
				v.Optional("enabled").IsBoolean()
				v.Optional("graph").IsObject()
			})
			if err != nil {
				return nil, err
			}
			var p WorkflowPatch
			p.Name, p.HasName = lookup(b, "name")
			p.Enabled, p.HasEnabled = lookup(b, "enabled")
			p.Graph, p.HasGraph = lookup(b, "graph")
			wf, err := r.Svc.UpdateWorkflow(ctx, in.App, in.ID, p)
			if err != nil {
				return nil, err
			}
			return api.OK(wf), nil
		})
	huma.Register(a, op("deleteWorkflow", http.MethodDelete, "/workflows/{id}", "Delete a workflow (and its run history).", "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[map[string]bool]], error) {
			res, err := r.Svc.DeleteWorkflow(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})
	huma.Register(a, op("enableWorkflow", http.MethodPost, "/workflows/{id}/enable", "Enable/disable a workflow.", "write"),
		func(ctx context.Context, in *idBody) (*api.Out[api.Envelope[*Workflow]], error) {
			b, err := dto(in.RawBody, func(v *validate.Body) { v.Optional("enabled").IsBoolean() })
			if err != nil {
				return nil, err
			}
			wf, err := r.Svc.UpdateWorkflow(ctx, in.App, in.ID, WorkflowPatch{Enabled: b.Get("enabled") != false, HasEnabled: true})
			if err != nil {
				return nil, err
			}
			return api.OK(wf), nil
		})
	huma.Register(a, op("runWorkflow", http.MethodPost, "/workflows/{id}/run", "Run a workflow manually (optional payload).", "write"),
		func(ctx context.Context, in *idBody) (*api.Out[api.Envelope[*Run]], error) {
			b, err := dto(in.RawBody, func(v *validate.Body) { v.Optional("payload").IsObject() })
			if err != nil {
				return nil, err
			}
			payload, _ := b.Get("payload").(*y.Map)
			run, err := r.Svc.ManualRun(ctx, in.App, in.ID, payload)
			if err != nil {
				return nil, err
			}
			return api.OK(run), nil
		})

	// --- Runs -------------------------------------------------------------------
	type runsIn struct {
		App        string `path:"app"`
		WorkflowID string `query:"workflowId"`
		Limit      string `query:"limit"`
	}
	huma.Register(a, op("listRuns", http.MethodGet, "/runs", "List recent runs (optionally filtered by workflow).", "read"),
		func(ctx context.Context, in *runsIn) (*api.Out[api.Envelope[[]Run]], error) {
			var lim *float64
			if in.Limit != "" {
				if n, ok := parseIntJS(in.Limit); ok {
					lim = &n
				}
			}
			runs, err := r.Svc.ListRuns(ctx, in.App, strings.TrimSpace(in.WorkflowID), lim)
			if err != nil {
				return nil, err
			}
			return api.OK(runs), nil
		})
	huma.Register(a, op("getRun", http.MethodGet, "/runs/{id}", "One run with its per-box steps.", "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*RunDetail]], error) {
			d, err := r.Svc.GetRun(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(d), nil
		})

	// --- Secrets (write-only) ---------------------------------------------------
	type nameIn struct {
		App  string `path:"app"`
		Name string `path:"name"`
	}
	type nameBody struct {
		App     string `path:"app"`
		Name    string `path:"name"`
		RawBody []byte
	}
	huma.Register(a, op("listSecrets", http.MethodGet, "/secrets", "List secret NAMES + masked hint (never the value).", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]SecretMeta]], error) {
			list, err := r.Secrets.List(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})
	huma.Register(a, op("putSecret", http.MethodPut, "/secrets/{name}", "Create/replace a secret value (encrypted at rest).", "write"),
		func(ctx context.Context, in *nameBody) (*api.Out[api.Envelope[*SecretMeta]], error) {
			b, err := dto(in.RawBody, func(v *validate.Body) { v.Field("value").IsString() })
			if err != nil {
				return nil, err
			}
			value, _ := b.Get("value").(string)
			meta, err := r.Secrets.Put(ctx, in.App, in.Name, value)
			if err != nil {
				return nil, err
			}
			return api.OK(meta), nil
		})
	huma.Register(a, op("deleteSecret", http.MethodDelete, "/secrets/{name}", "Delete a secret.", "write"),
		func(ctx context.Context, in *nameIn) (*api.Out[api.Envelope[map[string]bool]], error) {
			res, err := r.Secrets.Remove(ctx, in.App, in.Name)
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})
}

// parseIntJS is Number.parseInt(s, 10) (ok=false for NaN).
func parseIntJS(s string) (float64, bool) {
	t := strings.TrimLeft(s, " \t\n\r\v\f")
	i := 0
	if i < len(t) && (t[i] == '+' || t[i] == '-') {
		i++
	}
	j := i
	for j < len(t) && t[j] >= '0' && t[j] <= '9' {
		j++
	}
	if j == i {
		return 0, false
	}
	n := y.StringToNumber(t[:j])
	return n, !math.IsNaN(n)
}

// registerEvents mounts GET …/streamflow/events (the event catalogue).
func (r *Routes) registerEvents(a huma.API) {
	huma.Register(a, op("events", http.MethodGet, "/events", "Event catalogue (known trigger events by family) for the UI.", "read"),
		func(ctx context.Context, _ *appIn) (*api.Out[api.Envelope[json.RawMessage]], error) {
			return api.OK(eventCatalogue()), nil
		})
}
