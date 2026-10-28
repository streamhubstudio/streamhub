package authn

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

// Register implements api.Module: every controller of the Node auth module
// (auth/tokens, login, magic, sessions, account, teams, tenant invites).
func (s *Service) Register(a huma.API) {
	s.registerTokens(a)
	s.registerLogin(a)
	s.registerMagic(a)
	s.registerSessions(a)
	s.registerAccount(a)
	s.registerTeams(a)
	s.registerInvites(a)
}

func operation(id, method, path, summary, tag string) *huma.Operation {
	return api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{tag}})
}

func withStatus(op *huma.Operation, status int) *huma.Operation {
	op.DefaultStatus = status
	return op
}

type rawBody = api.RawBodyInput

// errMessage is (err as Error).message for audit meta.
func errMessage(err error) string { return err.Error() }

// ---------------------------------------------------------------------------
// /tokens (auth.controller.ts) — global scope only
// ---------------------------------------------------------------------------

const tokenScopeMessage = "token management requires a global-scope credential"

func (s *Service) registerTokens(a huma.API) {
	huma.Register(a, *operation("AuthController_list", http.MethodGet, "/tokens",
		"List API tokens (hashes never returned).", "tokens"),
		func(ctx context.Context, _ *struct{}) (*api.Out[[]TokenSummary], error) {
			if err := api.RequireGlobal(ctx, tokenScopeMessage); err != nil {
				return nil, err
			}
			list, err := s.ListTokens(ctx)
			if err != nil {
				return nil, err
			}
			return api.JSON(list), nil
		})

	type createMeta struct {
		Name  string `json:"name"`
		Scope string `json:"scope"`
		AppID *int64 `json:"appId"`
	}
	huma.Register(a, *withStatus(operation("AuthController_create", http.MethodPost, "/tokens",
		"Create an API token. Plaintext is returned ONCE.", "tokens"), http.StatusCreated),
		func(ctx context.Context, in *rawBody) (*api.Out[*CreatedToken], error) {
			b, err := body(in.RawBody, "CreateTokenDto")
			if err != nil {
				return nil, err
			}
			if err := api.RequireGlobal(ctx, tokenScopeMessage); err != nil {
				return nil, err
			}
			created, err := s.CreateToken(ctx, CreateTokenInput{
				Name: b.String("name"), Scope: b.String("scope"), AppID: b.Int("appId"), AllowedIPs: b.Strings("allowedIps"),
			})
			if err != nil {
				return nil, err
			}
			s.audit.RecordCtx(ctx, audit.Event{
				Action: "token.create", TargetType: audit.Str("token"), TargetID: audit.Str(strconv.FormatInt(created.ID, 10)),
				Meta: createMeta{b.String("name"), b.String("scope"), b.Int("appId")},
			})
			return api.JSON(created), nil
		})

	type idInput struct {
		ID string `path:"id"`
	}
	huma.Register(a, *withStatus(operation("AuthController_revoke", http.MethodDelete, "/tokens/{id}",
		"Revoke (soft-delete) an API token.", "tokens"), http.StatusNoContent),
		func(ctx context.Context, in *idInput) (*struct{}, error) {
			id, err := api.ParseIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			if err := api.RequireGlobal(ctx, tokenScopeMessage); err != nil {
				return nil, err
			}
			if err := s.RevokeToken(ctx, id); err != nil {
				return nil, err
			}
			s.audit.RecordCtx(ctx, audit.Event{Action: "token.revoke", TargetType: audit.Str("token"), TargetID: audit.Str(in.ID)})
			return nil, nil
		})
}

// ---------------------------------------------------------------------------
// /auth config, signup, login, me (login.controller.ts)
// ---------------------------------------------------------------------------

