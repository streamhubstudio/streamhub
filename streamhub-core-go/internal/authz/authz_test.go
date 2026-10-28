package authz

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// testdata/casbin_truth_table.json is every (role, domain, resource, action)
// verdict of the REAL casbin enforcer over the Node model + rbacPolicies().
// Historical generator — needs the retired NestJS core (branch legacy/node-2.x,
// tag 2.24.0); run from its streamhub-core/, dist built (`node - < gen.js`):
//
//	const { newEnforcer, newModelFromString } = require('casbin');
//	const { RBAC_MODEL, rbacPolicies } = require('./dist/modules/authz/rbac-model');
//	const e = await newEnforcer(newModelFromString(RBAC_MODEL)); await e.addPolicies(rbacPolicies());
//	const out = [];
//	for (const dom of ['platform', 'tnt_x'])
//	  for (const r of ['superadmin','owner','editor','viewer','service','nobody'])
//	    for (const o of [...resources]) for (const a of [...actions])
//	      out.push([r, dom, o, a, await e.enforce(r, dom, o, a)]);
func TestCanMatchesCasbinTruthTable(t *testing.T) {
	raw, err := os.ReadFile("testdata/casbin_truth_table.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows [][5]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2*6*len(Resources)*len(Actions) {
		t.Fatalf("truth table has %d rows", len(rows))
	}
	for _, r := range rows {
		role, dom, obj, act, want := r[0].(string), r[1].(string), r[2].(string), r[3].(string), r[4].(bool)
		if got := Can(role, dom, obj, act); got != want {
			t.Errorf("Can(%s,%s,%s,%s) = %v, casbin says %v", role, dom, obj, act, got, want)
		}
	}
}

func TestRoleCapabilities(t *testing.T) {
	cases := []struct {
		role, obj, act string
		want           bool
	}{
		{"owner", "tenant", "delete", true},
		{"viewer", "stream", "read", true},
		{"viewer", "app", "create", false},
		{"editor", "stream", "start", true},
		{"editor", "app", "delete", false},
		{"editor", "tenant", "write", false},
		{"editor", "token", "create", false},
		{"service", "token", "delete", true},
		{"superadmin", "app", "read", false}, // bypasses in the guard, not here
	}
	for _, c := range cases {
		if got := Can(c.role, "platform", c.obj, c.act); got != c.want {
			t.Errorf("%s %s:%s = %v", c.role, c.obj, c.act, got)
		}
	}
}

func TestModeDefaultsOn(t *testing.T) {
	cases := map[string]EnforcementMode{
		"": ModeOn, "onn": ModeOn, "true": ModeOn, "1": ModeOn, "enforce": ModeOn, "garbage": ModeOn,
		"log": ModeLog, "off": ModeOff, "ON": ModeOn, " Log ": ModeLog,
	}
	for raw, want := range cases {
		t.Setenv(EnforceEnv, raw)
		if got := Mode(); got != want {
			t.Errorf("%q → %s, want %s", raw, got, want)
		}
	}
}

func TestAppBelongsToTenant(t *testing.T) {
	_, g, _ := testutil.Store(t)
	testutil.Exec(t, g, `INSERT INTO apps (name, tenant_id) VALUES ('mine', 'tnt_a'), ('theirs', 'tnt_b'), ('orphan', NULL)`)
	s := New(g)
	ctx := context.Background()
	owner := &auth.Principal{TenantID: "tnt_a", Role: auth.RoleOwner}
	cases := []struct {
		p    *auth.Principal
		app  string
		want bool
	}{
		{owner, "mine", true},
		{owner, "theirs", false},
		{&auth.Principal{TenantID: "tnt_a", IsSuperadmin: true}, "theirs", true},
		{&auth.Principal{}, "theirs", true}, // unscoped
		{owner, "unknown", true},            // handler 404s
		{owner, "orphan", true},             // unassigned
	}
	for _, c := range cases {
		if got := s.AppBelongsToTenant(ctx, c.p, c.app); got != c.want {
			t.Errorf("%+v %s = %v", c.p, c.app, got)
		}
	}
}

// fakeAuthn maps "Bearer <key>" to a fixed principal.
type fakeAuthn map[string]*auth.Principal

