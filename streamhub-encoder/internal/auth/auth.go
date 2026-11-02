// Package auth is encoderd's authentication and authorization layer: local
// user accounts (bcrypt) with roles admin > operator > viewer, API tokens
// (ek_…, stored as SHA-256), a legacy static admin token, cookie sessions for
// the web UI (with a CSRF header requirement), login rate limiting, a
// route-based authorization policy, an append-only rotated audit log and TLS
// helpers (self-signed or operator-provided certificates).
//
// Wiring: build one *Auth with New, call Register on the same ServeMux that
// carries the REST API, and wrap that mux with Middleware.
//
// Web UI contract (cookie sessions):
//
//   - POST /api/v1/auth/login with Content-Type: application/json and body
//     {"user":"…","password":"…"} sets the HttpOnly cookie enc_session.
//   - Every non-GET request authenticated by that cookie MUST carry the header
//     "X-Requested-With: encoder-ui" (CSRF protection: a cross-site page can
//     not add custom headers without a CORS preflight, which encoderd never
//     grants). Requests authenticated with "Authorization: Bearer …" are
//     exempt.
//   - A user flagged mustChangePassword can only reach /api/v1/auth/* until
//     POST /api/v1/auth/password succeeds.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Role is an authorization level. Roles are ordered: admin > operator > viewer.
type Role string

// The three roles.
const (
	RoleViewer   Role = "viewer"
	RoleOperator Role = "operator"
	RoleAdmin    Role = "admin"
)

func (r Role) rank() int {
	switch r {
	case RoleViewer:
		return 1
	case RoleOperator:
		return 2
	case RoleAdmin:
		return 3
	}
	return 0
}

// Valid reports whether r is one of the three known roles.
func (r Role) Valid() bool { return r.rank() > 0 }

// AtLeast reports whether r grants at least the rights of min.
func (r Role) AtLeast(min Role) bool { return r.Valid() && r.rank() >= min.rank() }

// Kind says how a principal authenticated.
type Kind string

// Principal kinds.
const (
	KindUser   Kind = "user"   // web UI session (cookie) of a local account
	KindToken  Kind = "token"  // API token (ek_…) from users.json
	KindLegacy Kind = "legacy" // the static ENCODERD_API_TOKEN / api-token value
)

// Principal is the authenticated caller of a request.
type Principal struct {
	Name    string `json:"name"`
	Role    Role   `json:"role"`
	Kind    Kind   `json:"kind"`
	TokenID string `json:"tokenId,omitempty"`
	// MustChangePassword is only ever true for Kind == KindUser.
	MustChangePassword bool `json:"mustChangePassword"`
}

type principalKey struct{}

// PrincipalFrom returns the principal Middleware attached to the request
// context (absent on public routes called anonymously).
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

// WithPrincipal returns ctx carrying p (for tests and internal callers).
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// Defaults.
const (
	DefaultBcryptCost  = 12
	DefaultSessionIdle = 12 * time.Hour
	DefaultSessionMax  = 7 * 24 * time.Hour
	MinPasswordLen     = 10
	maxPasswordBytes   = 72 // bcrypt limit
	bootstrapUser      = "admin"
	// UIHeaderValue is the value of X-Requested-With the web UI must send on
	// cookie-authenticated mutating requests.
	UIHeaderValue = "encoder-ui"
	// SessionCookie is the name of the web UI session cookie.
	SessionCookie = "enc_session"
)

// Options configures New.
type Options struct {
	// DataDir holds users.json, audit.log and initial-admin-password.
	DataDir string
	// LegacyToken, when non-empty, is accepted as a bearer token with the admin
	// role (Kind "legacy") — keeps ENCODERD_API_TOKEN / api-token working.
	LegacyToken string
	// MetricsPublic leaves GET /metrics unauthenticated (else viewer+).
	MetricsPublic bool
	// TrustedProxies lists IPs or CIDRs of reverse proxies whose
	// X-Forwarded-For / X-Forwarded-Proto headers are honored.
	TrustedProxies []string
	// ExtraOperatorRoutes extends DefaultOperatorRoutes ("METHOD /path/*/x",
	// '*' matches exactly one path segment).
	ExtraOperatorRoutes []string
	// ExtraAdminReadPrefixes extends DefaultAdminReadPrefixes (GETs that need
	// admin because they expose secrets or security data).
	ExtraAdminReadPrefixes []string
	// SessionIdle / SessionMax override the 12 h idle / 7 d absolute limits.
	SessionIdle, SessionMax time.Duration
	// BcryptCost overrides DefaultBcryptCost (tests use bcrypt.MinCost).
	BcryptCost int
	// Logger receives internal errors (audit/persistence failures).
	Logger *slog.Logger
	// Now overrides the clock (tests).
	Now func() time.Time
}

// Auth is the authentication/authorization service. Safe for concurrent use.
type Auth struct {
	opts      Options
	cost      int
	now       func() time.Time
	log       *slog.Logger
	store     *store
	sessions  *sessionStore
	limiter   *limiter
	audit     *auditLog
	policy    *policy
	trusted   []netip.Prefix
	legacy    [32]byte // sha256 of the legacy token
	hasLegacy bool
	metrics   atomic.Bool

	dummyOnce sync.Once
	dummyHash []byte
}

