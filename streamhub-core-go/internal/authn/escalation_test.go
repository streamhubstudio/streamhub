package authn_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/tenancy"
)

// Security 3.3.3 F1: every path that used to end in the superadmin principal
// (or in somebody else's session) without owning the mailbox.

// magicSession requests a magic link for email and verifies it.
func (s *stack) magicSession(email string) resp {
	s.t.Helper()
	s.call("POST", "/auth/magic-link", "", `{"email":"`+email+`"}`)
	return s.call("POST", "/auth/magic/verify", "", `{"token":"`+s.mail.lastToken(s.t)+`"}`)
}

// C1: without STREAMHUB_SUPERADMIN_EMAIL there is no superadmin email — the
// historical default (info@streamhub.studio) is just another address.
func TestSuperadminEmailHasNoDefault(t *testing.T) {
	s := newStack(t)
	t.Setenv("STREAMHUB_PUBLIC_REGISTRATION", "1")
	r := s.magicSession("info@streamhub.studio")
	s.expect(r, 200)
	s.expect(s.call("GET", "/auth/me", r.str("data.token"), ""), 200, `"isSuperadmin":false`, `"via":"user_jwt"`)
}

// C1: a user that holds the superadmin email (an unverified change before
// 3.3.3, or a signup) signs into their OWN account; the `admin` mirror is
// only reached when it already holds that email or nobody else does.
func TestSuperadminEmailTakenByUserIsNotPromoted(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	t.Setenv("STREAMHUB_SUPERADMIN_EMAIL", "boss@x.io")
	s.signup("eve@x.io", "longenough")
	eve := s.ten.GetUserByEmail(ctx, "eve@x.io").ID
	s.g.Exec(`UPDATE users SET email = 'Boss@X.io' WHERE id = ?`, eve)

	r := s.magicSession("boss@x.io")
	s.expect(r, 200)
	s.expect(s.call("GET", "/auth/me", r.str("data.token"), ""), 200, `"userId":"`+eve+`"`, `"isSuperadmin":false`, `"via":"user_jwt"`)
	if s.ten.IsSuperadmin(ctx, eve) {
		t.Fatal("the impostor must not be flagged superadmin")
	}

	// Once the address is free again the mirror is promoted; from then on it
	// holds the email and keeps winning.
	s.g.Exec(`UPDATE users SET email = 'eve@x.io' WHERE id = ?`, eve)
	s.g.Exec(`UPDATE magic_tokens SET created_at = '2000-01-01T00:00:00.000Z'`)
	r = s.magicSession("boss@x.io")
	s.expect(s.call("GET", "/auth/me", r.str("data.token"), ""), 200, `"userId":"admin"`, `"isSuperadmin":true`)
}