// AuthConfig is GET /auth/config.
type AuthConfig struct {
	AllowSignup  bool    `json:"allowSignup"`
	NodeRole     string  `json:"nodeRole"`
	MasterURL    *string `json:"masterUrl"`
	LoginEnabled bool    `json:"loginEnabled"`
	AppVersion   string  `json:"appVersion"`
	// SamplesURL is the samples origin (STREAMHUB_SAMPLES_URL) the SPA links
	// and previews samples on; omitted when samples share this origin.
	SamplesURL string `json:"samplesUrl,omitempty"`
}

type loginToken struct {
	Token string `json:"token"`
}

// AuthContextJSON is the wire shape of req.authCtx (GET /auth/me).
type AuthContextJSON struct {
	UserID       string     `json:"userId"`
	TenantID     *string    `json:"tenantId"`
	Role         auth.Role  `json:"role"`
	IsSuperadmin bool       `json:"isSuperadmin"`
	Scope        auth.Scope `json:"scope"`
	Via          auth.Via   `json:"via"`
	Email        *string    `json:"email,omitempty"`
}

// ContextJSON renders a principal like Node serialises the AuthContext.
func ContextJSON(p *auth.Principal) *AuthContextJSON {
	if p == nil {
		return nil
	}
	return &AuthContextJSON{p.UserID, strPtr(p.TenantID), p.Role, p.IsSuperadmin, p.Scope, p.Via, p.Email}
}

type failureMeta struct {
	Error string `json:"error"`
}

func (s *Service) registerLogin(a huma.API) {
	huma.Register(a, *api.Public(&huma.Operation{
		OperationID: "LoginController_config", Method: http.MethodGet, Path: api.Prefix + "/auth/config",
		Summary: "Public auth capabilities (public, no auth)", Tags: []string{"auth"},
	}), func(ctx context.Context, _ *struct{}) (*api.Out[api.Data[AuthConfig]], error) {
		role := s.nodeRole.Role(ctx)
		return api.JSON(api.Data[AuthConfig]{Data: AuthConfig{
			AllowSignup: s.AllowSignup(), NodeRole: role, MasterURL: s.nodeRole.MasterURL(ctx),
			LoginEnabled: role != "edge", AppVersion: version.Get(), SamplesURL: s.cfg.SamplesURL,
		}}), nil
	})

	huma.Register(a, *withStatus(api.Public(&huma.Operation{
		OperationID: "LoginController_signup", Method: http.MethodPost, Path: api.Prefix + "/auth/signup",
		Summary: "Sign up: create a user + team (public, no auth)", Tags: []string{"auth"},
	}), http.StatusCreated), func(ctx context.Context, in *rawBody) (*api.Out[api.Data[loginToken]], error) {
		b, err := body(in.RawBody, "SignupDto")
		if err != nil {
			return nil, err
		}
		r := api.Request(ctx)
		token, err := s.Signup(ctx, SignupInput{b.String("email"), b.String("password"), b.String("teamName")}, SessionContextFrom(r))
		ev := audit.Event{Action: "user.signup", ActorType: audit.ActorUser, ActorID: audit.Str(b.String("email")), IP: audit.RequestIP(ctx), Result: audit.Success}
		if err != nil {
			ev.Result, ev.Meta = audit.Failure, failureMeta{errMessage(err)}
			s.audit.Record(ctx, ev)
			return nil, err
		}
		s.audit.Record(ctx, ev)
		return api.JSON(api.Data[loginToken]{Data: loginToken{token}}), nil
	})

	huma.Register(a, *api.Public(&huma.Operation{
		OperationID: "LoginController_login", Method: http.MethodPost, Path: api.Prefix + "/auth/login",
		Summary: "Log in with user/password (public, no auth)", Tags: []string{"auth"},
	}), func(ctx context.Context, in *rawBody) (*api.Out[api.Data[loginToken]], error) {
		b, err := body(in.RawBody, "LoginDto")
		if err != nil {
			return nil, err
		}
		r := api.Request(ctx)
		token, err := s.Login(ctx, b.String("user"), b.String("password"), b.String("code"), SessionContextFrom(r))
		ev := audit.Event{Action: "auth.login", ActorType: audit.ActorUser, ActorID: audit.Str(b.String("user")), IP: audit.RequestIP(ctx), Result: audit.Success}
		if err != nil {
			ev.Result, ev.Meta = audit.Failure, failureMeta{errMessage(err)}
			s.audit.Record(ctx, ev)
			return nil, err
		}
		s.audit.Record(ctx, ev)
		return api.JSON(api.Data[loginToken]{Data: loginToken{token}}), nil
	})

	huma.Register(a, *operation("LoginController_me", http.MethodGet, "/auth/me",
		"Resolved AuthContext for the current credential (Wave-5 §auth).", "auth"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Data[*AuthContextJSON]], error) {
			return api.JSON(api.Data[*AuthContextJSON]{Data: ContextJSON(auth.From(ctx))}), nil
		})
}

