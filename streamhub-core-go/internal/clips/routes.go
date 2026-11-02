package clips

import (
	"context"
	"net/http"
	"strconv"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/validate"
)

// Routes (feature without oracle — GO-DIVERGENCES). Permissions reuse the
// VOD actions: cutting a clip writes a VOD (vod:write, which editors hold);
// reading clips is vod:read.
type Routes struct{ Svc *Service }

func operation(id, method, path, summary string, status int) *huma.Operation {
	op := api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"clips"}})
	if status != 0 {
		op.DefaultStatus = status
	}
	return op
}

// ParseCreateBody validates {from, to} | {eventTs, before?, after?}.
func ParseCreateBody(raw []byte) (Request, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return Request{}, err
	}
	b.Optional("before").Min(0).IsNumber()
	b.Optional("after").Min(0).IsNumber()
	if err := b.Err(); err != nil {
		return Request{}, err
	}
	return Request{From: b.Raw("from"), To: b.Raw("to"), EventTs: b.Raw("eventTs"), Before: b.Float("before"), After: b.Float("after")}, nil
}

func limitOf(ctx context.Context) int {
	n, _ := strconv.Atoi(api.Request(ctx).URL.Query().Get("limit"))
	return n
}

// Register implements api.Module.
func (m *Routes) Register(a huma.API) {
	type streamIn struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}
	type streamBodyIn struct {
		App     string `path:"app"`
		ID      string `path:"id"`
		RawBody []byte
	}
	type appIn struct {
		App string `path:"app"`
	}
	type clipIn struct {
		App    string `path:"app"`
		ClipID string `path:"clipId"`
	}

	huma.Register(a, *authz.Require(operation("ClipsController_create", http.MethodPost, "/apps/{app}/streams/{id}/clips",
		"Cut a clip ({from, to} or {eventTs, before, after}) from the stream's HLS/DVR segments into a VOD (async).", http.StatusAccepted), "vod", "write"),
		func(ctx context.Context, in *streamBodyIn) (*api.Out[api.Envelope[*Clip]], error) {
			req, err := ParseCreateBody(in.RawBody)
			if err != nil {
				return nil, err
			}
			c, err := m.Svc.Create(ctx, CreateInput{App: in.App, StreamID: in.ID, Request: req})
			if err != nil {
				return nil, err
			}
			return api.OK(c), nil
		})

	huma.Register(a, *authz.Require(operation("ClipsController_listForStream", http.MethodGet, "/apps/{app}/streams/{id}/clips",
		"List the stream's clips, newest first (?limit, default 100).", 0), "vod", "read"),
		func(ctx context.Context, in *streamIn) (*api.Out[api.Envelope[[]Clip]], error) {
			id := in.ID
			list, err := m.Svc.List(ctx, in.App, &id, limitOf(ctx))
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, *authz.Require(operation("ClipsController_list", http.MethodGet, "/apps/{app}/clips",
		"List the app's clips, newest first (?limit, default 100).", 0), "vod", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]Clip]], error) {
			list, err := m.Svc.List(ctx, in.App, nil, limitOf(ctx))
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, *authz.Require(operation("ClipsController_get", http.MethodGet, "/apps/{app}/clips/{clipId}",
		"One clip: its state (queued/running/ready/failed), VOD id and, once ready, the MP4 URL.", 0), "vod", "read"),
		func(ctx context.Context, in *clipIn) (*api.Out[api.Envelope[*Clip]], error) {
			c, err := m.Svc.Get(ctx, in.App, in.ClipID)
			if err != nil {
				return nil, err
			}
			return api.OK(c), nil
		})
}
