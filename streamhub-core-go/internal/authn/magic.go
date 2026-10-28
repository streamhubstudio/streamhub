package authn

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

// Passwordless magic links (magic-link.service.ts): a one-time token (32
// random bytes, base64url) emailed as <APP_URL>/auth/magic?token=…, stored
// only as its sha256 with a 15-min TTL (72h for owner-issued invites).
// Requests always answer generically (no enumeration) and are rate-limited
// per email and per IP; verify claims the token atomically and mints the
// same session JWT as password login.

const (
	magicTTL          = 15 * time.Minute
	inviteTTL         = 72 * time.Hour
	rateWindow        = 15 * time.Minute
	maxPerEmail       = 3
	maxPerIP          = 10
	resendCooldownSec = 60
)

// MagicRequestResult is never surfaced to the client except the cooldown.
type MagicRequestResult struct {
	Dispatched        bool
	Reason            string // rate_limited | cooldown | invalid_email | send_failed | not_configured
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
		has, err := db.HasColumn(ctx, s.db, "magic_tokens", "kind")
		if err != nil || has {
			return err
		}
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE magic_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'login'`); err != nil {
			return err
		}
		s.log.Info("migrated magic_tokens: added kind")
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
         VALUES (?, ?, ?, ?, ?, 'login')`, auth.HashToken(token), email, ip, jsx.ISO(now), jsx.ISO(now.Add(magicTTL))); err != nil {
		return MagicRequestResult{}, err
	}
	var sc SendContext
	if holder := s.tenancy.GetUserByEmail(ctx, email); holder != nil {
		sc.UserID = holder.ID
	}
	res := s.mailer.SendMagicLink(ctx, email, s.buildMagicURL(token), sc)
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
         VALUES (?, ?, NULL, ?, ?, 'invite')`, auth.HashToken(token), email, jsx.ISO(now), jsx.ISO(now.Add(inviteTTL))); err != nil {
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
	token := strings.TrimSpace(rawToken)
	if token == "" {
		return "", s.verifyFailed(sc)
	}
	var (
		id               int64
		email, expiresAt string
		used             int
	)
	err = s.db.QueryRowContext(ctx, `SELECT id, email, expires_at, used FROM magic_tokens WHERE token_hash = ? LIMIT 1`,
		auth.HashToken(token)).Scan(&id, &email, &expiresAt, &used)
	if err != nil || used != 0 {
		return "", s.verifyFailed(sc)
	}
	if exp, ok := jsx.ParseDate(expiresAt); !ok || !s.now().Before(exp) {
		return "", s.verifyFailed(sc)
	}
	if holder := s.tenancy.GetUserByEmail(ctx, email); holder != nil {
		if err := s.AssertLoginCode(ctx, holder.ID, code); err != nil {
			return "", err
		}
	}
	res, err := s.db.ExecContext(ctx, `UPDATE magic_tokens SET used = 1, used_at = datetime('now')
          WHERE id = ? AND used = 0`, id)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", s.verifyFailed(sc)
	}
	userID, err := s.resolveOrCreateUser(ctx, email)
	if err != nil {
		return "", err
	}
	return s.issueSessionToken(ctx, userID, &email, secret, sc)
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

// resolveOrCreateUser: the superadmin email → the mirrored `admin`
// principal; an existing user (pending promoted to active); a brand-new email
// → user with a random unknown password + an owner team.
func (s *Service) resolveOrCreateUser(ctx context.Context, email string) (string, error) {
	norm := strings.ToLower(strings.TrimSpace(email))
	if norm == s.superadminEmail() {
		if err := s.tenancy.EnsureUser(ctx, tenancy.AdminUserID, &norm); err != nil {
			return "", err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE users SET is_superadmin = 1 WHERE id = ?`, tenancy.AdminUserID); err != nil {
			return "", err
		}
		return tenancy.AdminUserID, s.tenancy.AddMembership(ctx, tenancy.AdminUserID, auth.PlatformTenantID, tenancy.RoleOwner)
	}
	if u := s.tenancy.GetUserByEmail(ctx, norm); u != nil {
		if u.Status == "pending" {
			if _, err := s.db.ExecContext(ctx, `UPDATE users SET status = 'active' WHERE id = ?`, u.ID); err != nil {
				return "", err
			}
		}
		if s.tenancy.PrimaryMembership(ctx, u.ID) == nil {
			if err := s.ownTeam(ctx, u.ID, norm); err != nil {
				return "", err
			}
		}
		return u.ID, nil
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
	base := strings.TrimSpace(s.cfg.Env("STREAMHUB_APP_URL"))
	if base == "" {
		base = "https://app.streamhub.studio"
	}
	return strings.TrimRight(base, "/") + "/auth/magic?token=" + jsx.EncodeURIComponent(token)
}

func (s *Service) superadminEmail() string {
	v := strings.TrimSpace(s.cfg.Env("STREAMHUB_SUPERADMIN_EMAIL"))
	if v == "" {
		v = "info@streamhub.studio"
	}
	return strings.ToLower(v)
}
