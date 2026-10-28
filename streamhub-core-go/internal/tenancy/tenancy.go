// Package tenancy is the tenancy control-plane (modules/tenancy): tenants,
// the mirrored users table, memberships (role per tenant) and quotas rows on
// the global DB, plus the boot finisher the numbered migrations can't express
// (users auth columns, platform tenant, break-glass admin mirror).
package tenancy

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
)

// AdminUserID is the stable synthetic id of the break-glass admin principal.
const AdminUserID = "admin"

// MembershipRole is a role within a tenant.
type MembershipRole string

const (
	RoleOwner  MembershipRole = "owner"
	RoleEditor MembershipRole = "editor"
	RoleViewer MembershipRole = "viewer"
)

// Tenant is a tenants row.
type Tenant struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Plan      string `json:"plan"`
	CreatedAt string `json:"created_at"`
}

// User is a users row (secrets stay encrypted strings).
type User struct {
	ID                string
	Email             *string
	IsSuperadmin      bool
	CreatedAt         string
	PasswordHash      *string
	Status            string
	Name              *string
	TotpSecret        *string
	TotpPendingSecret *string
	TotpEnabled       bool
}

// TeamMember is a flattened membership + user (GET /teams/mine).
type TeamMember struct {
	UserID       string         `json:"userId"`
	Email        *string        `json:"email"`
	Name         *string        `json:"name"`
	Role         MembershipRole `json:"role"`
	Status       string         `json:"status"`
	IsSuperadmin bool           `json:"isSuperadmin"`
	CreatedAt    string         `json:"createdAt"`
}

// Quota holds a tenant's limits (-1 = unlimited).
type Quota struct {
	MaxApps                  int64
	MaxConcurrentStreams     int64
	MaxRecordingMinutesMonth int64
	MaxEgressGBMonth         int64
	MaxStorageGB             int64
}

// FreePlanQuota is the conservative open-signup `free` plan.
var FreePlanQuota = Quota{2, 2, 300, 5, 5}

// BroadcasterPlanQuota is the 24/7 linear-channel preset (QW-3).
var BroadcasterPlanQuota = Quota{50, -1, -1, -1, -1}

// PlanQuotas are the named presets a plan label applies.
var PlanQuotas = map[string]Quota{
	"free":        FreePlanQuota,
	"broadcaster": BroadcasterPlanQuota,
	"linear":      BroadcasterPlanQuota,
}

// Service owns the tenancy rows.
type Service struct {
	db        *sql.DB
	adminUser string
	log       *slog.Logger
}

// New builds the service over the global DB.
func New(global *sql.DB, adminUser string, log *slog.Logger) *Service {
	return &Service{db: global, adminUser: adminUser, log: log}
}

// Init is onModuleInit: never fails boot (errors are logged).
func (s *Service) Init(ctx context.Context) {
	err := s.ensureUserAuthColumns(ctx)
	if err == nil {
		err = s.ensurePlatformTenant(ctx)
	}
	if err == nil {
		err = s.ensureAdminSuperadmin(ctx)
	}
	if err != nil {
		s.log.Error("tenancy bootstrap failed (continuing)", "err", err)
	}
}

func (s *Service) ensurePlatformTenant(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO tenants (id, name, plan) VALUES (?, 'Platform', 'platform')`, auth.PlatformTenantID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO quotas
         (tenant_id, max_apps, max_concurrent_streams,
          max_recording_minutes_month, max_egress_gb_month, max_storage_gb)
       VALUES (?, 100000, 100000, 100000000, 100000, 100000)`, auth.PlatformTenantID)
	return err
}

