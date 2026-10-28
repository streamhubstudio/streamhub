package security

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Settings is the env-driven configuration (security-settings.ts).
type Settings struct {
	Mode               string // off | log | enforce
	AllowlistOnly      bool
	AutobanEnabled     bool
	AutobanMaxOffenses int
	AutobanWindowS     int
	AutobanBaseTTLS    int
	Autoban404Enabled  bool
}

// ResolveSettings reads the STREAMHUB_IP_* / STREAMHUB_AUTOBAN_* variables.
func ResolveSettings(env func(string) string) Settings {
	flag := func(name string) bool {
		switch strings.ToLower(strings.TrimSpace(env(name))) {
		case "1", "true", "on", "yes":
			return true
		}
		return false
	}
	num := func(name string, fallback int) int {
		raw := env(name)
		if raw == "" {
			return fallback
		}
		n, ok := config.ParseIntPrefix(raw)
		if !ok || n <= 0 {
			return fallback
		}
		return n
	}
	mode := strings.ToLower(strings.TrimSpace(env("STREAMHUB_IP_ACCESS_MODE")))
	if mode != "log" && mode != "enforce" {
		mode = "off"
	}
	return Settings{
		Mode:               mode,
		AllowlistOnly:      flag("STREAMHUB_IP_ALLOWLIST_ONLY"),
		AutobanEnabled:     flag("STREAMHUB_AUTOBAN_ENABLED"),
		AutobanMaxOffenses: num("STREAMHUB_AUTOBAN_MAX_OFFENSES", 10),
		AutobanWindowS:     num("STREAMHUB_AUTOBAN_WINDOW_S", 300),
		AutobanBaseTTLS:    num("STREAMHUB_AUTOBAN_BASE_TTL_S", 900),
		Autoban404Enabled:  flag("STREAMHUB_AUTOBAN_404_ENABLED"),
	}
}

// IPRule is an allow/block rule (admin API shape).
type IPRule struct {
	ID        int64   `json:"id"`
	CIDR      string  `json:"cidr"`
	Action    string  `json:"action"`
	Note      *string `json:"note"`
	CreatedAt string  `json:"createdAt"`
	CreatedBy *string `json:"createdBy"`
}

// Match is the explicit-rule verdict.
type Match string

const (
	MatchAllow Match = "allow"
	MatchBlock Match = "block"
	MatchNone  Match = "none"
)

type compiledRule struct {
	rule IPRule
	cidr *ParsedCIDR
}

// Rules is IpRulesService: rules persisted in ip_rules and compiled into
// memory, reloaded on every mutation (the hot-path match never hits the DB).
type Rules struct {
	db  *sql.DB
	log *slog.Logger

	mu       sync.RWMutex
	compiled []compiledRule
}

// NewRules builds the service over the global DB.
func NewRules(global *sql.DB, log *slog.Logger) *Rules { return &Rules{db: global, log: log} }

