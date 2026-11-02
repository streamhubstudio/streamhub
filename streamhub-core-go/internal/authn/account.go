package authn

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"regexp"
	"strings"

	"github.com/skip2/go-qrcode"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/tenancy"
)

// "Mi cuenta" (account.service.ts): self-service for the signed-in HUMAN
// (api tokens get 403). The break-glass admin's email/password stay
// env-managed (ADMIN_USER/ADMIN_PASS) and can't be changed here.

const minPasswordLen = 8

// AccountInfo is GET /account.
type AccountInfo struct {
	User struct {
		ID               string  `json:"id"`
		Email            *string `json:"email"`
		PendingEmail     *string `json:"pendingEmail,omitempty"` // requested change awaiting confirmation
		Name             *string `json:"name"`
		IsSuperadmin     bool    `json:"isSuperadmin"`
		HasPassword      bool    `json:"hasPassword"`
		TwoFactorEnabled bool    `json:"twoFactorEnabled"`
		Status           string  `json:"status"`
		CreatedAt        string  `json:"createdAt"`
	} `json:"user"`
	Tenant *AccountTenant `json:"tenant"`
}

// AccountTenant is the caller's tenant + role.
type AccountTenant struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Plan string `json:"plan"`
	Role string `json:"role"`
}

// MaskedSmtp is GET/PUT /account/smtp (password never in clear).
type MaskedSmtp struct {
	Enabled    bool   `json:"enabled"`
	Host       string `json:"host"`
	Port       int64  `json:"port"`
	User       string `json:"user"`
	From       string `json:"from"`
	Pass       string `json:"pass"`
	HasPass    bool   `json:"hasPass"`
	Configured bool   `json:"configured"`
}

// TwoFaSetup is POST /account/2fa/setup.
type TwoFaSetup struct {
	Secret     string `json:"secret"`
	OtpauthURI string `json:"otpauthUri"`
	QRDataURI  string `json:"qrDataUri"`
}

func (s *Service) requireUser(ctx context.Context, p *auth.Principal) (*tenancy.User, error) {
	if p.Via == auth.ViaAPIToken {
		return nil, httpx.Forbidden("API tokens have no account")
	}
	u := s.tenancy.GetUser(ctx, p.UserID)
	if u == nil {
		return nil, httpx.BadRequest("account not found")
	}
	return u, nil
}

// GetAccount resolves the caller's own account.
func (s *Service) GetAccount(ctx context.Context, p *auth.Principal) (*AccountInfo, error) {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return nil, err
	}
	var a AccountInfo
	a.User.ID, a.User.Email, a.User.Name = u.ID, u.Email, u.Name
	a.User.PendingEmail = s.pendingEmail(ctx, u.ID)
	a.User.IsSuperadmin = u.IsSuperadmin || p.IsSuperadmin
	a.User.HasPassword = hasPassword(u)
	a.User.TwoFactorEnabled = s.TotpEnabled(ctx, u.ID)
	a.User.Status = u.Status
	if a.User.Status == "" {
		a.User.Status = "active"
	}
	a.User.CreatedAt = u.CreatedAt
	if p.TenantID != "" {
		if t := s.tenancy.GetTenant(ctx, p.TenantID); t != nil {
			a.Tenant = &AccountTenant{t.ID, t.Name, t.Plan, string(p.Role)}
		}
	}
	return &a, nil
}

var accountEmailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// emailAvailable: e (normalized) is not another user's, the break-glass
// admin's or the superadmin's. Checked when a change is requested AND when
// it is confirmed.
func (s *Service) emailAvailable(ctx context.Context, userID, e string) error {
	if taken := s.tenancy.GetUserByEmail(ctx, e); taken != nil && taken.ID != userID {
		return httpx.BadRequest("email already in use")
	}
	if s.cfg.AdminUser != "" && e == strings.ToLower(strings.TrimSpace(s.cfg.AdminUser)) {
		return httpx.BadRequest("email already in use")
	}
	if sa := s.superadminEmail(); sa != "" && e == sa {
		return httpx.BadRequest("email already in use")
	}
	return nil
}

