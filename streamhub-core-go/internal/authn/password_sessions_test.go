package authn_test

import (
	"context"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authn"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/tenancy"
)

// Security 3.3.4: changing the password left every other session alive —
// whoever had the old password (or a stolen JWT) kept a 12h session. Now
// POST /account/password revokes all of the user's sessions but the one
// that made the change.
func TestChangePasswordRevokesOtherSessions(t *testing.T) {
	s := newStack(t)
	current := s.signup("me@x.io", "longenough")
	login := func() string {
		r := s.call("POST", "/auth/login", "", `{"user":"me@x.io","password":"longenough"}`)
		s.expect(r, 200)
		return r.str("data.token")
	}
	laptop, thief := login(), login()
	other := s.signup("other@x.io", "longenough")

	s.expect(s.call("POST", "/account/password", current, `{"currentPassword":"longenough","newPassword":"brand-new-pass"}`), 200, `{"data":{"ok":true},"error":null}`)
	s.expect(s.call("GET", "/auth/me", current, ""), 200, `"email":"me@x.io"`)
	for _, tok := range []string{laptop, thief} {
		s.expect(s.call("GET", "/auth/me", tok, ""), 401, `"Session revoked or expired"`)
	}
	list := s.call("GET", "/auth/sessions", current, "")
	s.expect(list, 200, `"current":true`)
	if n := len(list.body["data"].([]any)); n != 1 {
		t.Fatalf("%d live sessions after the change, want 1: %s", n, list.raw)
	}
	s.expect(s.call("GET", "/auth/me", other, ""), 200) // other users untouched

	// A failed change revokes nothing.
	fresh := s.call("POST", "/auth/login", "", `{"user":"me@x.io","password":"brand-new-pass"}`).str("data.token")
	s.expect(s.call("POST", "/account/password", current, `{"currentPassword":"wrong-one","newPassword":"another-pass"}`), 403)
	s.expect(s.call("GET", "/auth/me", fresh, ""), 200)
}

// The other path that sets a password — completing an invitation through
// /auth/signup (the "set your password" step, there is no separate reset
// flow) — ends EVERY earlier session of the account.
func TestPasswordSetOnSignupRevokesAllSessions(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	team, _ := s.ten.CreateTeam(ctx, "T", "")
	id, _ := s.ten.CreateUser(ctx, tenancy.CreateUserInput{Email: "inv@x.io", Status: "pending"})
	s.ten.AddMembership(ctx, id, team, tenancy.RoleEditor)
	sid, _ := s.svc.Sessions.Create(ctx, id, nil, authn.SessionContext{})
	before, _ := auth.SignJWT(map[string]any{"sub": id, "sid": sid}, jwtSecret, time.Hour)
	s.expect(s.call("GET", "/auth/me", before, ""), 200)

	t.Setenv("STREAMHUB_PUBLIC_REGISTRATION", "0")
	r := s.call("POST", "/auth/signup", "", `{"email":"inv@x.io","password":"longenough"}`)
	s.expect(r, 201)
	s.expect(s.call("GET", "/auth/me", before, ""), 401, `"Session revoked or expired"`)
	s.expect(s.call("GET", "/auth/me", r.str("data.token"), ""), 200, `"tenantId":"`+team+`"`)
}
