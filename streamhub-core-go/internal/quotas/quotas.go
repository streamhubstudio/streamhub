// Package quotas is tenant quota accounting + enforcement and the superadmin
// tenant administration (modules/quotas). Enforcement is phased exactly like
// authz (STREAMHUB_AUTHZ_ENFORCE); superadmin, api_token and unscoped
// callers are never quota-limited. Every table/column it depends on is
// probed first and degrades to "unlimited / zero usage" when absent.
package quotas

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

// TenantQuotas are a tenant's limits (-1 = unlimited).
type TenantQuotas struct {
	MaxApps                  int64 `json:"maxApps"`
	MaxConcurrentStreams     int64 `json:"maxConcurrentStreams"`
	MaxRecordingMinutesMonth int64 `json:"maxRecordingMinutesMonth"`
	MaxEgressGBMonth         int64 `json:"maxEgressGbMonth"`
	MaxStorageGB             int64 `json:"maxStorageGb"`
}

// TenantUsage is a consumption snapshot.
type TenantUsage struct {
	Apps                  int64   `json:"apps"`
	ConcurrentStreams     int64   `json:"concurrentStreams"`
	RecordingMinutesMonth float64 `json:"recordingMinutesMonth"`
	EgressGBMonth         float64 `json:"egressGbMonth"`
	StorageGB             float64 `json:"storageGb"`
}

// Exceeded are the per-metric over-limit flags.
type Exceeded struct {
	Apps                  bool `json:"apps"`
	ConcurrentStreams     bool `json:"concurrentStreams"`
	RecordingMinutesMonth bool `json:"recordingMinutesMonth"`
	EgressGBMonth         bool `json:"egressGbMonth"`
	StorageGB             bool `json:"storageGb"`
}

// UsageReport is GET /tenants/:id/usage.
type UsageReport struct {
	TenantID string       `json:"tenantId"`
	Plan     string       `json:"plan"`
	Quotas   TenantQuotas `json:"quotas"`
	Usage    TenantUsage  `json:"usage"`
	Exceeded Exceeded     `json:"exceeded"`
}

// TenantSummary is a tenant + effective quota (Superadmin Tenants screen).
type TenantSummary struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Plan      string       `json:"plan"`
	CreatedAt string       `json:"createdAt"`
	Quotas    TenantQuotas `json:"quotas"`
	AppCount  int64        `json:"appCount"`
}

// UpdateInput is a PATCH /tenants/:id/quotas body (nil = unchanged).
type UpdateInput struct {
	Plan                     *string
	MaxApps                  *int64
	MaxConcurrentStreams     *int64
	MaxRecordingMinutesMonth *int64
	MaxEgressGBMonth         *int64
	MaxStorageGB             *int64
}

var defaultQuotas = TenantQuotas{2, 2, 300, 5, 5}

// AppDB opens a per-app DB (db.Service.App).
type AppDB func(ctx context.Context, app string) (*sql.DB, error)

// Service is QuotasService.
type Service struct {
	db    *sql.DB
	appDB AppDB
	log   *slog.Logger

	mu       sync.Mutex
	tables   map[string]bool
	colCache map[string]map[string]bool
	now      func() time.Time
}

// New builds the service over the global DB and the per-app opener.
func New(global *sql.DB, appDB AppDB, log *slog.Logger) *Service {
	return &Service{db: global, appDB: appDB, log: log, tables: map[string]bool{}, colCache: map[string]map[string]bool{}, now: time.Now}
}

// ---------------------------------------------------------------------------
// enforcement entry points
// ---------------------------------------------------------------------------

// EnforceCreateApp: tenant must be under maxApps.
func (s *Service) EnforceCreateApp(ctx context.Context, p *auth.Principal) error {
	return s.enforce(ctx, p, "maxApps", func() float64 { return float64(s.countApps(ctx, p.TenantID)) })
}

