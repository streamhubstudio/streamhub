package system

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
)

// Module is SystemController over its services.
type Module struct {
	Gpu      *Gpu
	HwAccel  *HwAccel
	Settings *Settings
	OsTuning OsTuning
}

func op(id, method, path, summary string, status int) *huma.Operation {
	return api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"system"}, DefaultStatus: status})
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	huma.Register(a, *op("SystemController_getGpu", http.MethodGet, "/system/gpu",
		"GPU hardware-transcoding status of this node.", http.StatusOK),
		func(ctx context.Context, _ *struct{}) (*api.Out[GpuStatus], error) {
			q := api.Request(ctx).URL.Query()
			force := false
			if vs := q["refresh"]; len(vs) == 1 {
				force = vs[0] == "true" || vs[0] == "1"
			}
			// a forced re-probe spawns nvidia-smi/vainfo on the host: global
			// credentials only (3.3.4); anyone else reads the cached status
			if force && !api.HasGlobal(ctx) {
				force = false
			}
			if force {
				return api.JSON(m.Gpu.Refresh(ctx)), nil
			}
			return api.JSON(m.Gpu.Status(ctx)), nil
		})

	huma.Register(a, *api.Global(op("SystemController_refreshGpu", http.MethodPost, "/system/gpu/refresh",
		"Force a fresh GPU probe and return the status.", http.StatusCreated)),
		func(ctx context.Context, _ *struct{}) (*api.Out[GpuStatus], error) {
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			return api.JSON(m.Gpu.Refresh(ctx)), nil
		})

	huma.Register(a, *api.Global(op("SystemController_getSettings", http.MethodGet, "/system/settings",
		"READ-ONLY effective server config with EVERY secret redacted, plus per-group guidance on how to change each setting.", http.StatusOK)),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[ServerSettings]], error) {
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			return api.OK(m.Settings.Get(ctx)), nil
		})

	huma.Register(a, *api.Global(op("SystemController_getOsTuning", http.MethodGet, "/system/os-tuning",
		"READ-ONLY OS performance tuning posture.", http.StatusOK)),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[OsTuningReport]], error) {
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			return api.OK(m.OsTuning.Report()), nil
		})
}
