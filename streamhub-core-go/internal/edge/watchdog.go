package edge

import (
	"context"
	"database/sql"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

const (
	// WatchdogInterval is the reaper cadence.
	WatchdogInterval = 20 * time.Second
	// NodeStaleAfter: offline once unseen this long AND WS-disconnected.
	NodeStaleAfter = 90 * time.Second
	// FailoverGrace: WS-down this long before work fails over.
	FailoverGrace = 45 * time.Second
)

// Watchdog is EdgeWatchdogService: liveness flips → node.online/offline
// (first observation seeds silently) + failover past the grace.
type Watchdog struct {
	db       *sql.DB
	gw       *Gateway
	sched    *Scheduler
	notifier Notifier
	now      func() time.Time

	mu       sync.Mutex
	liveness map[string]bool
}

// NewWatchdog builds the reaper.
func NewWatchdog(global *sql.DB, gw *Gateway, sched *Scheduler, notifier Notifier) *Watchdog {
	return &Watchdog{db: global, gw: gw, sched: sched, notifier: notifier, now: time.Now, liveness: map[string]bool{}}
}

// Start ticks every 20s until ctx ends.
func (w *Watchdog) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(WatchdogInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				w.Tick(ctx)
			}
		}
	}()
}

type wdRow struct {
	id       string
	name     sql.NullString
	typ      sql.NullString
	lastSeen sql.NullString
}

// Tick is one reaper pass. Never fails.
func (w *Watchdog) Tick(ctx context.Context) {
	rows, err := w.db.QueryContext(ctx, `SELECT id, name, type, last_seen_at FROM nodes WHERE type IN ('common','edge')`)
	if err != nil {
		return
	}
	var rs []wdRow
	for rows.Next() {
		var r wdRow
		if rows.Scan(&r.id, &r.name, &r.typ, &r.lastSeen) == nil {
			rs = append(rs, r)
		}
	}
	rows.Close()
	now := w.now()
	for _, r := range rs {
		w.reconcileLiveness(ctx, r, now)
		w.maybeFailover(ctx, r.id, now)
	}
}

func (w *Watchdog) reconcileLiveness(ctx context.Context, r wdRow, now time.Time) {
	online := w.gw.IsConnected(r.id) || seenWithin(r.lastSeen, now, NodeStaleAfter)
	w.mu.Lock()
	prev, seen := w.liveness[r.id]
	w.liveness[r.id] = online
	w.mu.Unlock()
	if !seen || prev == online {
		return
	}
	event := "node.offline"
	if online {
		event = "node.online"
	}
	typ := "common"
	if r.typ.String == "edge" {
		typ = "edge"
	}
	payload := y.NewMap()
	payload.Set("nodeId", r.id)
	if r.name.Valid {
		payload.Set("name", r.name.String)
	} else {
		payload.Set("name", nil)
	}
	payload.Set("type", typ)
	payload.Set("at", jsx.ISO(now))
	if w.notifier != nil {
		safe(func() { w.notifier.Notify(ctx, event, payload) })
	}
}

func (w *Watchdog) maybeFailover(ctx context.Context, nodeID string, now time.Time) {
	if w.gw.IsConnected(nodeID) {
		return
	}
	since, ok := w.gw.DisconnectedSince(nodeID)
	if !ok || now.Sub(since) < FailoverGrace {
		return
	}
	safe(func() { w.sched.HandleNodeDown(ctx, nodeID) })
}

// seenWithin parses SQLite's UTC datetime('now') (no zone marker).
func seenWithin(lastSeen sql.NullString, now time.Time, window time.Duration) bool {
	t, ok := parseSQLiteUTC(lastSeen)
	if !ok {
		return false
	}
	return now.Sub(t) <= window
}

// parseSQLiteUTC is Date.parse(s.replace(' ', 'T') + 'Z').
func parseSQLiteUTC(s sql.NullString) (time.Time, bool) {
	if !s.Valid || s.String == "" {
		return time.Time{}, false
	}
	return jsx.ParseDate(strings.Replace(s.String, " ", "T", 1) + "Z")
}