// EnforceConcurrentStreams: under maxConcurrentStreams.
func (s *Service) EnforceConcurrentStreams(ctx context.Context, p *auth.Principal) error {
	return s.enforce(ctx, p, "maxConcurrentStreams", func() float64 { return float64(s.countConcurrentStreams(ctx, p.TenantID)) })
}

// EnforceRecordingMinutes: under the monthly recording budget.
func (s *Service) EnforceRecordingMinutes(ctx context.Context, p *auth.Principal) error {
	return s.enforce(ctx, p, "maxRecordingMinutesMonth", func() float64 { return s.monthlyUsage(ctx, p.TenantID).RecordingMinutesMonth })
}

// EnforceEgress: under the monthly egress budget.
func (s *Service) EnforceEgress(ctx context.Context, p *auth.Principal) error {
	return s.enforce(ctx, p, "maxEgressGbMonth", func() float64 { return s.monthlyUsage(ctx, p.TenantID).EgressGBMonth })
}

// EnforceAppConcurrentStreams: per-app cap; limit <= 0 = unlimited.
func (s *Service) EnforceAppConcurrentStreams(ctx context.Context, app string, limit float64, p *auth.Principal) error {
	return s.enforceScoped(p, "app", "maxConcurrentStreams", limit, func() float64 { return float64(s.CountAppConcurrentStreams(ctx, app)) })
}

// EnforceStreamViewers: per-stream cap with a caller-supplied count.
func (s *Service) EnforceStreamViewers(limit, current float64, p *auth.Principal) error {
	return s.enforceScoped(p, "stream", "maxViewersPerStream", limit, func() float64 { return current })
}