func (s *Service) ensureAdminSuperadmin(ctx context.Context) error {
	if s.adminUser == "" {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO users (id, email, is_superadmin) VALUES (?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET is_superadmin = 1, email = excluded.email`, AdminUserID, s.adminUser); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO memberships (user_id, tenant_id, role)
       VALUES (?, ?, 'owner')`, AdminUserID, auth.PlatformTenantID)
	return err
}

// userAuthColumns are added to users when missing (no ADD COLUMN IF NOT EXISTS).
var userAuthColumns = []struct{ name, ddl string }{
	{"password_hash", "password_hash TEXT"},
	{"status", "status TEXT NOT NULL DEFAULT 'active'"},
	{"name", "name TEXT"},
	{"totp_secret", "totp_secret TEXT"},
	{"totp_pending_secret", "totp_pending_secret TEXT"},
	{"totp_enabled", "totp_enabled INTEGER NOT NULL DEFAULT 0"},
	{"smtp_enabled", "smtp_enabled INTEGER NOT NULL DEFAULT 0"},
	{"smtp_host", "smtp_host TEXT"},
	{"smtp_port", "smtp_port INTEGER"},
	{"smtp_user", "smtp_user TEXT"},
	{"smtp_from", "smtp_from TEXT"},
	{"smtp_pass_enc", "smtp_pass_enc TEXT"},
}

func (s *Service) ensureUserAuthColumns(ctx context.Context) error {
	for _, c := range userAuthColumns {
		has, err := db.HasColumn(ctx, s.db, "users", c.name)
		if err != nil {
			return err
		}
		if has {
			continue
		}
		if _, err := s.db.ExecContext(ctx, "ALTER TABLE users ADD COLUMN "+c.ddl); err != nil {
			return err
		}
		s.log.Info("migrated users: added " + c.name)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

func (s *Service) nullableString(ctx context.Context, q string, args ...any) (*string, bool) {
	var v sql.NullString
	if err := s.db.QueryRowContext(ctx, q, args...).Scan(&v); err != nil {
		return nil, false
	}
	if !v.Valid {
		return nil, true
	}
	return &v.String, true
}

// TenantForApp is the tenant owning an app by name ("" when unknown/null).
func (s *Service) TenantForApp(ctx context.Context, app string) string {
	v, _ := s.nullableString(ctx, `SELECT tenant_id FROM apps WHERE name = ?`, app)
	if v == nil {
		return ""
	}
	return *v
}

// TenantForAppID is the tenant owning an app by id ("" when unknown/null).
func (s *Service) TenantForAppID(ctx context.Context, id int64) string {
	v, _ := s.nullableString(ctx, `SELECT tenant_id FROM apps WHERE id = ?`, id)
	if v == nil {
		return ""
	}
	return *v
}

// RoleInTenant is the user's role in a tenant ("" when not a member).
func (s *Service) RoleInTenant(ctx context.Context, userID, tenantID string) MembershipRole {
	v, _ := s.nullableString(ctx, `SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?`, userID, tenantID)
	if v == nil {
		return ""
	}
	return MembershipRole(*v)
}

// IsSuperadmin reports users.is_superadmin.
func (s *Service) IsSuperadmin(ctx context.Context, userID string) bool {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT is_superadmin FROM users WHERE id = ?`, userID).Scan(&n); err != nil {
		return false
	}
	return n != 0
}

// GetTenant returns the tenant row or nil.
func (s *Service) GetTenant(ctx context.Context, id string) *Tenant {
	var t Tenant
	err := s.db.QueryRowContext(ctx, `SELECT id, name, plan, created_at FROM tenants WHERE id = ?`, id).
		Scan(&t.ID, &t.Name, &t.Plan, &t.CreatedAt)
	if err != nil {
		return nil
	}
	return &t
}

// GetQuota returns the quotas row or nil.
func (s *Service) GetQuota(ctx context.Context, tenantID string) *Quota {
	var q Quota
	err := s.db.QueryRowContext(ctx, `SELECT max_apps, max_concurrent_streams, max_recording_minutes_month,
	  max_egress_gb_month, max_storage_gb FROM quotas WHERE tenant_id = ?`, tenantID).
		Scan(&q.MaxApps, &q.MaxConcurrentStreams, &q.MaxRecordingMinutesMonth, &q.MaxEgressGBMonth, &q.MaxStorageGB)
	if err != nil {
		return nil
	}
	return &q
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

// EnsureTenant creates the tenant (name defaults to the id) + a free-plan
// quota row. Idempotent.
func (s *Service) EnsureTenant(ctx context.Context, id, name, plan string) (string, error) {
	if name == "" {
		name = id
	}
	if plan == "" {
		plan = "free"
	}
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO tenants (id, name, plan) VALUES (?, ?, ?)`, id, name, plan); err != nil {
		return "", err
	}
	q := FreePlanQuota
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO quotas
         (tenant_id, max_apps, max_concurrent_streams,
          max_recording_minutes_month, max_egress_gb_month, max_storage_gb)
       VALUES (?, ?, ?, ?, ?, ?)`, id, q.MaxApps, q.MaxConcurrentStreams, q.MaxRecordingMinutesMonth, q.MaxEgressGBMonth, q.MaxStorageGB)
	return id, err
}

// EnsureUser mirrors a user by id (email kept when nil). Idempotent.
func (s *Service) EnsureUser(ctx context.Context, userID string, email *string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO users (id, email) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET email = COALESCE(excluded.email, users.email)`, userID, email)
	return err
}

const userColumns = `id, email, is_superadmin, created_at, password_hash, status, name,
  totp_secret, totp_pending_secret, totp_enabled`

func scanUser(row *sql.Row) *User {
	var (
		u                        User
		email, pw, name, ts, tps sql.NullString
		status                   sql.NullString
		superadmin, totpEnabled  int
	)
	if err := row.Scan(&u.ID, &email, &superadmin, &u.CreatedAt, &pw, &status, &name, &ts, &tps, &totpEnabled); err != nil {
		return nil
	}
	u.Email, u.PasswordHash, u.Name = ptr(email), ptr(pw), ptr(name)
	u.TotpSecret, u.TotpPendingSecret = ptr(ts), ptr(tps)
	u.IsSuperadmin, u.TotpEnabled = superadmin != 0, totpEnabled != 0
	u.Status = status.String
	return &u
}

func ptr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	return &v.String
}