// ---------------------------------------------------------------------------
// magic links (magic.controller.ts)
// ---------------------------------------------------------------------------

const genericMagicAck = "If that email is valid, we just sent a sign-in link."

type cooldownBody struct {
	StatusCode        int    `json:"statusCode"`
	Message           string `json:"message"`
	Error             string `json:"error"`
	RetryAfterSeconds int    `json:"retryAfterSeconds"`
}

func (s *Service) registerMagic(a huma.API) {
	type magicAck struct {
		Message string `json:"message"`
	}
	huma.Register(a, *api.Public(&huma.Operation{
		OperationID: "MagicController_request", Method: http.MethodPost, Path: api.Prefix + "/auth/magic-link",
		Summary: "Request a passwordless sign-in link (public, no auth)", Tags: []string{"auth"},
	}), func(ctx context.Context, in *rawBody) (*api.Out[api.Data[magicAck]], error) {
		b, err := body(in.RawBody, "MagicLinkRequestDto")
		if err != nil {
			return nil, err
		}
		res, err := s.RequestMagicLink(ctx, b.String("email"), strPtr(httpx.ClientIP(api.Request(ctx))))
		if err != nil {
			return nil, err
		}
		if res.Reason == "cooldown" {
			wait := res.RetryAfterSeconds
			if wait == 0 {
				wait = 60
			}
			return nil, &httpx.Error{Status: http.StatusTooManyRequests, Body: cooldownBody{
				http.StatusTooManyRequests, fmt.Sprintf("Please wait %ds before requesting another link.", wait), "Too Many Requests", wait,
			}}
		}
		return api.JSON(api.Data[magicAck]{Data: magicAck{genericMagicAck}}), nil
	})

	huma.Register(a, *api.Public(&huma.Operation{
		OperationID: "MagicController_verify", Method: http.MethodPost, Path: api.Prefix + "/auth/magic/verify",
		Summary: "Verify a magic-link token → session JWT (public, no auth)", Tags: []string{"auth"},
	}), func(ctx context.Context, in *rawBody) (*api.Out[api.Data[loginToken]], error) {
		b, err := body(in.RawBody, "MagicVerifyDto")
		if err != nil {
			return nil, err
		}
		token, err := s.VerifyMagicLink(ctx, b.String("token"), b.String("code"), SessionContextFrom(api.Request(ctx)))
		if err != nil {
			return nil, err
		}
		return api.JSON(api.Data[loginToken]{Data: loginToken{token}}), nil
	})
}

// ---------------------------------------------------------------------------
// /auth/sessions (session.controller.ts) — humans only
// ---------------------------------------------------------------------------

func requireHuman(ctx context.Context, msg string) (*auth.Principal, error) {
	p := auth.From(ctx)
	if p == nil || p.Via == auth.ViaAPIToken {
		return nil, httpx.Forbidden(msg)
	}
	return p, nil
}

const noSessions = "API tokens have no sessions"

