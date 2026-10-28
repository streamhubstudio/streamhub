package visionapps

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Register implements api.Module (vision.controller.ts: 5 routes under
// /apps/:app/plugins/:visionApp).
func (s *Service) Register(a huma.API) {
	op := func(id, method, path, summary, action string) huma.Operation {
		return *authz.Require(api.Bearer(&huma.Operation{
			OperationID: "VisionAppController_" + id, Method: method,
			Path: api.Prefix + "/apps/{app}/plugins/{visionApp}" + path, Summary: summary, Tags: []string{"vision-apps"},
		}), "config", action)
	}
	type in struct {
		App   string `path:"app"`
		Model string `path:"visionApp"`
	}
	huma.Register(a, op("overview", http.MethodGet, "/overview", "Model overview: events today, edge assignments, active streams.", "read"),
		func(ctx context.Context, i *in) (*api.Out[api.Envelope[*VisionOverview]], error) {
			v, err := s.Overview(ctx, i.App, i.Model)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
	huma.Register(a, op("streams", http.MethodGet, "/streams", "Active rooms with their tags + whether this model has a settings override.", "read"),
		func(ctx context.Context, i *in) (*api.Out[api.Envelope[[]VisionStreamView]], error) {
			v, err := s.Streams(ctx, i.App, i.Model)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
	type roomIn struct {
		App   string `path:"app"`
		Model string `path:"visionApp"`
		Room  string `path:"room"`
	}
	huma.Register(a, op("getSettings", http.MethodGet, "/streams/{room}/settings", "Get a room settings override + its resolved config for this model.", "read"),
		func(ctx context.Context, i *roomIn) (*api.Out[api.Envelope[*VisionSettingsView]], error) {
			v, err := s.GetSettings(ctx, i.App, i.Model, i.Room)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
	type putIn struct {
		App   string `path:"app"`
		Model string `path:"visionApp"`
		Room  string `path:"room"`
		api.RawBodyInput
	}
	huma.Register(a, op("putSettings", http.MethodPut, "/streams/{room}/settings", "Set a room settings override (polygons / lines / roi) for this model.", "write"),
		func(ctx context.Context, i *putIn) (*api.Out[api.Envelope[*VisionSettingsView]], error) {
			b, err := validate.Parse(i.RawBody)
			if err != nil {
				return nil, err
			}
			b.Optional("config").IsObject()
			if err := b.Err(); err != nil {
				return nil, err
			}
			var cfg any = y.NewMap()
			if b.Has("config") {
				parsed, _ := y.ParseJSON(i.RawBody)
				cfg = prop(parsed, "config")
			}
			v, err := s.PutSettings(ctx, i.App, i.Model, i.Room, cfg)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
	type evIn struct {
		App   string `path:"app"`
		Model string `path:"visionApp"`
		Limit string `query:"limit"`
	}
	huma.Register(a, op("events", http.MethodGet, "/events", "Recent detection events for this model (from its per-app db).", "read"),
		func(ctx context.Context, i *evIn) (*api.Out[api.Envelope[[]VisionEventRow]], error) {
			raw := i.Limit
			if raw == "" {
				raw = "50"
			}
			n, ok := config.ParseIntPrefix(raw)
			if !ok || n == 0 {
				n = 50
			}
			v, err := s.Events(ctx, i.App, i.Model, max(1, min(1000, n)))
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
}
