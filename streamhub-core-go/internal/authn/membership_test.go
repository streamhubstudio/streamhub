package authn_test

import (
	"context"
	"strings"
	"testing"
)

// Security 3.3.4 M2: an owner attached ANY existing account to their team on
// their own (POST /teams/mine/members, /tenant/invites), and as owner that
// membership outranked the account's own tenant — the victim's next request
// already ran in the attacker's tenant. Now an existing account only gets a
// pending membership, accepting it doesn't move the session's tenant, and
// switching is an explicit, per-session choice.
func TestExistingAccountJoinsOnlyByConsent(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	t.Setenv("STREAMHUB_APP_URL", "https://dash.example")

	// The victim: an invited viewer of team C (her only team).
	ownerC := s.signup("c@x.io", "longenough")
	cTeam := s.call("GET", "/auth/me", ownerC, "").str("data.tenantId")
	s.expect(s.call("POST", "/tenant/invites", ownerC, `{"email":"vic@x.io","role":"viewer"}`), 201)
	v := s.call("POST", "/auth/magic/verify", "", `{"token":"`+s.mail.lastToken(t)+`"}`)
	s.expect(v, 200)
	vic := v.str("data.token")
	vicID := s.ten.GetUserByEmail(ctx, "vic@x.io").ID
	s.expect(s.call("GET", "/auth/me", vic, ""), 200, `"tenantId":"`+cTeam+`"`, `"role":"viewer"`)

	// The attacker adds her to his team B as owner.
	attacker := s.signup("eve@x.io", "longenough")
	bTeam := s.call("GET", "/auth/me", attacker, "").str("data.tenantId")
	s.expect(s.call("POST", "/teams/mine/members", attacker, `{"email":"vic@x.io","role":"owner"}`), 201,
		`"userId":"`+vicID+`"`, `"status":"pending"`, `"role":"owner"`)
	s.expect(s.call("GET", "/auth/me", vic, ""), 200, `"tenantId":"`+cTeam+`"`, `"role":"viewer"`)
	if r := s.ten.RoleInTenant(ctx, vicID, bTeam); r != "" {
		t.Fatalf("a pending membership granted %q", r)
	}
	// The pending membership grants nothing: no switching into it either.
	s.expect(s.call("POST", "/account/tenants/"+bTeam+"/switch", vic, ""), 404, `"you are not a member of that team"`)

	// She sees it in her account and accepts; her session stays in C.
	inv := s.call("GET", "/account/invitations", vic, "")
	s.expect(inv, 200, `"tenantId":"`+bTeam+`"`, `"role":"owner"`, `"invitedBy":"eve@x.io"`)
	if strings.Contains(inv.raw, cTeam) {
		t.Fatal("an active membership is not an invitation")
	}
	s.expect(s.call("POST", "/account/invitations/"+bTeam+"/accept", vic, ""), 200, `"data":{"tenantId":"`+bTeam+`","status":"active"}`)
	s.expect(s.call("POST", "/account/invitations/"+bTeam+"/accept", vic, ""), 404, `"no pending invitation for that team"`)
	s.expect(s.call("GET", "/auth/me", vic, ""), 200, `"tenantId":"`+cTeam+`"`, `"role":"viewer"`)
	s.expect(s.call("GET", "/account/invitations", vic, ""), 200, `"data":[]`)

	// Switching is explicit and per session; a new session starts in the
	// primary tenant, which the accepted (owner) invitation didn't displace.
	tenants := s.call("GET", "/account/tenants", vic, "")
	s.expect(tenants, 200, `"tenantId":"`+cTeam+`"`, `"tenantId":"`+bTeam+`"`)
	if !strings.Contains(tenants.raw, `"tenantId":"`+cTeam+`","tenantName":"c@x.io","plan":"free","role":"viewer","invitedBy":"c@x.io"`) ||
		!strings.Contains(tenants.raw, `"current":true`) {
		t.Fatal(tenants.raw)
	}
	s.expect(s.call("POST", "/account/tenants/"+bTeam+"/switch", vic, ""), 200, `"tenant":{"id":"`+bTeam+`"`, `"role":"owner"`)
	s.expect(s.call("GET", "/auth/me", vic, ""), 200, `"tenantId":"`+bTeam+`"`, `"role":"owner"`)
	s.call("POST", "/auth/magic-link", "", `{"email":"vic@x.io"}`)
	other := s.call("POST", "/auth/magic/verify", "", `{"token":"`+s.mail.lastToken(t)+`"}`).str("data.token")
	s.expect(s.call("GET", "/auth/me", other, ""), 200, `"tenantId":"`+cTeam+`"`)

	// Losing the membership drops the pin back to the primary tenant.
	s.ten.RemoveMembership(ctx, vicID, bTeam)
	s.expect(s.call("GET", "/auth/me", vic, ""), 200, `"tenantId":"`+cTeam+`"`)

	// Humans only; the superadmin has no team to switch to.
	s.expect(s.call("GET", "/account/invitations", s.globalToken(), ""), 403)
	s.expect(s.call("POST", "/account/tenants/"+cTeam+"/switch", s.adminToken(), ""), 400)
}