// GetUser returns the user or nil.
func (s *Service) GetUser(ctx context.Context, id string) *User {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

// GetUserByEmail is the case-insensitive email lookup.
func (s *Service) GetUserByEmail(ctx context.Context, email string) *User {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE email = ? COLLATE NOCASE LIMIT 1`, email))
}

// CreateUserInput is a new built-in user (password already hashed).
type CreateUserInput struct {
	Email        string
	PasswordHash *string
	IsSuperadmin bool
	Status       string // "" = active
}

// CreateUser inserts a `usr_<uuid>` user and returns its id.
func (s *Service) CreateUser(ctx context.Context, in CreateUserInput) (string, error) {
	id := "usr_" + uuid()
	status := in.Status
	if status == "" {
		status = "active"
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO users (id, email, is_superadmin, password_hash, status)
         VALUES (?, ?, ?, ?, ?)`, id, in.Email, boolInt(in.IsSuperadmin), in.PasswordHash, status)
	return id, err
}

// SetPassword sets the hash and marks the user active.
func (s *Service) SetPassword(ctx context.Context, userID, hash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ?, status = 'active' WHERE id = ?`, hash, userID)
	return err
}

// ProfilePatch: nil fields are left untouched; Name may be set to null.
type ProfilePatch struct {
	SetName bool
	Name    *string
	Email   *string
}

// UpdateProfile applies a profile patch (no-op when empty).
func (s *Service) UpdateProfile(ctx context.Context, userID string, p ProfilePatch) error {
	var sets []string
	var args []any
	if p.SetName {
		sets, args = append(sets, "name = ?"), append(args, p.Name)
	}
	if p.Email != nil {
		sets, args = append(sets, "email = ?"), append(args, *p.Email)
	}
	if len(sets) == 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `UPDATE users SET `+strings.Join(sets, ", ")+` WHERE id = ?`, append(args, userID)...)
	return err
}

// TotpState is the raw (encrypted) 2FA state of a user.
type TotpState struct {
	Enabled       bool
	Secret        *string
	PendingSecret *string
}

// GetTotpState reads the TOTP columns (zero state for unknown users).
func (s *Service) GetTotpState(ctx context.Context, userID string) TotpState {
	var (
		enabled         int
		secret, pending sql.NullString
	)
	err := s.db.QueryRowContext(ctx, `SELECT totp_enabled, totp_secret, totp_pending_secret FROM users WHERE id = ?`, userID).
		Scan(&enabled, &secret, &pending)
	if err != nil {
		return TotpState{}
	}
	return TotpState{Enabled: enabled != 0, Secret: ptr(secret), PendingSecret: ptr(pending)}
}

// SetTotpPending stores an encrypted enrolment-pending secret.
func (s *Service) SetTotpPending(ctx context.Context, userID, encrypted string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET totp_pending_secret = ? WHERE id = ?`, encrypted, userID)
	return err
}

// ActivateTotp promotes the pending secret and flips the flag.
func (s *Service) ActivateTotp(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users
            SET totp_secret = totp_pending_secret,
                totp_pending_secret = NULL,
                totp_enabled = 1
          WHERE id = ? AND totp_pending_secret IS NOT NULL`, userID)
	return err
}

// ClearTotp disables 2FA and wipes both secrets.
func (s *Service) ClearTotp(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users
            SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0
          WHERE id = ?`, userID)
	return err
}

// UserSmtp is the raw per-user SMTP override (password still encrypted).
type UserSmtp struct {
	Enabled bool
	Host    string
	Port    *int64
	User    string
	From    string
	PassEnc *string
}

