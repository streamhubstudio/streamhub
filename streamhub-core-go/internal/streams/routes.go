package streams

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// Module bundles StreamsController + HlsController.
type Module struct {
	Streams *Service
	Plugins *PluginOverrides
	Hls     *Hls
}

func operation(id, method, path, summary string, status int) *huma.Operation {
	op := api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"streams"}})
	if status != 0 {
		op.DefaultStatus = status
	}
	return op
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	type appIn struct {
		App string `path:"app"`
	}
	type idIn struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}
	type idBodyIn struct {
		App     string `path:"app"`
		ID      string `path:"id"`
		RawBody []byte
	}
	type appBodyIn struct {
		App     string `path:"app"`
		RawBody []byte
	}

	huma.Register(a, *authz.Require(operation("StreamsController_list", http.MethodGet, "/apps/{app}/streams", "List active streams", 0), "stream", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Data[[]StreamRecord]], error) {
			list, err := m.Streams.List(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[[]StreamRecord]{Data: list}), nil
		})

	huma.Register(a, *authz.Require(operation("StreamsController_get", http.MethodGet, "/apps/{app}/streams/{id}", "Get stream detail", 0), "stream", "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Data[*StreamRecord]], error) {
			rec, err := m.Streams.Get(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			if rec == nil {
				return nil, httpx.NotFound("stream '" + in.ID + "' not found")
			}
			return api.JSON(api.Data[*StreamRecord]{Data: rec}), nil
		})

	huma.Register(a, *authz.Require(operation("StreamsController_getPlugins", http.MethodGet, "/apps/{app}/streams/{id}/plugins", "Get a stream's plugin opt-out list", 0), "stream", "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Data[*StreamPluginsState]], error) {
			st, err := m.Plugins.GetForStream(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*StreamPluginsState]{Data: st}), nil
		})

	huma.Register(a, *authz.Require(operation("StreamsController_setPlugins", http.MethodPatch, "/apps/{app}/streams/{id}/plugins", "Set a stream's plugin opt-out list", 0), "stream", "write"),
		func(ctx context.Context, in *idBodyIn) (*api.Out[api.Data[*StreamPluginsState]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			StreamPluginsDto(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			ids, _ := b.Raw("disabled").([]any)
			st, err := m.Plugins.SetForStream(ctx, in.App, in.ID, ids)
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*StreamPluginsState]{Data: st}), nil
		})

	huma.Register(a, *authz.Require(operation("StreamsController_stop", http.MethodDelete, "/apps/{app}/streams/{id}", "Stop a stream", http.StatusNoContent), "stream", "stop"),
		func(ctx context.Context, in *idIn) (*struct{}, error) {
			return nil, m.Streams.Stop(ctx, in.App, in.ID)
		})

	huma.Register(a, *authz.Require(operation("StreamsController_snapshot", http.MethodPost, "/apps/{app}/snapshots", "On-demand snapshot", http.StatusCreated), "stream", "write"),
		func(ctx context.Context, in *appBodyIn) (*api.Out[api.Data[*SnapshotResult]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			SnapshotDto(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			res, err := m.Streams.Snapshot(ctx, SnapshotInput{AppName: in.App, RoomName: b.String("room"), ParticipantIdentity: b.StringPtr("participantIdentity")})
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*SnapshotResult]{Data: res}), nil
		})

	huma.Register(a, *authz.Require(operation("StreamsController_snapshotStream", http.MethodPost, "/apps/{app}/streams/{id}/snapshot", "On-demand snapshot of a stream (by id)", http.StatusCreated), "stream", "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Data[*SnapshotResult]], error) {
			res, err := m.Streams.SnapshotByStream(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[*SnapshotResult]{Data: res}), nil
		})

	// HlsController: no @RequirePermission (global auth guard only).
	base := func(ctx context.Context) string {
		cfg := m.Streams.cfg
		return BaseURL(cfg.PublicBaseURL, api.Request(ctx), cfg.Host, cfg.Port)
	}
	huma.Register(a, *operation("HlsController_start", http.MethodPost, "/apps/{app}/streams/{id}/hls/start", "Start the live HLS egress for a stream room.", http.StatusCreated),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*HlsStartResult]], error) {
			res, err := m.Hls.Start(ctx, in.App, in.ID, base(ctx))
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})
	huma.Register(a, *operation("HlsController_stop", http.MethodPost, "/apps/{app}/streams/{id}/hls/stop", "Stop the live HLS egress for a stream room.", http.StatusOK),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*HlsStopResult]], error) {
			res, err := m.Hls.Stop(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})
	huma.Register(a, *operation("HlsController_status", http.MethodGet, "/apps/{app}/streams/{id}/hls", "Live HLS status for a stream.", 0),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*HlsStatusResult]], error) {
			res, err := m.Hls.Status(ctx, in.App, in.ID, base(ctx))
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})
}

// SnapshotDto: room @IsString @MinLength(1) @MaxLength(256);
// participantIdentity? @IsString @MaxLength(256). Rules run bottom-up.
func SnapshotDto(b *validate.Body) {
	b.Field("room").MaxLength(256).MinLength(1).IsString()
	b.Optional("participantIdentity").MaxLength(256).IsString()
}

// StreamPluginsDto: disabled @IsArray @IsString({each}) @ArrayUnique.
func StreamPluginsDto(b *validate.Body) {
	r := b.Field("disabled")
	r.Check(arrayUnique(b.Raw("disabled")), "All disabled's elements must be unique")
	r.EachIsString().IsArray()
}

// arrayUnique is class-validator arrayUnique (=== / indexOf semantics; a
// non-array fails).
func arrayUnique(v any) bool {
	arr, ok := v.([]any)
	if !ok {
		return false
	}
	for i := range arr {
		for j := 0; j < i; j++ {
			if scalarEqual(arr[i], arr[j]) {
				return false
			}
		}
	}
	return true
}

func scalarEqual(a, b any) bool {
	switch a.(type) {
	case nil, string, float64, bool:
		return a == b
	}
	return false
}
