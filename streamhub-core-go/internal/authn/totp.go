package authn

import (
	"context"
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// TOTP 2FA per built-in user (totp.service.ts). Enrolment is a two-step
// handshake (setup → pending secret, enable verifies a live code) so a typo
// can never lock the user out. Secrets are stored AES-GCM encrypted under
// STREAMHUB_JWT_SECRET. The break-glass admin never goes through this.

const totpIssuer = "StreamHub"

var sixDigits = regexp.MustCompile(`^\d{6}$`)

// TotpSetup is the enrolment payload.
type TotpSetup struct {
	Secret     string `json:"secret"`
	OtpauthURI string `json:"otpauthUri"`
}

func (s *Service) requireMaster() (string, error) {
	if s.cfg.JWTSecret == "" {
		return "", httpx.BadRequest("2FA is not available: STREAMHUB_JWT_SECRET is not configured")
	}
	return s.cfg.JWTSecret, nil
}

// TotpEnabled reports whether the user has 2FA fully enabled.
func (s *Service) TotpEnabled(ctx context.Context, userID string) bool {
	st := s.tenancy.GetTotpState(ctx, userID)
	return st.Enabled && st.Secret != nil && *st.Secret != ""
}

// TotpSetupFor mints and stores (encrypted, pending) a fresh secret.
func (s *Service) TotpSetupFor(ctx context.Context, userID, label string) (*TotpSetup, error) {
	master, err := s.requireMaster()
	if err != nil {
		return nil, err
	}
	if s.TotpEnabled(ctx, userID) {
		return nil, httpx.BadRequest("2FA is already enabled — disable it first")
	}
	secret := auth.GenerateTOTPSecret()
	enc, err := auth.EncryptSecret(secret, master)
	if err != nil {
		return nil, err
	}
	if err := s.tenancy.SetTotpPending(ctx, userID, enc); err != nil {
		return nil, err
	}
	if label == "" {
		label = userID
	}
	s.log.Info("2FA enrolment started for user " + userID)
	return &TotpSetup{Secret: secret, OtpauthURI: auth.TOTPKeyURI(label, totpIssuer, secret)}, nil
}

// TotpEnable verifies code against the pending secret and activates it.
func (s *Service) TotpEnable(ctx context.Context, userID, code string) error {
	master, err := s.requireMaster()
	if err != nil {
		return err
	}
	st := s.tenancy.GetTotpState(ctx, userID)
	if s.TotpEnabled(ctx, userID) {
		return httpx.BadRequest("2FA is already enabled")
	}
	if st.PendingSecret == nil || *st.PendingSecret == "" {
		return httpx.BadRequest("no 2FA enrolment in progress — run setup")
	}
	secret, ok := auth.DecryptSecret(*st.PendingSecret, master)
	if !ok || secret == "" || !s.checkCode(code, secret) {
		return httpx.BadRequest("invalid verification code")
	}
	if err := s.tenancy.ActivateTotp(ctx, userID); err != nil {
		return err
	}
	s.log.Info("2FA enabled for user " + userID)
	return nil
}

// TotpDisable requires a live valid code, then wipes both secrets.
func (s *Service) TotpDisable(ctx context.Context, userID, code string) error {
	master, err := s.requireMaster()
	if err != nil {
		return err
	}
	st := s.tenancy.GetTotpState(ctx, userID)
	if !st.Enabled || st.Secret == nil || *st.Secret == "" {
		return httpx.BadRequest("2FA is not enabled")
	}
	secret, ok := auth.DecryptSecret(*st.Secret, master)
	if !ok || secret == "" || !s.checkCode(code, secret) {
		return httpx.BadRequest("invalid verification code")
	}
	if err := s.tenancy.ClearTotp(ctx, userID); err != nil {
		return err
	}
	s.log.Info("2FA disabled for user " + userID)
	return nil
}

// TotpVerify reports whether code is valid for the user's ACTIVE secret.
func (s *Service) TotpVerify(ctx context.Context, userID, code string) bool {
	if s.cfg.JWTSecret == "" {
		return false
	}
	st := s.tenancy.GetTotpState(ctx, userID)
	if !st.Enabled || st.Secret == nil || *st.Secret == "" {
		return false
	}
	secret, ok := auth.DecryptSecret(*st.Secret, s.cfg.JWTSecret)
	return ok && secret != "" && s.checkCode(code, secret)
}

// AssertLoginCode is the login gate: no-op without 2FA; 401 totp_required
// for a missing code and totp_invalid for a wrong one.
func (s *Service) AssertLoginCode(ctx context.Context, userID, code string) error {
	if !s.TotpEnabled(ctx, userID) {
		return nil
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return httpx.Unauthorized("totp_required")
	}
	if !s.TotpVerify(ctx, userID, code) {
		return httpx.Unauthorized("totp_invalid")
	}
	return nil
}

var spaces = regexp.MustCompile(`\s+`)

func (s *Service) checkCode(code, secret string) bool {
	c := spaces.ReplaceAllString(code, "")
	return sixDigits.MatchString(c) && auth.TOTPCheck(c, secret, s.now())
}
