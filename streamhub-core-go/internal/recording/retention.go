package recording

import (
	"context"
	"math"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Port of vod-retention.service.ts: per-app VOD retention janitor. Each pass
// deletes terminal VODs older than recording.retentionDays (S3 best-effort,
// then the row — see DeleteVodCascade). Never throws, never overlaps.

const (
	retentionDefaultInterval = 3600 * time.Second
	retentionBatch           = 500
)

// RetentionCutoffISO is now − days (nil when retention is off).
func RetentionCutoffISO(now time.Time, days float64) *string {
	if math.IsNaN(days) || math.IsInf(days, 0) || days <= 0 {
		return nil
	}
	s := jsx.ISO(time.UnixMilli(now.UnixMilli() - int64(days*86_400_000)))
	return &s
}

// RetentionResult is one pass' outcome.
type RetentionResult struct {
	Apps    int
	Deleted int
}

// Retention is the janitor.
type Retention struct {
	s       *Service
	ticking atomic.Bool
}

// NewRetention builds the janitor over the recording service.
func NewRetention(s *Service) *Retention { return &Retention{s: s} }

// Interval is STREAMHUB_VOD_RETENTION_INTERVAL_S (≥ 60 s, default 1 h).
func (r *Retention) Interval() time.Duration {
	raw := strconvNumber(r.s.cfg.Env("STREAMHUB_VOD_RETENTION_INTERVAL_S"))
	if !math.IsNaN(raw) && !math.IsInf(raw, 0) && raw >= 60 {
		return time.Duration(math.Floor(raw)) * time.Second
	}
	return retentionDefaultInterval
}

// Enabled: off under NODE_ENV=test or STREAMHUB_VOD_RETENTION=off.
func (r *Retention) Enabled() bool {
	if r.s.cfg.NodeEnv == "test" {
		return false
	}
	v := r.s.cfg.Env("STREAMHUB_VOD_RETENTION")
	return v == "" || v != "off"
}

// Start arms the hourly timer (plane starter).
func (r *Retention) Start(ctx context.Context) {
	if !r.Enabled() {
		return
	}
	go r.s.every(ctx, r.Interval(), func() { r.SweepOnce(ctx, time.Now()) })
}

// SweepOnce runs one pass over every app.
func (r *Retention) SweepOnce(ctx context.Context, now time.Time) RetentionResult {
	var res RetentionResult
	if !r.ticking.CompareAndSwap(false, true) {
		return res
	}
	defer r.ticking.Store(false)
	list, err := r.s.apps.List(ctx, nil)
	if err != nil {
		r.warn("", "app list failed", err)
		return res
	}
	for _, a := range list {
		r.sweepApp(ctx, a.Name, now, &res)
	}
	return res
}

func (r *Retention) sweepApp(ctx context.Context, app string, now time.Time, res *RetentionResult) {
	cfg, err := r.s.apps.GetConfig(ctx, app)
	if err != nil {
		return
	}
	days := cfg.Recording.RetentionDays
	cutoff := RetentionCutoffISO(now, days)
	if cutoff == nil {
		return
	}
	res.Apps++
	ids, err := r.s.vods.ListExpired(ctx, app, *cutoff, retentionBatch)
	if err != nil {
		r.warn(app, "listExpired failed", err)
		return
	}
	deleted := 0
	for _, id := range ids {
		if _, err := r.s.DeleteVodCascade(ctx, app, id); err != nil {
			r.warn(app, "deleteVod "+strconv.FormatInt(id, 10)+" failed", err)
			continue
		}
		deleted++
	}
	res.Deleted += deleted
	if deleted > 0 {
		write(r.s.logs, "info", "vod retention pruned", retentionLog{app, deleted, days, *cutoff})
	}
}

type retentionLog struct {
	App           string  `json:"app"`
	Deleted       int     `json:"deleted"`
	RetentionDays float64 `json:"retentionDays"`
	Cutoff        string  `json:"cutoff"`
}

type retentionWarn struct {
	App   string `json:"app,omitempty"`
	Error string `json:"error"`
}

func (r *Retention) warn(app, msg string, err error) {
	write(r.s.logs, "warn", "retention: "+msg, retentionWarn{app, err.Error()})
}

// strconvNumber is Number(raw) for env strings ("" → 0).
func strconvNumber(raw string) float64 {
	if jsTrim(raw) == "" {
		return 0
	}
	f, err := strconv.ParseFloat(jsTrim(raw), 64)
	if err != nil {
		return math.NaN()
	}
	return f
}
