package apps

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
)

// The 22 apps.controller.ts routes: method, path, operationId, permission
// and default status exactly as Nest declares them.
func TestRoutes(t *testing.T) {
	s, _ := newTestService(t)
	a := api.New(http.NewServeMux(), "test")
	s.Register(a)

	want := []string{
		"DELETE /api/v1/apps/{name} AppsController_remove app:delete 200",
		"GET /api/v1/apps AppsController_list app:read 200",
		"GET /api/v1/apps/{name} AppsController_get app:read 200",
		"GET /api/v1/apps/{name}/config/backups AppsController_listConfigBackups config:read 200",
		"GET /api/v1/apps/{name}/config/backups/{ts} AppsController_getConfigBackup config:read 200",
		"GET /api/v1/apps/{name}/config/raw AppsController_getRawConfig config:read 200",
		"GET /api/v1/apps/{name}/mqtt AppsController_getMqtt config:read 200",
		"GET /api/v1/apps/{name}/presets AppsController_listPresets config:read 200",
		"GET /api/v1/apps/{name}/s3 AppsController_getS3 s3:read 200",
		"GET /api/v1/apps/{name}/sizes AppsController_getSizes app:read 200",
		"GET /api/v1/apps/{name}/smtp AppsController_getSmtp config:read 200",
		"PATCH /api/v1/apps/{name} AppsController_patch config:write 200",
		"POST /api/v1/apps AppsController_create app:create 201",
		"POST /api/v1/apps/{name}/config/backups/{ts}/revert AppsController_revertConfigBackup config:write 201",
		"POST /api/v1/apps/{name}/config/raw/validate AppsController_validateRawConfig config:read 201",
		"POST /api/v1/apps/{name}/presets/{preset}/apply AppsController_applyPreset config:write 201",
		"POST /api/v1/apps/{name}/presets/{preset}/deactivate AppsController_deactivatePreset config:write 201",
		"POST /api/v1/apps/{name}/reload AppsController_reload config:write 201",
		"PUT /api/v1/apps/{name}/config/raw AppsController_putRawConfig config:write 200",
		"PUT /api/v1/apps/{name}/mqtt AppsController_setMqtt config:write 200",
		"PUT /api/v1/apps/{name}/s3 AppsController_setS3 s3:write 200",
		"PUT /api/v1/apps/{name}/smtp AppsController_setSmtp config:write 200",
	}
	var got []string
	for path, item := range a.OpenAPI().Paths {
		for method, op := range map[string]*huma.Operation{"GET": item.Get, "POST": item.Post, "PUT": item.Put, "PATCH": item.Patch, "DELETE": item.Delete} {
			if op == nil {
				continue
			}
			p, _ := authz.RequiredBy(op)
			got = append(got, strings.Join([]string{method, path, op.OperationID, p.Resource + ":" + p.Action, itoa(op.DefaultStatus)}, " "))
		}
	}
	sort.Strings(got)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("routes:\n%s", strings.Join(got, "\n"))
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestBoolQuery(t *testing.T) {
	for q, want := range map[string]bool{"": false, "?deleteVods=true": true, "?deleteVods=false": false, "?deleteVods=yes": false,
		"?deleteVods=": false, "?deleteVods=true&deleteVods=true": false, "?deleteVods=TRUE": false} {
		r := httptest.NewRequest(http.MethodDelete, "/api/v1/apps/x"+q, nil)
		if got := boolQuery(r, "deleteVods"); got != want {
			t.Errorf("%q → %v", q, got)
		}
	}
}