func (s *Service) registerSessions(a huma.API) {
	huma.Register(a, *operation("SessionController_list", http.MethodGet, "/auth/sessions",
		"List my active sessions (ip, dates, current flag).", "auth"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[[]SessionSummary]], error) {
			p, err := requireHuman(ctx, noSessions)
			if err != nil {
				return nil, err
			}
			list, err := s.Sessions.ListForUser(ctx, p.UserID, p.SessionID)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	type sessionRevoked struct {
		Revoked bool `json:"revoked"`
		Current bool `json:"current"`
	}
	type idInput struct {
		ID string `path:"id"`
	}
	huma.Register(a, *operation("SessionController_revoke", http.MethodDelete, "/auth/sessions/{id}",
		"Revoke one of my sessions (revoking the current one signs me out).", "auth"),
		func(ctx context.Context, in *idInput) (*api.Out[api.Envelope[sessionRevoked]], error) {
			p, err := requireHuman(ctx, noSessions)
			if err != nil {
				return nil, err
			}
			ok, err := s.Sessions.Revoke(ctx, p.UserID, in.ID)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, httpx.NotFound("session not found")
			}
			return api.OK(sessionRevoked{true, p.SessionID != "" && in.ID == p.SessionID}), nil
		})

	type sessionsRevoked struct {
		Revoked int64 `json:"revoked"`
	}
	huma.Register(a, *operation("SessionController_revokeOthers", http.MethodDelete, "/auth/sessions",
		"Sign out every OTHER session, keeping this one.", "auth"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[sessionsRevoked]], error) {
			p, err := requireHuman(ctx, noSessions)
			if err != nil {
				return nil, err
			}
			n, err := s.Sessions.RevokeOthers(ctx, p.UserID, p.SessionID)
			if err != nil {
				return nil, err
			}
			return api.OK(sessionsRevoked{n}), nil
		})
}

// ---------------------------------------------------------------------------
// /account (account.controller.ts) — humans only
// ---------------------------------------------------------------------------

const noAccount = "API tokens have no account"

