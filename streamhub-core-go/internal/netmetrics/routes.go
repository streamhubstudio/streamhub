package netmetrics

import (
	"context"
	"math"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Routes is NetMetricsController: per-app network I/O (usage:read).
type Routes struct {
	Net    *Service
	AppDir func(app string) string
}

// HistoryData is GET /apps/:app/net/history's data.
type HistoryData = NetMetricsHistoryData

// NetMetricsHistoryData is the wire type (module-prefixed schema name).
type NetMetricsHistoryData struct {
	Hours   float64         `json:"hours"`
	Buckets []HistoryBucket `json:"buckets"`
}

// Register implements api.Module.
func (r *Routes) Register(a huma.API) {
	type appIn struct {
		App string `path:"app"`
	}
	huma.Register(a, *authz.Require(api.Bearer(&huma.Operation{
		OperationID: "NetMetricsController_summary", Method: http.MethodGet, Path: api.Prefix + "/apps/{app}/net",
		Summary: "App network I/O summary",
		Description: "Rolling per-app media-plane byte totals (today / last 24h / last 7d, " +
			"per direction and source) plus the configured threshold posture.",
		Tags: []string{"net-metrics"},
	}), "usage", "read"), func(ctx context.Context, in *appIn) (*api.Out[api.Data[Summary]], error) {
		threshold := ReadThresholdGBDay(r.AppDir(in.App))
		return api.JSON(api.Data[Summary]{Data: r.Net.Summary(ctx, in.App, time.Now(), threshold)}), nil
	})

	type historyIn struct {
		App   string `path:"app"`
		Hours string `query:"hours"`
	}
	huma.Register(a, *authz.Require(api.Bearer(&huma.Operation{
		OperationID: "NetMetricsController_history", Method: http.MethodGet, Path: api.Prefix + "/apps/{app}/net/history",
		Summary: "App network I/O history",
		Description: "Hourly-bucketed in/out byte rows for the dashboard sparkline. " +
			"`hours` (default 48) is clamped to [1, 720].",
		Tags: []string{"net-metrics"},
	}), "usage", "read"), func(ctx context.Context, in *historyIn) (*api.Out[api.Data[HistoryData]], error) {
		// Number(hours): a missing param is NaN; "" is 0 — both fall back.
		h := float64(defaultHistoryHour)
		if in.Hours != "" {
			if n := yamljs.StringToNumber(in.Hours); !math.IsNaN(n) && !math.IsInf(n, 0) && n > 0 {
				h = n
			}
		}
		return api.JSON(api.Data[HistoryData]{Data: HistoryData{Hours: h, Buckets: r.Net.History(ctx, in.App, h, time.Now())}}), nil
	})
}
