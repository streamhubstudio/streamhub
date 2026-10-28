// Package email ports modules/email: transactional SMTP mail (magic links,
// invites, notifier email, SMTP probes) with the owner-item-29 precedence
// per-user override > per-app override > global env default, plus
// POST /apps/:app/smtp/test. No send ever returns an error: failures are
// logged and carried in SendResult.
package email

import (
	"context"
	"log/slog"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authn"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

// SendResult is the outcome of a send attempt (the auth plane's type: one
// schema for both POST /apps/:app/smtp/test and /account/smtp/test).
type SendResult = authn.SendResult

// SendContext selects an override SMTP: UserID beats App beats global.
type SendContext struct {
	UserID string
	App    string
}

// Message is one outgoing mail (HTML optional).
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// SMTP is a resolved server (global, per-app or per-user).
type SMTP struct {
	Host string
	Port int
	User string
	Pass string
	From string
}

// Transport delivers one message (nodemailer's createTransport+sendMail).
// Port 465 = implicit TLS, anything else = mandatory STARTTLS.
type Transport interface {
	Send(ctx context.Context, smtp SMTP, from string, msg Message) (messageID string, err error)
}

// Tenancy is the per-user SMTP lookup (TenancyService.getUserSmtp).
type Tenancy interface {
	GetUserSmtp(ctx context.Context, userID string) *tenancy.UserSmtp
}

// Service is EmailService.
type Service struct {
	cfg       *config.Config
	settings  SMTP
	transport Transport
	apps      contracts.AppsService // optional
	tenancy   Tenancy               // optional
	log       *slog.Logger
}

// New resolves the global SMTP settings from env once (constructor time, as
// Node). apps/ten may be nil: every send then resolves to the global default.
func New(cfg *config.Config, transport Transport, apps contracts.AppsService, ten Tenancy, log *slog.Logger) *Service {
	return &Service{cfg: cfg, settings: resolveSettings(cfg), transport: transport, apps: apps, tenancy: ten, log: log}
}

// IsConfigured: a usable GLOBAL host + pass.
func (s *Service) IsConfigured() bool { return s.settings.Host != "" && s.settings.Pass != "" }

// FromAddress is the global From header.
func (s *Service) FromAddress() string { return s.settings.From }

// SendMagicLink sends the passwordless sign-in link.
func (s *Service) SendMagicLink(ctx context.Context, email, url string, sc *SendContext) SendResult {
	subject := "Your StreamHub sign-in link"
	text := "Sign in to StreamHub\n\n" +
		"Click the link below to sign in. It works once and expires in 15 minutes:\n\n" +
		url + "\n\n" +
		"If you did not request this, you can safely ignore this email."
	u := escapeHTML(url)
	html := `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto">` +
		`<h2 style="margin:0 0 16px">Sign in to StreamHub</h2>` +
		`<p style="color:#334155;line-height:1.5">Click the button below to sign in. ` +
		`This link works once and expires in 15 minutes.</p>` +
		`<p style="margin:24px 0"><a href="` + u + `" ` +
		`style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;` +
		`text-decoration:none;display:inline-block">Sign in</a></p>` +
		`<p style="color:#64748b;font-size:13px;line-height:1.5">Or paste this URL into your browser:<br>` +
		`<a href="` + u + `">` + u + `</a></p>` +
		`<p style="color:#94a3b8;font-size:12px;margin-top:24px">` +
		`If you did not request this, you can safely ignore this email.</p></div>`
	return s.Send(ctx, Message{To: email, Subject: subject, Text: text, HTML: html}, sc)
}

// InviteOptions are the invite template fields.
type InviteOptions struct {
	TeamName  string
	Role      string
	InvitedBy string
}

// SendInvite sends a team invitation carrying a sign-in link.
func (s *Service) SendInvite(ctx context.Context, email, url string, opts InviteOptions, sc *SendContext) SendResult {
	team := opts.TeamName
	if team == "" {
		team = "a StreamHub team"
	}
	by, roleLine := "", ""
	if opts.InvitedBy != "" {
		by = " by " + opts.InvitedBy
	}
	if opts.Role != "" {
		roleLine = " as " + opts.Role
	}
	subject := "You've been invited to " + team + " on StreamHub"
	text := "Join " + team + " on StreamHub\n\n" +
		"You have been invited" + by + " to join " + team + roleLine + ". " +
		"Click the link below to accept the invitation and sign in. " +
		"It works once and expires in 72 hours:\n\n" +
		url + "\n\n" +
		"If you did not expect this invitation, you can safely ignore this email."
	u := escapeHTML(url)
	html := `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto">` +
		`<h2 style="margin:0 0 16px">Join ` + escapeHTML(team) + ` on StreamHub</h2>` +
		`<p style="color:#334155;line-height:1.5">You have been invited` + escapeHTML(by) + ` ` +
		`to join <strong>` + escapeHTML(team) + `</strong>` + escapeHTML(roleLine) + `. ` +
		`Click the button below to accept the invitation and sign in. ` +
		`This link works once and expires in 72 hours.</p>` +
		`<p style="margin:24px 0"><a href="` + u + `" ` +
		`style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;` +
		`text-decoration:none;display:inline-block">Accept invitation</a></p>` +
		`<p style="color:#64748b;font-size:13px;line-height:1.5">Or paste this URL into your browser:<br>` +
		`<a href="` + u + `">` + u + `</a></p>` +
		`<p style="color:#94a3b8;font-size:12px;margin-top:24px">` +
		`If you did not expect this invitation, you can safely ignore this email.</p></div>`
	return s.Send(ctx, Message{To: email, Subject: subject, Text: text, HTML: html}, sc)
}

// Send resolves the SMTP (user > app > global) and delivers msg; nothing
// configured anywhere → skipped without dialing.
func (s *Service) Send(ctx context.Context, msg Message, sc *SendContext) SendResult {
	smtp, ok := s.resolve(ctx, sc)
	if !ok {
		s.log.Warn("email not sent to <" + mask(msg.To) + ">: SMTP not configured " +
			"(set STREAMHUB_SMTP_HOST + STREAMHUB_SMTP_PASS, or a per-app/per-user override)")
		return SendResult{OK: false, Skipped: true, Error: "smtp_not_configured"}
	}
	id, err := s.transport.Send(ctx, smtp, smtp.From, msg)
	if err != nil {
		s.log.Error("email send to <" + mask(msg.To) + "> failed: " + err.Error())
		return SendResult{OK: false, Error: err.Error()}
	}
	s.log.Info("email sent to <" + mask(msg.To) + "> (id=" + id + ")")
	return SendResult{OK: true, MessageID: id}
}

// TestAppSmtp probes the APP's own SMTP, bypassing its enabled gate. Never
// falls back to global.
func (s *Service) TestAppSmtp(ctx context.Context, app, to string) SendResult {
	if s.apps == nil {
		return SendResult{OK: false, Error: "apps_service_unavailable"}
	}
	cfg, err := s.apps.GetConfig(ctx, app)
	if err != nil || cfg == nil {
		return SendResult{OK: false, Error: "app_not_found"}
	}
	if cfg.Smtp.Host == "" || cfg.Smtp.Pass == "" {
		return SendResult{OK: false, Skipped: true, Error: "smtp_not_configured"}
	}
	return s.sendProbe(ctx, s.fromApp(cfg.Smtp), to)
}

// TestUserSmtp probes the USER's own SMTP, bypassing its enabled gate.
func (s *Service) TestUserSmtp(ctx context.Context, userID, to string) SendResult {
	if s.tenancy == nil {
		return SendResult{OK: false, Error: "tenancy_unavailable"}
	}
	row := s.tenancy.GetUserSmtp(ctx, userID)
	if row == nil || row.Host == "" || row.PassEnc == nil || *row.PassEnc == "" {
		return SendResult{OK: false, Skipped: true, Error: "smtp_not_configured"}
	}
	pass, ok := auth.DecryptUserSmtpSecret(*row.PassEnc, s.cfg.JWTSecret)
	if !ok || pass == "" {
		return SendResult{OK: false, Error: "decrypt_failed"}
	}
	return s.sendProbe(ctx, s.fromUser(row, pass), to)
}

func (s *Service) sendProbe(ctx context.Context, smtp SMTP, to string) SendResult {
	text := "This is a test email from StreamHub confirming this SMTP configuration works."
	id, err := s.transport.Send(ctx, smtp, smtp.From, Message{
		To: to, Subject: "StreamHub SMTP test", Text: text, HTML: "<p>" + escapeHTML(text) + "</p>",
	})
	if err != nil {
		s.log.Error("test email to <" + mask(to) + "> failed: " + err.Error())
		return SendResult{OK: false, Error: err.Error()}
	}
	s.log.Info("test email sent to <" + mask(to) + "> (id=" + id + ")")
	return SendResult{OK: true, MessageID: id}
}

// resolve picks the SMTP for one send. Each tier is best-effort: a failed
// lookup or decrypt falls through to the next.
func (s *Service) resolve(ctx context.Context, sc *SendContext) (SMTP, bool) {
	if sc != nil && sc.UserID != "" && s.tenancy != nil {
		if row := s.tenancy.GetUserSmtp(ctx, sc.UserID); row != nil && row.Enabled && row.Host != "" && row.PassEnc != nil && *row.PassEnc != "" {
			if pass, ok := auth.DecryptUserSmtpSecret(*row.PassEnc, s.cfg.JWTSecret); ok && pass != "" {
				return s.fromUser(row, pass), true
			}
		}
	}
	if sc != nil && sc.App != "" && s.apps != nil {
		if cfg, err := s.apps.GetConfig(ctx, sc.App); err == nil && cfg != nil &&
			cfg.Smtp.Enabled && cfg.Smtp.Host != "" && cfg.Smtp.Pass != "" {
			return s.fromApp(cfg.Smtp), true
		}
	}
	if !s.IsConfigured() {
		return SMTP{}, false
	}
	return s.settings, true
}

func (s *Service) fromApp(c contracts.SmtpConfig) SMTP {
	port := int(c.Port)
	if port == 0 {
		port = 587
	}
	from := c.From
	if from == "" {
		from = s.settings.From
	}
	return SMTP{Host: c.Host, Port: port, User: c.User, Pass: c.Pass, From: from}
}

func (s *Service) fromUser(row *tenancy.UserSmtp, pass string) SMTP {
	port := 587
	if row.Port != nil && *row.Port > 0 {
		port = int(*row.Port)
	}
	from := row.From
	if from == "" {
		from = s.settings.From
	}
	return SMTP{Host: row.Host, Port: port, User: row.User, Pass: pass, From: from}
}

func resolveSettings(cfg *config.Config) SMTP {
	str := func(name, fallback string) string {
		if v := cfg.Env(name); v != "" {
			return v
		}
		return fallback
	}
	port := 587
	if v := cfg.Env("STREAMHUB_SMTP_PORT"); v != "" {
		if n, ok := config.ParseIntPrefix(v); ok {
			port = n
		}
	}
	return SMTP{
		Host: str("STREAMHUB_SMTP_HOST", "mail.wipermax.online"),
		Port: port,
		User: str("STREAMHUB_SMTP_USER", "no-reply@streamhub.studio"),
		Pass: str("STREAMHUB_SMTP_PASS", ""),
		From: str("STREAMHUB_SMTP_FROM", "StreamHub <no-reply@streamhub.studio>"),
	}
}

// mask hides an address for logs: al***@example.com.
func mask(email string) string {
	at := strings.Index(email, "@")
	if at <= 0 {
		return "***"
	}
	local := []rune(email[:at])
	return string(local[:min(2, len(local))]) + "***" + email[at:]
}

func escapeHTML(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}
