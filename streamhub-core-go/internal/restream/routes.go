package restream

import (
	"context"
	"net/http"
	"regexp"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// Quotas is QuotasService.enforceEgress.
type Quotas interface {
	EnforceEgress(ctx context.Context, p *auth.Principal) error
}

// Module is RestreamController (+ its service).
type Module struct {
	Svc    *Service
	quotas Quotas
}

// NewModule wires the controller.
func NewModule(svc *Service, quotas Quotas) *Module { return &Module{Svc: svc, quotas: quotas} }

var dtoURL = regexp.MustCompile(`(?i)^rtmps?://.+`)

// addRules is AddRestreamDto (decorators bottom-up).
func addRules(b *validate.Body) {
	b.Optional("platform").IsIn(Platforms...)
	b.Optional("url").Matches(dtoURL, "url must start with rtmp:// or rtmps://").MaxLength(2000).IsString()
	b.Optional("key").MaxLength(500).IsString()
	b.Optional("name").MaxLength(120).IsString()
	b.Optional("layout").MaxLength(100).IsString()
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	op := func(id, method, path, summary, action string, status int) *huma.Operation {
		o := api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"restream"}})
		o.DefaultStatus = status
		return authz.Require(o, "broadcast", action)
	}
	type bodyIn struct {
		App     string `path:"app"`
		ID      string `path:"id"`
		RawBody []byte
	}
	type streamIn struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}
	type egressIn struct {
		App      string `path:"app"`
		ID       string `path:"id"`
		EgressID string `path:"egressId"`
	}

	huma.Register(a, *op("RestreamController_add", http.MethodPost, "/apps/{app}/streams/{id}/restream",
		"Add a forwarding destination (starts an RTMP stream egress).", "start", http.StatusCreated),
		func(ctx context.Context, in *bodyIn) (*api.Out[api.Envelope[RestreamTargetView]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			if addRules(b); b.Err() != nil {
				return nil, b.Err()
			}
			if err := m.quotas.EnforceEgress(ctx, auth.From(ctx)); err != nil {
				return nil, err
			}
			v, err := m.Svc.Add(ctx, in.App, in.ID, AddInput{
				Platform: b.StringPtr("platform"), URL: b.String("url"), Key: b.String("key"),
				Name: b.StringPtr("name"), Layout: b.String("layout"),
			})
			if err != nil {
				return nil, err
			}
			return api.OK(*v), nil
		})

	huma.Register(a, *op("RestreamController_list", http.MethodGet, "/apps/{app}/streams/{id}/restream",
		"List the stream’s forwarding destinations + per-endpoint state.", "read", 0),
		func(ctx context.Context, in *streamIn) (*api.Out[api.Envelope[[]RestreamTargetView]], error) {
			list, err := m.Svc.List(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, *op("RestreamController_remove", http.MethodDelete, "/apps/{app}/streams/{id}/restream/{egressId}",
		"Stop ONE forwarding destination by its egress id.", "stop", http.StatusOK),
		func(ctx context.Context, in *egressIn) (*api.Out[api.Envelope[RestreamTargetView]], error) {
			v, err := m.Svc.Remove(ctx, in.App, in.ID, in.EgressID)
			if err != nil {
				return nil, err
			}
			return api.OK(*v), nil
		})
}