// CountAppConcurrentStreams counts active streams of one app (0 on error).
func (s *Service) CountAppConcurrentStreams(ctx context.Context, app string) int64 {
	h, err := s.appDB(ctx, app)
	if err != nil {
		return 0
	}
	var n int64
	if err := h.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM streams WHERE status = 'active'`).Scan(&n); err != nil {
		return 0
	}
	return n
}

type quotaExceeded struct {
	Error  string  `json:"error"`
	Metric string  `json:"metric"`
	Limit  float64 `json:"limit"`
	Used   float64 `json:"used"`
}

type scopedExceeded struct {
	Error  string  `json:"error"`
	Scope  string  `json:"scope"`
	Metric string  `json:"metric"`
	Limit  float64 `json:"limit"`
	Used   float64 `json:"used"`
}

func (s *Service) enforce(ctx context.Context, p *auth.Principal, metric string, current func() float64) error {
	mode := authz.Mode()
	if mode == authz.ModeOff || p == nil || p.IsSuperadmin || p.Via == auth.ViaAPIToken || p.TenantID == "" {
		return nil
	}
	q := s.quotasFor(ctx, p.TenantID)
	limit := map[string]int64{
		"maxApps":                  q.MaxApps,
		"maxConcurrentStreams":     q.MaxConcurrentStreams,
		"maxRecordingMinutesMonth": q.MaxRecordingMinutesMonth,
		"maxEgressGbMonth":         q.MaxEgressGBMonth,
	}[metric]
	if limit < 0 {
		return nil
	}
	used := current()
	if used < float64(limit) {
		return nil
	}
	msg := fmt.Sprintf("tenant '%s' over quota %s: %v/%d", p.TenantID, metric, used, limit)
	if mode == authz.ModeOn {
		s.log.Warn("QUOTA-DENY " + msg)
		return &httpx.Error{Status: 429, Body: quotaExceeded{"quota_exceeded", metric, float64(limit), used}}
	}
	s.log.Warn("QUOTA-WOULD-DENY " + msg)
	return nil
}

func (s *Service) enforceScoped(p *auth.Principal, scope, metric string, limit float64, current func() float64) error {
	if math.IsNaN(limit) || math.IsInf(limit, 0) || limit <= 0 {
		return nil
	}
	mode := authz.Mode()
	if mode == authz.ModeOff || p == nil || p.IsSuperadmin || p.Via == auth.ViaAPIToken {
		return nil
	}
	used := current()
	if used < limit {
		return nil
	}
	msg := fmt.Sprintf("%s over quota %s: %v/%v", scope, metric, used, limit)
	if mode == authz.ModeOn {
		s.log.Warn("QUOTA-DENY " + msg)
		return &httpx.Error{Status: 429, Body: scopedExceeded{scope + "_quota_exceeded", scope, metric, limit, used}}
	}
	s.log.Warn("QUOTA-WOULD-DENY " + msg)
	return nil
}

// ---------------------------------------------------------------------------
// reporting + administration
// ---------------------------------------------------------------------------

// GetUsage is the usage report of a tenant.
func (s *Service) GetUsage(ctx context.Context, tenantID string) UsageReport {
	q := s.quotasFor(ctx, tenantID)
	m := s.monthlyUsage(ctx, tenantID)
	u := TenantUsage{
		Apps:                  s.countApps(ctx, tenantID),
		ConcurrentStreams:     s.countConcurrentStreams(ctx, tenantID),
		RecordingMinutesMonth: m.RecordingMinutesMonth,
		EgressGBMonth:         m.EgressGBMonth,
		StorageGB:             m.StorageGB,
	}
	return UsageReport{
		TenantID: tenantID,
		Plan:     s.planFor(ctx, tenantID),
		Quotas:   q,
		Usage:    u,
		Exceeded: Exceeded{
			Apps:                  over(float64(u.Apps), q.MaxApps),
			ConcurrentStreams:     over(float64(u.ConcurrentStreams), q.MaxConcurrentStreams),
			RecordingMinutesMonth: over(u.RecordingMinutesMonth, q.MaxRecordingMinutesMonth),
			EgressGBMonth:         over(u.EgressGBMonth, q.MaxEgressGBMonth),
			StorageGB:             over(u.StorageGB, q.MaxStorageGB),
		},
	}
}

func over(used float64, limit int64) bool { return limit >= 0 && used >= float64(limit) }

// ListTenants is every tenant + effective quota, oldest first.
func (s *Service) ListTenants(ctx context.Context) []TenantSummary {
	out := []TenantSummary{}
	if !s.tableExists(ctx, "tenants") {
		return out
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, plan, created_at FROM tenants ORDER BY created_at ASC, id ASC`)
	if err != nil {
		return out
	}
	type tr struct {
		id, name, created string
		plan              sql.NullString
	}
	var list []tr
	for rows.Next() {
		var r tr
		if rows.Scan(&r.id, &r.name, &r.plan, &r.created) == nil {
			list = append(list, r)
		}
	}
	rows.Close()
	for _, r := range list {
		out = append(out, s.summary(ctx, r.id, r.name, r.plan, r.created))
	}
	return out
}

// GetTenantSummary returns one tenant or nil.
func (s *Service) GetTenantSummary(ctx context.Context, id string) *TenantSummary {
	if !s.tableExists(ctx, "tenants") {
		return nil
	}
	var (
		name, created string
		plan          sql.NullString
	)
	if err := s.db.QueryRowContext(ctx, `SELECT id, name, plan, created_at FROM tenants WHERE id = ?`, id).Scan(&id, &name, &plan, &created); err != nil {
		return nil
	}
	sum := s.summary(ctx, id, name, plan, created)
	return &sum
}

func (s *Service) summary(ctx context.Context, id, name string, plan sql.NullString, created string) TenantSummary {
	p := plan.String
	if !plan.Valid {
		p = "free"
	}
	return TenantSummary{ID: id, Name: name, Plan: p, CreatedAt: created, Quotas: s.quotasFor(ctx, id), AppCount: s.countApps(ctx, id)}
}