// UpdateAccount patches the name (nil = untouched) and REQUESTS an email
// change: the new address only replaces the current one once the link
// mailed to it is followed (POST /auth/magic/verify). Until then the
// response carries it as user.pendingEmail.
func (s *Service) UpdateAccount(ctx context.Context, p *auth.Principal, name, email *string) (*AccountInfo, error) {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return nil, err
	}
	var patch tenancy.ProfilePatch
	if name != nil {
		patch.SetName = true
		if n := strings.TrimSpace(*name); n != "" {
			patch.Name = &n
		}
	}
	if email != nil {
		e := strings.ToLower(strings.TrimSpace(*email))
		if !accountEmailRe.MatchString(e) || jsx.UTF16Len(e) > 200 {
			return nil, httpx.BadRequest("invalid email")
		}
		if u.ID == tenancy.AdminUserID {
			return nil, httpx.BadRequest("the break-glass admin email is managed via ADMIN_USER (env)")
		}
		current := ""
		if u.Email != nil {
			current = strings.ToLower(*u.Email)
		}
		if e != current {
			if err := s.emailAvailable(ctx, u.ID, e); err != nil {
				return nil, err
			}
			if err := s.requestEmailChange(ctx, u, e); err != nil {
				return nil, err
			}
		}
	}
	if err := s.tenancy.UpdateProfile(ctx, u.ID, patch); err != nil {
		return nil, err
	}
	s.log.Info("account updated for user " + u.ID)
	return s.GetAccount(ctx, p)
}

// requestEmailChange mints the kind='email_change' token (one live per user,
// 60s cooldown), mails its link to the NEW address and a notice to the
// current one — both over the global SMTP. A confirmation that can't be
// delivered is withdrawn: the change could never be confirmed.
func (s *Service) requestEmailChange(ctx context.Context, u *tenancy.User, e string) error {
	if wait := s.emailChangeCooldown(ctx, u.ID); wait > 0 {
		return &httpx.Error{Status: http.StatusTooManyRequests, Body: cooldownBody{
			http.StatusTooManyRequests, fmt.Sprintf("Please wait %ds before requesting another email change.", wait), "Too Many Requests", wait,
		}}
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE magic_tokens SET used = 1, used_at = datetime('now')
          WHERE user_id = ? AND kind = ? AND used = 0`, u.ID, kindEmailChange); err != nil {
		return err
	}
	token := auth.RandomToken(32)
	hash := auth.HashToken(token)
	now := s.now()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO magic_tokens (token_hash, email, request_ip, created_at, expires_at, kind, user_id)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`, hash, e, jsx.ISO(now), jsx.ISO(now.Add(emailChangeTTL)), kindEmailChange, u.ID); err != nil {
		return err
	}
	if res := s.mailer.SendEmailChange(ctx, e, s.buildMagicURL(token)); !res.OK {
		_, _ = s.db.ExecContext(ctx, `UPDATE magic_tokens SET used = 1, used_at = datetime('now') WHERE token_hash = ?`, hash)
		if res.Skipped {
			return httpx.Unavailable("email change needs the global SMTP (STREAMHUB_SMTP_HOST + STREAMHUB_SMTP_PASS)")
		}
		return httpx.Unavailable("could not send the confirmation email")
	}
	if u.Email != nil && *u.Email != "" {
		s.mailer.SendEmailChangeNotice(ctx, *u.Email, e)
	}
	s.log.Info(fmt.Sprintf("email change requested for user %s → <%s>", u.ID, maskEmail(e)))
	return nil
}

func (s *Service) emailChangeCooldown(ctx context.Context, userID string) int {
	var last sql.NullString
	if err := s.db.QueryRowContext(ctx, `SELECT MAX(created_at) AS last FROM magic_tokens
          WHERE user_id = ? AND kind = ?`, userID, kindEmailChange).Scan(&last); err != nil || !last.Valid {
		return 0
	}
	t, ok := jsx.ParseDate(last.String)
	if !ok {
		return 0
	}
	return max(0, int(math.Ceil(float64(resendCooldownSec)-s.now().Sub(t).Seconds())))
}

