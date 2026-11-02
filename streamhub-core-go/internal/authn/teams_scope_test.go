package authn_test

import (
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
)

// TestTeamsMineDeniedToAppScopedToken: GET /teams/mine returns the tenant's
// member list (emails, roles, status). An app-scoped token is a machine
// credential confined to one app, but the route has no app in the path and
// the guard lets api_tokens through RBAC, so it read the whole team. It has
// no team now; global credentials keep the platform view.
func TestTeamsMineDeniedToAppScopedToken(t *testing.T) {
	s := newStack(t)
	t.Setenv(authz.EnforceEnv, "on")
	admin := s.adminToken()
	s.g.Exec(`INSERT INTO apps (id, name) VALUES (1, 'live')`)
	app := s.call("POST", "/tokens", admin, `{"name":"a","scope":"app","appId":1}`).str("token")

	s.expect(s.call("GET", "/teams/mine", app, ""), 403, `"an app-scoped credential has no team"`)
	s.expect(s.call("GET", "/teams/mine", s.globalToken(), ""), 200, `"id":"platform"`)
	s.expect(s.call("GET", "/teams/mine", admin, ""), 200, `"id":"platform"`)
}
