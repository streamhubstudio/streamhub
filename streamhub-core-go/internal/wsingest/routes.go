package wsingest

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

// Register implements api.Module: WsKeysController (/apps/:app/ws-ingest).
func (s *Service) Register(a huma.API) {
	op := func(id, method, path, summary string) *huma.Operation {
		return api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"ws-ingest"}})
	}
	type appIn struct {
		App string `path:"app"`
	}
	type bodyIn struct {
		App     string `path:"app"`
		RawBody []byte
	}
	type idIn struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}
	type roomIn struct {
		App  string `path:"app"`
		Room string `path:"room"`
	}
	type wsKeyDeleted struct {
		ID      string `json:"id"`
		Deleted bool   `json:"deleted"`
	}

	create := authz.Require(op("WsKeysController_create", http.MethodPost, "/apps/{app}/ws-ingest",
		"Mint a WebSocket ingest key (wsk_) for an ESP32/MJPEG camera. Returns the plaintext key once, plus wsUrl/mjpegUrl/playerUrl."), "ingress", "create")
	create.DefaultStatus = http.StatusCreated
	huma.Register(a, *create, func(ctx context.Context, in *bodyIn) (*api.Out[api.Data[*WsIngestProvisioned]], error) {
		b, err := validate.Parse(in.RawBody)
		if err != nil {
			return nil, err
		}
		CreateWsIngestDto(b)
		if err := b.Err(); err != nil {
			return nil, err
		}
		if q := getter(s.d.Quotas); q != nil {
			if err := q.EnforceConcurrentStreams(ctx, auth.From(ctx)); err != nil {
				return nil, err
			}
		}
		res, err := s.Provision(ctx, in.App, b.String("room"), b.String("identity"))
		if err != nil {
			return nil, err
		}
		return api.JSON(api.Data[*WsIngestProvisioned]{Data: res}), nil
	})

	huma.Register(a, *authz.Require(op("WsKeysController_list", http.MethodGet, "/apps/{app}/ws-ingest",
		"List the app WS ingest keys with live state (active = camera connected). Credentials ride along, like the RTMP ingress listing."), "ingress", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Data[[]WsIngestKeyStatus]], error) {
			list, err := s.ListKeys(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[[]WsIngestKeyStatus]{Data: list}), nil
		})

	huma.Register(a, *authz.Require(op("WsKeysController_remove", http.MethodDelete, "/apps/{app}/ws-ingest/{id}",
		"Revoke a WS ingest key. The live camera connection (if any) is closed immediately."), "ingress", "delete"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Data[wsKeyDeleted]], error) {
			if err := s.Revoke(ctx, in.App, in.ID); err != nil {
				return nil, err
			}
			return api.JSON(api.Data[wsKeyDeleted]{Data: wsKeyDeleted{in.ID, true}}), nil
		})

	huma.Register(a, *api.Public(op("WsKeysController_liveInfo", http.MethodGet, "/apps/{app}/ws-ingest/live/{room}",
		"PUBLIC: whether a ws-mjpeg camera is live in a room (+ playback URLs). Drives the MJPEG mode of /play and /embed.")),
		func(ctx context.Context, in *roomIn) (*api.Out[api.Data[*WsIngestLiveInfo]], error) {
			info, err := s.LiveInfo(ctx, in.App, in.Room)
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*WsIngestLiveInfo]{Data: info}), nil
		})

	a.OpenAPI().Paths[api.Prefix+"/apps/{app}/ws-ingest"].Post.RequestBody.Required = false
}

var dtoSlugRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// CreateWsIngestDto: room @IsString @MaxLength(64) @Matches(slug);
// identity? same. Rules run bottom-up.
func CreateWsIngestDto(b *validate.Body) {
	b.Field("room").Matches(dtoSlugRE, "room must be alphanumeric with dashes/underscores").MaxLength(64).IsString()
	b.Optional("identity").Matches(dtoSlugRE, "identity must be alphanumeric with dashes/underscores").MaxLength(64).IsString()
}
