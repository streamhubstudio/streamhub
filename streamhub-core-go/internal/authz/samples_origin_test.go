package authz

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// With samples on their own origin (STREAMHUB_SAMPLES_URL) the 3.2.1 stopgap
// is lifted: sample:write is plain RBAC + tenant/app scope again. Without it
// the stopgap holds (TestGuardSampleWriteSuperadminOnly).
func TestGuardSampleWriteLiftedWhenSamplesIsolated(t *testing.T) {
	_, g, _ := testutil.Store(t)
	testutil.Exec(t, g, `INSERT INTO apps (id, name, tenant_id) VALUES (1, 'appa', 'tnt_a'), (2, 'other', 'tnt_b')`)
	appA := int64(1)
	principals := fakeAuthn{
		"viewer":   {UserID: "u1", TenantID: "tnt_a", Role: auth.RoleViewer, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"editor":   {UserID: "u3", TenantID: "tnt_a", Role: auth.RoleEditor, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"owner":    {UserID: "u2", TenantID: "tnt_a", Role: auth.RoleOwner, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"admin":    {UserID: "admin", TenantID: "platform", Role: auth.RoleSuperadmin, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAdminJWT},
		"appToken": {UserID: "token:2", TenantID: "tnt_a", Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaAPIToken, TokenID: 2, AppID: &appA},
	}
	type appIn struct {
		App string `path:"app"`
	}
	ok := func(context.Context, *appIn) (*api.Out[map[string]bool], error) {
		return api.JSON(map[string]bool{"ok": true}), nil
	}
	build := func(isolated bool) *http.ServeMux {
		mux := http.NewServeMux()
		a := api.New(mux, "test")
		api.UseAuth(a, principals, false)
		NewGuard(New(g), nil, testutil.Log()).SamplesIsolated(isolated).Install(a)
		huma.Register(a, *Require(&huma.Operation{OperationID: "w", Method: http.MethodPut, Path: "/apps/{app}/samples/x"}, "sample", "write"), ok)
		return mux
	}
	t.Setenv(EnforceEnv, "on")
	for _, c := range []struct {
		isolated bool
		who, app string
		want     int
	}{
		{false, "owner", "appa", 403},
		{false, "editor", "appa", 403},
		{false, "appToken", "appa", 403},
		{false, "admin", "appa", 200},
		{true, "owner", "appa", 200},
		{true, "editor", "appa", 200},
		{true, "appToken", "appa", 200},
		{true, "admin", "appa", 200},
		{true, "viewer", "appa", 403},    // RBAC still applies
		{true, "owner", "other", 403},    // tenant scope still applies
		{true, "appToken", "other", 403}, // app-scoped token isolation still applies
	} {
		w := do(build(c.isolated), "PUT", "/apps/"+c.app+"/samples/x", c.who)
		if w.Code != c.want {
			t.Errorf("isolated=%v PUT %s as %s: %d %s", c.isolated, c.app, c.who, w.Code, w.Body)
		}
		stopgap := strings.Contains(w.Body.String(), "sample:write is restricted to superadmin")
		if c.want == 403 && stopgap == c.isolated {
			t.Errorf("isolated=%v %s on %s: stopgap reason present=%v: %s", c.isolated, c.who, c.app, stopgap, w.Body)
		}
	}
	gd := NewGuard(New(g), nil, testutil.Log()).SamplesIsolated(true).SamplesIsolated(false)
	if !gd.superadminOnly[sampleWrite] {
		t.Fatal("SamplesIsolated(false) must restore the restriction")
	}
}