func (s *Service) registerAccount(a huma.API) {
	huma.Register(a, *operation("AccountController_me", http.MethodGet, "/account",
		"My account: profile + tenant + security flags.", "account"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[*AccountInfo]], error) {
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			info, err := s.GetAccount(ctx, p)
			if err != nil {
				return nil, err
			}
			return api.OK(info), nil
		})

	huma.Register(a, *operation("AccountController_update", http.MethodPatch, "/account",
		"Update my profile (name and/or email).", "account"),
		func(ctx context.Context, in *rawBody) (*api.Out[api.Envelope[*AccountInfo]], error) {
			b, err := body(in.RawBody, "UpdateAccountDto")
			if err != nil {
				return nil, err
			}
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			info, err := s.UpdateAccount(ctx, p, b.StringPtr("name"), b.StringPtr("email"))
			if err != nil {
				return nil, err
			}
			return api.OK(info), nil
		})

	type passwordChanged struct {
		OK bool `json:"ok"`
	}
	huma.Register(a, *operation("AccountController_changePassword", http.MethodPost, "/account/password",
		"Change my password (requires the current password).", "account"),
		func(ctx context.Context, in *rawBody) (*api.Out[api.Envelope[passwordChanged]], error) {
			b, err := body(in.RawBody, "ChangePasswordDto")
			if err != nil {
				return nil, err
			}
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			if err := s.ChangePassword(ctx, p, b.String("currentPassword"), b.String("newPassword")); err != nil {
				return nil, err
			}
			return api.OK(passwordChanged{true}), nil
		})

	huma.Register(a, *operation("AccountController_setup2fa", http.MethodPost, "/account/2fa/setup",
		"Start 2FA enrolment: returns secret + otpauth URI + QR data URI.", "account"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[*TwoFaSetup]], error) {
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			setup, err := s.SetupTwoFa(ctx, p)
			if err != nil {
				return nil, err
			}
			return api.OK(setup), nil
		})

	type twoFaState struct {
		Enabled bool `json:"enabled"`
	}
	twoFa := func(id, path, summary string, on bool, fn func(context.Context, *auth.Principal, string) error) {
		huma.Register(a, *operation(id, http.MethodPost, path, summary, "account"),
			func(ctx context.Context, in *rawBody) (*api.Out[api.Envelope[twoFaState]], error) {
				b, err := body(in.RawBody, "TwoFaCodeDto")
				if err != nil {
					return nil, err
				}
				p, err := requireHuman(ctx, noAccount)
				if err != nil {
					return nil, err
				}
				if err := fn(ctx, p, b.String("code")); err != nil {
					return nil, err
				}
				return api.OK(twoFaState{on}), nil
			})
	}
	twoFa("AccountController_enable2fa", "/account/2fa/enable", "Activate 2FA by verifying a code against the pending secret.", true, s.EnableTwoFa)
	twoFa("AccountController_disable2fa", "/account/2fa/disable", "Disable 2FA (requires a live valid code).", false, s.DisableTwoFa)

	huma.Register(a, *operation("AccountController_getSmtp", http.MethodGet, "/account/smtp",
		"My SMTP override (password masked).", "account"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[*MaskedSmtp]], error) {
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			m, err := s.GetSmtp(ctx, p)
			if err != nil {
				return nil, err
			}
			return api.OK(m), nil
		})

	huma.Register(a, *operation("AccountController_setSmtp", http.MethodPut, "/account/smtp",
		"Update my SMTP override. Omit pass to keep the stored one.", "account"),
		func(ctx context.Context, in *rawBody) (*api.Out[api.Envelope[*MaskedSmtp]], error) {
			b, err := body(in.RawBody, "SetAccountSmtpDto")
			if err != nil {
				return nil, err
			}
			in2 := smtpInput(b)
			if err != nil {
				return nil, err
			}
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			m, err := s.SetSmtp(ctx, p, in2)
			if err != nil {
				return nil, err
			}
			return api.OK(m), nil
		})

	huma.Register(a, *operation("AccountController_testSmtp", http.MethodPost, "/account/smtp/test",
		"Send a probe email using MY configured SMTP.", "account"),
		func(ctx context.Context, in *rawBody) (*api.Out[api.Envelope[SendResult]], error) {
			b, err := body(in.RawBody, "TestSmtpDto")
			if err != nil {
				return nil, err
			}
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			res, err := s.TestSmtp(ctx, p, b.String("to"))
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})
}

// smtpInput reads a validated SetAccountSmtpDto body.
func smtpInput(b *validate.Body) SmtpInput {
	return SmtpInput{
		Enabled: b.Bool("enabled"), Host: b.StringPtr("host"), Port: b.Int("port"),
		User: b.StringPtr("user"), Pass: b.StringPtr("pass"), From: b.StringPtr("from"),
	}
}

// ---------------------------------------------------------------------------
// /teams (teams.controller.ts) — the caller's own tenant only
// ---------------------------------------------------------------------------

func requireTenant(ctx context.Context) (*auth.Principal, error) {
	p := auth.From(ctx)
	if p == nil || p.TenantID == "" {
		return nil, httpx.BadRequest("no team in context (unscoped credential)")
	}
	return p, nil
}

// MyTeam is GET /teams/mine.
type MyTeam struct {
	Team    *tenancy.Tenant      `json:"team"`
	Members []tenancy.TeamMember `json:"members"`
	Usage   quotas.UsageReport   `json:"usage"`
}

func parseInvite(raw []byte) (email string, role tenancy.MembershipRole, err error) {
	b, err := body(raw, "InviteMemberDto")
	if err != nil {
		return "", "", err
	}
	role = tenancy.RoleViewer
	if r := b.String("role"); r != "" {
		role = tenancy.MembershipRole(r)
	}
	return b.String("email"), role, nil
}

