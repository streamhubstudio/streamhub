package quotas

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
)

// principals maps "Bearer <key>" to a fixed principal.
type principals map[string]*auth.Principal

func (f principals) Authenticate(r *http.Request) (*auth.Principal, error) {
	return f[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")], nil
}

// TestUsageOtherTenantDenied: GET /tenants/{id}/usage lets a non-superadmin
// read only its own tenant — but the check skipped every api_token (Node
// `via !== 'api_token'`), so an app-scoped token read ANY tenant's plan and
// usage. Only global-scope credentials read another tenant now.
func TestUsageOtherTenantDenied(t *testing.T) {
	s := setup(t)
	app := int64(1)
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	api.UseAuth(a, principals{
		"appTokenA": {UserID: "token:2", TenantID: "tnt_a", Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaAPIToken, TokenID: 2, AppID: &app},
		"ownerA":    owner,
		"global":    {UserID: "token:1", TenantID: auth.PlatformTenantID, Role: auth.RoleService, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAPIToken, TokenID: 1},
	}, false)
	s.Register(a)

	cases := []struct {
		who, tenant string
		want        int
	}{
		{"appTokenA", "tnt_b", 403},
		{"appTokenA", auth.PlatformTenantID, 403},
		{"appTokenA", "tnt_a", 200},
		{"ownerA", "tnt_b", 403},
		{"ownerA", "tnt_a", 200},
		{"global", "tnt_a", 200},
		{"global", "tnt_b", 200},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/tenants/"+c.tenant+"/usage", nil)
		r.Header.Set("Authorization", "Bearer "+c.who)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != c.want || (c.want == 403 && !strings.Contains(w.Body.String(), "cannot read another tenant usage")) {
			t.Errorf("usage of %s as %s: %d %s", c.tenant, c.who, w.Code, w.Body)
		}
	}
}
