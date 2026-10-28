// Package audit is the append-only, hash-chained security audit trail
// (modules/audit/audit.service.ts + audit.controller.ts; ISO 27002 §8.15).
// Every security-relevant event is appended to the global `audit_log` table;
// SQLite triggers reject UPDATE/DELETE, and the only sanctioned delete is the
// retention purge, which drops and re-arms the delete guard in a transaction.
package audit

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// ActorType is who performed an audited action.
type ActorType string

const (
	ActorUser      ActorType = "user"
	ActorToken     ActorType = "token"
	ActorAdmin     ActorType = "admin"
	ActorSystem    ActorType = "system"
	ActorAnonymous ActorType = "anonymous"
)

// Result is the outcome of the audited action.
type Result string

const (
	Success Result = "success"
	Failure Result = "failure"
	Deny    Result = "deny"
)

// Event is one security-relevant event. Empty strings are stored as NULL.
// Meta is serialized like JSON.stringify — pass a struct to keep key order —
// and MUST NEVER contain secrets.
type Event struct {
	Action     string
	ActorType  ActorType // "" = system
	ActorID    *string
	TenantID   *string
	TargetType *string
	TargetID   *string
	IP         *string
	Result     Result // "" = success
	Meta       any
}

// AuditEntry is a persisted entry (GET /system/audit).
type AuditEntry struct {
	ID         int64           `json:"id"`
	Ts         string          `json:"ts"`
	ActorType  string          `json:"actorType"`
	ActorID    *string         `json:"actorId"`
	TenantID   *string         `json:"tenantId"`
	Action     string          `json:"action"`
	TargetType *string         `json:"targetType"`
	TargetID   *string         `json:"targetId"`
	IP         *string         `json:"ip"`
	Result     string          `json:"result"`
	Meta       json.RawMessage `json:"meta"`
}

// Query filters (all optional).
type Query struct {
	Action string // prefix
	Actor  string // exact actor_id
	Result string
	From   string
	To     string
	Limit  *int
	Offset *int
}

// AuditPage is a query result.
type AuditPage struct {
	Entries []AuditEntry `json:"entries"`
	Total   int          `json:"total"`
	Limit   int          `json:"limit"`
	Offset  int          `json:"offset"`
}

// AuditChainReport is the hash-chain verification result.
type AuditChainReport struct {
	OK       bool   `json:"ok"`
	Checked  int    `json:"checked"`
	BrokenAt *int64 `json:"brokenAt"`
}

const (
	defaultLimit   = 50
	maxLimit       = 500
	maxMetaBytes   = 4096
	verifyMaxRows  = 10_000
	purgeKickoff   = 90 * time.Second
	purgeEvery     = 6 * time.Hour
	RetentionEnv   = "STREAMHUB_AUDIT_RETENTION_DAYS"
	DefaultRetDays = 90
)

const deleteGuardSQL = `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
       BEFORE DELETE ON audit_log
       BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`

const schemaSQL = `CREATE TABLE IF NOT EXISTS audit_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         actor_type TEXT NOT NULL,
         actor_id TEXT,
         tenant_id TEXT,
         action TEXT NOT NULL,
         target_type TEXT,
         target_id TEXT,
         ip TEXT,
         result TEXT NOT NULL DEFAULT 'success'
           CHECK (result IN ('success', 'failure', 'deny')),
         meta_json TEXT,
         prev_hash TEXT,
         hash TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
       CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
       CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
       CREATE TRIGGER IF NOT EXISTS audit_log_no_update
         BEFORE UPDATE ON audit_log
         BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
       ` + deleteGuardSQL + `;`

// Service is the audit trail.
type Service struct {
	db  *sql.DB
	env func(string) string
	log *slog.Logger
	now func() time.Time
}

// New builds the service over the global DB; env is the raw env getter.
func New(global *sql.DB, env func(string) string, log *slog.Logger) *Service {
	return &Service{db: global, env: env, log: log, now: time.Now}
}

// Init creates the table + triggers (idempotent, never fatal).
func (s *Service) Init(ctx context.Context) {
	if _, err := s.db.ExecContext(ctx, schemaSQL); err != nil {
		s.log.Error("audit_log bootstrap failed (continuing)", "err", err)
	}
}

// Start runs the retention passes: 90s after boot, then every 6h.
func (s *Service) Start(ctx context.Context) {
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(purgeKickoff):
			s.PurgeExpired(ctx)
		}
		t := time.NewTicker(purgeEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.PurgeExpired(ctx)
			}
		}
	}()
}

// RetentionDays is STREAMHUB_AUDIT_RETENTION_DAYS (default 90, 0 = forever).
func (s *Service) RetentionDays() int {
	raw := s.env(RetentionEnv)
	if strings.TrimSpace(raw) == "" {
		return DefaultRetDays
	}
	n, ok := config.ParseIntPrefix(raw)
	if !ok || n < 0 {
		return DefaultRetDays
	}
	return n
}