func (s *Service) registerTeams(a huma.API) {
	huma.Register(a, *authz.Require(operation("TeamsController_mine", http.MethodGet, "/teams/mine",
		"My team: tenant, members and quota usage.", "teams"), "usage", "read"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[MyTeam]], error) {
			p, err := requireTenant(ctx)
			if err != nil {
				return nil, err
			}
			members, err := s.tenancy.ListMembers(ctx, p.TenantID)
			if err != nil {
				return nil, err
			}
			return api.OK(MyTeam{s.tenancy.GetTenant(ctx, p.TenantID), members, s.quotas.GetUsage(ctx, p.TenantID)}), nil
		})

	huma.Register(a, *withStatus(authz.Require(operation("TeamsController_invite", http.MethodPost, "/teams/mine/members",
		"Invite/attach a member to my team (owner or superadmin only).", "teams"), "tenant", "write"), http.StatusCreated),
		func(ctx context.Context, in *rawBody) (*api.Out[api.Envelope[*tenancy.TeamMember]], error) {
			rawEmail, role, err := parseInvite(in.RawBody)
			if err != nil {
				return nil, err
			}
			p, err := requireTenant(ctx)
			if err != nil {
				return nil, err
			}
			if !p.IsSuperadmin && p.Role != auth.RoleOwner {
				return nil, httpx.Forbidden("only a team owner can invite members")
			}
			email := strings.ToLower(strings.TrimSpace(rawEmail))
			if email == "" {
				return nil, httpx.BadRequest("email is required")
			}
			var userID string
			if existing := s.tenancy.GetUserByEmail(ctx, email); existing != nil {
				userID = existing.ID
			} else if userID, err = s.tenancy.CreateUser(ctx, tenancy.CreateUserInput{Email: email, Status: "pending"}); err != nil {
				return nil, err
			}
			if err := s.tenancy.AddMembership(ctx, userID, p.TenantID, role); err != nil {
				return nil, err
			}
			member, err := s.tenancy.FindMember(ctx, p.TenantID, userID)
			if err != nil {
				return nil, err
			}
			if member == nil {
				return nil, httpx.NotFound("member not found after invite")
			}
			return api.OK(member), nil
		})
}

// ---------------------------------------------------------------------------
// /tenant/invites (tenant-invites.controller.ts) — owner/superadmin only
// ---------------------------------------------------------------------------

// PendingInvite is a pending user + membership in the caller's tenant.
type PendingInvite struct {
	UserID    string                 `json:"userId"`
	Email     *string                `json:"email"`
	Role      tenancy.MembershipRole `json:"role"`
	InvitedAt string                 `json:"invitedAt"`
}

// InviteResult is POST /tenant/invites.
type InviteResult struct {
	PendingInvite
	EmailSent bool `json:"emailSent"`
}

func requireOwner(ctx context.Context) (*auth.Principal, error) {
	p, err := requireTenant(ctx)
	if err != nil {
		return nil, err
	}
	if !p.IsSuperadmin && p.Role != auth.RoleOwner {
		return nil, httpx.Forbidden("only a team owner can manage invitations")
	}
	return p, nil
}

