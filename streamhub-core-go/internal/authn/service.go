// Package authn is the authentication module (modules/auth): the request
// validator behind the global guard (sk_ API tokens with IP allowlists, login
// JWTs, the break-glass admin), signup/login, API-token CRUD, active
// sessions, TOTP 2FA, passwordless magic links, "Mi cuenta", teams and
// tenant invites. Credential primitives live in package auth.
package authn

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

// jwtTTL is the lifetime of every session JWT (~12h).
const jwtTTL = 12 * time.Hour

// publicPathPrefixes bypass the validator even if a route forgot api.Public.
var publicPathPrefixes = []string{
	"/api/v1/health",
	"/api/v1/docs",
	"/api/v1/openapi.json",
	"/api/v1/play",
	"/api/v1/embed",
	"/api/v1/assets",
	"/api/v1/samples",
}

// Deps are the module's collaborators. Audit, Reputation, Quotas may be nil;
// NodeRole defaults to standalone and Mailer to LogMailer.
type Deps struct {
	Config     *config.Config
	DB         *sql.DB
	Tenancy    *tenancy.Service
	Quotas     *quotas.Service
	Audit      *audit.Service
	Reputation *security.Reputation
	NodeRole   NodeRole
	Mailer     Mailer
	Log        *slog.Logger
}

// Service is the auth module: AuthService + MagicLinkService + TotpService +
// AccountService over one set of dependencies.
type Service struct {
	cfg      *config.Config
	db       *sql.DB
	tenancy  *tenancy.Service
	quotas   *quotas.Service
	audit    *audit.Service
	rep      *security.Reputation
	nodeRole NodeRole
	mailer   Mailer
	log      *slog.Logger
	now      func() time.Time

	Sessions *Sessions
}

// New wires the module.
func New(d Deps) *Service {
	if d.NodeRole == nil {
		d.NodeRole = StandaloneNode{}
	}
	if d.Mailer == nil {
		d.Mailer = LogMailer{Log: d.Log}
	}
	return &Service{
		cfg: d.Config, db: d.DB, tenancy: d.Tenancy, quotas: d.Quotas, audit: d.Audit,
		rep: d.Reputation, nodeRole: d.NodeRole, mailer: d.Mailer, log: d.Log, now: time.Now,
		Sessions: NewSessions(d.DB, d.Log),
	}
}

// SetMailer late-binds the email module (wired by a later plane, before
// the server starts serving). nil is ignored.
func (s *Service) SetMailer(m Mailer) {
	if m != nil {
		s.mailer = m
	}
}

// Init creates the module-owned tables (sessions, magic_tokens).
func (s *Service) Init(ctx context.Context) {
	s.Sessions.Init(ctx)
	s.initMagic(ctx)
}

func (s *Service) offense(ip *string, kind security.OffenseKind) {
	if s.rep != nil && ip != nil {
		s.rep.RecordOffense(*ip, kind)
	}
}

// issueSessionToken mints a session row and a JWT carrying it as `sid`.
func (s *Service) issueSessionToken(ctx context.Context, userID string, email *string, secret string, sc SessionContext) (string, error) {
	sid, err := s.Sessions.Create(ctx, userID, email, sc)
	if err != nil {
		return "", err
	}
	return auth.SignJWT(map[string]any{"sub": userID, "sid": sid}, secret, jwtTTL)
}

// AllowSignup is STREAMHUB_PUBLIC_REGISTRATION (alias STREAMHUB_ALLOW_SIGNUP):
// the canonical flag wins whenever it is set.
func (s *Service) AllowSignup() bool {
	raw := s.cfg.Env("STREAMHUB_PUBLIC_REGISTRATION")
	if raw == "" {
		raw = s.cfg.Env("STREAMHUB_ALLOW_SIGNUP")
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "on", "yes":
		return true
	}
	return false
}

