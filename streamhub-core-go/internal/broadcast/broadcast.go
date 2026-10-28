// Package broadcast is src/modules/broadcast: per-app RTMP stream egress
// (forward a LiveKit room to an external RTMP target such as YouTube/Twitch).
package broadcast

import (
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// LiveKit is the slice of the guarded LiveKit wrapper broadcast uses.
type LiveKit interface {
	StartStreamEgress(ctx context.Context, in livekit.StartStreamEgressInput) (livekit.StreamEgressInfo, error)
	StopEgress(ctx context.Context, egressID string) (livekit.EgressInfo, error)
	ListStreamEgress(ctx context.Context, roomPrefix string) ([]livekit.StreamEgressInfo, error)
}

// Quotas is QuotasService.enforceEgress.
type Quotas interface {
	EnforceEgress(ctx context.Context, p *auth.Principal) error
}

// Logs is LogsServiceContract.write.
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Service is BroadcastService.
type Service struct {
	lk   LiveKit
	apps contracts.AppsService
	logs func() Logs
	log  *slog.Logger
}

// Module is BroadcastController (+ its service).
type Module struct {
	Svc    *Service
	quotas Quotas
}

// New wires the module. logs may return nil (slog fallback).
func New(lk LiveKit, apps contracts.AppsService, quotas Quotas, logs func() Logs, log *slog.Logger) *Module {
	if log == nil {
		log = slog.Default()
	}
	return &Module{Svc: &Service{lk: lk, apps: apps, logs: logs, log: log}, quotas: quotas}
}

func (s *Service) write(level, msg string, meta any) {
	if s.logs != nil {
		if l := s.logs(); l != nil {
			l.Write(level, "broadcast", msg, meta, nil)
			return
		}
	}
	s.log.Info(msg, "source", "broadcast", "level", level, "meta", meta)
}

var rtmpURL = regexp.MustCompile(`(?i)^rtmps?://.+`)

const rtmpURLMessage = "rtmpUrl must start with rtmp:// or rtmps://"

type startFailMeta struct {
	AppName string `json:"appName"`
	Room    string `json:"room"`
	Error   string `json:"error"`
}

type startedMeta struct {
	AppName  string   `json:"appName"`
	Room     string   `json:"room"`
	EgressID string   `json:"egressId"`
	Status   string   `json:"status"`
	URLs     []string `json:"urls"`
}

type stopFailMeta struct {
	AppName  string `json:"appName"`
	EgressID string `json:"egressId"`
	Error    string `json:"error"`
}

type stopMeta struct {
	AppName  string `json:"appName"`
	EgressID string `json:"egressId"`
	Status   string `json:"status"`
}

type listFailMeta struct {
	AppName string `json:"appName"`
	Error   string `json:"error"`
}

// Start broadcasts roomName of appName to rtmpURL.
func (s *Service) Start(ctx context.Context, appName, roomName, rtmp, layout string) (livekit.StreamEgressInfo, error) {
	room := strings.TrimSpace(roomName)
	if room == "" {
		return livekit.StreamEgressInfo{}, httpx.BadRequest("roomName is required")
	}
	url := strings.TrimSpace(rtmp)
	if !rtmpURL.MatchString(url) {
		return livekit.StreamEgressInfo{}, httpx.BadRequest(rtmpURLMessage)
	}
	namespaced := s.resolveRoom(ctx, appName, room)
	info, err := s.lk.StartStreamEgress(ctx, livekit.StartStreamEgressInput{AppName: appName, RoomName: namespaced, RtmpURL: url, Layout: layout})
	if err != nil {
		s.write("error", "startStreamEgress failed", startFailMeta{appName, namespaced, err.Error()})
		return livekit.StreamEgressInfo{}, httpx.Internal("failed to start broadcast: " + err.Error())
	}
	s.write("info", "broadcast started", startedMeta{appName, namespaced, info.EgressID, info.Status, info.URLs})
	return info, nil
}

// Stop ends a broadcast by egress id.
func (s *Service) Stop(ctx context.Context, appName, egressID string) (livekit.EgressInfo, error) {
	id := strings.TrimSpace(egressID)
	if id == "" {
		return livekit.EgressInfo{}, httpx.BadRequest("egress id is required")
	}
	res, err := s.lk.StopEgress(ctx, id)
	if err != nil {
		s.write("error", "stopEgress failed", stopFailMeta{appName, id, err.Error()})
		return livekit.EgressInfo{}, httpx.Internal("failed to stop broadcast: " + err.Error())
	}
	s.write("info", "broadcast stop requested", stopMeta{appName, id, res.Status})
	return res, nil
}

// List returns the app's active stream egresses ([] on any failure).
func (s *Service) List(ctx context.Context, appName string) []livekit.StreamEgressInfo {
	prefix := s.roomPrefix(ctx, appName)
	list, err := s.lk.ListStreamEgress(ctx, prefix)
	if err != nil {
		s.write("warn", "listStreamEgress failed", listFailMeta{appName, err.Error()})
		return []livekit.StreamEgressInfo{}
	}
	if list == nil {
		list = []livekit.StreamEgressInfo{}
	}
	return list
}

func (s *Service) roomPrefix(ctx context.Context, app string) string {
	if s.apps == nil {
		return app
	}
	cfg, err := s.apps.GetConfig(ctx, app)
	if err != nil {
		s.log.Warn("roomPrefix lookup failed for '" + app + "': " + err.Error())
		return app
	}
	if cfg.RoomPrefix != "" {
		return cfg.RoomPrefix
	}
	return app
}

func (s *Service) resolveRoom(ctx context.Context, app, room string) string {
	prefix := s.roomPrefix(ctx, app)
	if room == prefix || strings.HasPrefix(room, prefix+"-") {
		return room
	}
	return prefix + "-" + room
}

// BroadcastStartResult is POST broadcast/start.data.
type BroadcastStartResult struct {
	EgressID string `json:"egressId"`
	Status   string `json:"status"`
	RoomName string `json:"roomName"`
	RtmpURL  string `json:"rtmpUrl"`
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	op := func(id, method, path, summary, action string) *huma.Operation {
		o := api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"broadcast"}})
		if method == http.MethodPost {
			o.DefaultStatus = http.StatusCreated
		}
		return authz.Require(o, "broadcast", action)
	}
	type bodyIn struct {
		App     string `path:"app"`
		RawBody []byte
	}
	type stopIn struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}
	type appIn struct {
		App string `path:"app"`
	}

	huma.Register(a, *op("BroadcastController_start", http.MethodPost, "/apps/{app}/broadcast/start",
		"Start broadcasting a room to an external RTMP URL (stream egress).", "start"),
		func(ctx context.Context, in *bodyIn) (*api.Out[api.Envelope[BroadcastStartResult]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Field("roomName").MaxLength(200).IsString()
			b.Field("rtmpUrl").Matches(rtmpURL, rtmpURLMessage).MaxLength(2000).IsString()
			b.Optional("layout").MaxLength(100).IsString()
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := m.quotas.EnforceEgress(ctx, auth.From(ctx)); err != nil {
				return nil, err
			}
			body := b.String("rtmpUrl")
			info, err := m.Svc.Start(ctx, in.App, b.String("roomName"), body, b.String("layout"))
			if err != nil {
				return nil, err
			}
			url := body
			if len(info.URLs) > 0 {
				url = info.URLs[0]
			}
			return api.OK(BroadcastStartResult{info.EgressID, info.Status, info.RoomName, url}), nil
		})

	huma.Register(a, *op("BroadcastController_stop", http.MethodPost, "/apps/{app}/broadcast/{id}/stop",
		"Stop an in-progress broadcast (stream egress).", "stop"),
		func(ctx context.Context, in *stopIn) (*api.Out[api.Envelope[livekit.EgressInfo]], error) {
			res, err := m.Svc.Stop(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})

	huma.Register(a, *op("BroadcastController_list", http.MethodGet, "/apps/{app}/broadcast",
		"List active broadcasts (RTMP stream egresses) of the app.", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]livekit.StreamEgressInfo]], error) {
			return api.OK(m.Svc.List(ctx, in.App)), nil
		})
}
