package metricshistory

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
)

// Register implements api.Module: GET /system/metrics/history (global
// scope only, the same requireGlobal rule as /system/settings).
func (s *Service) Register(a huma.API) {
	type in struct {
		Range  string `query:"range"`
		Metric string `query:"metric"`
	}
	huma.Register(a, *api.Bearer(&huma.Operation{
		OperationID: "MetricsHistoryController_get", Method: http.MethodGet, Path: api.Prefix + "/system/metrics/history",
		Summary: "Time-bucketed host resource-usage history (CPU / RAM / Disk / Network) at 1-hour precision for a dot chart. " +
			"Global-scope (superadmin) surface. Pass ?metric=cpu|mem|disk|net to narrow to one series (default: all); " +
			"?range=24h|7d|30d|90d (default 30d).",
		Tags: []string{"system"},
	}), func(ctx context.Context, i *in) (*api.Out[api.Envelope[Response]], error) {
		if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
			return nil, err
		}
		metric := ""
		switch i.Metric {
		case "cpu", "mem", "disk", "net":
			metric = i.Metric
		}
		rng := i.Range
		if rng == "" {
			rng = DefaultRange
		}
		return api.OK(s.History(ctx, rng, metric, time.Now().UnixMilli())), nil
	})
}
