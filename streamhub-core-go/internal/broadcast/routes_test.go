package broadcast

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

// The broadcast.controller.ts routes: method, path, operationId, permission (public
// = @Public) and default status exactly as Nest declares them.
func TestRoutes(t *testing.T) {
	a := api.New(http.NewServeMux(), "test")
	New(nil, nil, nil, nil, nil).Register(a)
	want := []string{
		"GET /api/v1/apps/{app}/broadcast BroadcastController_list broadcast:read 200",
		"POST /api/v1/apps/{app}/broadcast/start BroadcastController_start broadcast:start 201",
		"POST /api/v1/apps/{app}/broadcast/{id}/stop BroadcastController_stop broadcast:stop 201",
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
