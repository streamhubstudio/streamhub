package authn

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/db"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/tenancy"
)

// Passwordless magic links (magic-link.service.ts): a one-time token (32
// random bytes, base64url) emailed as <APP_URL>/auth/magic?token=…, stored
// only as its sha256 with a 15-min TTL (72h for owner-issued invites).
// Requests always answer generically (no enumeration) and are rate-limited
// per email and per IP; verify claims the token atomically and mints the
// same session JWT as password login.

// magic_tokens.kind: a sign-in link, an owner-issued invite, or the
// confirmation of an email change (email = the NEW address, user_id = who).
const (
	kindLogin       = "login"
	kindInvite      = "invite"
	kindEmailChange = "email_change"
)

const (
	magicTTL          = 15 * time.Minute
	inviteTTL         = 72 * time.Hour
	emailChangeTTL    = 24 * time.Hour
	rateWindow        = 15 * time.Minute
	maxPerEmail       = 3
	maxPerIP          = 10
	resendCooldownSec = 60
)

// MagicRequestResult is never surfaced to the client except the cooldown.
type MagicRequestResult struct {
	Dispatched        bool
	Reason            string // rate_limited | cooldown | invalid_email | signup_disabled | send_failed | not_configured
	RetryAfterSeconds int
}

func (s *Service) initMagic(ctx context.Context) {
	err := func() error {
		if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS magic_tokens (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         token_hash TEXT NOT NULL UNIQUE,
         email TEXT NOT NULL,
         request_ip TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         expires_at TEXT NOT NULL,
         used INTEGER NOT NULL DEFAULT 0,
         used_at TEXT
       );
       CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);
       CREATE INDEX IF NOT EXISTS idx_magic_tokens_created ON magic_tokens(created_at);`); err != nil {
			return err
		}
		for _, c := range []struct{ name, ddl string }{
			{"kind", "kind TEXT NOT NULL DEFAULT 'login'"},
			{"user_id", "user_id TEXT"}, // the requesting account of an email_change
		} {
			has, err := db.HasColumn(ctx, s.db, "magic_tokens", c.name)
			if err != nil {
				return err
			}
			if has {
				continue
			}
			if _, err := s.db.ExecContext(ctx, "ALTER TABLE magic_tokens ADD COLUMN "+c.ddl); err != nil {
				return err
			}
			s.log.Info("migrated magic_tokens: added " + c.name)
		}
		return nil
	}()
	if err != nil {
		s.log.Error("magic_tokens bootstrap failed (continuing)", "err", err)
	}
}

var magicEmailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func validMagicEmail(e string) bool {
	return e != "" && jsx.UTF16Len(e) <= 200 && magicEmailRe.MatchString(e)
}

func maskEmail(e string) string {
	at := strings.IndexByte(e, '@')
	if at <= 0 {
		return "***"
	}
	return e[:min(2, at)] + "***" + e[at:]
}

// RequestMagicLink issues a login link. Every branch folds into the result;
// the controller must not leak `Dispatched`.
func (s *Service) RequestMagicLink(ctx context.Context, rawEmail string, ip *string) (MagicRequestResult, error) {
	email := strings.ToLower(strings.TrimSpace(rawEmail))
	if !validMagicEmail(email) {
		return MagicRequestResult{Reason: "invalid_email"}, nil
	}
	if wait := s.cooldownRemaining(ctx, email); wait > 0 {
		s.log.Warn(fmt.Sprintf("magic-link cooldown for <%s> (%ds left)", maskEmail(email), wait))
		return MagicRequestResult{Reason: "cooldown", RetryAfterSeconds: wait}, nil
	}
	if s.magicRateLimited(ctx, email, ip) {
		ipStr := "?"
		if ip != nil {
			ipStr = *ip
		}
		s.log.Warn(fmt.Sprintf("magic-link rate-limited for <%s> ip=%s", maskEmail(email), ipStr))
		return MagicRequestResult{Reason: "rate_limited"}, nil
	}
	token := auth.RandomToken(32)
	now := s.now()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO magic_tokens (token_hash, email, request_ip, created_at, expires_at, kind)
         VALUES (?, ?, ?, ?, ?, ?)`, auth.HashToken(token), email, ip, jsx.ISO(now), jsx.ISO(now.Add(magicTTL)), kindLogin); err != nil {
		return MagicRequestResult{}, err
	}
	// The row above still arms the cooldown/rate windows: an unknown email
	// with signup off answers exactly like a known one, it just gets no mail.
	if !s.magicMayLogin(ctx, email) {
		s.log.Info(fmt.Sprintf("magic-link for unknown <%s> not sent: public signup is off", maskEmail(email)))
		return MagicRequestResult{Reason: "signup_disabled"}, nil
	}
	res := s.mailer.SendMagicLink(ctx, email, s.buildMagicURL(token))
	if !res.OK {
		if res.Skipped {
			return MagicRequestResult{Reason: "not_configured"}, nil
		}
		return MagicRequestResult{Reason: "send_failed"}, nil
	}
	s.log.Info(fmt.Sprintf("magic-link dispatched to <%s>", maskEmail(email)))
	return MagicRequestResult{Dispatched: true}, nil
}

