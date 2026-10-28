package security

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// OffenseKind is what an IP did wrong.
type OffenseKind string

const (
	OffenseLoginFailed       OffenseKind = "login_failed"
	OffenseMagicVerifyFailed OffenseKind = "magic_verify_failed"
	OffenseInvalidToken      OffenseKind = "invalid_token"
	OffenseRateLimited       OffenseKind = "rate_limited"
	OffenseNotFound          OffenseKind = "not_found"
)

// BanView is an active or recent ban (admin API).
type BanView struct {
	IP              string `json:"ip"`
	Reason          string `json:"reason"`
	FirstSeen       string `json:"firstSeen"`
	OffenseCount    int    `json:"offenseCount"`
	BannedUntil     string `json:"bannedUntil"`
	EscalationLevel int    `json:"escalationLevel"`
	Active          bool   `json:"active"`
}

// OffenderView is a recent offender (window counts).
type OffenderView struct {
	IP       string         `json:"ip"`
	Count    int            `json:"count"`
	LastSeen string         `json:"lastSeen"`
	Kinds    map[string]int `json:"kinds"`
}

const (
	maxBanTTLS          = 7 * 24 * 3600
	banHistoryRetention = 7 * 24 * time.Hour
	sweepInterval       = time.Minute
	maxTrackedOffenders = 10_000
)

type offense struct {
	ts   time.Time
	kind OffenseKind
}

type banEntry struct {
	reason          string
	firstSeen       string
	offenseCount    int
	bannedUntil     time.Time
	escalationLevel int
}

// Reputation is IpReputationService: offenses in an in-memory sliding
// window; crossing the threshold bans for baseTTL·2^level (capped at 7 days).
// Active bans persist to ip_bans so they survive restarts. Loopback/private
// and allowlisted IPs are never banned; RecordOffense never panics.
type Reputation struct {
	db       *sql.DB
	rules    *Rules
	log      *slog.Logger
	Settings Settings
	now      func() time.Time

	mu       sync.Mutex
	offenses map[string][]offense
	order    []string // insertion order of offenses keys (Map iteration order)
	bans     map[string]*banEntry
}

// NewReputation builds the service.
func NewReputation(global *sql.DB, settings Settings, rules *Rules, log *slog.Logger) *Reputation {
	return &Reputation{db: global, rules: rules, log: log, Settings: settings, now: time.Now,
		offenses: map[string][]offense{}, bans: map[string]*banEntry{}}
}