// Count is the number of entries in the trail.
func (s *Service) Count(ctx context.Context) int {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM audit_log`).Scan(&n); err != nil {
		return 0
	}
	return n
}

// Record appends one event. Fire-and-forget: failures are logged, never returned.
func (s *Service) Record(ctx context.Context, e Event) {
	if s == nil {
		return
	}
	if err := s.record(ctx, e); err != nil {
		s.log.Warn("audit record failed for '"+e.Action+"'", "err", err)
	}
}

func (s *Service) record(ctx context.Context, e Event) error {
	ts := jsx.ISO(s.now())
	actorType := e.ActorType
	if actorType == "" {
		actorType = ActorSystem
	}
	result := e.Result
	if result == "" {
		result = Success
	}
	metaJSON := serializeMeta(e.Meta)
	tx, err := s.db.BeginTx(context.WithoutCancel(ctx), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var prev sql.NullString
	if err := tx.QueryRow(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`).Scan(&prev); err != nil && err != sql.ErrNoRows {
		return err
	}
	fields := []*string{&ts, (*string)(&actorType), e.ActorID, e.TenantID, &e.Action, e.TargetType, e.TargetID, e.IP, (*string)(&result), metaJSON}
	prevHash := ptr(prev)
	hash := chainHash(prevHash, fields)
	if _, err := tx.Exec(`INSERT INTO audit_log
             (ts, actor_type, actor_id, tenant_id, action, target_type,
              target_id, ip, result, meta_json, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ts, string(actorType), e.ActorID, e.TenantID, e.Action, e.TargetType, e.TargetID, e.IP, string(result), metaJSON, prevHash, hash); err != nil {
		return err
	}
	return tx.Commit()
}

// Query reads the trail newest first.
func (s *Service) Query(ctx context.Context, q Query) (AuditPage, error) {
	limit := defaultLimit
	if q.Limit != nil {
		limit = min(max(1, *q.Limit), maxLimit)
	}
	offset := 0
	if q.Offset != nil {
		offset = max(0, *q.Offset)
	}
	var where []string
	var params []any
	if q.Action != "" {
		where = append(where, `action LIKE ? ESCAPE '\'`)
		r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
		params = append(params, r.Replace(q.Action)+"%")
	}
	if q.Actor != "" {
		where, params = append(where, "actor_id = ?"), append(params, q.Actor)
	}
	if q.Result != "" {
		where, params = append(where, "result = ?"), append(params, q.Result)
	}
	if q.From != "" {
		where, params = append(where, "ts >= ?"), append(params, q.From)
	}
	if q.To != "" {
		where, params = append(where, "ts <= ?"), append(params, q.To)
	}
	clause := ""
	if len(where) > 0 {
		clause = " WHERE " + strings.Join(where, " AND ")
	}
	page := AuditPage{Entries: []AuditEntry{}, Limit: limit, Offset: offset}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM audit_log`+clause, params...).Scan(&page.Total); err != nil {
		return page, err
	}
	rows, err := s.selectRows(ctx, `SELECT id, ts, actor_type, actor_id, tenant_id, action, target_type,
                target_id, ip, result, meta_json, prev_hash, hash
           FROM audit_log`+clause+`
          ORDER BY id DESC LIMIT ? OFFSET ?`, append(params, limit, offset)...)
	if err != nil {
		return page, err
	}
	for _, r := range rows {
		page.Entries = append(page.Entries, r.view())
	}
	return page, nil
}

// VerifyChain checks hash + linkage over the most recent 10k rows. The
// oldest surviving row is the anchor (its predecessor may have been purged).
func (s *Service) VerifyChain(ctx context.Context) AuditChainReport {
	rows, err := s.selectRows(ctx, `SELECT * FROM (
             SELECT id, ts, actor_type, actor_id, tenant_id, action,
                    target_type, target_id, ip, result, meta_json, prev_hash, hash
               FROM audit_log ORDER BY id DESC LIMIT ?
           ) ORDER BY id ASC`, verifyMaxRows)
	if err != nil {
		s.log.Warn("audit verify failed", "err", err)
		return AuditChainReport{}
	}
	var prev *row
	for i := range rows {
		r := &rows[i]
		expected := chainHash(r.prevHash, []*string{&r.ts, &r.actorType, r.actorID, r.tenantID, &r.action, r.targetType, r.targetID, r.ip, &r.result, r.metaJSON})
		linked := prev == nil || (r.prevHash != nil && *r.prevHash == prev.hash)
		if r.hash != expected || !linked {
			id := r.id
			return AuditChainReport{OK: false, Checked: len(rows), BrokenAt: &id}
		}
		prev = r
	}
	return AuditChainReport{OK: true, Checked: len(rows)}
}

// PurgeExpired deletes rows past the retention window (the only sanctioned
// delete). Returns the number of rows purged.
func (s *Service) PurgeExpired(ctx context.Context) int {
	days := s.RetentionDays()
	if days == 0 {
		return 0
	}
	cutoff := jsx.ISO(s.now().Add(-time.Duration(days) * 24 * time.Hour))
	n, err := func() (int64, error) {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return 0, err
		}
		defer tx.Rollback()
		if _, err := tx.Exec(`DROP TRIGGER IF EXISTS audit_log_no_delete`); err != nil {
			return 0, err
		}
		res, err := tx.Exec(`DELETE FROM audit_log WHERE ts < ?`, cutoff)
		if err != nil {
			return 0, err
		}
		n, _ := res.RowsAffected()
		if _, err := tx.Exec(deleteGuardSQL); err != nil {
			return 0, err
		}
		return n, tx.Commit()
	}()
	if err != nil {
		s.log.Warn("audit retention failed", "err", err)
		return 0
	}
	if n > 0 {
		s.log.Info("audit retention: purged rows", "rows", n, "days", days)
	}
	return int(n)
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type row struct {
	id                                                              int64
	ts, actorType, action, result, hash                             string
	actorID, tenantID, targetType, targetID, ip, metaJSON, prevHash *string
}

func (r row) view() AuditEntry {
	e := AuditEntry{ID: r.id, Ts: r.ts, ActorType: r.actorType, ActorID: r.actorID, TenantID: r.tenantID,
		Action: r.action, TargetType: r.targetType, TargetID: r.targetID, IP: r.ip, Result: r.result, Meta: json.RawMessage("null")}
	if r.metaJSON != nil && *r.metaJSON != "" && json.Valid([]byte(*r.metaJSON)) {
		e.Meta = json.RawMessage(*r.metaJSON) // JSON.parse; unparsable → null
	}
	return e
}

func (s *Service) selectRows(ctx context.Context, q string, args ...any) ([]row, error) {
	rs, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	var out []row
	for rs.Next() {
		var (
			r                                                       row
			actorID, tenantID, targetType, targetID, ip, meta, prev sql.NullString
		)
		if err := rs.Scan(&r.id, &r.ts, &r.actorType, &actorID, &tenantID, &r.action, &targetType,
			&targetID, &ip, &r.result, &meta, &prev, &r.hash); err != nil {
			return nil, err
		}
		r.actorID, r.tenantID, r.targetType, r.targetID = ptr(actorID), ptr(tenantID), ptr(targetType), ptr(targetID)
		r.ip, r.metaJSON, r.prevHash = ptr(ip), ptr(meta), ptr(prev)
		out = append(out, r)
	}
	return out, rs.Err()
}

// chainHash is sha256(prev_hash ‖ JSON.stringify([ts, actorType, actorId,
// tenantId, action, targetType, targetId, ip, result, metaJson])).
func chainHash(prev *string, fields []*string) string {
	vals := make([]any, len(fields))
	for i, f := range fields {
		if f != nil {
			vals[i] = *f
		}
	}
	canonical, _ := jsx.Stringify(vals)
	p := ""
	if prev != nil {
		p = *prev
	}
	sum := sha256.Sum256([]byte(p + canonical))
	return hex.EncodeToString(sum[:])
}

// serializeMeta is JSON.stringify(meta) with the 4096-char truncation.
func serializeMeta(meta any) *string {
	if meta == nil {
		return nil
	}
	js, err := jsx.Stringify(meta)
	if err != nil {
		note := `{"note":"meta not serializable"}`
		return &note
	}
	if js == "null" {
		return nil
	}
	if jsx.UTF16Len(js) > maxMetaBytes {
		t, _ := jsx.Stringify(struct {
			Note string `json:"note"`
			Head string `json:"head"`
		}{"meta truncated", jsx.UTF16Slice(js, 512)})
		return &t
	}
	return &js
}

func ptr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	return &v.String
}

// Str is a convenience for optional string fields ("" → nil/NULL).
func Str(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ActorFromPrincipal maps the resolved principal onto actor fields
// (actorFromCtx): no principal → anonymous.
func ActorFromPrincipal(p *auth.Principal) (ActorType, *string, *string) {
	if p == nil {
		return ActorAnonymous, nil, nil
	}
	t := ActorUser
	switch p.Via {
	case auth.ViaAPIToken:
		t = ActorToken
	case auth.ViaAdminJWT:
		t = ActorAdmin
	}
	return t, Str(p.UserID), Str(p.TenantID)
}

// WithActor fills e's actor fields from p and returns it.
func (e Event) WithActor(p *auth.Principal) Event {
	e.ActorType, e.ActorID, e.TenantID = ActorFromPrincipal(p)
	return e
}
