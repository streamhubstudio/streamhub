package plugins

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Routes is the plugins module's HTTP surface: PluginsController (19
// routes under /apps/:app/plugins), GridAgentController (4, /grid) and
// AppstoreController (4, /plugins/:id/versions).
type Routes struct {
	svc          *Service
	versions     *Versions
	store        *Appstore
	agent        *Agent
	exporter     *Exporter
	clusterToken string
	authn        api.Authenticator // nil = no auth graph (dev): allow
}

// NewRoutes builds the module.
func NewRoutes(svc *Service, versions *Versions, store *Appstore, agent *Agent, exporter *Exporter, clusterToken string, authn api.Authenticator) *Routes {
	return &Routes{svc: svc, versions: versions, store: store, agent: agent, exporter: exporter, clusterToken: clusterToken, authn: authn}
}

// Register implements api.Module.
func (rt *Routes) Register(a huma.API) {
	rt.registerPlugins(a)
	rt.registerGrid(a)
	rt.registerAppstore(a)
}

func pluginOp(id, method, path, summary string, status int) *huma.Operation {
	return api.Bearer(&huma.Operation{
		OperationID: "PluginsController_" + id, Method: method, Path: api.Prefix + "/apps/{app}/plugins" + path,
		Summary: summary, Tags: []string{"plugins"}, DefaultStatus: status,
	})
}

func perm(op *huma.Operation, action string) huma.Operation {
	return *authz.Require(op, "config", action)
}

type appIn struct {
	App    string `path:"app"`
	Stream string `query:"stream"`
	Room   string `query:"room"`
}

type idIn struct {
	App string `path:"app"`
	ID  string `path:"id"`
}

type idBodyIn struct {
	App string `path:"app"`
	ID  string `path:"id"`
	api.RawBodyInput
}

type ingestIn struct {
	App   string `path:"app"`
	ID    string `path:"id"`
	Token string `header:"x-plugin-ingest-token"`
	api.RawBodyInput
}

type roomIn struct {
	App  string `path:"app"`
	ID   string `path:"id"`
	Room string `query:"room"`
}

type limitIn struct {
	App   string `path:"app"`
	ID    string `path:"id"`
	Limit string `query:"limit"`
}

func scopeOf(in *appIn) *Scope { return &Scope{Stream: in.Stream, Room: in.Room} }

// parseLoose decodes an untyped @Body() (no DTO: nothing validated).
func parseLoose(raw []byte) (any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return y.NewMap(), nil
	}
	v, err := y.ParseJSON(raw)
	if err != nil {
		return nil, httpx.BadRequest("Unexpected token in JSON body")
	}
	return v, nil
}

// logLimit is `limit ? max(1, min(1000, Number(limit) || 200)) : 200`.
func logLimit(raw string) int {
	if raw == "" {
		return 200
	}
	n := y.StringToNumber(raw)
	if math.IsNaN(n) || n == 0 {
		n = 200
	}
	return int(math.Max(1, math.Min(1000, n)))
}

type removed struct {
	Removed bool `json:"removed"`
}

