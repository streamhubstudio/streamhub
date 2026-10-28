package authn_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

const genericAck = `{"data":{"message":"If that email is valid, we just sent a sign-in link."}}`

func TestMagicLink(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	t.Setenv("STREAMHUB_APP_URL", "https://dash.example/")

	s.expect(s.call("POST", "/auth/magic-link", "", `{"email":"New@X.io"}`), 200, genericAck)
	if u := s.mail.urls[0]; !strings.HasPrefix(u, "https://dash.example/auth/magic?token=") || s.mail.contexts[0].UserID != "" {
		t.Fatalf("%s %+v", u, s.mail.contexts)
	}
	token := s.mail.lastToken(t)
	var stored string
	s.g.QueryRow(`SELECT token_hash FROM magic_tokens`).Scan(&stored)
	if stored != auth.HashToken(token) {
		t.Fatal("only the hash may be stored")
	}
	s.expect(s.call("POST", "/auth/magic-link", "", `{"email":"nope"}`), 400, `"email must be an email"`)

	// Cooldown: a 2nd request for the same email within 60s → 429 with the wait.
	r := s.call("POST", "/auth/magic-link", "", `{"email":"new@x.io"}`)
	s.expect(r, 429, `"statusCode":429`, `"error":"Too Many Requests"`, `"retryAfterSeconds":`, `"message":"Please wait `)
	s.expect(s.call("POST", "/auth/magic-link", "", `{"email":"other@x.io"}`), 200, genericAck)

	// Verify → new user + owner team + session JWT; single use.
	v := s.call("POST", "/auth/magic/verify", "", `{"token":"`+token+`"}`)
	s.expect(v, 200)
	me := s.call("GET", "/auth/me", v.str("data.token"), "")
	s.expect(me, 200, `"role":"owner"`, `"email":"new@x.io"`)
	u := s.ten.GetUserByEmail(ctx, "new@x.io")
	if u.PasswordHash == nil || !strings.HasPrefix(*u.PasswordHash, "scrypt$") {
		t.Fatal("magic-born accounts get a random unknown password")
	}
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"`+token+`"}`), 401, `"Invalid or expired link"`)
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"tampered-token-123"}`), 401, `"Invalid or expired link"`)
	s.expect(s.call("POST", "/auth/magic/verify", "", `{}`), 400, `"token must be a string"`)

	// The existing user's id is the SMTP-resolution context of their next link.
	s.g.Exec(`UPDATE magic_tokens SET created_at = '2000-01-01T00:00:00.000Z'`)
	s.call("POST", "/auth/magic-link", "", `{"email":"new@x.io"}`)
	if s.mail.contexts[len(s.mail.contexts)-1].UserID != u.ID {
		t.Fatal("holder context")
	}

	// Expired link.
	s.g.Exec(`UPDATE magic_tokens SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T00:15:00.000Z'`)
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"`+s.mail.lastToken(t)+`"}`), 401)

	// Per-email window: 3 per 15 min (cooldown cleared by back-dating).
	for i := 0; i < 3; i++ {
		s.g.Exec(`UPDATE magic_tokens SET created_at = ? WHERE email = 'rate@x.io'`, time.Now().Add(-2*time.Minute).UTC().Format("2006-01-02T15:04:05.000Z"))
		s.call("POST", "/auth/magic-link", "", `{"email":"rate@x.io"}`)
	}
	s.g.Exec(`UPDATE magic_tokens SET created_at = ? WHERE email = 'rate@x.io'`, time.Now().Add(-2*time.Minute).UTC().Format("2006-01-02T15:04:05.000Z"))
	before := len(s.mail.urls)
	s.expect(s.call("POST", "/auth/magic-link", "", `{"email":"rate@x.io"}`), 200, genericAck)
	if len(s.mail.urls) != before {
		t.Fatal("4th link in the window must not be sent")
	}

	// SMTP failure is still the generic 200.
	s.mail.result.OK = false
	s.expect(s.call("POST", "/auth/magic-link", "", `{"email":"smtp@x.io"}`), 200, genericAck)
}

func TestMagicLinkSuperadminAndPending(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	verify := func(email string) resp {
		s.call("POST", "/auth/magic-link", "", `{"email":"`+email+`"}`)
		return s.call("POST", "/auth/magic/verify", "", `{"token":"`+s.mail.lastToken(t)+`"}`)
	}
	r := verify("info@streamhub.studio")
	s.expect(s.call("GET", "/auth/me", r.str("data.token"), ""), 200, `"userId":"admin"`, `"via":"admin_jwt"`)
	t.Setenv("STREAMHUB_SUPERADMIN_EMAIL", "Boss@X.io")
	r = verify("boss@x.io")
	s.expect(s.call("GET", "/auth/me", r.str("data.token"), ""), 200, `"isSuperadmin":true`)

	team, _ := s.ten.CreateTeam(ctx, "T", "")
	id, _ := s.ten.CreateUser(ctx, tenancy.CreateUserInput{Email: "inv@x.io", Status: "pending"})
	s.ten.AddMembership(ctx, id, team, tenancy.RoleEditor)
	r = verify("inv@x.io")
	s.expect(s.call("GET", "/auth/me", r.str("data.token"), ""), 200, `"tenantId":"`+team+`"`, `"role":"editor"`)
	if s.ten.GetUser(ctx, id).Status != "active" {
		t.Fatal("pending invitee not promoted")
	}
}

func TestAccountAnd2FA(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	tok := s.signup("me@x.io", "longenough")
	s.signup("taken@x.io", "longenough")

	s.expect(s.call("GET", "/account", tok, ""), 200, `"email":"me@x.io"`, `"hasPassword":true`, `"twoFactorEnabled":false`, `"status":"active"`, `"role":"owner"`, `"error":null`)
	s.expect(s.call("PATCH", "/account", tok, `{"name":"  Me  ","email":" ME2@X.io "}`), 400, `"email must be an email"`)
	s.expect(s.call("PATCH", "/account", tok, `{"name":"  Me  ","email":"ME2@X.io"}`), 200, `"name":"Me"`, `"email":"me2@x.io"`)
	s.expect(s.call("PATCH", "/account", tok, `{"email":"taken@x.io"}`), 400, `"email already in use"`)
	s.expect(s.call("PATCH", "/account", tok, `{"email":"root@x.io"}`), 400, `"email already in use"`)
	s.expect(s.call("PATCH", "/account", tok, `{"name":""}`), 200, `"name":null`)
	admin := s.adminToken()
	s.expect(s.call("PATCH", "/account", admin, `{"email":"x@y.io"}`), 400, `"the break-glass admin email is managed via ADMIN_USER (env)"`)
	s.expect(s.call("POST", "/account/password", admin, `{"currentPassword":"x","newPassword":"longenough"}`), 400, `managed via ADMIN_PASS (env)`)
	sk := s.globalToken()
	s.expect(s.call("GET", "/account", sk, ""), 403, `"API tokens have no account"`)

	s.expect(s.call("POST", "/account/password", tok, `{"currentPassword":"wrong","newPassword":"newpassword"}`), 403, `"current password is incorrect"`)
	s.expect(s.call("POST", "/account/password", tok, `{"currentPassword":"longenough","newPassword":"short"}`), 400, `"newPassword must be longer than or equal to 8 characters"`)
	s.expect(s.call("POST", "/account/password", tok, `{"currentPassword":"longenough","newPassword":"newpassword"}`), 200, `{"data":{"ok":true},"error":null}`)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"me2@x.io","password":"newpassword"}`), 200)

	// 2FA: setup stores the secret encrypted (pending) and returns otpauth + QR.
	setup := s.call("POST", "/account/2fa/setup", tok, "")
	s.expect(setup, 200, `"otpauthUri":"otpauth://totp/StreamHub:me2%40x.io?secret=`, `"qrDataUri":"data:image/png;base64,`)
	secret := setup.str("data.secret")
	uid := s.ten.GetUserByEmail(ctx, "me2@x.io").ID
	st := s.ten.GetTotpState(ctx, uid)
	if st.Enabled || st.PendingSecret == nil || strings.Contains(*st.PendingSecret, secret) {
		t.Fatalf("pending secret must be stored encrypted: %+v", st)
	}
	s.expect(s.call("POST", "/account/2fa/enable", tok, `{"code":"12345"}`), 400, `"code must be a 6-digit number"`)
	s.expect(s.call("POST", "/account/2fa/enable", tok, `{"code":"000000"}`), 400, `"invalid verification code"`)
	code := auth.TOTPCode(secret, time.Now())
	s.expect(s.call("POST", "/account/2fa/enable", tok, `{"code":" `+code+` "}`), 200, `{"data":{"enabled":true},"error":null}`)
	s.expect(s.call("POST", "/account/2fa/setup", tok, ""), 400, `"2FA is already enabled — disable it first"`)

	login := func(extra string) resp {
		return s.call("POST", "/auth/login", "", `{"user":"me2@x.io","password":"newpassword"`+extra+`}`)
	}
	s.expect(login(""), 401, `"totp_required"`)
	s.expect(login(`,"code":"000000"`), 401, `"totp_invalid"`)
	s.expect(login(`,"code":"`+auth.TOTPCode(secret, time.Now())+`"`), 200)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"root@x.io","password":"rootpass"}`), 200) // break-glass never gated

	// Magic link with 2FA: the code is required and a miss does not burn the link.
	s.call("POST", "/auth/magic-link", "", `{"email":"me2@x.io"}`)
	link := s.mail.lastToken(t)
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"`+link+`"}`), 401, `"totp_required"`)
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"`+link+`","code":"`+auth.TOTPCode(secret, time.Now())+`"}`), 200)

	s.expect(s.call("POST", "/account/2fa/disable", tok, `{"code":"000000"}`), 400, `"invalid verification code"`)
	s.expect(s.call("POST", "/account/2fa/disable", tok, `{"code":"`+auth.TOTPCode(secret, time.Now())+`"}`), 200, `"enabled":false`)
	s.expect(s.call("POST", "/account/2fa/disable", tok, `{"code":"123456"}`), 400, `"2FA is not enabled"`)
	s.expect(login(""), 200)
}

func TestAccountSmtp(t *testing.T) {
	s := newStack(t)
	tok := s.signup("me@x.io", "longenough")
	s.expect(s.call("GET", "/account/smtp", tok, ""), 200,
		`{"data":{"enabled":false,"host":"","port":587,"user":"","from":"","pass":"","hasPass":false,"configured":false},"error":null}`)
	s.expect(s.call("PUT", "/account/smtp", tok, `{"port":0}`), 400, `"port must not be less than 1"`)
	s.expect(s.call("PUT", "/account/smtp", tok, `{"enabled":true,"host":" smtp.x.io ","port":465,"user":"me","pass":"supersecret","from":" Me <me@x.io> "}`), 200,
		`"host":"smtp.x.io"`, `"port":465`, `"from":"Me <me@x.io>"`, `"pass":"su***et"`, `"hasPass":true`, `"configured":true`)
	var enc string
	s.g.QueryRow(`SELECT smtp_pass_enc FROM users WHERE email = 'me@x.io'`).Scan(&enc)
	if !strings.HasPrefix(enc, "aesgcm$") || strings.Contains(enc, "supersecret") {
		t.Fatal("smtp password must be encrypted at rest")
	}
	s.expect(s.call("PUT", "/account/smtp", tok, `{"enabled":false}`), 200, `"pass":"su***et"`, `"configured":false`)
	s.expect(s.call("POST", "/account/smtp/test", tok, `{"to":"ops@x.io"}`), 200, `{"data":{"ok":true,"messageId":"m1"},"error":null}`)
	if len(s.mail.tests) != 1 || !strings.HasSuffix(s.mail.tests[0], "→ops@x.io") {
		t.Fatalf("%v", s.mail.tests)
	}
}

func TestTeamsAndInvites(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	owner := s.signup("owner@x.io", "longenough")
	ownerTenant := s.call("GET", "/auth/me", owner, "").str("data.tenantId")

	s.expect(s.call("GET", "/teams/mine", owner, ""), 200, `"members":[{"userId":"usr_`, `"usage":{"tenantId":"`+ownerTenant+`"`)
	s.expect(s.call("POST", "/teams/mine/members", owner, `{"email":"Viewer@X.io"}`), 201, `"email":"viewer@x.io"`, `"role":"viewer"`, `"status":"pending"`)
	s.expect(s.call("POST", "/auth/signup", "", `{"email":"viewer@x.io","password":"longenough"}`), 201) // completes the invite
	viewer := s.call("POST", "/auth/login", "", `{"user":"viewer@x.io","password":"longenough"}`).str("data.token")

	// Invites are owner-only regardless of the phased flag; with AUTHZ=on the
	// permission guard answers first.
	t.Setenv(authz.EnforceEnv, "log")
	s.expect(s.call("POST", "/teams/mine/members", viewer, `{"email":"x@x.io"}`), 403, `"only a team owner can invite members"`)
	t.Setenv(authz.EnforceEnv, "on")
	s.expect(s.call("POST", "/teams/mine/members", viewer, `{"email":"x@x.io"}`), 403, `"role 'viewer' lacks tenant:write"`)
	s.expect(s.call("GET", "/tenants/"+ownerTenant+"/usage", viewer, ""), 200)
	other := s.signup("other@x.io", "longenough")
	s.expect(s.call("GET", "/tenants/"+ownerTenant+"/usage", other, ""), 403, `"cannot read another tenant usage"`)
	s.expect(s.call("GET", "/tenants", owner, ""), 403, `"superadmin only"`)
	sk := s.globalToken()
	s.expect(s.call("GET", "/teams/mine", sk, ""), 200) // platform tenant

	// Tenant invites.
	inv := s.call("POST", "/tenant/invites", owner, `{"email":"Inv@X.io","role":"editor"}`)
	s.expect(inv, 201, `"email":"inv@x.io"`, `"role":"editor"`, `"emailSent":true`, `"invitedAt":"`)
	if s.mail.contexts[len(s.mail.contexts)-1].UserID != s.ten.GetUserByEmail(ctx, "owner@x.io").ID {
		t.Fatal("inviter's own SMTP context")
	}
	inviteLink := s.mail.lastToken(t)
	s.expect(s.call("POST", "/tenant/invites", owner, `{"email":"inv@x.io"}`), 400, `"that email is already a member"`)
	s.expect(s.call("POST", "/tenant/invites", owner, `{"email":"root@x.io"}`), 400, `"cannot invite the break-glass admin"`)
	s.expect(s.call("POST", "/tenant/invites", owner, `{"email":"inv2@x.io"}`), 201, `"role":"viewer"`)
	list := s.call("GET", "/tenant/invites", owner, "")
	s.expect(list, 200, `"email":"inv@x.io"`, `"email":"inv2@x.io"`)
	if strings.Contains(list.raw, "owner@x.io") || strings.Contains(list.raw, "viewer@x.io") {
		t.Fatal("only pending invitations")
	}
	s.expect(s.call("GET", "/tenant/invites", viewer, ""), 403)
	s.expect(s.call("GET", "/tenant/invites", sk, ""), 200) // superadmin on its platform tenant

	// The emailed invite link accepts into a session (pending → active, role kept).
	acc := s.call("POST", "/auth/magic/verify", "", `{"token":"`+inviteLink+`"}`)
	s.expect(s.call("GET", "/auth/me", acc.str("data.token"), ""), 200, `"tenantId":"`+ownerTenant+`"`, `"role":"editor"`)

	inv2 := s.ten.GetUserByEmail(ctx, "inv2@x.io").ID
	inv2Link := s.mail.lastToken(t)
	accepted := s.ten.GetUserByEmail(ctx, "inv@x.io").ID
	s.expect(s.call("DELETE", "/tenant/invites/"+accepted, owner, ""), 400, `"that user already accepted — not a pending invitation"`)
	s.expect(s.call("DELETE", "/tenant/invites/usr_nobody", owner, ""), 404, `"no such invitation in your tenant"`)
	s.expect(s.call("DELETE", "/tenant/invites/"+inv2, viewer, ""), 403)
	s.expect(s.call("DELETE", "/tenant/invites/"+inv2, owner, ""), 204)
	if s.ten.GetUser(ctx, inv2) != nil {
		t.Fatal("orphan invitee not deleted")
	}
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"`+inv2Link+`"}`), 401) // link killed

	// Unscoped credential.
	s.ten.RemoveMembership(ctx, s.ten.GetUserByEmail(ctx, "other@x.io").ID, s.call("GET", "/auth/me", other, "").str("data.tenantId"))
	t.Setenv(authz.EnforceEnv, "log")
	s.expect(s.call("GET", "/tenant/invites", other, ""), 400, `"no team in context (unscoped credential)"`)
}

func TestSuperadminSurfaces(t *testing.T) {
	s := newStack(t)
	admin := s.adminToken()
	s.g.Exec(`INSERT INTO apps (id, name) VALUES (1, 'live')`)
	app := s.call("POST", "/tokens", admin, `{"name":"a","scope":"app","appId":1}`).str("token")
	user := s.signup("u@x.io", "longenough")
	for _, p := range []string{"/system/audit", "/system/audit/verify", "/security/status", "/security/ip-rules", "/security/bans", "/security/offenses"} {
		s.expect(s.call("GET", p, app, ""), 403, `"this endpoint requires a global-scope credential"`)
		s.expect(s.call("GET", p, user, ""), 403)
		s.expect(s.call("GET", p, admin, ""), 200, `"error":null`)
	}
	s.expect(s.call("GET", "/security/status", admin, ""), 200,
		`{"data":{"mode":"off","allowlistOnly":false,"autoban":{"enabled":false,"maxOffenses":10,"windowS":300,"baseTtlS":900,"track404":false},"counts":{"rules":0,"allowRules":0,"blockRules":0,"activeBans":0,"trackedOffenders":0}},"error":null}`)
	s.expect(s.call("POST", "/security/ip-rules", admin, `{"cidr":"nope","action":"block"}`), 400, `"invalid CIDR — expected an IPv4/IPv6 address or a.b.c.d/nn form"`)
	s.expect(s.call("POST", "/security/ip-rules", admin, `{"cidr":"203.0.113.1","action":"deny"}`), 400, `"action must be one of the following values: allow, block"`)
	s.expect(s.call("POST", "/security/ip-rules", admin, `{"cidr":"203.0.113.1","action":"block","note":"x"}`), 201,
		`"cidr":"203.0.113.1/32"`, `"action":"block"`, `"note":"x"`, `"createdBy":"admin"`)
	s.expect(s.call("DELETE", "/security/ip-rules/1", admin, ""), 200, `{"data":{"id":1,"deleted":true},"error":null}`)
	s.expect(s.call("DELETE", "/security/ip-rules/1", admin, ""), 404, `"ip rule 1 not found"`)
	s.expect(s.call("POST", "/security/bans/203.0.113.9/unban", admin, ""), 404, `"no ban record for 203.0.113.9"`)
	s.expect(s.call("GET", "/system/audit?action=security.&limit=abc&result=bogus", admin, ""), 200, `"total":2`, `"limit":50`)
	s.expect(s.call("GET", "/system/audit/verify", admin, ""), 200, `"ok":true`)
}

// Every Node route of the auth plane is registered with the openapi.json
// operationId (account smtp routes postdate the committed spec).
func TestRoutesMatchOpenAPI(t *testing.T) {
	s := newStack(t)
	r := s.call("GET", "/openapi.json", "", "")
	s.expect(r, 200)
	want := strings.Fields(`GET /api/v1/security/status SecurityController_status
GET /api/v1/security/ip-rules SecurityController_listRules
POST /api/v1/security/ip-rules SecurityController_addRule
DELETE /api/v1/security/ip-rules/{id} SecurityController_removeRule
GET /api/v1/security/bans SecurityController_bans
POST /api/v1/security/bans/{ip}/unban SecurityController_unban
GET /api/v1/security/offenses SecurityController_offenses
GET /api/v1/tokens AuthController_list
POST /api/v1/tokens AuthController_create
DELETE /api/v1/tokens/{id} AuthController_revoke
GET /api/v1/auth/config LoginController_config
POST /api/v1/auth/signup LoginController_signup
POST /api/v1/auth/login LoginController_login
GET /api/v1/auth/me LoginController_me
POST /api/v1/auth/magic-link MagicController_request
POST /api/v1/auth/magic/verify MagicController_verify
GET /api/v1/auth/sessions SessionController_list
DELETE /api/v1/auth/sessions SessionController_revokeOthers
DELETE /api/v1/auth/sessions/{id} SessionController_revoke
GET /api/v1/teams/mine TeamsController_mine
POST /api/v1/teams/mine/members TeamsController_invite
GET /api/v1/tenant/invites TenantInvitesController_list
POST /api/v1/tenant/invites TenantInvitesController_invite
DELETE /api/v1/tenant/invites/{userId} TenantInvitesController_revoke
GET /api/v1/account AccountController_me
PATCH /api/v1/account AccountController_update
POST /api/v1/account/password AccountController_changePassword
POST /api/v1/account/2fa/setup AccountController_setup2fa
POST /api/v1/account/2fa/enable AccountController_enable2fa
POST /api/v1/account/2fa/disable AccountController_disable2fa
GET /api/v1/account/smtp AccountController_getSmtp
PUT /api/v1/account/smtp AccountController_setSmtp
POST /api/v1/account/smtp/test AccountController_testSmtp
GET /api/v1/tenants QuotasController_list
GET /api/v1/tenants/{id}/usage QuotasController_usage
PATCH /api/v1/tenants/{id}/quotas QuotasController_updateQuotas
GET /api/v1/system/audit AuditController_list
GET /api/v1/system/audit/verify AuditController_verify`)
	paths, _ := r.body["paths"].(map[string]any)
	for i := 0; i < len(want); i += 3 {
		ops, _ := paths[want[i+1]].(map[string]any)
		op, _ := ops[strings.ToLower(want[i])].(map[string]any)
		if op == nil || op["operationId"] != want[i+2] {
			t.Errorf("%s %s: want %s, got %v", want[i], want[i+1], want[i+2], op["operationId"])
		}
	}
}
