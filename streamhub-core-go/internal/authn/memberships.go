package authn

import (
	"context"
	"fmt"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/audit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/tenancy"
)

// Memberships by consent (security 3.3.4, M2). An owner used to attach any
// existing account to their team on their own, and the account's tenant
// (PrimaryMembership, owner role first) could flip to the inviter's without
// the user noticing — uploads and streams then landed in a tenant the
// inviter controls. Now:
//   - inviting an account that already exists records a PENDING membership:
//     no role until the user accepts it from "Mi cuenta" (or declines it);
//   - a brand-new invitee (or a pending invitation shell nobody has claimed
//     yet) still joins right away — following its invite link is the consent;
//   - the tenant a session works in is explicit: the user picks one of their
//     active memberships and it is pinned on the session row
//     (sessions.tenant_id); without a pick it is the primary membership,
//     which an accepted invitation never displaces.

// AccountTenantChoice is one tenant the caller may work in.
type AccountTenantChoice struct {
	tenancy.UserTenant
	Current bool `json:"current"`
}

// addInvitee resolves (or creates, pending) the invited account and records
// its membership in the caller's tenant. existing reports a live account,
// whose membership stays pending until it accepts.
func (s *Service) addInvitee(ctx context.Context, p *auth.Principal, email string, role tenancy.MembershipRole) (userID string, existing bool, err error) {
	status := tenancy.MembershipActive
	if u := s.tenancy.GetUserByEmail(ctx, email); u != nil {
		userID = u.ID
		if u.Status != "pending" {
			status, existing = tenancy.MembershipPending, true
		}
	} else if userID, err = s.tenancy.CreateUser(ctx, tenancy.CreateUserInput{Email: email, Status: "pending"}); err != nil {
		return "", false, err
	}
	return userID, existing, s.tenancy.InviteMembership(ctx, userID, p.TenantID, role, p.UserID, status)
}

// Invitations are the caller's pending memberships.
func (s *Service) Invitations(ctx context.Context, p *auth.Principal) ([]tenancy.UserTenant, error) {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.tenancy.UserTenants(ctx, u.ID, tenancy.MembershipPending)
}

// AcceptInvitation activates the caller's pending membership in tenantID.
// The session's tenant doesn't move: switching to it is an explicit step.
func (s *Service) AcceptInvitation(ctx context.Context, p *auth.Principal, tenantID string) error {
	return s.answerInvitation(ctx, p, tenantID, "accepted", s.tenancy.AcceptMembership)
}

// DeclineInvitation drops the caller's pending membership in tenantID.
func (s *Service) DeclineInvitation(ctx context.Context, p *auth.Principal, tenantID string) error {
	return s.answerInvitation(ctx, p, tenantID, "declined", s.tenancy.DeclineMembership)
}

func (s *Service) answerInvitation(ctx context.Context, p *auth.Principal, tenantID, verb string,
	fn func(context.Context, string, string) (bool, error)) error {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return err
	}
	ok, err := fn(ctx, u.ID, tenantID)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("no pending invitation for that team")
	}
	s.log.Info(fmt.Sprintf("user %s %s the invitation to %s", u.ID, verb, tenantID))
	return nil
}

// Tenants are the caller's active memberships, flagging the session's one.
func (s *Service) Tenants(ctx context.Context, p *auth.Principal) ([]AccountTenantChoice, error) {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return nil, err
	}
	list, err := s.tenancy.UserTenants(ctx, u.ID, tenancy.MembershipActive)
	if err != nil {
		return nil, err
	}
	out := make([]AccountTenantChoice, 0, len(list))
	for _, t := range list {
		out = append(out, AccountTenantChoice{t, t.TenantID == p.TenantID})
	}
	return out, nil
}

// SwitchTenant pins tenantID — one of the caller's ACTIVE memberships — on
// the current session and returns the account as seen from it.
func (s *Service) SwitchTenant(ctx context.Context, p *auth.Principal, tenantID string) (*AccountInfo, error) {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return nil, err
	}
	if p.IsSuperadmin {
		return nil, httpx.BadRequest("the superadmin is not scoped to a team")
	}
	role := s.tenancy.RoleInTenant(ctx, u.ID, tenantID)
	if role == "" {
		return nil, httpx.NotFound("you are not a member of that team")
	}
	ok, err := s.Sessions.SetTenant(ctx, u.ID, p.SessionID, tenantID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, httpx.Unauthorized("Session revoked or expired")
	}
	next := *p
	next.TenantID, next.Role = tenantID, auth.Role(role)
	return s.GetAccount(ctx, &next)
}

func (s *Service) registerMemberships(a huma.API) {
	type tenantInput struct {
		TenantID string `path:"tenantId"`
	}
	type invitationAnswer struct {
		TenantID string `json:"tenantId"`
		Status   string `json:"status"` // active | declined
	}

	huma.Register(a, *operation("AccountController_tenants", http.MethodGet, "/account/tenants",
		"Teams I am an active member of (current = this session's).", "account"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[[]AccountTenantChoice]], error) {
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			list, err := s.Tenants(ctx, p)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, *operation("AccountController_switchTenant", http.MethodPost, "/account/tenants/{tenantId}/switch",
		"Work in another of my teams: pins it on this session.", "account"),
		func(ctx context.Context, in *tenantInput) (*api.Out[api.Envelope[*AccountInfo]], error) {
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			info, err := s.SwitchTenant(ctx, p, in.TenantID)
			if err != nil {
				return nil, err
			}
			s.audit.RecordCtx(ctx, audit.Event{Action: "session.tenant", TargetType: audit.Str("tenant"), TargetID: audit.Str(in.TenantID)})
			return api.OK(info), nil
		})

	huma.Register(a, *operation("AccountController_invitations", http.MethodGet, "/account/invitations",
		"Team invitations waiting for my answer.", "account"),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[[]tenancy.UserTenant]], error) {
			p, err := requireHuman(ctx, noAccount)
			if err != nil {
				return nil, err
			}
			list, err := s.Invitations(ctx, p)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	answer := func(id, verb, summary, status string, fn func(context.Context, *auth.Principal, string) error) {
		huma.Register(a, *operation(id, http.MethodPost, "/account/invitations/{tenantId}/"+verb, summary, "account"),
			func(ctx context.Context, in *tenantInput) (*api.Out[api.Envelope[invitationAnswer]], error) {
				p, err := requireHuman(ctx, noAccount)
				if err != nil {
					return nil, err
				}
				if err := fn(ctx, p, in.TenantID); err != nil {
					return nil, err
				}
				s.audit.RecordCtx(ctx, audit.Event{Action: "membership." + verb, TargetType: audit.Str("tenant"), TargetID: audit.Str(in.TenantID)})
				return api.OK(invitationAnswer{in.TenantID, status}), nil
			})
	}
	answer("AccountController_acceptInvitation", "accept", "Accept a team invitation (my current team does not change).", "active", s.AcceptInvitation)
	answer("AccountController_declineInvitation", "decline", "Decline a team invitation.", "declined", s.DeclineInvitation)
}