// GetUserSmtp reads the SMTP columns (nil for an unknown user).
func (s *Service) GetUserSmtp(ctx context.Context, userID string) *UserSmtp {
	var (
		enabled                   int
		host, user, from, passEnc sql.NullString
		port                      sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx, `SELECT smtp_enabled, smtp_host, smtp_port, smtp_user, smtp_from, smtp_pass_enc
           FROM users WHERE id = ?`, userID).Scan(&enabled, &host, &port, &user, &from, &passEnc)
	if err != nil {
		return nil
	}
	out := &UserSmtp{Enabled: enabled != 0, Host: host.String, User: user.String, From: from.String, PassEnc: ptr(passEnc)}
	if port.Valid {
		out.Port = &port.Int64
	}
	return out
}

// SmtpPatch: nil fields are left untouched; PassEnc is already encrypted.
type SmtpPatch struct {
	Enabled *bool
	Host    *string
	Port    *int64
	User    *string
	From    *string
	PassEnc *string
}

// SetUserSmtp applies an SMTP patch (no-op when empty).
func (s *Service) SetUserSmtp(ctx context.Context, userID string, p SmtpPatch) error {
	var sets []string
	var args []any
	add := func(col string, v any) { sets, args = append(sets, col+" = ?"), append(args, v) }
	if p.Enabled != nil {
		add("smtp_enabled", boolInt(*p.Enabled))
	}
	if p.Host != nil {
		add("smtp_host", *p.Host)
	}
	if p.Port != nil {
		add("smtp_port", *p.Port)
	}
	if p.User != nil {
		add("smtp_user", *p.User)
	}
	if p.From != nil {
		add("smtp_from", *p.From)
	}
	if p.PassEnc != nil {
		add("smtp_pass_enc", *p.PassEnc)
	}
	if len(sets) == 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `UPDATE users SET `+strings.Join(sets, ", ")+` WHERE id = ?`, append(args, userID)...)
	return err
}

// CreateTeam creates a `tnt_<uuid>` tenant with a free-plan quota.
func (s *Service) CreateTeam(ctx context.Context, name, plan string) (string, error) {
	return s.EnsureTenant(ctx, "tnt_"+uuid(), name, plan)
}

// AddMembership adds or upgrades a membership. Idempotent on (user, tenant).
func (s *Service) AddMembership(ctx context.Context, userID, tenantID string, role MembershipRole) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?)
         ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role`, userID, tenantID, string(role))
	return err
}

// Membership is a user's tenant + role.
type Membership struct {
	TenantID string
	Role     MembershipRole
}

// PrimaryMembership is the owner membership if any, else the earliest one.
func (s *Service) PrimaryMembership(ctx context.Context, userID string) *Membership {
	var m Membership
	err := s.db.QueryRowContext(ctx, `SELECT tenant_id, role FROM memberships
          WHERE user_id = ?
          ORDER BY (role = 'owner') DESC, created_at ASC
          LIMIT 1`, userID).Scan(&m.TenantID, &m.Role)
	if err != nil {
		return nil
	}
	return &m
}

// RemoveMembership deletes a membership; true when a row was removed.
func (s *Service) RemoveMembership(ctx context.Context, userID, tenantID string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM memberships WHERE user_id = ? AND tenant_id = ?`, userID, tenantID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// MembershipCount is how many teams the user belongs to.
func (s *Service) MembershipCount(ctx context.Context, userID string) int {
	var n int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?`, userID).Scan(&n)
	return n
}

// DeleteUser hard-deletes a user row.
func (s *Service) DeleteUser(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
	return err
}

// ListMembers returns a team's members, oldest first.
func (s *Service) ListMembers(ctx context.Context, tenantID string) ([]TeamMember, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT u.id AS userId, u.email AS email, u.name AS name, m.role AS role,
                u.status AS status, u.is_superadmin AS isSuperadmin,
                m.created_at AS createdAt
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = ?
          ORDER BY m.created_at ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TeamMember{}
	for rows.Next() {
		var (
			m           TeamMember
			email, name sql.NullString
			status      sql.NullString
			superadmin  int
		)
		if err := rows.Scan(&m.UserID, &email, &name, &m.Role, &status, &superadmin, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.Email, m.Name = ptr(email), ptr(name)
		m.Status = status.String
		if !status.Valid {
			m.Status = "active"
		}
		m.IsSuperadmin = superadmin != 0
		out = append(out, m)
	}
	return out, rows.Err()
}

// FindMember returns one member of a tenant (nil when absent).
func (s *Service) FindMember(ctx context.Context, tenantID, userID string) (*TeamMember, error) {
	members, err := s.ListMembers(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for i := range members {
		if members[i].UserID == userID {
			return &members[i], nil
		}
	}
	return nil, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// uuid is crypto.randomUUID (RFC 4122 v4, lower-case).
func uuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(errors.New("crypto/rand unavailable"))
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
