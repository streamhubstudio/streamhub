package livekit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// Security 3.3.4: GET /stats gives host metrics and server-wide totals only
// to global credentials; any other caller gets its own apps' counts.
func TestStatsScopedForNonGlobal(t *testing.T) {
	store, g, dir := testutil.Store(t)
	ctx := context.Background()
	testutil.Exec(t, g, `INSERT INTO apps (name, tenant_id) VALUES ('ta1', 'tnt_a'), ('ta2', 'tnt_a'), ('tb1', 'tnt_b')`)
	for _, app := range []string{"ta1", "tb1"} {
		h, err := store.App(ctx, app)
		if err != nil {
			t.Fatal(err)
		}
		testutil.Exec(t, h, `INSERT INTO streams (app_id, stream_id, type, status, room) VALUES (1, 'a', 'webrtc', 'active', 'r')`)
	}
	cfg := testConfig("livekit")
	cfg.DataDir = dir
	f := &fakeLK{on: func(m string, _ any) (string, bool) {
		if m == "ListRooms" {
			return `{"rooms":[{"name":"a"}]}`, true
		}
		return `{"items":[]}`, true
	}}
	m := &Module{stats: newStatsSource(cfg, store, *f.clients(), testutil.Log())}
	var current *auth.Principal
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	a.UseMiddleware(func(hc huma.Context, next func(huma.Context)) {
		next(huma.WithContext(hc, auth.WithPrincipal(hc.Context(), current)))
	})
	m.registerStats(a)
	get := func(p *auth.Principal) map[string]any {
		t.Helper()
		current = p
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/stats", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	counts := func(b map[string]any) (float64, float64) {
		c, _ := b["counts"].(map[string]any)
		apps, _ := c["apps"].(float64)
		active, _ := c["activeStreams"].(float64)
		return apps, active
	}
	host := []string{"cpu", "memory", "uptimeSeconds", "egress", "ingress", "storage"}

	global := get(&auth.Principal{IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAPIToken})
	for _, k := range host {
		if _, ok := global[k]; !ok {
			t.Errorf("global caller lost %q", k)
		}
	}
	if apps, active := counts(global); apps != 3 || active != 2 {
		t.Errorf("global counts %v/%v", apps, active)
	}

	appID := int64(2) // ta2
	for _, c := range []struct {
		name         string
		p            *auth.Principal
		apps, active float64
		scope        string
	}{
		{"tenant user", &auth.Principal{UserID: "u", TenantID: "tnt_a", Role: auth.RoleOwner, Scope: auth.ScopeUser, Via: auth.ViaUserJWT}, 2, 1, "tenant"},
		{"app token", &auth.Principal{TenantID: "tnt_a", Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaAPIToken, AppID: &appID}, 1, 0, "app"},
		{"no tenant", &auth.Principal{UserID: "u", Role: auth.RoleViewer, Scope: auth.ScopeUser, Via: auth.ViaUserJWT}, 0, 0, "tenant"},
	} {
		b := get(c.p)
		for _, k := range host {
			if _, ok := b[k]; ok {
				t.Errorf("%s sees host field %q", c.name, k)
			}
		}
		if b["disk"] != nil || b["livekitReachable"] != true || b["scope"] != c.scope {
			t.Errorf("%s: %v", c.name, b)
		}
		if apps, active := counts(b); apps != c.apps || active != c.active {
			t.Errorf("%s counts %v/%v, want %v/%v", c.name, apps, active, c.apps, c.active)
		}
	}
}
