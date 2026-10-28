package edge

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/notifications"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Notifier is the EDGE_NOTIFIER seam the watchdog / alerter fire through.
type Notifier interface {
	Notify(ctx context.Context, event string, payload *y.Map)
}

// FanOut is the notifications module (NotifierService).
type FanOut interface {
	Notify(ctx context.Context, app, event string, payload any, opts *notifications.Options)
	NotifyGlobal(ctx context.Context, event string, payload any, opts *notifications.Options)
}

// Callbacks is the signed callbacks funnel (fallback without notifications).
type Callbacks interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// DefaultNotifier is DefaultEdgeNotifier: logs every node event and fans
// node.online / node.offline / cluster.capacity out globally + to every app
// whose config.yaml opts in with a truthy cluster.notify.
type DefaultNotifier struct {
	db      *sql.DB
	dataDir string
	log     *slog.Logger

	mu        sync.Mutex
	logs      Logs
	fanout    FanOut
	callbacks Callbacks
}

// NewDefaultNotifier builds the notifier; the sinks are late-bound.
func NewDefaultNotifier(global *sql.DB, dataDir string, log *slog.Logger) *DefaultNotifier {
	return &DefaultNotifier{db: global, dataDir: dataDir, log: log}
}

// Bind sets the optional sinks (nil leaves one unset).
func (n *DefaultNotifier) Bind(logs Logs, fanout FanOut, callbacks Callbacks) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.logs, n.fanout, n.callbacks = logs, fanout, callbacks
}

var fanoutEvents = map[string]bool{"node.online": true, "node.offline": true, "cluster.capacity": true}

// Notify implements Notifier. Never fails.
func (n *DefaultNotifier) Notify(ctx context.Context, event string, payload *y.Map) {
	n.mu.Lock()
	logs, fanout, callbacks := n.logs, n.fanout, n.callbacks
	n.mu.Unlock()
	if logs != nil {
		logs.Write("info", "edge", "cluster "+event, payload, nil)
	}
	js, _ := jsx.Stringify(payload)
	n.log.Info(fmt.Sprintf("cluster %s: %s", event, js))
	if !fanoutEvents[event] {
		return
	}
	if fanout != nil {
		safe(func() { fanout.NotifyGlobal(ctx, event, payload, nil) })
	}
	for _, app := range n.optedInApps(ctx) {
		switch {
		case fanout != nil:
			safe(func() { fanout.Notify(ctx, app, event, payload, nil) })
		case callbacks != nil:
			safe(func() { _ = callbacks.Dispatch(ctx, app, event, payload) })
		}
	}
}

func safe(fn func()) {
	defer func() { _ = recover() }()
	fn()
}

func (n *DefaultNotifier) optedInApps(ctx context.Context) []string {
	rows, err := n.db.QueryContext(ctx, `SELECT name FROM apps`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil && n.optedIn(name) {
			out = append(out, name)
		}
	}
	return out
}

func (n *DefaultNotifier) optedIn(app string) bool {
	raw, err := os.ReadFile(filepath.Join(n.dataDir, "apps", app, "config.yaml"))
	if err != nil {
		return false
	}
	doc, err := y.Load(string(raw))
	if err != nil {
		return false
	}
	m, ok := doc.(*y.Map)
	if !ok {
		return false
	}
	c, ok := m.Get("cluster").(*y.Map)
	if !ok {
		return false
	}
	switch v := c.Get("notify").(type) {
	case bool:
		return v
	case string:
		s := strings.ToLower(strings.TrimSpace(v))
		return s == "1" || s == "true" || s == "on" || s == "yes"
	case float64:
		return v == 1
	}
	return false
}

// ---------------------------------------------------------------------------
// capacity alerter
// ---------------------------------------------------------------------------

// AlertCooldown is the minimum gap between two alerts of one reason.
const AlertCooldown = 300 * time.Second

// Alerter is EdgeCapacityAlerter: one cluster.capacity per reason per
// cooldown, to the central log (warn/edge) and the notifier (async).
type Alerter struct {
	notifier Notifier // optional
	logs     Logs     // optional
	now      func() time.Time
	log      *slog.Logger

	mu   sync.Mutex
	last map[string]time.Time
}

// NewAlerter builds the alerter.
func NewAlerter(notifier Notifier, logs Logs, log *slog.Logger) *Alerter {
	return &Alerter{notifier: notifier, logs: logs, now: time.Now, log: log, last: map[string]time.Time{}}
}

// Alert fires unless the reason fired within the cooldown; true when it did.
func (a *Alerter) Alert(reason string, payload *y.Map) bool {
	now := a.now()
	a.mu.Lock()
	if last, ok := a.last[reason]; ok && now.Sub(last) < AlertCooldown {
		a.mu.Unlock()
		return false
	}
	a.last[reason] = now
	a.mu.Unlock()

	detail := y.NewMap()
	detail.Set("reason", reason)
	if payload != nil {
		for _, k := range payload.Keys() {
			detail.Set(k, payload.Get(k))
		}
	}
	if a.logs != nil {
		a.logs.Write("warn", "edge", "cluster capacity: "+reason, detail, nil)
	}
	if a.notifier != nil {
		go safe(func() { a.notifier.Notify(context.Background(), "cluster.capacity", detail) })
	}
	return true
}
