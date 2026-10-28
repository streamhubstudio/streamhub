package backups

import (
	"context"
	"net/http"
	"regexp"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

var dbIDRE = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9_-]*$`)

func op(id, method, path, summary string) *huma.Operation {
	return api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"backups"}})
}

func actor(ctx context.Context) string {
	if p := auth.From(ctx); p != nil {
		return p.UserID
	}
	return ""
}

// Register implements api.Module (BackupsController, global scope only).
func (s *Service) Register(a huma.API) {
	huma.Register(a, *op("BackupsController_list", http.MethodGet, "/system/backups",
		"List available snapshots per database plus the effective backup settings."),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[Overview]], error) {
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			ov, err := s.Overview(ctx)
			if err != nil {
				return nil, httpx.Internal("Internal server error")
			}
			return api.OK(ov), nil
		})

	huma.Register(a, *op("BackupsController_run", http.MethodPost, "/system/backups",
		"Trigger an on-demand backup NOW (VACUUM INTO + gzip of every SQLite DB, then prune)."),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[RunResult]], error) {
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			// Detached: an aborted request never leaves a half-written run.
			return api.OK(s.RunBackup(context.WithoutCancel(ctx), "manual", actor(ctx))), nil
		})

	huma.Register(a, *op("BackupsController_restore", http.MethodPost, "/system/backups/restore",
		"Restore a snapshot over the LIVE database (destructive; requires confirm:true)."),
		func(ctx context.Context, in *api.RawBodyInput) (*api.Out[api.Envelope[RestoreResult]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			// RestoreBackupDto (rules bottom-up per property)
			b.Field("db").Matches(dbIDRE, "db must be a database id (streamhub | app-<name>)").IsString()
			b.Field("snapshot").IsString()
			confirm, _ := b.Raw("confirm").(bool)
			b.Field("confirm").Check(confirm, "confirm must be true to authorize a restore").IsBoolean()
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			res, err := s.Restore(context.WithoutCancel(ctx), b.String("db"), b.String("snapshot"), actor(ctx))
			if err != nil {
				if _, ok := err.(*httpx.Error); ok {
					return nil, err
				}
				return nil, httpx.Internal("Internal server error")
			}
			return api.OK(res), nil
		})
}
