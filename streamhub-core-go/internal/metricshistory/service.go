// Package metricshistory is modules/metrics-history: the lightweight in-app
// host resource-usage history (CPU / RAM / Disk / Network sampled once per
// hour into the global DB, 30-day retention) behind GET
// /system/metrics/history. The Node BullMQ repeatable job becomes an
// in-process cron (one process owns its DATA_DIR, so a mutex is the lock).
package metricshistory

import (
	"context"
	"database/sql"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	hourMs = int64(time.Hour / time.Millisecond)
	dayMs  = 24 * hourMs

	// DefaultRange is the history window when none/unknown is given.
	DefaultRange = "30d"
	// DefaultRetentionDays prunes samples older than this.
	DefaultRetentionDays = 30
	// DefaultCron samples once per hour, on the hour.
	DefaultCron = "0 * * * *"
)

var ranges = map[string]int64{"24h": dayMs, "7d": 7 * dayMs, "30d": 30 * dayMs, "90d": 90 * dayMs}

// Settings are resolved from env once (metrics-history-settings.ts).
type Settings struct {
	Enabled       bool
	RetentionDays int
	Cron          string
}

// ResolveSettings reads STREAMHUB_METRICS_HISTORY_{ENABLED,RETENTION_DAYS,CRON}.
func ResolveSettings(env func(string) string) Settings {
	s := Settings{Enabled: true, RetentionDays: DefaultRetentionDays, Cron: DefaultCron}
	switch v := strings.ToLower(strings.TrimSpace(env("STREAMHUB_METRICS_HISTORY_ENABLED"))); v {
	case "0", "false", "off", "no":
		s.Enabled = false
	}
	if raw := env("STREAMHUB_METRICS_HISTORY_RETENTION_DAYS"); raw != "" {
		if n, ok := parseIntJS(raw); ok && n >= 0 {
			s.RetentionDays = n
		}
	}
	if raw := strings.TrimSpace(env("STREAMHUB_METRICS_HISTORY_CRON")); raw != "" {
		if f := strings.Fields(raw); len(f) == 5 || len(f) == 6 {
			s.Cron = raw
		}
	}
	return s
}

// parseIntJS is Number.parseInt(raw, 10): leading whitespace, optional sign,
// the longest digit prefix.
func parseIntJS(raw string) (int, bool) {
	m := intPrefix.FindString(strings.TrimLeft(raw, " \t\n\r\v\f"))
	if m == "" {
		return 0, false
	}
	n, err := strconv.Atoi(m)
	return n, err == nil
}

// Service is MetricsHistoryService.
type Service struct {
	db       *sql.DB
	dataDir  string
	log      *slog.Logger
	Settings Settings

	// Read is the host reader seam (tests inject fixed readings).
	Read func(dataDir string) HostReading

	mu      sync.Mutex
	prevCPU *CPUTimes
}

// New builds the service (env read once, as Node resolves per instance).
func New(global *sql.DB, dataDir string, env func(string) string, log *slog.Logger) *Service {
	return &Service{db: global, dataDir: dataDir, log: log, Settings: ResolveSettings(env), Read: ReadHost}
}

// Init bootstraps the table (onModuleInit). Never fails boot.
func (s *Service) Init(ctx context.Context) {
	if err := s.ensureSchema(ctx); err != nil {
		s.log.Error("resource_samples bootstrap failed (continuing): " + err.Error())
	}
}

