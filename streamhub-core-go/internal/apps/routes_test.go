package apps

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
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

// principals maps "Bearer <key>" to a fixed principal.
type principals map[string]*auth.Principal

func (f principals) Authenticate(r *http.Request) (*auth.Principal, error) {
	return f[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")], nil
}

// TestCreateDeniedToAppScopedToken: an app-scoped token is confined to ONE
// app (guard M2), but POST /apps has no app in the path, the guard lets every
// api_token through RBAC and quotas exempt api_tokens too — so it created any
// number of new apps in its tenant. App creation needs a user role or a
// global credential now.
func TestCreateDeniedToAppScopedToken(t *testing.T) {
	t.Setenv(authz.EnforceEnv, "on")
	s, _ := newTestService(t)
	app := int64(1)
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	api.UseAuth(a, principals{
		"appToken": {UserID: "token:2", TenantID: "tnt_a", Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaAPIToken, TokenID: 2, AppID: &app},
		"global":   {UserID: "token:1", TenantID: auth.PlatformTenantID, Role: auth.RoleService, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAPIToken, TokenID: 1},
	}, false)
	s.Register(a)

	for _, c := range []struct {
		who, name string
		want      int
		body      string
	}{
		{"appToken", "escaped", 403, "an app-scoped credential cannot create apps"},
		{"global", "created", 201, `"name":"created"`},
	} {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/apps", strings.NewReader(`{"name":"`+c.name+`"}`))
		r.Header.Set("Authorization", "Bearer "+c.who)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != c.want || !strings.Contains(w.Body.String(), c.body) {
			t.Errorf("POST /apps as %s: %d %s", c.who, w.Code, w.Body)
		}
	}
	if rec, _ := s.Get(context.Background(), "escaped"); rec != nil {
		t.Fatal("the app-scoped token created an app")
	}
}
