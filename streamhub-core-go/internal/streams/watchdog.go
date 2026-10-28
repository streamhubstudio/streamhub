package streams

import (
	"context"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Port of hls-watchdog.service.ts: every interval it reconciles apps whose
// features.linear opts into always-on HLS (relaunch a dead egress exactly
// once, via the idempotent Hls.Start) and/or DVR (prune expired segments).
// Never throws; never overlaps a slow pass.

const defaultWatchdogInterval = 30 // seconds

// ReconcileResult is the outcome of one pass.
type ReconcileResult struct {
	Checked    int
	Relaunched int
	Pruned     int
}

// Watchdog is HlsWatchdogService.
type Watchdog struct {
	s       *Service
	hls     *Hls
	ticking atomic.Bool
}

// NewWatchdog builds the watchdog.
func NewWatchdog(s *Service, hls *Hls) *Watchdog { return &Watchdog{s: s, hls: hls} }

// interval is STREAMHUB_HLS_WATCHDOG_INTERVAL_S (>= 5, floored) or 30 s.
func (w *Watchdog) interval() time.Duration {
	raw := strings.TrimSpace(w.s.cfg.Env("STREAMHUB_HLS_WATCHDOG_INTERVAL_S"))
	n := 0.0
	if raw != "" {
		f, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			f = math.NaN()
		}
		n = f
	}
	if !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 5 {
		return time.Duration(math.Floor(n)) * time.Second
	}
	return defaultWatchdogInterval * time.Second
}

// Start arms the timer (onModuleInit): disabled under NODE_ENV=test or
// STREAMHUB_HLS_WATCHDOG=off. Stops when ctx is cancelled.
func (w *Watchdog) Start(ctx context.Context) {
	if w.s.cfg.NodeEnv == "test" {
		return
	}
	if v := w.s.cfg.Env("STREAMHUB_HLS_WATCHDOG"); v == "off" {
		return
	}
	t := time.NewTicker(w.interval())
	go func() {
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				w.ReconcileOnce(ctx, w.s.now())
			}
		}
	}()
}

// ReconcileOnce is one pass over every always-on/DVR app.
func (w *Watchdog) ReconcileOnce(ctx context.Context, now time.Time) ReconcileResult {
	var res ReconcileResult
	if !w.ticking.CompareAndSwap(false, true) {
		return res
	}
	defer w.ticking.Store(false)
	apps, err := w.s.apps.List(ctx, nil)
	if err != nil {
		w.warn("", "app list failed", err)
		return res
	}
	for _, a := range apps {
		w.reconcileApp(ctx, a.Name, now, &res)
	}
	return res
}

type relaunchMeta struct {
	App      string `json:"app"`
	Room     string `json:"room"`
	StreamID string `json:"streamId"`
}

type pruneMeta struct {
	App           string  `json:"app"`
	Room          string  `json:"room"`
	Deleted       int     `json:"deleted"`
	WindowSeconds float64 `json:"windowSeconds"`
}

func (w *Watchdog) reconcileApp(ctx context.Context, appName string, now time.Time, res *ReconcileResult) {
	cfg, err := w.s.apps.GetConfig(ctx, appName)
	if err != nil {
		return
	}
	linear := cfg.Features.Linear
	if linear == nil || (!linear.AlwaysOnHls && !linear.Dvr) {
		return
	}
	streams, err := w.s.List(ctx, appName)
	if err != nil {
		w.warn(appName, "active-room lookup failed", err)
		streams = nil
	}
	seen := map[string]bool{}
	for _, st := range streams {
		if st.Status != "active" || st.Room == "" || seen[st.Room] {
			continue
		}
		seen[st.Room] = true
		res.Checked++

		if linear.AlwaysOnHls && !w.hasActiveHls(ctx, st.Room) {
			if _, err := w.hls.Start(ctx, appName, st.StreamID, strings.TrimRight(w.s.cfg.PublicBaseURL, "/")); err != nil {
				w.warn(appName, "hls relaunch failed", err)
			} else {
				res.Relaunched++
				w.log("info", "relaunched dead HLS egress", relaunchMeta{appName, st.Room, st.StreamID})
			}
		}
		if linear.Dvr {
			res.Pruned += w.pruneRoom(appName, st.Room, linear.DvrWindowSeconds, now)
		}
	}
}

// hasActiveHls errs on the safe side: a failed listing counts as alive so a
// LiveKit hiccup never double-launches.
func (w *Watchdog) hasActiveHls(ctx context.Context, room string) bool {
	list, err := w.hls.egressOrMissing().ListHlsEgress(ctx, room)
	if err != nil {
		w.warn("", "listHlsEgress failed", err)
		return true
	}
	for _, e := range list {
		if e.RoomName == room {
			return true
		}
	}
	return false
}

func (w *Watchdog) pruneRoom(appName, room string, windowSeconds float64, now time.Time) int {
	dir := filepath.Join(w.s.apps.AppDir(appName), "hls", Safe(room))
	r := PruneDvrDir(dir, windowSeconds, PruneOptions{Now: float64(now.UnixNano()) / 1e6})
	if len(r.Deleted) > 0 {
		w.log("info", "pruned DVR segments", pruneMeta{appName, room, len(r.Deleted), windowSeconds})
	}
	return len(r.Deleted)
}

type warnMeta struct {
	App   string `json:"app,omitempty"`
	Error string `json:"error"`
}

func (w *Watchdog) log(level, message string, meta any) {
	if l := get(w.s.opt.Logs); l != nil {
		l.Write(level, "hls-watchdog", message, meta, nil)
	}
}

func (w *Watchdog) warn(app, message string, err error) {
	w.log("warn", message, warnMeta{app, err.Error()})
}
