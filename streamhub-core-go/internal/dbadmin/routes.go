package dbadmin

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// purgePage is the page size when cascading a purge over an app's VODs.
const purgePage = 200

// VodDeleter is the slice of RecordingService the VOD purge reuses: the
// per-VOD cascade (row + S3 objects + local files).
type VodDeleter interface {
	// ListVodIDs is listVods(app, {limit, offset}).data ids, newest first.
	ListVodIDs(ctx context.Context, app string, limit, offset int) ([]int64, error)
	// DeleteVod is deleteVod(app, id) → {s3Deleted, localDeleted}.
	DeleteVod(ctx context.Context, app string, id int64) (s3Deleted int64, localDeleted bool, err error)
}

// PurgeResult is the per-slice purge report.
type PurgeResult struct {
	Scope          string `json:"scope"`
	VodsDeleted    int64  `json:"vodsDeleted"`
	StreamsDeleted int64  `json:"streamsDeleted"`
	LogsDeleted    int64  `json:"logsDeleted"`
	S3Deleted      int64  `json:"s3Deleted"`
	LocalDeleted   int64  `json:"localDeleted"`
}

// Module is DbAdminController.
type Module struct {
	m     *Maintenance
	vods  VodDeleter // nil until the recording module is wired
	audit *audit.Service
}

// New builds the controller; vods may be nil (VOD purges then delete 0).
func New(m *Maintenance, vods VodDeleter, a *audit.Service) *Module {
	return &Module{m: m, vods: vods, audit: a}
}

// SetVods late-binds the recording cascade.
func (d *Module) SetVods(v VodDeleter) { d.vods = v }

func op(id, method, path, summary string, status int) *huma.Operation {
	return api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"db-admin"}, DefaultStatus: status})
}

// Register implements api.Module.
func (d *Module) Register(a huma.API) {
	type appIn struct {
		App string `path:"app"`
	}
	huma.Register(a, *authz.Require(op("DbAdminController_appHealth", http.MethodGet, "/apps/{app}/db/health",
		"Health of the app DB: size, WAL size, page/freelist counts, fragmentation %, per-table rows.", http.StatusOK), "usage", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[Health]], error) {
			h, err := d.m.AppHealth(ctx, in.App)
			if err != nil {
				return nil, httpx.Internal("Internal server error")
			}
			return api.OK(h), nil
		})

	huma.Register(a, *authz.Require(op("DbAdminController_optimizeApp", http.MethodPost, "/apps/{app}/db/optimize",
		"Optimize the app DB: PRAGMA optimize + ANALYZE + REINDEX + VACUUM + wal_checkpoint(TRUNCATE). Returns before/after sizes.", http.StatusCreated), "app", "write"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[OptimizeResult]], error) {
			r, err := d.m.OptimizeApp(ctx, in.App)
			if err != nil {
				return nil, httpx.Internal("Internal server error")
			}
			return api.OK(r), nil
		})

	type purgeIn struct {
		App     string `path:"app"`
		RawBody []byte
	}
	huma.Register(a, *authz.Require(op("DbAdminController_purge", http.MethodPost, "/apps/{app}/db/purge",
		"Purge app data by scope ('vods' | 'logs' | 'all'); requires confirm:true.", http.StatusCreated), "app", "delete"),
		func(ctx context.Context, in *purgeIn) (*api.Out[api.Envelope[PurgeResult]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Field("scope").IsIn("vods", "logs", "all")
			confirm, _ := b.Raw("confirm").(bool)
			b.Field("confirm").Check(confirm, "confirm must be true to authorize a purge").IsBoolean()
			if err := b.Err(); err != nil {
				return nil, err
			}
			res, err := d.Purge(ctx, in.App, b.String("scope"))
			if err != nil {
				return nil, httpx.Internal("Internal server error")
			}
			d.audit.RecordCtx(ctx, audit.Event{Action: "db.purge", TargetType: audit.Str("app"), TargetID: audit.Str(in.App), Meta: res})
			return api.OK(res), nil
		})

	huma.Register(a, *authz.Require(op("DbAdminController_systemHealth", http.MethodGet, "/system/db/health",
		"Health of the GLOBAL registry DB (data/streamhub.db). Requires a global-scope token.", http.StatusOK), "usage", "read"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[Health]], error) {
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			return api.OK(d.m.GlobalHealth(ctx)), nil
		})
}

// Purge removes the scope's slice of app data (never the app or its config).
func (d *Module) Purge(ctx context.Context, app, scope string) (PurgeResult, error) {
	r := PurgeResult{Scope: scope}
	if scope == "vods" || scope == "all" {
		r.VodsDeleted, r.S3Deleted, r.LocalDeleted = d.purgeVods(ctx, app)
	}
	if scope == "all" {
		n, err := d.m.PurgeAppStreams(ctx, app)
		if err != nil {
			return r, err
		}
		r.StreamsDeleted = n
	}
	if scope == "logs" || scope == "all" {
		n, err := d.m.PurgeAppLogs(ctx, app)
		if err != nil {
			return r, err
		}
		r.LogsDeleted = n
	}
	return r, nil
}

// purgeVods drains the VOD list from offset 0 (deletes shrink it), bounded
// so a non-deletable VOD can't spin.
func (d *Module) purgeVods(ctx context.Context, app string) (vods, s3, local int64) {
	if d.vods == nil {
		return 0, 0, 0
	}
	for guard := 0; guard < 100000; guard++ {
		ids, err := d.vods.ListVodIDs(ctx, app, purgePage, 0)
		if err != nil || len(ids) == 0 {
			break
		}
		progressed := false
		for _, id := range ids {
			s3n, loc, err := d.vods.DeleteVod(ctx, app, id)
			if err != nil {
				continue // vanished mid-purge
			}
			vods++
			s3 += s3n
			if loc {
				local++
			}
			progressed = true
		}
		if !progressed {
			break
		}
	}
	return vods, s3, local
}