// SetQuotas merges a patch onto the tenant's effective quota (a known plan
// preset becomes the baseline; explicit per-metric values still win).
func (s *Service) SetQuotas(ctx context.Context, id string, in UpdateInput) (*TenantSummary, error) {
	existing := s.GetTenantSummary(ctx, id)
	if existing == nil {
		return nil, httpx.NotFound(fmt.Sprintf("tenant '%s' not found", id))
	}
	if in.Plan != nil {
		if _, err := s.db.ExecContext(ctx, `UPDATE tenants SET plan = ? WHERE id = ?`, *in.Plan, id); err != nil {
			return nil, err
		}
	}
	if s.tableExists(ctx, "quotas") {
		base := existing.Quotas
		if in.Plan != nil {
			if pq, ok := tenancy.PlanQuotas[*in.Plan]; ok {
				base = TenantQuotas{pq.MaxApps, pq.MaxConcurrentStreams, pq.MaxRecordingMinutesMonth, pq.MaxEgressGBMonth, pq.MaxStorageGB}
			}
		}
		pick := func(v *int64, d int64) int64 {
			if v != nil {
				return *v
			}
			return d
		}
		m := TenantQuotas{
			pick(in.MaxApps, base.MaxApps),
			pick(in.MaxConcurrentStreams, base.MaxConcurrentStreams),
			pick(in.MaxRecordingMinutesMonth, base.MaxRecordingMinutesMonth),
			pick(in.MaxEgressGBMonth, base.MaxEgressGBMonth),
			pick(in.MaxStorageGB, base.MaxStorageGB),
		}
		if _, err := s.db.ExecContext(ctx, `INSERT INTO quotas
             (tenant_id, max_apps, max_concurrent_streams,
              max_recording_minutes_month, max_egress_gb_month, max_storage_gb)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id) DO UPDATE SET
             max_apps = excluded.max_apps,
             max_concurrent_streams = excluded.max_concurrent_streams,
             max_recording_minutes_month = excluded.max_recording_minutes_month,
             max_egress_gb_month = excluded.max_egress_gb_month,
             max_storage_gb = excluded.max_storage_gb`,
			id, m.MaxApps, m.MaxConcurrentStreams, m.MaxRecordingMinutesMonth, m.MaxEgressGBMonth, m.MaxStorageGB); err != nil {
			return nil, err
		}
	}
	return s.GetTenantSummary(ctx, id), nil
}

// ---------------------------------------------------------------------------
// quota resolution + usage counting (defensive)
// ---------------------------------------------------------------------------

func (s *Service) quotasFor(ctx context.Context, tenantID string) TenantQuotas {
	if s.tableExists(ctx, "quotas") {
		var v [5]sql.NullFloat64
		err := s.db.QueryRowContext(ctx, `SELECT max_apps, max_concurrent_streams, max_recording_minutes_month,
		  max_egress_gb_month, max_storage_gb FROM quotas WHERE tenant_id = ?`, tenantID).Scan(&v[0], &v[1], &v[2], &v[3], &v[4])
		if err == nil {
			n := func(x sql.NullFloat64, d int64) int64 {
				switch {
				case !x.Valid:
					return d
				case x.Float64 >= 0:
					return int64(x.Float64)
				case x.Float64 == -1:
					return -1
				}
				return d
			}
			return TenantQuotas{
				n(v[0], defaultQuotas.MaxApps), n(v[1], defaultQuotas.MaxConcurrentStreams),
				n(v[2], defaultQuotas.MaxRecordingMinutesMonth), n(v[3], defaultQuotas.MaxEgressGBMonth),
				n(v[4], defaultQuotas.MaxStorageGB),
			}
		}
	}
	// Forward-compat fallback: tenants.quotas_json, then the defaults.
	q := defaultQuotas
	if !s.columns(ctx, "tenants")["quotas_json"] {
		return q
	}
	var raw sql.NullString
	if s.db.QueryRowContext(ctx, `SELECT quotas_json FROM tenants WHERE id = ?`, tenantID).Scan(&raw) != nil || !raw.Valid {
		return q
	}
	var m map[string]any
	_ = json.Unmarshal([]byte(raw.String), &m)
	pickJSON := func(snake, camel string, d int64) int64 {
		v, ok := m[snake]
		if !ok || v == nil {
			v = m[camel]
		}
		if f, ok := v.(float64); ok {
			return int64(f)
		}
		return d
	}
	return TenantQuotas{
		pickJSON("max_apps", "maxApps", q.MaxApps),
		pickJSON("max_concurrent_streams", "maxConcurrentStreams", q.MaxConcurrentStreams),
		pickJSON("max_recording_minutes_month", "maxRecordingMinutesMonth", q.MaxRecordingMinutesMonth),
		pickJSON("max_egress_gb_month", "maxEgressGbMonth", q.MaxEgressGBMonth),
		pickJSON("max_storage_gb", "maxStorageGb", q.MaxStorageGB),
	}
}