// IssueInviteLink mints a 72h kind='invite' link (outside the login
// cooldown/rate windows) and returns its URL.
func (s *Service) IssueInviteLink(ctx context.Context, rawEmail string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(rawEmail))
	if !validMagicEmail(email) {
		return "", httpx.BadRequest("invalid email")
	}
	token := auth.RandomToken(32)
	now := s.now()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO magic_tokens (token_hash, email, request_ip, created_at, expires_at, kind)
         VALUES (?, ?, NULL, ?, ?, ?)`, auth.HashToken(token), email, jsx.ISO(now), jsx.ISO(now.Add(inviteTTL)), kindInvite); err != nil {
		return "", err
	}
	return s.buildMagicURL(token), nil
}

// RevokeInviteLinks invalidates every outstanding invite link of an email.
func (s *Service) RevokeInviteLinks(ctx context.Context, rawEmail string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE magic_tokens SET used = 1, used_at = datetime('now')
          WHERE email = ? AND kind = 'invite' AND used = 0`, strings.ToLower(strings.TrimSpace(rawEmail)))
	return err
}

// VerifyMagicLink consumes a token and returns a session JWT. 2FA is
// asserted BEFORE the claim so a missing/wrong code doesn't burn the link.
func (s *Service) VerifyMagicLink(ctx context.Context, rawToken, code string, sc SessionContext) (string, error) {
	secret, err := s.requireMagicSecret(ctx)
	if err != nil {
		return "", err
	}
	if err := s.throttle.Attempt(sc.IP); err != nil {
		return "", err
	}
	token := strings.TrimSpace(rawToken)
	if token == "" {
		return "", s.verifyFailed(sc)
	}
	var (
		id                     int64
		email, expiresAt, kind string
		used                   int
		owner                  sql.NullString
	)
	err = s.db.QueryRowContext(ctx, `SELECT id, email, expires_at, used, kind, user_id FROM magic_tokens WHERE token_hash = ? LIMIT 1`,
		auth.HashToken(token)).Scan(&id, &email, &expiresAt, &used, &kind, &owner)
	if err != nil || used != 0 {
		return "", s.verifyFailed(sc)
	}
	if exp, ok := jsx.ParseDate(expiresAt); !ok || !s.now().Before(exp) {
		return "", s.verifyFailed(sc)
	}
	holder := s.tenancy.GetUserByEmail(ctx, email)
	switch kind {
	case kindEmailChange:
		// The link proves the NEW mailbox; the session is the requester's.
		if holder = nil; owner.Valid {
			holder = s.tenancy.GetUser(ctx, owner.String)
		}
		if holder == nil {
			return "", s.verifyFailed(sc)
		}
		if err := s.emailAvailable(ctx, holder.ID, email); err != nil {
			return "", err
		}
	case kindInvite:
		// Only the PENDING user the invitation created; never a live account.
		if holder == nil {
			return "", s.verifyFailed(sc)
		}
		if holder.Status != "pending" {
			return "", httpx.Nest(http.StatusGone, "invite already used")
		}
	default:
		if !s.magicMayLogin(ctx, email) {
			return "", s.verifyFailed(sc)
		}
	}
	// The link survives a wrong code, so its 2FA code is throttled per
	// account like the password login's (M3).
	if holder != nil && s.TotpEnabled(ctx, holder.ID) {
		key := accountKey(holder.Email, holder.ID)
		if err := s.throttle.Locked(key); err != nil {
			return "", err
		}
		if err := s.AssertLoginCode(ctx, holder.ID, code); err != nil {
			if err.Error() == totpInvalid {
				s.throttle.Fail(key)
			}
			return "", err
		}
		s.throttle.Succeed(key)
	}
	res, err := s.db.ExecContext(ctx, `UPDATE magic_tokens SET used = 1, used_at = datetime('now')
          WHERE id = ? AND used = 0`, id)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", s.verifyFailed(sc)
	}
	switch kind {
	case kindEmailChange:
		if err := s.tenancy.UpdateProfile(ctx, holder.ID, tenancy.ProfilePatch{Email: &email}); err != nil {
			return "", err
		}
		s.log.Info("email change confirmed for user " + holder.ID)
		return s.issueSessionToken(ctx, holder.ID, &email, secret, sc)
	case kindInvite:
		if err := s.activate(ctx, holder, email); err != nil {
			return "", err
		}
		return s.issueSessionToken(ctx, holder.ID, &email, secret, sc)
	}
	userID, err := s.resolveOrCreateUser(ctx, email)
	if err != nil {
		return "", err
	}
	return s.issueSessionToken(ctx, userID, &email, secret, sc)
}