// pendingEmail is the address of the user's live (unused, unexpired)
// email-change request, nil when none.
func (s *Service) pendingEmail(ctx context.Context, userID string) *string {
	var email, expiresAt string
	if err := s.db.QueryRowContext(ctx, `SELECT email, expires_at FROM magic_tokens
          WHERE user_id = ? AND kind = ? AND used = 0 ORDER BY id DESC LIMIT 1`, userID, kindEmailChange).
		Scan(&email, &expiresAt); err != nil {
		return nil
	}
	if exp, ok := jsx.ParseDate(expiresAt); !ok || !s.now().Before(exp) {
		return nil
	}
	return &email
}

// ChangePassword requires the current password.
func (s *Service) ChangePassword(ctx context.Context, p *auth.Principal, current, next string) error {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return err
	}
	if u.ID == tenancy.AdminUserID {
		return httpx.BadRequest("the break-glass admin password is managed via ADMIN_PASS (env)")
	}
	if next == "" || jsx.UTF16Len(next) < minPasswordLen {
		return httpx.BadRequest(fmt.Sprintf("password must be at least %d characters", minPasswordLen))
	}
	if !hasPassword(u) {
		return httpx.BadRequest("no password set — use the password reset flow to set one")
	}
	if !auth.VerifyPassword(current, *u.PasswordHash) {
		return httpx.Forbidden("current password is incorrect")
	}
	hash, err := auth.HashPassword(next)
	if err != nil {
		return err
	}
	if err := s.setPassword(ctx, u.ID, hash, p.SessionID); err != nil {
		return err
	}
	s.log.Info("password changed for user " + u.ID)
	return nil
}

// setPassword stores the hash and ends every session of the user but keepSID
// ("" = all): whoever signed in with the old password — or stole one of its
// sessions — is out once it changes (3.3.4). Every path that sets a password
// goes through here.
func (s *Service) setPassword(ctx context.Context, userID, hash, keepSID string) error {
	if err := s.tenancy.SetPassword(ctx, userID, hash); err != nil {
		return err
	}
	n, err := s.Sessions.RevokeOthers(ctx, userID, keepSID)
	if err != nil {
		return err
	}
	if n > 0 {
		s.log.Info(fmt.Sprintf("password set for user %s: %d other session(s) revoked", userID, n))
	}
	return nil
}

// SetupTwoFa starts enrolment: secret + otpauth URI + QR PNG data URI.
func (s *Service) SetupTwoFa(ctx context.Context, p *auth.Principal) (*TwoFaSetup, error) {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return nil, err
	}
	label := u.ID
	if u.Email != nil {
		label = *u.Email
	}
	setup, err := s.TotpSetupFor(ctx, u.ID, label)
	if err != nil {
		return nil, err
	}
	qr, err := qrDataURI(setup.OtpauthURI, 1, 220)
	if err != nil {
		return nil, err
	}
	return &TwoFaSetup{setup.Secret, setup.OtpauthURI, qr}, nil
}

// EnableTwoFa / DisableTwoFa act on the caller's own user. A wrong code
// counts against the account's throttle (M3).
func (s *Service) EnableTwoFa(ctx context.Context, p *auth.Principal, code string) error {
	return s.throttledCode(ctx, p, code, s.TotpEnable)
}

func (s *Service) DisableTwoFa(ctx context.Context, p *auth.Principal, code string) error {
	return s.throttledCode(ctx, p, code, s.TotpDisable)
}

func (s *Service) throttledCode(ctx context.Context, p *auth.Principal, code string, fn func(context.Context, string, string) error) error {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return err
	}
	if err := s.throttle.Attempt(strPtr(httpx.ClientIP(api.Request(ctx)))); err != nil {
		return err
	}
	key := accountKey(u.Email, u.ID)
	if err := s.throttle.Locked(key); err != nil {
		return err
	}
	err = fn(ctx, u.ID, code)
	switch {
	case err == nil:
		s.throttle.Succeed(key)
	case err.Error() == invalidCode:
		s.throttle.Fail(key)
	}
	return err
}