func (f fakeAuthn) Authenticate(r *http.Request) (*auth.Principal, error) {
	return f[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")], nil
}

func newGuarded(t *testing.T) (http.Handler, *audit.Service) {
	t.Helper()
	_, g, _ := testutil.Store(t)
	testutil.Exec(t, g, `INSERT INTO apps (id, name, tenant_id) VALUES (1, 'appa', 'tnt_a'), (2, 'appb', 'tnt_a'), (3, 'other', 'tnt_b')`)
	aud := audit.New(g, os.Getenv, testutil.Log())
	aud.Init(context.Background())
	appA := int64(1)
	principals := fakeAuthn{
		"viewer":    {UserID: "u1", TenantID: "tnt_a", Role: auth.RoleViewer, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"owner":     {UserID: "u2", TenantID: "tnt_a", Role: auth.RoleOwner, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"admin":     {UserID: "admin", TenantID: "platform", Role: auth.RoleSuperadmin, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAdminJWT},
		"global":    {UserID: "token:1", TenantID: "platform", Role: auth.RoleService, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAPIToken, TokenID: 1},
		"appToken":  {UserID: "token:2", TenantID: "tnt_a", Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaAPIToken, TokenID: 2, AppID: &appA},
		"lostToken": {UserID: "token:3", TenantID: "tnt_a", Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaAPIToken, TokenID: 3}, // req.auth.appId null
	}
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	api.UseAuth(a, principals, false)
	NewGuard(New(g), aud, testutil.Log()).Install(a)
	ok := func(ctx context.Context, _ *struct{}) (*api.Out[map[string]bool], error) {
		return api.JSON(map[string]bool{"ok": true}), nil
	}
	type appIn struct {
		App string `path:"app"`
	}
	type nameIn struct {
		Name string `path:"name"`
	}
	huma.Register(a, *Require(&huma.Operation{OperationID: "create", Method: http.MethodPost, Path: "/apps/{app}/streams"}, "stream", "create"),
		func(ctx context.Context, _ *appIn) (*api.Out[map[string]bool], error) { return ok(ctx, nil) })
	huma.Register(a, *Require(&huma.Operation{OperationID: "read", Method: http.MethodGet, Path: "/apps/{app}/streams"}, "stream", "read"),
		func(ctx context.Context, _ *appIn) (*api.Out[map[string]bool], error) { return ok(ctx, nil) })
	huma.Register(a, *Require(&huma.Operation{OperationID: "cfg", Method: http.MethodGet, Path: "/config/{name}"}, "config", "read"),
		func(ctx context.Context, _ *nameIn) (*api.Out[map[string]bool], error) { return ok(ctx, nil) })
	huma.Register(a, huma.Operation{OperationID: "plain", Method: http.MethodPost, Path: "/plain"}, ok)
	return mux, aud
}

func do(h http.Handler, method, path, who string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	r.Header.Set("Authorization", "Bearer "+who)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestGuard(t *testing.T) {
	h, aud := newGuarded(t)
	cases := []struct {
		mode, who, method, path string
		want                    int
		body                    string
	}{
		{"on", "viewer", "POST", "/plain", 200, ""}, // no @RequirePermission
		{"on", "nobody", "POST", "/apps/appa/streams", 200, ""},
		{"off", "viewer", "POST", "/apps/appa/streams", 200, ""},
		{"log", "viewer", "POST", "/apps/appa/streams", 200, ""},
		{"on", "viewer", "POST", "/apps/appa/streams", 403, `"role 'viewer' lacks stream:create"`},
		{"on", "viewer", "GET", "/apps/appa/streams", 200, ""},
		{"on", "owner", "GET", "/apps/other/streams", 403, `"app 'other' is outside tenant 'tnt_a'"`},
		{"on", "owner", "GET", "/apps/appb/streams", 200, ""},
		// M2: app-scoped token confined to its own app (before the api_token bypass).
		{"on", "appToken", "GET", "/apps/appb/streams", 403, `"app 'appb' is outside this credential's app scope"`},
		{"on", "appToken", "GET", "/config/appb", 403, `outside this credential's app scope`},
		{"on", "appToken", "GET", "/apps/appa/streams", 200, ""},
		{"log", "appToken", "GET", "/apps/appb/streams", 200, ""},
		{"on", "appToken", "GET", "/apps/ghost/streams", 200, ""}, // unknown route app → handler 404s
		{"on", "lostToken", "GET", "/apps/appb/streams", 200, ""}, // token app unresolvable → fail safe
		{"on", "global", "POST", "/apps/other/streams", 200, ""},  // golden rule
	}
	for _, mode := range []string{"off", "log", "on"} { // INVARIANT: platform owners never blocked
		cases = append(cases,
			struct {
				mode, who, method, path string
				want                    int
				body                    string
			}{mode, "admin", "POST", "/apps/other/streams", 200, ""},
			struct {
				mode, who, method, path string
				want                    int
				body                    string
			}{mode, "global", "POST", "/apps/other/streams", 200, ""})
	}
	for _, c := range cases {
		t.Setenv(EnforceEnv, c.mode)
		w := do(h, c.method, c.path, c.who)
		if w.Code != c.want || !strings.Contains(w.Body.String(), c.body) {
			t.Errorf("%s %s %s as %s: %d %s", c.mode, c.method, c.path, c.who, w.Code, w.Body)
		}
	}

	// Denials are audited (authz.deny), with enforced=false in log mode.
	page, err := aud.Query(context.Background(), audit.Query{Action: "authz.deny"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 6 {
		t.Fatalf("authz.deny entries = %d", page.Total)
	}
	var enforced, logged int
	for _, e := range page.Entries {
		var m struct {
			Method, Path, Reason string
			Enforced             bool
		}
		_ = json.Unmarshal(e.Meta, &m)
		if e.Result != "deny" || m.Method == "" || m.Path == "" || m.Reason == "" {
			t.Fatalf("entry %+v meta %s", e, e.Meta)
		}
		if m.Enforced {
			enforced++
		} else {
			logged++
		}
	}
	if enforced != 4 || logged != 2 {
		t.Fatalf("enforced=%d logged=%d", enforced, logged)
	}
}

func TestGuardSampleWriteSuperadminOnly(t *testing.T) {
	_, g, _ := testutil.Store(t)
	testutil.Exec(t, g, `INSERT INTO apps (id, name, tenant_id) VALUES (1, 'appa', 'tnt_a')`)
	appA := int64(1)
	principals := fakeAuthn{
		"owner":    {UserID: "u2", TenantID: "tnt_a", Role: auth.RoleOwner, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"admin":    {UserID: "admin", TenantID: "platform", Role: auth.RoleSuperadmin, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAdminJWT},
		"global":   {UserID: "token:1", TenantID: "platform", Role: auth.RoleService, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAPIToken, TokenID: 1},
		"appToken": {UserID: "token:2", TenantID: "tnt_a", Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaAPIToken, TokenID: 2, AppID: &appA},
	}
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	api.UseAuth(a, principals, false)
	NewGuard(New(g), nil, testutil.Log()).Install(a)
	type appIn struct {
		App string `path:"app"`
	}
	ok := func(context.Context, *appIn) (*api.Out[map[string]bool], error) {
		return api.JSON(map[string]bool{"ok": true}), nil
	}
	huma.Register(a, *Require(&huma.Operation{OperationID: "w", Method: http.MethodPut, Path: "/apps/{app}/samples/x"}, "sample", "write"), ok)
	huma.Register(a, *Require(&huma.Operation{OperationID: "r", Method: http.MethodGet, Path: "/apps/{app}/samples"}, "sample", "read"), ok)
	t.Setenv(EnforceEnv, "on")
	for _, c := range []struct {
		who, method, path string
		want              int
	}{
		{"owner", "PUT", "/apps/appa/samples/x", 403},
		{"appToken", "PUT", "/apps/appa/samples/x", 403},
		{"admin", "PUT", "/apps/appa/samples/x", 200},
		{"global", "PUT", "/apps/appa/samples/x", 200},
		{"owner", "GET", "/apps/appa/samples", 200},
		{"appToken", "GET", "/apps/appa/samples", 200},
	} {
		w := do(mux, c.method, c.path, c.who)
		if w.Code != c.want {
			t.Errorf("%s %s as %s: %d %s", c.method, c.path, c.who, w.Code, w.Body)
		}
		if c.want == 403 && !strings.Contains(w.Body.String(), "sample:write is restricted to superadmin") {
			t.Errorf("reason: %s", w.Body)
		}
	}
}