// requireSecret is the choke point of every human mint path: refused on a
// cluster edge, 401 when STREAMHUB_JWT_SECRET is unset.
func (s *Service) requireSecret(ctx context.Context) (string, error) {
	if s.nodeRole.Role(ctx) == "edge" {
		return "", httpx.Forbidden("cluster_edge_login_disabled")
	}
	return s.resolveJWTSecret()
}

// resolveJWTSecret is the validation-side lookup (no edge lock).
func (s *Service) resolveJWTSecret() (string, error) {
	if s.cfg.JWTSecret == "" {
		s.log.Warn("auth attempted but STREAMHUB_JWT_SECRET not configured")
		return "", httpx.Unauthorized("Login is not configured")
	}
	return s.cfg.JWTSecret, nil
}

// SignupInput is POST /auth/signup.
type SignupInput struct {
	Email, Password, TeamName string
}

// Signup creates a user + free-plan team + owner membership and signs in.
// With public registration OFF only an invited pending user may complete it.
func (s *Service) Signup(ctx context.Context, in SignupInput, sc SessionContext) (string, error) {
	secret, err := s.requireSecret(ctx)
	if err != nil {
		return "", err
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if email == "" || in.Password == "" {
		return "", httpx.BadRequest("email and password are required")
	}
	if s.cfg.AdminUser != "" && email == strings.ToLower(strings.TrimSpace(s.cfg.AdminUser)) {
		return "", httpx.BadRequest("email already in use")
	}
	existing := s.tenancy.GetUserByEmail(ctx, email)
	completesInvite := existing != nil && !hasPassword(existing) && existing.Status == "pending"
	if !s.AllowSignup() && !completesInvite {
		return "", httpx.Forbidden("signup_disabled")
	}
	if existing != nil && hasPassword(existing) {
		return "", httpx.BadRequest("email already in use")
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		return "", err
	}
	var userID string
	if existing != nil {
		userID = existing.ID
		if err := s.tenancy.SetPassword(ctx, userID, hash); err != nil {
			return "", err
		}
	} else if userID, err = s.tenancy.CreateUser(ctx, tenancy.CreateUserInput{Email: email, PasswordHash: &hash}); err != nil {
		return "", err
	}
	if s.tenancy.PrimaryMembership(ctx, userID) == nil {
		team := strings.TrimSpace(in.TeamName)
		if team == "" {
			team = email
		}
		tenantID, err := s.tenancy.CreateTeam(ctx, team, "")
		if err != nil {
			return "", err
		}
		if err := s.tenancy.AddMembership(ctx, userID, tenantID, tenancy.RoleOwner); err != nil {
			return "", err
		}
	}
	return s.issueSessionToken(ctx, userID, &email, secret, sc)
}

// Login: break-glass ADMIN_USER/ADMIN_PASS first (exempt from 2FA), then a
// built-in user by email (+ TOTP when enabled).
func (s *Service) Login(ctx context.Context, user, pass, code string, sc SessionContext) (string, error) {
	secret, err := s.requireSecret(ctx)
	if err != nil {
		return "", err
	}
	if s.cfg.AdminUser != "" && s.cfg.AdminPass != "" {
		userOK := safeEqual(user, s.cfg.AdminUser)
		passOK := safeEqual(pass, s.cfg.AdminPass)
		if userOK && passOK {
			admin := s.cfg.AdminUser
			return s.issueSessionToken(ctx, tenancy.AdminUserID, &admin, secret, sc)
		}
	}
	email := strings.ToLower(strings.TrimSpace(user))
	var row *tenancy.User
	if email != "" {
		row = s.tenancy.GetUserByEmail(ctx, email)
	}
	if row != nil && hasPassword(row) && row.Status != "pending" &&
		auth.VerifyPassword(pass, *row.PasswordHash) {
		if err := s.AssertLoginCode(ctx, row.ID, code); err != nil {
			s.offense(sc.IP, security.OffenseLoginFailed)
			return "", err
		}
		return s.issueSessionToken(ctx, row.ID, row.Email, secret, sc)
	}
	s.offense(sc.IP, security.OffenseLoginFailed)
	return "", httpx.Unauthorized("Invalid username or password")
}

func hasPassword(u *tenancy.User) bool { return u.PasswordHash != nil && *u.PasswordHash != "" }

func safeEqual(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ---------------------------------------------------------------------------
// Validator (api.Authenticator)
// ---------------------------------------------------------------------------

var bearerRe = regexp.MustCompile(`(?is)^Bearer\s+(.+)$`)

func extractBearer(r *http.Request) string {
	m := bearerRe.FindStringSubmatch(strings.TrimSpace(r.Header.Get("Authorization")))
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func isPublicPath(path string) bool {
	for _, p := range publicPathPrefixes {
		if path == p || strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
}

// tokenRow is an api_tokens row.
type tokenRow struct {
	id                   int64
	name, scope          string
	appID                *int64
	tenantID, allowedIPs *string
	lastUsedAt           *string
	createdAt            string
	revoked              bool
}

const tokenColumns = `id, name, scope, app_id, tenant_id, allowed_ips_json, last_used_at, created_at, revoked`

func scanToken(sc interface{ Scan(...any) error }) (*tokenRow, error) {
	var (
		t                 tokenRow
		app               sql.NullInt64
		tenant, ips, used sql.NullString
		revoked           int
	)
	if err := sc.Scan(&t.id, &t.name, &t.scope, &app, &tenant, &ips, &used, &t.createdAt, &revoked); err != nil {
		return nil, err
	}
	if app.Valid {
		t.appID = &app.Int64
	}
	t.tenantID, t.allowedIPs, t.lastUsedAt = nullable(tenant), nullable(ips), nullable(used)
	t.revoked = revoked != 0
	return &t, nil
}

// Authenticate implements api.Authenticator (AuthService.validate). A nil
// principal with a nil error is the public-path context.
func (s *Service) Authenticate(r *http.Request) (*auth.Principal, error) {
	if isPublicPath(r.URL.Path) {
		return nil, nil
	}
	ctx := r.Context()
	token := extractBearer(r)
	if token == "" {
		return nil, httpx.Unauthorized("Missing Bearer token")
	}
	if !strings.HasPrefix(token, auth.APITokenPrefix) {
		return s.validateJWT(ctx, r, token)
	}
	row, err := scanToken(s.db.QueryRowContext(ctx, `SELECT `+tokenColumns+` FROM api_tokens
          WHERE token_hash = ? AND revoked = 0 LIMIT 1`, auth.HashToken(token)))
	if err != nil {
		s.offense(strPtr(httpx.ClientIP(r)), security.OffenseInvalidToken)
		return nil, httpx.Unauthorized("Invalid or revoked API token")
	}
	allowed, err := ipAllowed(row, httpx.ClientIP(r))
	if err != nil {
		return nil, err // non-string whitelist entry: Node throws → generic 401
	}
	if !allowed {
		s.log.Warn(fmt.Sprintf("token %d (%s) rejected: client IP not in whitelist", row.id, row.name))
		return nil, httpx.Unauthorized("Client IP not allowed for this token")
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`, row.id); err != nil {
		s.log.Debug(fmt.Sprintf("failed to update last_used_at for token %d", row.id), "err", err)
	}
	isGlobal := row.scope == "global"
	p := &auth.Principal{
		UserID:       "token:" + strconv.FormatInt(row.id, 10),
		TenantID:     auth.PlatformTenantID,
		Role:         auth.RoleService,
		IsSuperadmin: isGlobal,
		Scope:        auth.ScopeApp,
		Via:          auth.ViaAPIToken,
		TokenID:      row.id,
		AppID:        row.appID,
	}
	if row.tenantID != nil {
		p.TenantID = *row.tenantID
	}
	if isGlobal {
		p.Scope = auth.ScopeGlobal
	}
	return p, nil
}

func (s *Service) validateJWT(ctx context.Context, r *http.Request, token string) (*auth.Principal, error) {
	secret, err := s.resolveJWTSecret()
	if err != nil {
		return nil, err
	}
	claims, err := auth.VerifyJWT(token, secret)
	if err != nil {
		s.offense(strPtr(httpx.ClientIP(r)), security.OffenseInvalidToken)
		return nil, httpx.Unauthorized("Invalid or expired token")
	}
	sub := claims.String("sub")
	if sub == "" {
		return nil, httpx.Unauthorized("Invalid or expired token")
	}
	sid := claims.String("sid")
	if sid != "" {
		if !s.Sessions.IsActive(ctx, sid) {
			return nil, httpx.Unauthorized("Session revoked or expired")
		}
		s.Sessions.Touch(ctx, sid)
	}
	user := s.tenancy.GetUser(ctx, sub)
	isLegacyAdmin := s.cfg.AdminUser != "" && sub == s.cfg.AdminUser
	if sub == tenancy.AdminUserID || isLegacyAdmin || (user != nil && user.IsSuperadmin) {
		email := s.cfg.AdminUser
		if user != nil && user.Email != nil {
			email = *user.Email
		}
		return &auth.Principal{
			UserID: tenancy.AdminUserID, TenantID: auth.PlatformTenantID, Role: auth.RoleSuperadmin,
			IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAdminJWT, Email: &email, SessionID: sid,
		}, nil
	}
	if user == nil {
		return nil, httpx.Unauthorized("Invalid or expired token")
	}
	p := &auth.Principal{
		UserID: user.ID, Role: auth.RoleViewer, Scope: auth.ScopeUser, Via: auth.ViaUserJWT,
		Email: user.Email, SessionID: sid,
	}
	if m := s.tenancy.PrimaryMembership(ctx, user.ID); m != nil {
		p.TenantID, p.Role = m.TenantID, auth.Role(m.Role)
	}
	return p, nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ipAllowed: no whitelist (or corrupt JSON) → allowed; otherwise an exact
// match or an IPv4 CIDR match on the proxy-validated client IP.
func ipAllowed(row *tokenRow, clientIP string) (bool, error) {
	if row.allowedIPs == nil || *row.allowedIPs == "" {
		return true, nil
	}
	var list []any
	if err := json.Unmarshal([]byte(*row.allowedIPs), &list); err != nil || len(list) == 0 {
		return true, nil
	}
	ip := strings.TrimPrefix(clientIP, "::ffff:")
	if ip == "" {
		return false, nil
	}
	for _, e := range list {
		entry, ok := e.(string)
		if !ok {
			return false, errors.New("allowed_ips_json entry is not a string")
		}
		if ipMatches(ip, strings.TrimSpace(entry)) {
			return true, nil
		}
	}
	return false, nil
}

func ipMatches(ip, entry string) bool {
	if entry == "" {
		return false
	}
	if entry == ip {
		return true
	}
	return strings.Contains(entry, "/") && cidrMatchV4(ip, entry)
}

func cidrMatchV4(ip, cidr string) bool {
	rng, bitsStr, _ := strings.Cut(cidr, "/")
	bits, ok := config.ParseIntPrefix(bitsStr)
	if !ok || bits < 0 || bits > 32 {
		return false
	}
	ipN, ok1 := ipv4ToInt(ip)
	rngN, ok2 := ipv4ToInt(rng)
	if !ok1 || !ok2 {
		return false
	}
	if bits == 0 {
		return true
	}
	mask := uint32(0xffffffff) << (32 - bits)
	return ipN&mask == rngN&mask
}

// ipv4ToInt mirrors the Node helper: each part through Number(), which
// must be an integer 0..255.
func ipv4ToInt(ip string) (uint32, bool) {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return 0, false
	}
	var n uint32
	for _, p := range parts {
		v, ok := jsNumber(p)
		if !ok || v != math.Trunc(v) || v < 0 || v > 255 {
			return 0, false
		}
		n = n<<8 | uint32(v)
	}
	return n, true
}

// jsNumber is Number(string): trimmed, "" → 0, 0x/0o/0b prefixes, decimals
// with exponents; anything else is NaN (ok=false).
func jsNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, true
	}
	if len(s) > 2 && s[0] == '0' {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
		if base != 0 {
			n, err := strconv.ParseUint(s[2:], base, 64)
			return float64(n), err == nil
		}
	}
	if strings.ContainsAny(s, "_xXnNiI") { // ParseFloat extras JS rejects (inf, nan, 0x…)
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}

// ---------------------------------------------------------------------------
// API tokens (/tokens)
// ---------------------------------------------------------------------------

// TokenSummary is GET /tokens (hashes never returned).
type TokenSummary struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	Scope      string  `json:"scope"`
	AppID      *int64  `json:"appId"`
	LastUsedAt *string `json:"lastUsedAt"`
	CreatedAt  string  `json:"createdAt"`
	Revoked    bool    `json:"revoked"`
}

// CreatedToken carries the plaintext ONCE.
type CreatedToken struct {
	ID    int64  `json:"id"`
	Token string `json:"token"`
}

// ListTokens returns every token, newest first.
func (s *Service) ListTokens(ctx context.Context) ([]TokenSummary, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+tokenColumns+` FROM api_tokens ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TokenSummary{}
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, TokenSummary{t.id, t.name, t.scope, t.appID, t.lastUsedAt, t.createdAt, t.revoked})
	}
	return out, rows.Err()
}

// CreateTokenInput is POST /tokens.
type CreateTokenInput struct {
	Name       string
	Scope      string
	AppID      *int64
	AllowedIPs []string
}

// CreateToken mints a token; only its sha256 is stored. App tokens are pinned
// to the app's tenant, global ones to the platform tenant (M2).
func (s *Service) CreateToken(ctx context.Context, in CreateTokenInput) (*CreatedToken, error) {
	var appID *int64
	tenantID := auth.PlatformTenantID
	if in.Scope == "app" {
		if in.AppID == nil {
			return nil, httpx.BadRequest("appId is required when scope=app")
		}
		var id int64
		if err := s.db.QueryRowContext(ctx, `SELECT id FROM apps WHERE id = ?`, *in.AppID).Scan(&id); err != nil {
			return nil, httpx.BadRequest(fmt.Sprintf("app %d does not exist", *in.AppID))
		}
		appID = in.AppID
		if t := s.tenancy.TenantForAppID(ctx, id); t != "" {
			tenantID = t
		}
	} else if in.AppID != nil {
		return nil, httpx.BadRequest("appId is only valid when scope=app")
	}
	var ipsJSON *string
	var cleaned []string
	for _, ip := range in.AllowedIPs {
		if t := strings.TrimSpace(ip); t != "" {
			cleaned = append(cleaned, t)
		}
	}
	if len(cleaned) > 0 {
		b, _ := json.Marshal(cleaned)
		js := string(b)
		ipsJSON = &js
	}
	plaintext := auth.GenerateAPIToken()
	res, err := s.db.ExecContext(ctx, `INSERT INTO api_tokens (name, token_hash, scope, app_id, tenant_id, allowed_ips_json)
         VALUES (?, ?, ?, ?, ?, ?)`, in.Name, auth.HashToken(plaintext), in.Scope, appID, tenantID, ipsJSON)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &CreatedToken{ID: id, Token: plaintext}, nil
}

// RevokeToken soft-deletes a token (400 when unknown).
func (s *Service) RevokeToken(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `UPDATE api_tokens SET revoked = 1 WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return httpx.BadRequest(fmt.Sprintf("token %d not found", id))
	}
	return nil
}
