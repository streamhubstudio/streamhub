package logs

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// principals maps "Bearer <key>" to a fixed principal.
type principals map[string]*auth.Principal

func (f principals) Authenticate(r *http.Request) (*auth.Principal, error) {
	return f[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")], nil
}

// TestGlobalLogsRequireGlobalScope (A2): GET /logs is the server-wide feed
// (every app, every tenant). Node guarded it with the auth guard only, so an
// app-scoped token or any tenant user read the other tenants' logs. It is a
// global-scope surface now; /apps/{app}/logs stays the scoped one.
func TestGlobalLogsRequireGlobalScope(t *testing.T) {
	t.Setenv(authz.EnforceEnv, "on")
	s, g, _ := boot(t, 0)
	liveID := seedApp(t, g, "live")
	seedApp(t, g, "other")
	s.Write("info", "stream", "other tenant event", map[string]any{"app": "other"}, nil)

	mux := http.NewServeMux()
	a := api.New(mux, "test")
	api.UseAuth(a, principals{
		"appToken": {UserID: "token:2", TenantID: "platform", Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaAPIToken, TokenID: 2, AppID: &liveID},
		"owner":    {UserID: "u1", TenantID: "tnt_a", Role: auth.RoleOwner, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"global":   {UserID: "token:1", TenantID: "platform", Role: auth.RoleService, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAPIToken, TokenID: 1},
		"admin":    {UserID: "admin", TenantID: "platform", Role: auth.RoleSuperadmin, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAdminJWT},
	}, false)
	authz.NewGuard(authz.New(g), nil, testutil.Log()).Install(a)
	s.Register(a)

	cases := []struct {
		who  string
		want int
		body string
	}{
		{"appToken", 403, api.GlobalScopeMessage},
		{"owner", 403, api.GlobalScopeMessage},
		{"global", 200, "other tenant event"},
		{"admin", 200, "other tenant event"},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/logs?app=other", nil)
		r.Header.Set("Authorization", "Bearer "+c.who)
		w := httptest.NewRecorder()
		httpx.WithRequest(mux).ServeHTTP(w, r)
		if w.Code != c.want || !strings.Contains(w.Body.String(), c.body) {
			t.Errorf("GET /logs as %s: %d %s", c.who, w.Code, w.Body)
		}
	}
}
