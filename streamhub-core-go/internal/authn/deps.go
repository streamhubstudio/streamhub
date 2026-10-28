package authn

import (
	"context"
	"database/sql"
	"log/slog"
	"strings"
)

// NodeRole is the slice of cluster/node-role.service.ts the auth plane
// needs: the role (standalone|master|edge) gates every login mint path, and
// the master URL is surfaced by GET /auth/config.
type NodeRole interface {
	Role(ctx context.Context) string
	MasterURL(ctx context.Context) *string
}

// StandaloneNode is the default role when no cluster module is wired.
type StandaloneNode struct{}

func (StandaloneNode) Role(context.Context) string       { return "standalone" }
func (StandaloneNode) MasterURL(context.Context) *string { return nil }

// MetaNodeRole reads the role from the global `_streamhub_meta` KV
// (node_role / master_url), the source of truth NodeRoleService writes. The
// first-boot env seed (STREAMHUB_NODE_ROLE) belongs to the cluster port.
type MetaNodeRole struct{ DB *sql.DB }

func (m MetaNodeRole) meta(ctx context.Context, key string) string {
	var v sql.NullString
	_ = m.DB.QueryRowContext(ctx, `SELECT value FROM _streamhub_meta WHERE key = ?`, key).Scan(&v)
	return v.String
}

// Role coerces the stored value (unknown → standalone).
func (m MetaNodeRole) Role(ctx context.Context) string {
	switch v := strings.ToLower(strings.TrimSpace(m.meta(ctx, "node_role"))); v {
	case "standalone", "master", "edge":
		return v
	}
	return "standalone"
}

// MasterURL is the stored master URL without trailing slashes (nil if blank).
func (m MetaNodeRole) MasterURL(ctx context.Context) *string {
	v := strings.TrimRight(strings.TrimSpace(m.meta(ctx, "master_url")), "/")
	if v == "" {
		return nil
	}
	return &v
}

// SendResult is EmailService's SendResult.
type SendResult struct {
	OK        bool   `json:"ok"`
	MessageID string `json:"messageId,omitempty"`
	Error     string `json:"error,omitempty"`
	Skipped   bool   `json:"skipped,omitempty"`
}

// SendContext selects the per-user SMTP override (owner item 29).
type SendContext struct{ UserID string }

// InviteOptions are the invite email's template fields.
type InviteOptions struct {
	TeamName  string
	Role      string
	InvitedBy string
}

// Mailer is the slice of modules/email the auth plane uses. Sends never
// return an error: failures are carried in the result, as in Node.
type Mailer interface {
	SendMagicLink(ctx context.Context, email, url string, sc SendContext) SendResult
	SendInvite(ctx context.Context, email, url string, opts InviteOptions, sc SendContext) SendResult
	TestUserSMTP(ctx context.Context, userID, to string) SendResult
}

// LogMailer stands in until the email module is ported: it logs and reports
// every send as skipped (what Node returns when SMTP is not configured).
type LogMailer struct{ Log *slog.Logger }

func (m LogMailer) SendMagicLink(_ context.Context, email, _ string, _ SendContext) SendResult {
	m.Log.Warn("email not configured: magic link not sent", "to", maskEmail(email))
	return SendResult{OK: false, Skipped: true}
}

func (m LogMailer) SendInvite(_ context.Context, email, _ string, _ InviteOptions, _ SendContext) SendResult {
	m.Log.Warn("email not configured: invite not sent", "to", maskEmail(email))
	return SendResult{OK: false, Skipped: true}
}

func (m LogMailer) TestUserSMTP(context.Context, string, string) SendResult {
	return SendResult{OK: false, Skipped: true, Error: "smtp_not_configured"}
}
