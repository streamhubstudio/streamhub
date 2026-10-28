package scheduledlive

import (
	"context"
	"encoding/json"
	"math"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Module is ScheduledLiveController.
type Module struct {
	Svc  *Service
	apps contracts.AppsService
}

// NewModule wires the controller.
func NewModule(svc *Service, apps contracts.AppsService) *Module {
	return &Module{Svc: svc, apps: apps}
}

// defaultTimezone is the app's configured timezone (UTC on any failure).
func (m *Module) defaultTimezone(ctx context.Context, app string) string {
	if m.apps == nil {
		return "UTC"
	}
	cfg, err := m.apps.GetConfig(ctx, app)
	if err != nil || cfg.Timezone == "" {
		return "UTC"
	}
	return cfg.Timezone
}

// eventRules are the shared DTO decorators (bottom-up order).
func eventRules(b *validate.Body, startRequired bool) {
	start := b.Optional("startAt")
	if startRequired {
		start = b.Field("startAt")
	}
	f, isNum := b.Raw("startAt").(float64)
	start.Check(isNum && f > 0, "startAt must be a positive number").IsInt()
	b.Optional("timezone").MaxLength(64).IsString()
	b.Optional("room").MaxLength(200).IsString()
	b.Optional("title").MaxLength(200).IsString()
	b.Optional("message").MaxLength(500).IsString()
	b.Optional("enabled").IsBoolean()
}

// present reports which top-level keys the JSON object carries (incl. null).
func present(raw []byte) map[string]bool {
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	out := map[string]bool{}
	for k := range m {
		out[k] = true
	}
	return out
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	op := func(id, method, path, summary string, status int) *huma.Operation {
		o := api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"scheduled-live"}})
		if status != 0 {
			o.DefaultStatus = status
		}
		return o
	}
	type publicIn struct {
		App  string `path:"app"`
		Room string `query:"room"`
	}
	type appIn struct {
		App string `path:"app"`
	}
	type bodyIn struct {
		App     string `path:"app"`
		RawBody []byte
	}
	type idBodyIn struct {
		App     string `path:"app"`
		ID      string `path:"id"`
		RawBody []byte
	}
	type idIn struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}

	// /public is declared before the /{id} routes.
	huma.Register(a, *api.Public(op("ScheduledLiveController_listPublic", http.MethodGet, "/apps/{app}/scheduled-live/public",
		"Public agenda for the anonymous player (enabled + upcoming).", 0)),
		func(ctx context.Context, in *publicIn) (*api.Out[api.Envelope[[]ScheduledEventView]], error) {
			var since *float64
			if vals, ok := api.Request(ctx).URL.Query()["sinceMs"]; ok {
				var n float64
				if len(vals) == 1 {
					n = y.StringToNumber(vals[0])
				} else {
					arr := make([]any, len(vals))
					for i, v := range vals {
						arr[i] = v
					}
					n = y.ToNumber(arr)
				}
				since = &n
			}
			list, err := m.Svc.ListPublic(ctx, in.App, in.Room, since)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, *authz.Require(op("ScheduledLiveController_list", http.MethodGet, "/apps/{app}/scheduled-live",
		"List every scheduled event (the operator agenda).", 0), "config", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]ScheduledEventView]], error) {
			list, err := m.Svc.List(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, *authz.Require(op("ScheduledLiveController_create", http.MethodPost, "/apps/{app}/scheduled-live",
		"Schedule a new live premiere.", http.StatusCreated), "config", "write"),
		func(ctx context.Context, in *bodyIn) (*api.Out[api.Envelope[*ScheduledEventView]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			eventRules(b, true)
			if err := b.Err(); err != nil {
				return nil, err
			}
			ci := CreateInput{
				Timezone: b.StringPtr("timezone"), Room: b.StringPtr("room"), Title: b.StringPtr("title"),
				Message: b.StringPtr("message"), Enabled: b.Bool("enabled"),
			}
			if f := b.Float("startAt"); f != nil {
				ci.StartAt = *f
			}
			v, err := m.Svc.Create(ctx, in.App, ci, m.defaultTimezone(ctx, in.App))
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, *authz.Require(op("ScheduledLiveController_update", http.MethodPatch, "/apps/{app}/scheduled-live/{id}",
		"Update a scheduled event (time, enable/disable, …).", 0), "config", "write"),
		func(ctx context.Context, in *idBodyIn) (*api.Out[api.Envelope[*ScheduledEventView]], error) {
			// The body's ValidationPipe answers before ParseIntPipe on :id.
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			eventRules(b, false)
			if err := b.Err(); err != nil {
				return nil, err
			}
			id, err := api.ParseIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			has := present(in.RawBody)
			pi := PatchInput{
				StartAt:     b.Float("startAt"),
				HasTimezone: has["timezone"], Timezone: b.StringPtr("timezone"),
				HasRoom: has["room"], Room: b.StringPtr("room"),
				HasTitle: has["title"], Title: b.StringPtr("title"),
				HasMessage: has["message"], Message: b.StringPtr("message"),
				Enabled: b.Bool("enabled"),
			}
			// A present null still reaches the service (Node's `!== undefined`):
			// startAt null fails validateStartAt, enabled null writes 0.
			if has["startAt"] && pi.StartAt == nil {
				nan := math.NaN()
				pi.StartAt = &nan
			}
			if has["enabled"] && pi.Enabled == nil {
				f := false
				pi.Enabled = &f
			}
			v, err := m.Svc.Update(ctx, in.App, id, pi, m.defaultTimezone(ctx, in.App))
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	huma.Register(a, *authz.Require(op("ScheduledLiveController_remove", http.MethodDelete, "/apps/{app}/scheduled-live/{id}",
		"Delete a scheduled event.", 0), "config", "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*ScheduledRemoved]], error) {
			id, err := api.ParseIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			v, err := m.Svc.Remove(ctx, in.App, id)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
}