// Init creates ip_rules and compiles it (never fatal).
func (r *Rules) Init(ctx context.Context) {
	_, err := r.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS ip_rules (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         cidr TEXT NOT NULL,
         action TEXT NOT NULL CHECK (action IN ('allow', 'block')),
         note TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         created_by TEXT
       );
       CREATE INDEX IF NOT EXISTS idx_ip_rules_action ON ip_rules(action);`)
	if err == nil {
		err = r.Reload(ctx)
	}
	if err != nil {
		r.log.Error("ip_rules bootstrap failed (continuing)", "err", err)
	}
}

const ruleColumns = `id, cidr, action, note, created_at, created_by`

func (r *Rules) query(ctx context.Context, q string, args ...any) ([]IPRule, error) {
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IPRule{}
	for rows.Next() {
		var (
			x        IPRule
			note, by sql.NullString
		)
		if err := rows.Scan(&x.ID, &x.CIDR, &x.Action, &note, &x.CreatedAt, &by); err != nil {
			return nil, err
		}
		if note.Valid {
			x.Note = &note.String
		}
		if by.Valid {
			x.CreatedBy = &by.String
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// Reload re-reads and re-compiles every rule (unparseable rows are skipped).
func (r *Rules) Reload(ctx context.Context) error {
	rules, err := r.query(ctx, `SELECT `+ruleColumns+` FROM ip_rules ORDER BY id ASC`)
	if err != nil {
		return err
	}
	compiled := make([]compiledRule, 0, len(rules))
	for _, x := range rules {
		c := ParseCIDR(x.CIDR)
		if c == nil {
			r.log.Warn(fmt.Sprintf("ip_rules row %d has invalid cidr, skipping", x.ID))
			continue
		}
		compiled = append(compiled, compiledRule{x, c})
	}
	r.mu.Lock()
	r.compiled = compiled
	r.mu.Unlock()
	return nil
}

// Evaluate matches ip against the explicit rules: any allow wins over any
// block; unparseable IPs never match.
func (r *Rules) Evaluate(ip string) Match {
	p := ParseIP(ip)
	if p == nil {
		return MatchNone
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	m := MatchNone
	for _, c := range r.compiled {
		if !InCIDR(p, c.cidr) {
			continue
		}
		if c.rule.Action == "allow" {
			return MatchAllow
		}
		m = MatchBlock
	}
	return m
}

// IsAllowlisted mirrors Evaluate()==allow.
func (r *Rules) IsAllowlisted(ip string) bool { return r.Evaluate(ip) == MatchAllow }

// List returns every rule, newest first.
func (r *Rules) List(ctx context.Context) ([]IPRule, error) {
	return r.query(ctx, `SELECT `+ruleColumns+` FROM ip_rules ORDER BY id DESC`)
}

// Add validates, stores the normalised CIDR and reloads the cache.
func (r *Rules) Add(ctx context.Context, cidr, action string, note, createdBy *string) (*IPRule, error) {
	parsed := ParseCIDR(cidr)
	if parsed == nil {
		return nil, httpx.BadRequest("invalid CIDR — expected an IPv4/IPv6 address or a.b.c.d/nn form")
	}
	var dup int64
	if err := r.db.QueryRowContext(ctx, `SELECT id FROM ip_rules WHERE cidr = ? AND action = ? LIMIT 1`, parsed.CIDR, action).Scan(&dup); err == nil {
		return nil, httpx.BadRequest(fmt.Sprintf("rule already exists (id %d)", dup))
	}
	if action == "block" && IsPrivateOrLoopback(strings.Split(parsed.CIDR, "/")[0]) {
		r.log.Warn(fmt.Sprintf("block rule %s covers a private/loopback range — those are always permitted", parsed.CIDR))
	}
	var noteVal *string
	if note != nil {
		if t := strings.TrimSpace(*note); t != "" {
			noteVal = &t
		}
	}
	res, err := r.db.ExecContext(ctx, `INSERT INTO ip_rules (cidr, action, note, created_by)
         VALUES (?, ?, ?, ?)`, parsed.CIDR, action, noteVal, createdBy)
	if err != nil {
		return nil, err
	}
	if err := r.Reload(ctx); err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	rules, err := r.query(ctx, `SELECT `+ruleColumns+` FROM ip_rules WHERE id = ?`, id)
	if err != nil || len(rules) == 0 {
		return nil, fmt.Errorf("ip rule %d vanished: %v", id, err)
	}
	r.log.Info(fmt.Sprintf("ip rule added: %s %s", action, parsed.CIDR))
	return &rules[0], nil
}

// Remove deletes a rule (404 when unknown) and reloads the cache.
func (r *Rules) Remove(ctx context.Context, id int64) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM ip_rules WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return httpx.NotFound(fmt.Sprintf("ip rule %d not found", id))
	}
	r.log.Info(fmt.Sprintf("ip rule %d removed", id))
	return r.Reload(ctx)
}

// Counts splits the compiled rules for /security/status.
func (r *Rules) Counts() (total, allow, block int) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, c := range r.compiled {
		if c.rule.Action == "allow" {
			allow++
		} else {
			block++
		}
	}
	return len(r.compiled), allow, block
}
