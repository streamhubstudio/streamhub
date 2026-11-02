package quotas

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/validate"
)

// Register implements api.Module (quotas.controller.ts: /tenants).
func (s *Service) Register(a huma.API) {
	huma.Register(a, *authz.Require(api.Bearer(&huma.Operation{
		OperationID: "QuotasController_list",
		Method:      http.MethodGet,
		Path:        api.Prefix + "/tenants",
		Summary:     "List every tenant + its effective quota (superadmin only).",
		Tags:        []string{"quotas"},
	}), "tenant", "read"), func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[[]TenantSummary]], error) {
		if err := requireSuperadmin(ctx); err != nil {
			return nil, err
		}
		return api.OK(s.ListTenants(ctx)), nil
	})

	type idInput struct {
		ID string `path:"id"`
	}
	huma.Register(a, *authz.Require(api.Bearer(&huma.Operation{
		OperationID: "QuotasController_usage",
		Method:      http.MethodGet,
		Path:        api.Prefix + "/tenants/{id}/usage",
		Summary:     "Tenant quota usage vs limits (apps, streams, recording, egress).",
		Tags:        []string{"quotas"},
	}), "usage", "read"), func(ctx context.Context, in *idInput) (*api.Out[api.Envelope[UsageReport]], error) {
		// A non-superadmin may only read its OWN tenant (always enforced).
		// Node exempted every api_token, so an app-scoped token read any
		// tenant's usage; only global-scope credentials are exempt now.
		if p := auth.From(ctx); p != nil && !p.IsSuperadmin && p.Scope != auth.ScopeGlobal {
			if p.TenantID != "" && p.TenantID != in.ID {
				return nil, httpx.Forbidden("cannot read another tenant usage")
			}
		}
		return api.OK(s.GetUsage(ctx, in.ID)), nil
	})

	type patchInput struct {
		ID string `path:"id"`
		api.RawBodyInput
	}
	huma.Register(a, *authz.Require(api.Bearer(&huma.Operation{
		OperationID: "QuotasController_updateQuotas",
		Method:      http.MethodPatch,
		Path:        api.Prefix + "/tenants/{id}/quotas",
		Summary:     "Raise/lower a tenant's plan + quota limits (superadmin only).",
		Tags:        []string{"quotas"},
	}), "tenant", "write"), func(ctx context.Context, in *patchInput) (*api.Out[api.Envelope[*TenantSummary]], error) {
		body, err := validate.Parse(in.RawBody)
		if err != nil {
			return nil, err
		}
		upd, err := ParseUpdate(body)
		if err != nil {
			return nil, err
		}
		if err := requireSuperadmin(ctx); err != nil {
			return nil, err
		}
		sum, err := s.SetQuotas(ctx, in.ID, upd)
		if err != nil {
			return nil, err
		}
		return api.OK(sum), nil
	})
}

// ParseUpdate validates an UpdateQuotasDto body.
func ParseUpdate(b *validate.Body) (UpdateInput, error) {
	b.Optional("plan").Length(1, 64).IsString()
	for _, f := range []string{"maxApps", "maxConcurrentStreams", "maxRecordingMinutesMonth", "maxEgressGbMonth", "maxStorageGb"} {
		b.Optional(f).Min(-1).IsInt()
	}
	if err := b.Err(); err != nil {
		return UpdateInput{}, err
	}
	return UpdateInput{
		Plan:                     b.StringPtr("plan"),
		MaxApps:                  b.Int("maxApps"),
		MaxConcurrentStreams:     b.Int("maxConcurrentStreams"),
		MaxRecordingMinutesMonth: b.Int("maxRecordingMinutesMonth"),
		MaxEgressGBMonth:         b.Int("maxEgressGbMonth"),
		MaxStorageGB:             b.Int("maxStorageGb"),
	}, nil
}

// requireSuperadmin gates tenant administration (always enforced).
func requireSuperadmin(ctx context.Context) error {
	if p := auth.From(ctx); p == nil || !p.IsSuperadmin {
		return httpx.Forbidden("superadmin only")
	}
	return nil
}