// magicMayLogin: a login link for email may end in a session — an existing
// account, the superadmin promotion, or a new account with public signup on.
func (s *Service) magicMayLogin(ctx context.Context, email string) bool {
	return s.AllowSignup() || s.tenancy.GetUserByEmail(ctx, email) != nil || s.promotesSuperadmin(ctx, email)
}

// activate promotes a pending user to active and gives a team-less one its
// own owner team.
func (s *Service) activate(ctx context.Context, u *tenancy.User, email string) error {
	if u.Status == "pending" {
		if _, err := s.db.ExecContext(ctx, `UPDATE users SET status = 'active' WHERE id = ?`, u.ID); err != nil {
			return err
		}
	}
	if s.tenancy.PrimaryMembership(ctx, u.ID) == nil {
		return s.ownTeam(ctx, u.ID, email)
	}
	return nil
}

func (s *Service) verifyFailed(sc SessionContext) error {
	s.offense(sc.IP, security.OffenseMagicVerifyFailed)
	return httpx.Unauthorized("Invalid or expired link")
}

func (s *Service) requireMagicSecret(ctx context.Context) (string, error) {
	if s.nodeRole.Role(ctx) == "edge" {
		return "", httpx.Forbidden("cluster_edge_login_disabled")
	}
	if s.cfg.JWTSecret == "" {
		s.log.Warn("magic-link verify attempted but STREAMHUB_JWT_SECRET not configured")
		return "", httpx.Unauthorized("Login is not configured")
	}
	return s.cfg.JWTSecret, nil
}

// promotesSuperadmin: norm is the configured superadmin email AND it is not
// somebody else's — the `admin` mirror already holds it, or no other user
// does. A user who got hold of that address signs into their own account.
func (s *Service) promotesSuperadmin(ctx context.Context, norm string) bool {
	sa := s.superadminEmail()
	if sa == "" || norm != sa {
		return false
	}
	if admin := s.tenancy.GetUser(ctx, tenancy.AdminUserID); admin != nil && admin.Email != nil &&
		strings.EqualFold(*admin.Email, sa) {
		return true
	}
	other := s.tenancy.GetUserByEmail(ctx, norm)
	return other == nil || other.ID == tenancy.AdminUserID
}