func (s *Service) ensureSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS resource_samples (
         ts INTEGER PRIMARY KEY,
         cpu_pct REAL,
         mem_used_bytes INTEGER,
         mem_total_bytes INTEGER,
         disk_used_bytes INTEGER,
         disk_total_bytes INTEGER,
         net_rx_bytes INTEGER,
         net_tx_bytes INTEGER,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       );
       CREATE INDEX IF NOT EXISTS idx_resource_samples_ts ON resource_samples(ts);`)
	return err
}

// BucketFor aligns an epoch-ms instant down to the start of its hour.
func BucketFor(nowMs int64) int64 {
	return int64(math.Floor(float64(nowMs)/float64(hourMs))) * hourMs
}

// Sample takes one host reading, upserts it into the current hour bucket
// and prunes. Returns nil on error (logged, never fatal).
func (s *Service) Sample(ctx context.Context, nowMs int64) *HostSample {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureSchema(ctx); err != nil {
		s.log.Error("resource sample failed: " + err.Error())
		return nil
	}
	reading := s.Read(s.dataDir)
	sample := ToSample(reading, s.prevCPU)
	cpu := reading.CPU
	s.prevCPU = &cpu // advance the baseline AFTER computing this sample's %

	_, err := s.db.ExecContext(ctx, `INSERT INTO resource_samples
             (ts, cpu_pct, mem_used_bytes, mem_total_bytes,
              disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ts) DO UPDATE SET
             cpu_pct = excluded.cpu_pct,
             mem_used_bytes = excluded.mem_used_bytes,
             mem_total_bytes = excluded.mem_total_bytes,
             disk_used_bytes = excluded.disk_used_bytes,
             disk_total_bytes = excluded.disk_total_bytes,
             net_rx_bytes = excluded.net_rx_bytes,
             net_tx_bytes = excluded.net_tx_bytes`,
		BucketFor(nowMs), sample.CPUPercent, intCol(&sample.MemUsedBytes), intCol(&sample.MemTotalBytes),
		intCol(sample.DiskUsedBytes), intCol(sample.DiskTotalBytes), intCol(sample.NetRxBytes), intCol(sample.NetTxBytes))
	if err != nil {
		s.log.Error("resource sample failed: " + err.Error())
		return nil
	}
	s.Prune(ctx, nowMs)
	return &sample
}

// intCol binds a byte count as INTEGER (better-sqlite3 binds an integral JS
// number as an integer), nil as NULL.
func intCol(v *float64) any {
	if v == nil {
		return nil
	}
	return int64(*v)
}

// Prune deletes samples older than RetentionDays (0 disables).
func (s *Service) Prune(ctx context.Context, nowMs int64) int64 {
	days := s.Settings.RetentionDays
	if days <= 0 {
		return 0
	}
	res, err := s.db.ExecContext(ctx, "DELETE FROM resource_samples WHERE ts < ?", nowMs-int64(days)*dayMs)
	if err != nil {
		s.log.Warn("resource prune failed: " + err.Error())
		return 0
	}
	n, _ := res.RowsAffected()
	return n
}

// NewestSampleAge is the gap since the newest sample; ok=false when the
// table is empty or unreadable (Node: Infinity).
func (s *Service) NewestSampleAge(ctx context.Context, nowMs int64) (ageMs int64, ok bool) {
	var ts sql.NullInt64
	if err := s.db.QueryRowContext(ctx, "SELECT MAX(ts) AS ts FROM resource_samples").Scan(&ts); err != nil || !ts.Valid {
		return 0, false
	}
	return nowMs - ts.Int64, true
}

// HistoryPoint is one dot (ts = bucket start, epoch ms).
type HistoryPoint = MetricsHistoryHistoryPoint

// MetricsHistoryHistoryPoint is the wire type (module-prefixed schema name).
type MetricsHistoryHistoryPoint struct {
	Ts    int64    `json:"ts"`
	Value *float64 `json:"value"`
}

// MemPoint is one memory dot.
type MemPoint = MetricsHistoryMemPoint

// MetricsHistoryMemPoint is the wire type (module-prefixed schema name).
type MetricsHistoryMemPoint struct {
	Ts    int64    `json:"ts"`
	Used  *int64   `json:"used"`
	Total *int64   `json:"total"`
	Pct   *float64 `json:"pct"`
}

// NetPoint carries per-bucket rx/tx deltas.
type NetPoint = MetricsHistoryNetPoint

// MetricsHistoryNetPoint is the wire type (module-prefixed schema name).
type MetricsHistoryNetPoint struct {
	Ts int64  `json:"ts"`
	Rx *int64 `json:"rx"`
	Tx *int64 `json:"tx"`
}

// Series holds only the requested metric(s).
type Series = MetricsHistorySeries

// MetricsHistorySeries is the wire type (module-prefixed schema name).
type MetricsHistorySeries struct {
	CPU  *[]HistoryPoint `json:"cpu,omitempty"`
	Mem  *[]MemPoint     `json:"mem,omitempty"`
	Disk *[]HistoryPoint `json:"disk,omitempty"`
	Net  *[]NetPoint     `json:"net,omitempty"`
}

// Response is MetricsHistoryResponse.
type Response = MetricsHistoryResponse

// MetricsHistoryResponse is the wire type (module-prefixed schema name).
type MetricsHistoryResponse struct {
	Range         string `json:"range"`
	RetentionDays int    `json:"retentionDays"`
	Now           int64  `json:"now"`
	BucketMs      int64  `json:"bucketMs"`
	Series        Series `json:"series"`
}

type sampleRow struct {
	ts                  int64
	cpu                 *float64
	memUsed, memTotal   *int64
	diskUsed, diskTotal *int64
	netRx, netTx        *int64
}

// History is the bucketed series over the window; metric "" = every series.
func (s *Service) History(ctx context.Context, rng, metric string, nowMs int64) Response {
	norm := rng
	if _, ok := ranges[rng]; !ok {
		norm = DefaultRange
	}
	rows := s.rowsSince(ctx, nowMs-ranges[norm])
	all := metric == ""
	var series Series
	if all || metric == "cpu" {
		pts := make([]HistoryPoint, 0, len(rows))
		for _, r := range rows {
			pts = append(pts, HistoryPoint{Ts: r.ts, Value: r.cpu})
		}
		series.CPU = &pts
	}
	if all || metric == "mem" {
		pts := make([]MemPoint, 0, len(rows))
		for _, r := range rows {
			pts = append(pts, MemPoint{Ts: r.ts, Used: r.memUsed, Total: r.memTotal, Pct: pct(r.memUsed, r.memTotal)})
		}
		series.Mem = &pts
	}
	if all || metric == "disk" {
		pts := make([]HistoryPoint, 0, len(rows))
		for _, r := range rows {
			pts = append(pts, HistoryPoint{Ts: r.ts, Value: pct(r.diskUsed, r.diskTotal)})
		}
		series.Disk = &pts
	}
	if all || metric == "net" {
		pts := deltaNet(rows)
		series.Net = &pts
	}
	return Response{Range: norm, RetentionDays: s.Settings.RetentionDays, Now: nowMs, BucketMs: hourMs, Series: series}
}

func (s *Service) rowsSince(ctx context.Context, since int64) []sampleRow {
	rows, err := s.db.QueryContext(ctx, "SELECT ts, cpu_pct, mem_used_bytes, mem_total_bytes, "+
		"disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes "+
		"FROM resource_samples WHERE ts >= ? ORDER BY ts ASC", since)
	if err != nil {
		s.log.Warn("resource history read failed: " + err.Error())
		return nil
	}
	defer rows.Close()
	var out []sampleRow
	for rows.Next() {
		var r sampleRow
		var cpu sql.NullFloat64
		var mu, mt, du, dt, rx, tx sql.NullInt64
		if err := rows.Scan(&r.ts, &cpu, &mu, &mt, &du, &dt, &rx, &tx); err != nil {
			s.log.Warn("resource history read failed: " + err.Error())
			return nil
		}
		if cpu.Valid {
			r.cpu = &cpu.Float64
		}
		r.memUsed, r.memTotal, r.diskUsed, r.diskTotal, r.netRx, r.netTx = ip(mu), ip(mt), ip(du), ip(dt), ip(rx), ip(tx)
		out = append(out, r)
	}
	return out
}

func ip(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	return &v.Int64
}

// pct is Math.round(used/total·10000)/100, null-safe.
func pct(used, total *int64) *float64 {
	if used == nil || total == nil || *total <= 0 {
		return nil
	}
	v := jsRound(float64(*used)/float64(*total)*10000) / 100
	return &v
}

// deltaNet turns cumulative counters into per-bucket deltas; the first
// point and any counter reset (negative delta) are null.
func deltaNet(rows []sampleRow) []NetPoint {
	out := make([]NetPoint, 0, len(rows))
	var prev *sampleRow
	for i := range rows {
		r := &rows[i]
		p := NetPoint{Ts: r.ts}
		if prev != nil && r.netRx != nil && prev.netRx != nil && r.netTx != nil && prev.netTx != nil {
			if d := *r.netRx - *prev.netRx; d >= 0 {
				p.Rx = &d
			}
			if d := *r.netTx - *prev.netTx; d >= 0 {
				p.Tx = &d
			}
		}
		out = append(out, p)
		prev = r
	}
	return out
}