// GetSmtp is the masked per-user SMTP override.
func (s *Service) GetSmtp(ctx context.Context, p *auth.Principal) (*MaskedSmtp, error) {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.maskedSmtp(ctx, u.ID), nil
}

// SmtpInput is PUT /account/smtp (nil = keep).
type SmtpInput struct {
	Enabled          *bool
	Host, User, From *string
	Port             *int64
	Pass             *string
}

// SetSmtp updates the override; the password is encrypted before storage.
func (s *Service) SetSmtp(ctx context.Context, p *auth.Principal, in SmtpInput) (*MaskedSmtp, error) {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return nil, err
	}
	patch := tenancy.SmtpPatch{Enabled: in.Enabled, Port: in.Port, User: in.User}
	if in.Host != nil {
		h := strings.TrimSpace(*in.Host)
		patch.Host = &h
	}
	if in.From != nil {
		f := strings.TrimSpace(*in.From)
		patch.From = &f
	}
	if in.Pass != nil && *in.Pass != "" {
		enc, err := auth.EncryptUserSmtpSecret(*in.Pass, s.cfg.JWTSecret)
		if err != nil {
			return nil, err // Node throws too when STREAMHUB_JWT_SECRET is empty
		}
		patch.PassEnc = &enc
	}
	if err := s.tenancy.SetUserSmtp(ctx, u.ID, patch); err != nil {
		return nil, err
	}
	s.log.Info("smtp override updated for user " + u.ID)
	return s.maskedSmtp(ctx, u.ID), nil
}

// TestSmtp sends a probe through the caller's own SMTP (never fails the call).
func (s *Service) TestSmtp(ctx context.Context, p *auth.Principal, to string) (SendResult, error) {
	u, err := s.requireUser(ctx, p)
	if err != nil {
		return SendResult{}, err
	}
	return s.mailer.TestUserSMTP(ctx, u.ID, to), nil
}

func (s *Service) maskedSmtp(ctx context.Context, userID string) *MaskedSmtp {
	row := s.tenancy.GetUserSmtp(ctx, userID)
	if row == nil {
		row = &tenancy.UserSmtp{}
	}
	pass := ""
	if row.PassEnc != nil {
		pass, _ = auth.DecryptUserSmtpSecret(*row.PassEnc, s.cfg.JWTSecret)
	}
	port := int64(587)
	if row.Port != nil && *row.Port > 0 {
		port = *row.Port
	}
	return &MaskedSmtp{
		Enabled: row.Enabled, Host: row.Host, Port: port, User: row.User, From: row.From,
		Pass: maskSecret(pass), HasPass: pass != "", Configured: row.Enabled && row.Host != "" && pass != "",
	}
}

func maskSecret(v string) string {
	switch n := jsx.UTF16Len(v); {
	case n == 0:
		return ""
	case n <= 4:
		return "****"
	}
	r := []rune(v)
	return string(r[:2]) + "***" + string(r[len(r)-2:])
}

// qrDataURI renders like node-qrcode's toDataURL({margin, width}): ECC M,
// black on white, the module grid scaled into a width-pixel PNG.
func qrDataURI(text string, margin, width int) (string, error) {
	q, err := qrcode.New(text, qrcode.Medium)
	if err != nil {
		return "", err
	}
	q.DisableBorder = true
	bm := q.Bitmap()
	size := len(bm)
	scale := 4.0
	if width >= size+margin*2 {
		scale = float64(width) / float64(size+margin*2)
	}
	symbol := int(math.Floor(float64(size+margin*2) * scale))
	sm := float64(margin) * scale
	img := image.NewGray(image.Rect(0, 0, symbol, symbol))
	for i := 0; i < symbol; i++ {
		for j := 0; j < symbol; j++ {
			c := color.Gray{Y: 255}
			fi, fj := float64(i), float64(j)
			if fi >= sm && fj >= sm && fi < float64(symbol)-sm && fj < float64(symbol)-sm {
				if bm[int((fi-sm)/scale)][int((fj-sm)/scale)] {
					c = color.Gray{Y: 0}
				}
			}
			img.SetGray(j, i, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}
