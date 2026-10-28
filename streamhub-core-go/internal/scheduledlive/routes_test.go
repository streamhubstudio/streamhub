package scheduledlive

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
)

// The scheduled-live.controller.ts routes: method, path, operationId, permission (public
// = @Public) and default status exactly as Nest declares them.
func TestRoutes(t *testing.T) {
	a := api.New(http.NewServeMux(), "test")
	NewModule(nil, nil).Register(a)
	want := []string{
		"DELETE /api/v1/apps/{app}/scheduled-live/{id} ScheduledLiveController_remove config:write 200",
		"GET /api/v1/apps/{app}/scheduled-live ScheduledLiveController_list config:read 200",
		"GET /api/v1/apps/{app}/scheduled-live/public ScheduledLiveController_listPublic public 200",
		"PATCH /api/v1/apps/{app}/scheduled-live/{id} ScheduledLiveController_update config:write 200",
		"POST /api/v1/apps/{app}/scheduled-live ScheduledLiveController_create config:write 201",
	}
	var got []string
	for path, item := range a.OpenAPI().Paths {
		for method, op := range map[string]*huma.Operation{"GET": item.Get, "POST": item.Post, "PUT": item.Put, "PATCH": item.Patch, "DELETE": item.Delete} {
			if op == nil {
				continue
			}
			perm := "public"
			if p, ok := authz.RequiredBy(op); ok {
				perm = p.Resource + ":" + p.Action
			} else if pub, _ := op.Metadata["public"].(bool); !pub {
				perm = "bearer"
			}
			got = append(got, strings.Join([]string{method, path, op.OperationID, perm, strconv.Itoa(op.DefaultStatus)}, " "))
		}
	}
	sort.Strings(got)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("routes:\n%s", strings.Join(got, "\n"))
	}
}