// /tenant/invites to an existing account: a pending membership and a mail
// pointing at the account page — never a sign-in link (M1 refused to honour
// one; M2 stops minting it). Declining removes only the invitation.
func TestTenantInviteOfExistingAccount(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	t.Setenv("STREAMHUB_APP_URL", "https://dash.example/")
	owner := s.signup("owner@x.io", "longenough")
	team := s.call("GET", "/auth/me", owner, "").str("data.tenantId")
	bob := s.signup("bob@x.io", "longenough")
	bobID := s.ten.GetUserByEmail(ctx, "bob@x.io").ID
	bobTeam := s.call("GET", "/auth/me", bob, "").str("data.tenantId")

	s.expect(s.call("POST", "/tenant/invites", owner, `{"email":"bob@x.io","role":"editor"}`), 201, `"userId":"`+bobID+`"`, `"emailSent":true`)
	if u := s.mail.urls[len(s.mail.urls)-1]; u != "https://dash.example/account" {
		t.Fatalf("an existing account gets the account page, not a sign-in link: %s", u)
	}
	var links int
	s.g.QueryRow(`SELECT COUNT(*) FROM magic_tokens WHERE email = 'bob@x.io' AND kind = 'invite'`).Scan(&links)
	if links != 0 {
		t.Fatal("no invite token may be minted for an existing account")
	}
	s.expect(s.call("GET", "/tenant/invites", owner, ""), 200, `"userId":"`+bobID+`"`)
	s.expect(s.call("POST", "/tenant/invites", owner, `{"email":"bob@x.io"}`), 400, `"that email is already a member"`)
	s.expect(s.call("GET", "/auth/me", bob, ""), 200, `"tenantId":"`+bobTeam+`"`, `"role":"owner"`)

	s.expect(s.call("POST", "/account/invitations/"+team+"/decline", bob, ""), 200, `"status":"declined"`)
	s.expect(s.call("POST", "/account/invitations/"+team+"/decline", bob, ""), 404)
	s.expect(s.call("POST", "/account/invitations/"+bobTeam+"/decline", bob, ""), 404) // never an active one
	if s.ten.GetMembership(ctx, bobID, team) != nil || s.ten.GetUser(ctx, bobID) == nil {
		t.Fatal("decline drops the invitation, never the account")
	}
	s.expect(s.call("GET", "/tenant/invites", owner, ""), 200, `"data":[]`)

	// The owner may also withdraw it before an answer; the account stays.
	s.expect(s.call("POST", "/tenant/invites", owner, `{"email":"bob@x.io"}`), 201)
	s.expect(s.call("DELETE", "/tenant/invites/"+bobID, owner, ""), 204)
	if s.ten.GetUser(ctx, bobID) == nil {
		t.Fatal("revoking an invitation deleted a live account")
	}
}