func (rt *Routes) registerPlugins(a huma.API) {
	s := rt.svc
	huma.Register(a, perm(pluginOp("list", http.MethodGet, "", "Marketplace: all built-in plugins + this app install/config state.", 200), "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]View]], error) {
			v, err := s.List(ctx, in.App, scopeOf(in))
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, *api.Public(pluginOp("publicOverlays", http.MethodGet, "/public", "This app's ENABLED player-overlay plugins for anonymous players (no auth).", 200)),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]PublicOverlay]], error) {
			v, err := s.PublicOverlays(ctx, in.App, scopeOf(in))
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("getOne", http.MethodGet, "/{id}", "One marketplace entry (manifest + install state).", 200), "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[View]], error) {
			v, err := s.Get(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	type fileOut struct {
		ContentType        string `header:"Content-Type"`
		ContentDisposition string `header:"Content-Disposition"`
		ContentLength      string `header:"Content-Length"`
		Body               []byte
	}
	huma.Register(a, perm(pluginOp("export", http.MethodGet, "/{id}/export", "Export an installed Studio App as a standalone tarball.", 200), "write"),
		func(ctx context.Context, in *idIn) (*fileOut, error) {
			name, body, err := rt.exporter.Export(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return &fileOut{"application/gzip", `attachment; filename="` + name + `"`, strconv.Itoa(len(body)), body}, nil
		})

	huma.Register(a, perm(pluginOp("versions", http.MethodGet, "/{id}/versions", "Version state for this install (active pin, catalog, history).", 200), "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[AppVersionView]], error) {
			v, err := rt.versions.View(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("pinVersion", http.MethodPut, "/{id}/version", "Pin (or unpin) the appstore version this install runs.", 200), "write"),
		func(ctx context.Context, in *idBodyIn) (*api.Out[api.Envelope[AppVersionView]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			if b.Has("version") {
				b.Field("version").MaxLength(64).IsString()
			}
			if err := b.Err(); err != nil {
				return nil, err
			}
			v, err := rt.versions.Pin(ctx, in.App, in.ID, b.StringPtr("version"))
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("rollbackVersion", http.MethodPost, "/{id}/version/rollback", "Roll back to the version this install ran before its last change.", 201), "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[AppVersionView]], error) {
			v, err := rt.versions.Rollback(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("install", http.MethodPost, "/{id}/install", "Install a plugin into the app (idempotent).", 201), "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[View]], error) {
			v, err := s.Install(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("patch", http.MethodPatch, "/{id}", "Enable/disable and/or reconfigure an installed plugin.", 200), "write"),
		func(ctx context.Context, in *idBodyIn) (*api.Out[api.Envelope[View]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Optional("enabled").IsBoolean()
			b.Optional("config").IsObject()
			if err := b.Err(); err != nil {
				return nil, err
			}
			p := Patch{Enabled: b.Bool("enabled")}
			if b.Has("config") {
				parsed, _ := y.ParseJSON(in.RawBody)
				p.Config, _ = prop(parsed, "config").(*y.Map)
			}
			v, err := s.Patch(ctx, in.App, in.ID, p)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("remove", http.MethodDelete, "/{id}", "Uninstall a plugin (stops its worker).", 200), "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[removed]], error) {
			if err := s.Remove(ctx, in.App, in.ID); err != nil {
				return nil, err
			}
			return api.OK(removed{true}), nil
		})

	huma.Register(a, perm(pluginOp("startWorker", http.MethodPost, "/{id}/worker/start", "Explicitly (re)start a plugin worker via the worker-hook.", 201), "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[WorkerState]], error) {
			v, err := s.StartWorker(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("stopWorker", http.MethodPost, "/{id}/worker/stop", "Explicitly stop a plugin worker (no-op if idle).", 201), "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[WorkerState]], error) {
			v, err := s.StopWorker(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("workerStatus", http.MethodGet, "/{id}/worker/status", "Current worker state for a needsWorker plugin.", 200), "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[WorkerState]], error) {
			v, err := s.WorkerStatus(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, *api.Public(pluginOp("ingestLive", http.MethodPost, "/{id}/live", "Worker live-data ingest (framework channel, ingest-token auth).", 201)),
		func(ctx context.Context, in *ingestIn) (*api.Out[api.Envelope[OK]], error) {
			body, err := parseLoose(in.RawBody)
			if err != nil {
				return nil, err
			}
			v, err := s.IngestLive(ctx, in.App, in.ID, in.Token, body)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, *api.Public(pluginOp("ingestEvent", http.MethodPost, "/{id}/events", "Worker DOMAIN-EVENT ingest (framework channel, ingest-token auth).", 201)),
		func(ctx context.Context, in *ingestIn) (*api.Out[api.Envelope[EventAck]], error) {
			body, err := parseLoose(in.RawBody)
			if err != nil {
				return nil, err
			}
			v, err := s.IngestEvent(ctx, in.App, in.ID, in.Token, body)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("data", http.MethodGet, "/{id}/data", "Latest worker live data for ANY installed plugin (authenticated).", 200), "read"),
		func(ctx context.Context, in *roomIn) (*api.Out[api.Envelope[*LiveDataView]], error) {
			v, err := s.LiveData(ctx, in.App, in.ID, in.Room)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, *api.Public(pluginOp("liveData", http.MethodGet, "/{id}/live", "Latest worker live data for an ENABLED player-overlay plugin (no auth).", 200)),
		func(ctx context.Context, in *roomIn) (*api.Out[api.Envelope[*LiveDataView]], error) {
			v, err := s.LiveOverlayData(ctx, in.App, in.ID, in.Room)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("liveState", http.MethodGet, "/{id}/live/state", "Latest worker live data for the DASHBOARD (auth) — any needsWorker plugin.", 200), "read"),
		func(ctx context.Context, in *roomIn) (*api.Out[api.Envelope[*LiveDataView]], error) {
			v, err := s.LiveWorkerData(ctx, in.App, in.ID, in.Room)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, perm(pluginOp("logs", http.MethodGet, "/{id}/logs", "Per-plugin logs (worker output + persisted).", 200), "read"),
		func(ctx context.Context, in *limitIn) (*api.Out[api.Envelope[Logs]], error) {
			v, err := s.GetLogs(ctx, in.App, in.ID, logLimit(in.Limit))
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
}

// ---------------------------------------------------------------------------
// /grid (grid-agent.controller.ts) — cluster-token auth
// ---------------------------------------------------------------------------

const gridDisabled = "grid agent disabled (STREAMHUB_CLUSTER_TOKEN unset)"

func gridOp(id, method, path, summary string, status int) huma.Operation {
	return *api.Public(&huma.Operation{
		OperationID: "GridAgentController_" + id, Method: method, Path: api.Prefix + "/grid" + path,
		Summary: summary, Tags: []string{"grid"}, DefaultStatus: status,
	})
}

func (rt *Routes) gate(ctx context.Context) error {
	return AssertClusterToken(api.Request(ctx), rt.clusterToken, gridDisabled)
}

func (rt *Routes) registerGrid(a huma.API) {
	huma.Register(a, gridOp("createWorker", http.MethodPost, "/workers", "Run an offloaded plugin worker on this node (X-Cluster-Token).", 201),
		func(ctx context.Context, in *api.RawBodyInput) (*api.Out[api.Envelope[GridWorkerView]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Field("pluginId").MaxLength(64).NotEmpty().IsString()
			b.Field("appName").MaxLength(64).NotEmpty().IsString()
			b.Field("command").MaxLength(512).NotEmpty().IsString()
			b.Optional("args").ArrayMaxSize(256).EachIsString().IsArray()
			b.Optional("env").IsObject()
			b.Optional("ingestToken").MaxLength(200).IsString()
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := rt.gate(ctx); err != nil {
				return nil, err
			}
			parsed, _ := y.ParseJSON(in.RawBody)
			env, _ := prop(parsed, "env").(*y.Map)
			return api.OK(rt.agent.Spawn(GridWorkerInput{
				PluginID: b.String("pluginId"), AppName: b.String("appName"), Command: b.String("command"),
				Args: b.Strings("args"), Env: env, IngestToken: b.String("ingestToken"),
			})), nil
		})

	type wid struct {
		ID string `path:"id"`
	}
	huma.Register(a, gridOp("status", http.MethodGet, "/workers/{id}/status", "Status of a dispatched worker (X-Cluster-Token). 404 if unknown.", 200),
		func(ctx context.Context, in *wid) (*api.Out[api.Envelope[GridWorkerView]], error) {
			if err := rt.gate(ctx); err != nil {
				return nil, err
			}
			v, err := rt.agent.Status(in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, gridOp("stop", http.MethodPost, "/workers/{id}/stop", "Stop a dispatched worker (X-Cluster-Token). 404 if unknown.", 200),
		func(ctx context.Context, in *wid) (*api.Out[api.Envelope[GridWorkerView]], error) {
			if err := rt.gate(ctx); err != nil {
				return nil, err
			}
			v, err := rt.agent.Stop(in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	type wlogs struct {
		ID    string `path:"id"`
		Limit string `query:"limit"`
	}
	huma.Register(a, gridOp("logs", http.MethodGet, "/workers/{id}/logs", "Recent stdout/stderr of a dispatched worker (X-Cluster-Token). 404 if unknown.", 200),
		func(ctx context.Context, in *wlogs) (*api.Out[api.Envelope[[]LogLine]], error) {
			if err := rt.gate(ctx); err != nil {
				return nil, err
			}
			v, err := rt.agent.Logs(in.ID, logLimit(in.Limit))
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
}

// ---------------------------------------------------------------------------
// /plugins/:id/versions (appstore.controller.ts) — superadmin / cluster token
// ---------------------------------------------------------------------------

const maxBundleUpload = 200 * 1024 * 1024

func storeOp(id, method, path, summary string, status int) huma.Operation {
	return *api.Public(&huma.Operation{
		OperationID: "AppstoreController_" + id, Method: method, Path: api.Prefix + "/plugins" + path,
		Summary: summary, Tags: []string{"appstore"}, DefaultStatus: status,
	})
}

// requireSuperadmin authenticates a @Public route manually (401 on bad
// creds, 403 for a non-superadmin/global principal).
func (rt *Routes) requireSuperadmin(ctx context.Context) error {
	if rt.authn == nil {
		return nil
	}
	p, err := rt.authn.Authenticate(api.Request(ctx))
	if err != nil {
		return err
	}
	if p != nil && !p.IsSuperadmin && p.Scope != auth.ScopeGlobal {
		return httpx.Forbidden("this endpoint requires a superadmin credential")
	}
	return nil
}

type deletedOut struct {
	Deleted bool `json:"deleted"`
}

func (rt *Routes) registerAppstore(a huma.API) {
	type pid struct {
		ID string `path:"id"`
	}
	huma.Register(a, storeOp("list", http.MethodGet, "/{id}/versions", "List the appstore version catalog for a plugin (superadmin).", 200),
		func(ctx context.Context, in *pid) (*api.Out[api.Envelope[VersionCatalog]], error) {
			if err := rt.requireSuperadmin(ctx); err != nil {
				return nil, err
			}
			return api.OK(rt.store.ListVersions(in.ID)), nil
		})

	huma.Register(a, storeOp("upload", http.MethodPost, "/{id}/versions", "Upload a new immutable version bundle (superadmin, multipart).", 201),
		func(ctx context.Context, in *pid) (*api.Out[api.Envelope[*BundleManifest]], error) {
			r := api.Request(ctx)
			file, fields, err := readMultipart(r)
			if err != nil {
				return nil, err
			}
			b := validate.FromStrings(fields)
			b.Field("version").MaxLength(64).IsString()
			b.Optional("notes").MaxLength(2000).IsString()
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := rt.requireSuperadmin(ctx); err != nil {
				return nil, err
			}
			if len(file) == 0 {
				return nil, httpx.BadRequest("missing 'bundle' file part")
			}
			m, err := rt.store.SaveUploaded(in.ID, b.String("version"), file, b.StringPtr("notes"))
			if err != nil {
				return nil, err
			}
			return api.OK(m), nil
		})

	type pv struct {
		ID string `path:"id"`
		V  string `path:"v"`
	}
	type bundleOut struct {
		ContentType        string `header:"Content-Type"`
		ContentDisposition string `header:"Content-Disposition"`
		ContentLength      string `header:"Content-Length"`
		Sha256             string `header:"x-bundle-sha256"`
		Body               []byte
	}
	huma.Register(a, storeOp("downloadBundle", http.MethodGet, "/{id}/versions/{v}/bundle", "Download a version bundle (superadmin sk_ OR X-Cluster-Token).", 200),
		func(ctx context.Context, in *pv) (*bundleOut, error) {
			r := api.Request(ctx)
			if r.Header.Get("x-cluster-token") != "" {
				if err := AssertClusterToken(r, rt.clusterToken, "bundle download disabled (STREAMHUB_CLUSTER_TOKEN unset)"); err != nil {
					return nil, err
				}
			} else if err := rt.requireSuperadmin(ctx); err != nil {
				return nil, err
			}
			body, sum, name, err := rt.store.ReadBundle(in.ID, in.V)
			if err != nil {
				return nil, err
			}
			return &bundleOut{"application/gzip", `attachment; filename="` + name + `"`, strconv.Itoa(len(body)), sum, body}, nil
		})

	huma.Register(a, storeOp("remove", http.MethodDelete, "/{id}/versions/{v}", "Delete a version (superadmin). Refused if pinned or built-in.", 200),
		func(ctx context.Context, in *pv) (*api.Out[api.Envelope[deletedOut]], error) {
			if err := rt.requireSuperadmin(ctx); err != nil {
				return nil, err
			}
			if err := rt.versions.DeleteVersion(ctx, in.ID, in.V); err != nil {
				return nil, err
			}
			return api.OK(deletedOut{true}), nil
		})
}

// readMultipart is FileInterceptor('bundle', 200 MB) + the text fields.
// A non-multipart request carries no file and no fields.
func readMultipart(r *http.Request) ([]byte, map[string]string, error) {
	fields := map[string]string{}
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, fields, nil
	}
	var file []byte
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, httpx.BadRequest("Multipart: Unexpected end of form")
		}
		data, err := io.ReadAll(io.LimitReader(part, maxBundleUpload+1))
		if err != nil {
			return nil, nil, httpx.BadRequest(err.Error())
		}
		switch {
		case part.FileName() != "":
			if part.FormName() != "bundle" {
				return nil, nil, httpx.BadRequest("Unexpected field")
			}
			if len(data) > maxBundleUpload {
				return nil, nil, httpx.Nest(http.StatusRequestEntityTooLarge, "File too large")
			}
			file = data
		default:
			fields[part.FormName()] = string(data)
		}
	}
	return file, fields, nil
}

var _ = fmt.Sprintf
