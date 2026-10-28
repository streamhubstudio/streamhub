package streamflow

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// GO-DIVERGENCE: the Node core never serves the event catalogue (a vision
// `{model}/events` route shadows it). Go must serve it even with such a
// route mounted, while other models still reach the vision route.
func TestEventsRouteNotShadowed(t *testing.T) {
	w := newWorld(t)
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	huma.Register(a, huma.Operation{OperationID: "Vision_events", Method: http.MethodGet, Path: api.Prefix + "/apps/{app}/plugins/{model}/events"},
		func(context.Context, *struct {
			App   string `path:"app"`
			Model string `path:"model"`
		}) (*struct{}, error) {
			return nil, httpx.NotFound("vision")
		})
	(&Routes{Svc: w.svc, Secrets: w.secrets}).Register(a)
	h := httpx.WithRequest(mux)
	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		return rec
	}
	rec := get("/api/v1/apps/live/plugins/streamflow/events")
	if rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"data":[{"family":`) || !strings.Contains(rec.Body.String(), `"error":null`) {
		t.Fatalf("events %d %s", rec.Code, rec.Body.String()[:min(200, rec.Body.Len())])
	}
	if rec := get("/api/v1/apps/live/plugins/occupancy/events"); rec.Code != 404 {
		t.Fatalf("vision route lost: %d", rec.Code)
	}
}