func (s *Service) planFor(ctx context.Context, tenantID string) string {
	if s.tableExists(ctx, "tenants") && s.columns(ctx, "tenants")["plan"] {
		var plan sql.NullString
		if s.db.QueryRowContext(ctx, `SELECT plan FROM tenants WHERE id = ?`, tenantID).Scan(&plan) == nil && plan.String != "" {
			return plan.String
		}
	}
	return "free"
}

func (s *Service) appsForTenant(ctx context.Context, tenantID string) []string {
	if !s.columns(ctx, "apps")["tenant_id"] {
		return nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT name FROM apps WHERE tenant_id = ?`, tenantID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			out = append(out, n)
		}
	}
	return out
}

func (s *Service) countApps(ctx context.Context, tenantID string) int64 {
	if !s.columns(ctx, "apps")["tenant_id"] {
		return 0
	}
	var n int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM apps WHERE tenant_id = ?`, tenantID).Scan(&n); err != nil {
		return 0
	}
	return n
}

func (s *Service) countConcurrentStreams(ctx context.Context, tenantID string) int64 {
	var total int64
	for _, app := range s.appsForTenant(ctx, tenantID) {
		total += s.CountAppConcurrentStreams(ctx, app)
	}
	return total
}

type monthly struct{ RecordingMinutesMonth, EgressGBMonth, StorageGB float64 }

// monthlyUsage reads the optional quota_usage table (zeros when absent).
func (s *Service) monthlyUsage(ctx context.Context, tenantID string) monthly {
	var zero monthly
	if !s.tableExists(ctx, "quota_usage") {
		return zero
	}
	cols := s.columns(ctx, "quota_usage")
	q, args := `SELECT * FROM quota_usage WHERE tenant_id = ?`, []any{tenantID}
	if cols["period"] {
		q, args = q+` AND period = ?`, append(args, s.now().UTC().Format("2006-01"))
	}
	rows, err := s.db.QueryContext(ctx, q+` LIMIT 1`, args...)
	if err != nil {
		return zero
	}
	defer rows.Close()
	names, _ := rows.Columns()
	if !rows.Next() {
		return zero
	}
	vals := make([]any, len(names))
	ptrs := make([]any, len(names))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if rows.Scan(ptrs...) != nil {
		return zero
	}
	num := func(col string) float64 {
		for i, n := range names {
			if n == col {
				switch v := vals[i].(type) {
				case int64:
					return float64(v)
				case float64:
					return v
				}
			}
		}
		return 0
	}
	return monthly{num("recording_minutes_month"), num("egress_gb_month"), num("storage_gb")}
}

func (s *Service) tableExists(ctx context.Context, table string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.tables[table]; ok {
		return v
	}
	var name string
	exists := s.db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, table).Scan(&name) == nil
	s.tables[table] = exists
	return exists
}

func (s *Service) columns(ctx context.Context, table string) map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.colCache[table]; ok {
		return c
	}
	set := map[string]bool{}
	if rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`PRAGMA table_info(%s)`, table)); err == nil {
		for rows.Next() {
			var (
				cid, notnull, pk int
				name, typ        string
				dflt             sql.NullString
			)
			if rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk) == nil {
				set[name] = true
			}
		}
		rows.Close()
	}
	s.colCache[table] = set
	return set
}