// New opens (or bootstraps) the user store under opts.DataDir. When no user
// exists yet it creates "admin" with a random password, flags it
// mustChangePassword, writes the password to <DataDir>/initial-admin-password
// (0600) and returns it as initialPassword so the caller can log it; on every
// later start initialPassword is "".
func New(opts Options) (a *Auth, initialPassword string, err error) {
	if opts.DataDir == "" {
		return nil, "", errors.New("auth: DataDir is required")
	}
	if err := os.MkdirAll(opts.DataDir, 0o750); err != nil {
		return nil, "", err
	}
	a = &Auth{opts: opts, cost: opts.BcryptCost, now: opts.Now, log: opts.Logger}
	if a.cost == 0 {
		a.cost = DefaultBcryptCost
	}
	if a.cost < bcrypt.MinCost || a.cost > bcrypt.MaxCost {
		return nil, "", fmt.Errorf("auth: invalid bcrypt cost %d", a.cost)
	}
	if a.now == nil {
		a.now = time.Now
	}
	if a.log == nil {
		a.log = slog.Default()
	}
	idle, max := opts.SessionIdle, opts.SessionMax
	if idle <= 0 {
		idle = DefaultSessionIdle
	}
	if max <= 0 {
		max = DefaultSessionMax
	}
	for _, s := range opts.TrustedProxies {
		p, err := parsePrefix(s)
		if err != nil {
			return nil, "", fmt.Errorf("auth: trusted proxy %q: %w", s, err)
		}
		a.trusted = append(a.trusted, p)
	}
	if a.policy, err = newPolicy(opts.ExtraOperatorRoutes, opts.ExtraAdminReadPrefixes); err != nil {
		return nil, "", err
	}
	if t := strings.TrimSpace(opts.LegacyToken); t != "" {
		a.legacy, a.hasLegacy = sha256.Sum256([]byte(t)), true
	}
	a.metrics.Store(opts.MetricsPublic)
	a.sessions = newSessionStore(idle, max, a.now)
	a.limiter = newLimiter(a.now)
	if a.store, err = openStore(filepath.Join(opts.DataDir, "users.json")); err != nil {
		return nil, "", err
	}
	if a.audit, err = openAudit(filepath.Join(opts.DataDir, "audit.log"), auditMaxBytes, auditBackups); err != nil {
		return nil, "", err
	}
	if initialPassword, err = a.bootstrap(); err != nil {
		_ = a.audit.Close()
		return nil, "", err
	}
	return a, initialPassword, nil
}

// bootstrap creates the first admin when the store has no user.
func (a *Auth) bootstrap() (string, error) {
	if a.store.userCount() > 0 {
		return "", nil
	}
	pw := randomString(18)
	hash, err := bcrypt.GenerateFromPassword([]byte(pw), a.cost)
	if err != nil {
		return "", err
	}
	// Password file first: if users.json then fails, the next start simply
	// bootstraps again and rewrites both.
	if err := writeFileAtomic(a.initialPasswordPath(), []byte(pw+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("auth: write initial admin password: %w", err)
	}
	err = a.store.update(func(d *fileData) error {
		d.Users = append(d.Users, User{Name: bootstrapUser, Role: RoleAdmin, PasswordHash: string(hash),
			MustChangePassword: true, CreatedAt: a.now().UTC()})
		return nil
	})
	if err != nil {
		return "", err
	}
	return pw, nil
}

func (a *Auth) initialPasswordPath() string {
	return filepath.Join(a.opts.DataDir, "initial-admin-password")
}

// SetMetricsPublic toggles unauthenticated access to GET /metrics at runtime.
func (a *Auth) SetMetricsPublic(public bool) { a.metrics.Store(public) }

// Close flushes and closes the audit log and persists pending token usage.
func (a *Auth) Close() error {
	err1 := a.store.flush()
	err2 := a.audit.Close()
	return errors.Join(err1, err2)
}

// verifyPassword compares pw with hash in constant time; with an empty hash
// (unknown user) it still burns one bcrypt comparison so response timing does
// not reveal which user names exist.
func (a *Auth) verifyPassword(hash, pw string) bool {
	if hash == "" {
		a.dummyOnce.Do(func() {
			a.dummyHash, _ = bcrypt.GenerateFromPassword([]byte(randomString(16)), a.cost)
		})
		_ = bcrypt.CompareHashAndPassword(a.dummyHash, []byte(pw))
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

func (a *Auth) hashPassword(pw string) (string, error) {
	if err := checkPassword(pw); err != nil {
		return "", err
	}
	h, err := bcrypt.GenerateFromPassword([]byte(pw), a.cost)
	return string(h), err
}

func checkPassword(pw string) error {
	if len([]rune(pw)) < MinPasswordLen {
		return invalidErr(fmt.Sprintf("password must be at least %d characters", MinPasswordLen))
	}
	if len(pw) > maxPasswordBytes {
		return invalidErr(fmt.Sprintf("password must be at most %d bytes", maxPasswordBytes))
	}
	return nil
}

// legacyMatches compares tok with the legacy token in constant time.
func (a *Auth) legacyMatches(tok string) bool {
	if !a.hasLegacy {
		return false
	}
	h := sha256.Sum256([]byte(tok))
	return subtle.ConstantTimeCompare(h[:], a.legacy[:]) == 1
}

// randomBytes returns n bytes from crypto/rand (which never fails on Go ≥1.24).
func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// randomString returns base64url(n random bytes) without padding.
func randomString(n int) string { return base64.RawURLEncoding.EncodeToString(randomBytes(n)) }

func parsePrefix(s string) (netip.Prefix, error) {
	s = strings.TrimSpace(s)
	if strings.Contains(s, "/") {
		p, err := netip.ParsePrefix(s)
		return p.Masked(), err
	}
	ip, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, err
	}
	ip = ip.Unmap()
	return netip.PrefixFrom(ip, ip.BitLen()), nil
}
