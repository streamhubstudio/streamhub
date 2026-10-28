// Package auth holds the authentication plane: credential primitives (JWT,
// scrypt), the per-request principal, and (as it is ported) the validator for
// sk_ tokens, login JWTs and the break-glass admin.
package auth

import "context"

// Role is the coarse role of the principal (shared/auth-context.ts AuthRole).
type Role string

const (
	RoleSuperadmin Role = "superadmin"
	RoleOwner      Role = "owner"
	RoleEditor     Role = "editor"
	RoleViewer     Role = "viewer"
	RoleService    Role = "service"
)

// Scope is the breadth of the credential.
type Scope string

const (
	ScopeGlobal Scope = "global"
	ScopeApp    Scope = "app"
	ScopeUser   Scope = "user"
)

// Via is how the principal proved identity.
type Via string

const (
	ViaAPIToken Via = "api_token"
	ViaAdminJWT Via = "admin_jwt"
	ViaUserJWT  Via = "user_jwt"
)

// PlatformTenantID owns the platform's own apps.
const PlatformTenantID = "platform"

// Principal is the resolved caller. It merges the two Node shapes:
// req.authCtx (tenancy-aware, STABLE CONTRACT) and the legacy req.auth
// ({tokenId, scope, appId}) that token-scoped code still reads.
type Principal struct {
	UserID       string // user id, or "token:<id>" for API tokens
	TenantID     string // "" = null
	Role         Role
	IsSuperadmin bool
	Scope        Scope
	Via          Via
	Email        *string // nil = absent (JSON omits it, as Node's undefined)

	// Legacy req.auth fields (API tokens only; 0 / nil otherwise).
	TokenID int64
	AppID   *int64
	// SessionID is set for JWT sessions (session.service).
	SessionID string
}

// LegacyScope is the req.auth.scope Node token-scoped code reads: user JWTs
// carried 'app' there (no global powers), everything else its own scope.
func (p *Principal) LegacyScope() Scope {
	if p.Scope == ScopeUser {
		return ScopeApp
	}
	return p.Scope
}

type ctxKey struct{}

// WithPrincipal attaches p to ctx.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// From returns the principal (nil on public routes).
func From(ctx context.Context) *Principal {
	p, _ := ctx.Value(ctxKey{}).(*Principal)
	return p
}