// resolveOrCreateUser: the superadmin email → the mirrored `admin`
// principal; an existing user (pending promoted to active); a brand-new email
// → user with a random unknown password + an owner team.
func (s *Service) resolveOrCreateUser(ctx context.Context, email string) (string, error) {
	norm := strings.ToLower(strings.TrimSpace(email))
	if s.promotesSuperadmin(ctx, norm) {
		if err := s.tenancy.EnsureUser(ctx, tenancy.AdminUserID, &norm); err != nil {
			return "", err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE users SET is_superadmin = 1 WHERE id = ?`, tenancy.AdminUserID); err != nil {
			return "", err
		}
		return tenancy.AdminUserID, s.tenancy.AddMembership(ctx, tenancy.AdminUserID, auth.PlatformTenantID, tenancy.RoleOwner)
	}
	if u := s.tenancy.GetUserByEmail(ctx, norm); u != nil {
		return u.ID, s.activate(ctx, u, norm)
	}
	hash, err := auth.HashRandomPassword()
	if err != nil {
		return "", err
	}
	id, err := s.tenancy.CreateUser(ctx, tenancy.CreateUserInput{Email: norm, PasswordHash: &hash})
	if err != nil {
		return "", err
	}
	return id, s.ownTeam(ctx, id, norm)
}

func (s *Service) ownTeam(ctx context.Context, userID, name string) error {
	tenantID, err := s.tenancy.CreateTeam(ctx, name, "")
	if err != nil {
		return err
	}
	return s.tenancy.AddMembership(ctx, userID, tenantID, tenancy.RoleOwner)
}

func (s *Service) magicRateLimited(ctx context.Context, email string, ip *string) bool {
	since := jsx.ISO(s.now().Add(-rateWindow))
	if s.countSince(ctx, "email", email, since) >= maxPerEmail {
		return true
	}
	return ip != nil && *ip != "" && s.countSince(ctx, "request_ip", *ip, since) >= maxPerIP
}

func (s *Service) countSince(ctx context.Context, column, value, since string) int {
	var n int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM magic_tokens
          WHERE `+column+` = ? AND created_at >= ? AND kind = 'login'`, value, since).Scan(&n)
	return n
}

func (s *Service) cooldownRemaining(ctx context.Context, email string) int {
	var last sql.NullString
	if err := s.db.QueryRowContext(ctx, `SELECT MAX(created_at) AS last FROM magic_tokens
          WHERE email = ? AND kind = 'login'`, email).Scan(&last); err != nil || !last.Valid || last.String == "" {
		return 0
	}
	t, ok := jsx.ParseDate(last.String)
	if !ok {
		return 0
	}
	remaining := float64(resendCooldownSec) - s.now().Sub(t).Seconds()
	if remaining <= 0 {
		return 0
	}
	return int(math.Ceil(remaining))
}

func (s *Service) buildMagicURL(token string) string {
	return s.appURL() + "/auth/magic?token=" + jsx.EncodeURIComponent(token)
}

// appURL is the dashboard's public base (STREAMHUB_APP_URL), no trailing /.
func (s *Service) appURL() string {
	base := strings.TrimSpace(s.cfg.Env("STREAMHUB_APP_URL"))
	if base == "" {
		base = "https://app.streamhub.studio"
	}
	return strings.TrimRight(base, "/")
}

// superadminEmail is STREAMHUB_SUPERADMIN_EMAIL, lower-cased. No default:
// unset = no email is ever promoted to the superadmin principal.
func (s *Service) superadminEmail() string {
	return strings.ToLower(strings.TrimSpace(s.cfg.Env("STREAMHUB_SUPERADMIN_EMAIL")))
}