// C1: PATCH /account {email} only REQUESTS the change — the link goes to the
// new mailbox (the old one gets a notice) and nothing changes until it is
// followed; that is what made the superadmin email (or anybody's) takeable.
func TestEmailChangeNeedsConfirmation(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	tok := s.signup("me@x.io", "longenough")
	id := s.ten.GetUserByEmail(ctx, "me@x.io").ID

	s.expect(s.call("PATCH", "/account", tok, `{"email":"New@X.io"}`), 200, `"email":"me@x.io"`, `"pendingEmail":"new@x.io"`)
	if u := s.ten.GetUserByEmail(ctx, "new@x.io"); u != nil {
		t.Fatal("email changed without confirmation")
	}
	s.expect(s.call("GET", "/account", tok, ""), 200, `"email":"me@x.io"`, `"pendingEmail":"new@x.io"`)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"new@x.io","password":"longenough"}`), 401)
	if s.mail.to[len(s.mail.to)-1] != "new@x.io" || len(s.mail.notices) != 1 || s.mail.notices[0] != "me@x.io→new@x.io" {
		t.Fatalf("confirmation to the new address, notice to the old one: %v %v", s.mail.to, s.mail.notices)
	}

	// Confirming signs the requester in under the new address; single use.
	link := s.mail.lastToken(t)
	v := s.call("POST", "/auth/magic/verify", "", `{"token":"`+link+`"}`)
	s.expect(v, 200)
	s.expect(s.call("GET", "/auth/me", v.str("data.token"), ""), 200, `"userId":"`+id+`"`, `"email":"new@x.io"`)
	if r := s.call("GET", "/account", tok, ""); !strings.Contains(r.raw, `"email":"new@x.io"`) || strings.Contains(r.raw, "pendingEmail") {
		t.Fatal(r.raw)
	}
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"`+link+`"}`), 401)

	// An address taken in the meantime is not stolen at confirmation time.
	s.g.Exec(`UPDATE magic_tokens SET created_at = '2000-01-01T00:00:00.000Z'`)
	s.expect(s.call("PATCH", "/account", tok, `{"email":"late@x.io"}`), 200, `"pendingEmail":"late@x.io"`)
	link = s.mail.lastToken(t)
	s.signup("late@x.io", "longenough")
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"`+link+`"}`), 400, `"email already in use"`)
}

// M1: an invite link only activates the PENDING user its invitation
// created. An owner who invites an already-active account must not get a
// link that signs into it (with the inviter's SMTP that link was theirs).
func TestInviteLinkOfActiveUserIs410(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	owner := s.signup("owner@x.io", "longenough")
	victim := s.signup("victim@x.io", "longenough")
	victimID := s.ten.GetUserByEmail(ctx, "victim@x.io").ID

	// Since 3.3.4 (M2) inviting an existing account mints no link at all
	// (membership_test.go); one minted before still gets the 410.
	s.expect(s.call("POST", "/tenant/invites", owner, `{"email":"victim@x.io","role":"editor"}`), 201)
	url, err := s.svc.IssueInviteLink(ctx, "victim@x.io")
	if err != nil {
		t.Fatal(err)
	}
	r := s.call("POST", "/auth/magic/verify", "", `{"token":"`+url[strings.Index(url, "token=")+len("token="):]+`"}`)
	s.expect(r, 410, `"statusCode":410`, `"message":"invite already used"`)

	// An invitee who already accepted (here: completed signup) can't replay it.
	s.expect(s.call("POST", "/tenant/invites", owner, `{"email":"inv@x.io"}`), 201)
	link := s.mail.lastToken(t)
	s.expect(s.call("POST", "/auth/signup", "", `{"email":"inv@x.io","password":"longenough"}`), 201)
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"`+link+`"}`), 410, `"invite already used"`)

	// The pending invitee is still accepted.
	s.expect(s.call("POST", "/tenant/invites", owner, `{"email":"fresh@x.io"}`), 201)
	r = s.call("POST", "/auth/magic/verify", "", `{"token":"`+s.mail.lastToken(t)+`"}`)
	s.expect(r, 200)
	if u := s.ten.GetUserByEmail(ctx, "fresh@x.io"); u == nil || u.Status != "active" {
		t.Fatal("pending invitee not activated")
	}
	s.expect(s.call("GET", "/auth/me", victim, ""), 200, `"userId":"`+victimID+`"`)
}

// M1: with public registration off a magic link never creates an account.
// The request still answers the generic ack and still arms the cooldown, so
// nothing tells an unknown email from a known one.
func TestMagicLinkNoSignupWhenRegistrationOff(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	t.Setenv("STREAMHUB_PUBLIC_REGISTRATION", "0")

	s.expect(s.call("POST", "/auth/magic-link", "", `{"email":"stranger@x.io"}`), 200, genericAck)
	if len(s.mail.urls) != 0 {
		t.Fatal("no link may be mailed for an unknown email with signup off")
	}
	s.expect(s.call("POST", "/auth/magic-link", "", `{"email":"stranger@x.io"}`), 429, `"retryAfterSeconds":`)

	// A login token for an unknown email (minted while signup was on) no
	// longer creates the user.
	s.g.Exec(`INSERT INTO magic_tokens (token_hash, email, created_at, expires_at, kind)
	   VALUES (?, 'stranger2@x.io', ?, ?, 'login')`, auth.HashToken("tok-stranger"),
		time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), time.Now().Add(10*time.Minute).UTC().Format("2006-01-02T15:04:05.000Z"))
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"tok-stranger"}`), 401, `"Invalid or expired link"`)
	if s.ten.GetUserByEmail(ctx, "stranger2@x.io") != nil {
		t.Fatal("magic link created an account with signup off")
	}

	// Existing accounts keep signing in.
	id, _ := s.ten.CreateUser(ctx, tenancy.CreateUserInput{Email: "known@x.io"})
	r := s.magicSession("known@x.io")
	s.expect(s.call("GET", "/auth/me", r.str("data.token"), ""), 200, `"userId":"`+id+`"`)
}