// Init creates ip_bans and re-arms still-active bans (never fatal).
func (r *Reputation) Init(ctx context.Context) {
	_, err := r.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS ip_bans (
         ip TEXT PRIMARY KEY,
         reason TEXT NOT NULL,
         first_seen TEXT NOT NULL,
         offense_count INTEGER NOT NULL DEFAULT 0,
         banned_until TEXT NOT NULL,
         escalation_level INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX IF NOT EXISTS idx_ip_bans_until ON ip_bans(banned_until);`)
	if err == nil {
		err = r.loadPersisted(ctx)
	}
	if err != nil {
		r.log.Error("ip_bans bootstrap failed (continuing)", "err", err)
	}
}

// Start runs the 60s maintenance sweep until ctx is done.
func (r *Reputation) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(sweepInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				r.Sweep(ctx)
			}
		}
	}()
}

func (r *Reputation) loadPersisted(ctx context.Context) error {
	rows, err := r.queryBans(ctx, `SELECT ip, reason, first_seen, offense_count, banned_until, escalation_level FROM ip_bans`)
	if err != nil {
		return err
	}
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	restored := 0
	for _, b := range rows {
		until, ok := jsx.ParseDate(b.BannedUntil)
		if !ok || !until.After(now) {
			continue
		}
		r.bans[b.IP] = &banEntry{b.Reason, b.FirstSeen, b.OffenseCount, until, b.EscalationLevel}
		restored++
	}
	if restored > 0 {
		r.log.Info(fmt.Sprintf("restored %d active IP ban(s) from ip_bans", restored))
	}
	return nil
}

// RecordOffense records one offense for ip. Fire-and-forget; a no-op when
// STREAMHUB_AUTOBAN_ENABLED is off.
func (r *Reputation) RecordOffense(ip string, kind OffenseKind) {
	if r == nil || !r.Settings.AutobanEnabled {
		return
	}
	defer func() {
		if v := recover(); v != nil {
			r.log.Debug("recordOffense failed", "err", v)
		}
	}()
	norm := NormalizeIP(ip)
	if norm == "" || ParseIP(norm) == nil {
		return
	}
	now := r.now()
	window := time.Duration(r.Settings.AutobanWindowS) * time.Second

	r.mu.Lock()
	list := fresh(r.offenses[norm], now, window)
	list = append(list, offense{now, kind})
	if _, tracked := r.offenses[norm]; !tracked {
		if len(r.offenses) >= maxTrackedOffenders {
			r.dropOldestLocked()
		}
		r.order = append(r.order, norm)
	}
	r.offenses[norm] = list
	r.mu.Unlock()

	if IsPrivateOrLoopback(norm) || r.rules.IsAllowlisted(norm) || r.IsBanned(norm) {
		return
	}
	if len(list) >= r.Settings.AutobanMaxOffenses {
		r.ban(norm, kind, len(list))
	}
}

func (r *Reputation) dropOldestLocked() {
	for len(r.order) > 0 {
		k := r.order[0]
		r.order = r.order[1:]
		if _, ok := r.offenses[k]; ok {
			delete(r.offenses, k)
			return
		}
	}
}

func (r *Reputation) deleteOffensesLocked(ip string) {
	delete(r.offenses, ip)
	for i, k := range r.order {
		if k == ip {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}
}

func fresh(list []offense, now time.Time, window time.Duration) []offense {
	out := list[:0:0]
	for _, o := range list {
		if now.Sub(o.ts) < window {
			out = append(out, o)
		}
	}
	return out
}

func (r *Reputation) ban(ip string, kind OffenseKind, count int) {
	ctx := context.Background()
	now := r.now()
	var (
		priorLevel int
		priorFirst string
	)
	level := 0
	if err := r.db.QueryRowContext(ctx, `SELECT escalation_level, first_seen FROM ip_bans WHERE ip = ?`, ip).Scan(&priorLevel, &priorFirst); err == nil {
		level = priorLevel + 1
	} else {
		priorFirst = jsx.ISO(now)
	}
	ttl := math.Min(float64(r.Settings.AutobanBaseTTLS)*math.Pow(2, float64(level)), maxBanTTLS)
	e := &banEntry{string(kind), priorFirst, count, now.Add(time.Duration(ttl * float64(time.Second))), level}
	r.mu.Lock()
	r.bans[ip] = e
	r.deleteOffensesLocked(ip)
	r.mu.Unlock()
	r.persist(ctx, ip, e)
	r.log.Warn(fmt.Sprintf("auto-ban ip=%s reason=%s offenses=%d ttl=%ds level=%d", ip, kind, count, int64(ttl), level))
}

func (r *Reputation) persist(ctx context.Context, ip string, e *banEntry) {
	_, err := r.db.ExecContext(ctx, `INSERT INTO ip_bans (ip, reason, first_seen, offense_count, banned_until, escalation_level)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(ip) DO UPDATE SET
             reason = excluded.reason,
             offense_count = excluded.offense_count,
             banned_until = excluded.banned_until,
             escalation_level = excluded.escalation_level`,
		ip, e.reason, e.firstSeen, e.offenseCount, jsx.ISO(e.bannedUntil), e.escalationLevel)
	if err != nil {
		r.log.Error("failed to persist ban for "+ip, "err", err)
	}
}

// IsBanned is the hot-path in-memory lookup (expired entries drop lazily).
func (r *Reputation) IsBanned(ip string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.bans[ip]
	if e == nil {
		return false
	}
	if !e.bannedUntil.After(r.now()) {
		delete(r.bans, ip)
		return false
	}
	return true
}

// ActiveBans lists current bans, latest expiry first.
func (r *Reputation) ActiveBans() []BanView {
	now := r.now()
	r.mu.Lock()
	out := []BanView{}
	for ip, e := range r.bans {
		if !e.bannedUntil.After(now) {
			continue
		}
		out = append(out, BanView{ip, e.reason, e.firstSeen, e.offenseCount, jsx.ISO(e.bannedUntil), e.escalationLevel, true})
	}
	r.mu.Unlock()
	sort.SliceStable(out, func(i, j int) bool { return out[i].BannedUntil > out[j].BannedUntil })
	return out
}

// RecentBans lists expired bans still in the history retention, newest first.
func (r *Reputation) RecentBans(ctx context.Context, limit int) ([]BanView, error) {
	return r.queryBans(ctx, `SELECT ip, reason, first_seen, offense_count, banned_until, escalation_level
	  FROM ip_bans WHERE banned_until <= ? ORDER BY banned_until DESC LIMIT ?`, jsx.ISO(r.now()), limit)
}

func (r *Reputation) queryBans(ctx context.Context, q string, args ...any) ([]BanView, error) {
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BanView{}
	for rows.Next() {
		var b BanView
		if err := rows.Scan(&b.IP, &b.Reason, &b.FirstSeen, &b.OffenseCount, &b.BannedUntil, &b.EscalationLevel); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Unban is a clean slate: memory ban, offense window and the persisted row
// (so the next ban restarts at level 0). False when the IP was unknown.
func (r *Reputation) Unban(ctx context.Context, raw string) bool {
	ip := NormalizeIP(raw)
	r.mu.Lock()
	_, had := r.bans[ip]
	delete(r.bans, ip)
	r.deleteOffensesLocked(ip)
	r.mu.Unlock()
	if res, err := r.db.ExecContext(ctx, `DELETE FROM ip_bans WHERE ip = ?`, ip); err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			had = true
		}
	}
	if had {
		r.log.Info(fmt.Sprintf("ip %s unbanned by operator", ip))
	}
	return had
}

// Offenders lists window counts, heaviest first.
func (r *Reputation) Offenders(limit int) []OffenderView {
	now := r.now()
	window := time.Duration(r.Settings.AutobanWindowS) * time.Second
	r.mu.Lock()
	out := []OffenderView{}
	for _, ip := range append([]string(nil), r.order...) {
		list := fresh(r.offenses[ip], now, window)
		if len(list) == 0 {
			r.deleteOffensesLocked(ip)
			continue
		}
		r.offenses[ip] = list
		kinds := map[string]int{}
		var last time.Time
		for _, o := range list {
			kinds[string(o.kind)]++
			if o.ts.After(last) {
				last = o.ts
			}
		}
		out = append(out, OffenderView{ip, len(list), jsx.ISO(last), kinds})
	}
	r.mu.Unlock()
	sort.SliceStable(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Counts are the /security/status numbers.
func (r *Reputation) Counts() (activeBans, tracked int) {
	activeBans = len(r.ActiveBans())
	r.mu.Lock()
	tracked = len(r.offenses)
	r.mu.Unlock()
	return
}

// Sweep flushes active bans, drops expired memory and prunes old history.
func (r *Reputation) Sweep(ctx context.Context) {
	now := r.now()
	window := time.Duration(r.Settings.AutobanWindowS) * time.Second
	type kv struct {
		ip string
		e  banEntry
	}
	var active []kv
	r.mu.Lock()
	for ip, e := range r.bans {
		if !e.bannedUntil.After(now) {
			delete(r.bans, ip)
		} else {
			active = append(active, kv{ip, *e})
		}
	}
	for _, ip := range append([]string(nil), r.order...) {
		if list := fresh(r.offenses[ip], now, window); len(list) == 0 {
			r.deleteOffensesLocked(ip)
		} else {
			r.offenses[ip] = list
		}
	}
	r.mu.Unlock()
	for _, a := range active {
		r.persist(ctx, a.ip, &a.e)
	}
	if _, err := r.db.ExecContext(ctx, `DELETE FROM ip_bans WHERE banned_until < ?`, jsx.ISO(now.Add(-banHistoryRetention))); err != nil {
		r.log.Debug("sweep failed", "err", err)
	}
}