func (s *Service) registerInvites(a huma.API) {
	huma.Register(a, *authz.Require(operation("TenantInvitesController_list", http.MethodGet, "/tenant/invites",
		"Pending invitations of my tenant (owner/superadmin only).", "teams"), "tenant", "read"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[[]PendingInvite]], error) {
			p, err := requireOwner(ctx)
			if err != nil {
				return nil, err
			}
			members, err := s.tenancy.ListMembers(ctx, p.TenantID)
			if err != nil {
				return nil, err
			}
			out := []PendingInvite{}
			for _, m := range members {
				if m.Status == "pending" {
					out = append(out, PendingInvite{m.UserID, m.Email, m.Role, m.CreatedAt})
				}
			}
			return api.OK(out), nil
		})

	huma.Register(a, *withStatus(authz.Require(operation("TenantInvitesController_invite", http.MethodPost, "/tenant/invites",
		"Invite a user by email to my tenant (owner/superadmin only).", "teams"), "tenant", "write"), http.StatusCreated),
		func(ctx context.Context, in *rawBody) (*api.Out[api.Envelope[InviteResult]], error) {
			rawEmail, role, err := parseInvite(in.RawBody)
			if err != nil {
				return nil, err
			}
			p, err := requireOwner(ctx)
			if err != nil {
				return nil, err
			}
			email := strings.ToLower(strings.TrimSpace(rawEmail))
			if email == "" {
				return nil, httpx.BadRequest("email is required")
			}
			if s.cfg.AdminUser != "" && email == strings.ToLower(strings.TrimSpace(s.cfg.AdminUser)) {
				return nil, httpx.BadRequest("cannot invite the break-glass admin")
			}
			existing := s.tenancy.GetUserByEmail(ctx, email)
			if existing != nil && s.tenancy.RoleInTenant(ctx, existing.ID, p.TenantID) != "" {
				return nil, httpx.BadRequest("that email is already a member")
			}
			var userID string
			if existing != nil {
				userID = existing.ID
			} else if userID, err = s.tenancy.CreateUser(ctx, tenancy.CreateUserInput{Email: email, Status: "pending"}); err != nil {
				return nil, err
			}
			if err := s.tenancy.AddMembership(ctx, userID, p.TenantID, role); err != nil {
				return nil, err
			}
			url, err := s.IssueInviteLink(ctx, email)
			if err != nil {
				return nil, err
			}
			opts := InviteOptions{Role: string(role)}
			if t := s.tenancy.GetTenant(ctx, p.TenantID); t != nil {
				opts.TeamName = t.Name
			}
			if p.Email != nil {
				opts.InvitedBy = *p.Email
			}
			sent := s.mailer.SendInvite(ctx, email, url, opts, SendContext{UserID: p.UserID})
			member, err := s.tenancy.FindMember(ctx, p.TenantID, userID)
			if err != nil {
				return nil, err
			}
			if member == nil {
				return nil, httpx.NotFound("member not found after invite")
			}
			return api.OK(InviteResult{PendingInvite{member.UserID, member.Email, member.Role, member.CreatedAt}, sent.OK}), nil
		})

	type userInput struct {
		UserID string `path:"userId"`
	}
	huma.Register(a, *withStatus(authz.Require(operation("TenantInvitesController_revoke", http.MethodDelete, "/tenant/invites/{userId}",
		"Revoke a pending invitation (owner/superadmin only).", "teams"), "tenant", "write"), http.StatusNoContent),
		func(ctx context.Context, in *userInput) (*struct{}, error) {
			p, err := requireOwner(ctx)
			if err != nil {
				return nil, err
			}
			member, err := s.tenancy.FindMember(ctx, p.TenantID, in.UserID)
			if err != nil {
				return nil, err
			}
			if member == nil {
				return nil, httpx.NotFound("no such invitation in your tenant")
			}
			if member.Status != "pending" {
				return nil, httpx.BadRequest("that user already accepted — not a pending invitation")
			}
			if _, err := s.tenancy.RemoveMembership(ctx, in.UserID, p.TenantID); err != nil {
				return nil, err
			}
			if member.Email != nil && *member.Email != "" {
				if err := s.RevokeInviteLinks(ctx, *member.Email); err != nil {
					return nil, err
				}
			}
			if u := s.tenancy.GetUser(ctx, in.UserID); u != nil && u.Status == "pending" && !hasPassword(u) &&
				s.tenancy.MembershipCount(ctx, in.UserID) == 0 {
				if err := s.tenancy.DeleteUser(ctx, in.UserID); err != nil {
					return nil, err
				}
			}
			return nil, nil
		})
}
