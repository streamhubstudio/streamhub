package streams

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// principals maps "Bearer <key>" to a fixed principal.
type principals map[string]*auth.Principal

func (f principals) Authenticate(r *http.Request) (*auth.Principal, error) {
	return f[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")], nil
}

// TestHlsRoutesRequirePermission (A1): the HlsController routes used to
// carry no @RequirePermission, so any authenticated principal — a viewer of
// another tenant included — could start/stop/read the HLS egress of any app.
// They now need stream:start / stream:stop / stream:read in the app's tenant.
func TestHlsRoutesRequirePermission(t *testing.T) {
	t.Setenv(authz.EnforceEnv, "on")
	h := newHarness(t, nil)
	g, err := h.store.Global(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	testutil.Exec(t, g, `UPDATE apps SET tenant_id = 'tnt_a' WHERE name = ?`, testApp)
	testutil.Exec(t, g, `INSERT INTO apps (name, tenant_id) VALUES ('other', 'tnt_a')`)
	var otherID int64
	if err := g.QueryRow(`SELECT id FROM apps WHERE name = 'other'`).Scan(&otherID); err != nil {
		t.Fatal(err)
	}
	h.insertActive("cam1", "webrtc", "live/room", "cam", 0)

	mux := http.NewServeMux()
	a := api.New(mux, "test")
	api.UseAuth(a, principals{
		"viewerB":  {UserID: "u1", TenantID: "tnt_b", Role: auth.RoleViewer, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"editorB":  {UserID: "u4", TenantID: "tnt_b", Role: auth.RoleEditor, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"otherApp": {UserID: "token:9", TenantID: "tnt_a", Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaAPIToken, TokenID: 9, AppID: &otherID},
		"viewerA":  {UserID: "u2", TenantID: "tnt_a", Role: auth.RoleViewer, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
		"editorA":  {UserID: "u3", TenantID: "tnt_a", Role: auth.RoleEditor, Scope: auth.ScopeUser, Via: auth.ViaUserJWT},
	}, false)
	authz.NewGuard(authz.New(g), nil, testutil.Log()).Install(a)
	(&Module{Streams: h.svc, Hls: withEgress(h, &fakeEgress{})}).Register(a)

	base := "/api/v1/apps/" + testApp + "/streams/cam1/hls"
	cases := []struct {
		who, method, path string
		want              int
		body              string
	}{
		{"viewerB", "POST", base + "/start", 403, "lacks stream:start"},
		{"viewerB", "POST", base + "/stop", 403, "lacks stream:stop"},
		{"viewerB", "GET", base, 403, "outside tenant 'tnt_b'"},
		{"editorB", "POST", base + "/start", 403, "outside tenant 'tnt_b'"},
		{"editorB", "POST", base + "/stop", 403, "outside tenant 'tnt_b'"},
		{"otherApp", "POST", base + "/start", 403, "outside this credential's app scope"},
		{"otherApp", "GET", base, 403, "outside this credential's app scope"},
		{"viewerA", "POST", base + "/start", 403, "lacks stream:start"},
		{"viewerA", "POST", base + "/stop", 403, "lacks stream:stop"},
		{"viewerA", "GET", base, 200, `"active"`},
		{"editorA", "POST", base + "/start", 201, `"egressId"`},
		{"editorA", "POST", base + "/stop", 200, `"status"`},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, c.path, nil)
		r.Header.Set("Authorization", "Bearer "+c.who)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != c.want || !strings.Contains(w.Body.String(), c.body) {
			t.Errorf("%s %s as %s: %d %s", c.method, c.path, c.who, w.Code, w.Body)
		}
	}
}
