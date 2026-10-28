package fleet

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of fleet-battery-monitor.service.ts (branch feat/hls-direct-serve-
// scaling, written against the Node core and never released there): a
// per-AGENT battery threshold monitor. Same latched state machine with
// hysteresis as netmetrics.ThresholdMonitor, but keyed by "<app>/<agentId>"
// — the network threshold is one number per app, the battery is one live
// reading per agent.
//
//	battery <= threshold and not latched                 → fleet.battery_low, latch
//	battery >  threshold + BatteryRecoverMargin, latched → fleet.battery_recovered, unlatch
//
// Both go through the callbacks funnel (webhook + MQTT tap + notifiers). The
// threshold is the fleet plugin's own per-app `batteryLowPercent` (0, the
// default, disables it). Agents that never report a battery (most of the
// fleet: Luckfox boxes / desktops on mains) are SKIPPED, never treated as 0 %.

const (
	// BatteryTick is the pass cadence (telemetry lands every ~15 s).
	BatteryTick = 60 * time.Second
	// BatteryRecoverMargin is the recovery hysteresis in percentage POINTS.
	BatteryRecoverMargin = 10.0

	EventBatteryLow       = "fleet.battery_low"
	EventBatteryRecovered = "fleet.battery_recovered"
)

// Callbacks is the callbacks funnel (CallbacksServiceContract.dispatch).
type Callbacks interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// BatteryMonitor is FleetBatteryMonitorService.
type BatteryMonitor struct {
	ListApps func(ctx context.Context) ([]contracts.AppRecord, error)
	AppDir   func(app string) string
	Plugins  PluginRepo
	// Agents lists an app's registry rows (default: a Service's Store).
	Agents func(ctx context.Context, app, appDir string) ([]AgentRow, error)
	// Callbacks / Logs are resolved at call time (nil = skip).
	Callbacks func() Callbacks
	Logs      func() Logs
	// Interval overrides BatteryTick (tests).
	Interval time.Duration

	mu      sync.Mutex
	ticking bool
	low     map[string]bool // "<app>/<agentId>" → latched low
}

// NewBatteryMonitor wires the monitor over a fleet Service's registry.
func NewBatteryMonitor(s *Service, cb func() Callbacks) *BatteryMonitor {
	return &BatteryMonitor{
		ListApps:  func(ctx context.Context) ([]contracts.AppRecord, error) { return s.apps.List(ctx, nil) },
		AppDir:    s.apps.AppDir,
		Plugins:   s.plugins,
		Agents:    s.store.ListAgents,
		Callbacks: cb,
		Logs:      s.logs,
	}
}

// Start runs a pass every BatteryTick until ctx is cancelled (onModuleInit).
func (m *BatteryMonitor) Start(ctx context.Context) {
	go func() {
		every := m.Interval
		if every <= 0 {
			every = BatteryTick
		}
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.TickOnce(ctx)
			}
		}
	}()
}

// TickOnce is one pass over every app's every agent. Never overlaps, never panics.
func (m *BatteryMonitor) TickOnce(ctx context.Context) {
	m.mu.Lock()
	if m.ticking {
		m.mu.Unlock()
		return
	}
	m.ticking = true
	if m.low == nil {
		m.low = map[string]bool{}
	}
	m.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			m.warn("", "battery threshold pass failed", fmt.Errorf("%v", r))
		}
		m.mu.Lock()
		m.ticking = false
		m.mu.Unlock()
	}()
	apps, err := m.ListApps(ctx)
	if err != nil {
		m.warn("", "battery threshold pass failed", err)
		return
	}
	live := map[string]bool{}
	for _, a := range apps {
		threshold := m.thresholdFor(ctx, a.Name)
		if threshold <= 0 {
			continue // disabled
		}
		rows, err := m.Agents(ctx, a.Name, m.AppDir(a.Name))
		if err != nil {
			m.warn(a.Name, "listAgents failed", err)
			continue
		}
		for _, r := range rows {
			battery, ok := batteryOf(r.Telemetry)
			if !ok {
				continue // no battery on this host — absent, not 0 %
			}
			key := a.Name + "/" + r.AgentID
			live[key] = true
			m.checkAgent(ctx, a.Name, r.AgentID, battery, threshold, key)
		}
	}
	// Forget latches of agents that vanished, lost their battery reading, or
	// whose app disabled the alert.
	m.mu.Lock()
	for key := range m.low {
		if !live[key] {
			delete(m.low, key)
		}
	}
	m.mu.Unlock()
}

func batteryOf(t *y.Map) (float64, bool) {
	if t == nil {
		return 0, false
	}
	f, ok := t.Get("battery").(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

func (m *BatteryMonitor) checkAgent(ctx context.Context, app, agentID string, battery, threshold float64, key string) {
	m.mu.Lock()
	low := m.low[key]
	m.low[key] = low
	event := ""
	switch {
	case !low && battery <= threshold:
		m.low[key] = true
		event = EventBatteryLow
	case low && battery > threshold+BatteryRecoverMargin:
		m.low[key] = false
		event = EventBatteryRecovered
	}
	m.mu.Unlock()
	if event == "" {
		return
	}
	payload := y.NewMap()
	payload.Set("agentId", agentID)
	payload.Set("batteryPercent", battery)
	payload.Set("thresholdPercent", threshold)
	m.dispatch(ctx, app, event, payload)
}

// thresholdFor reads the app's fleet `batteryLowPercent` (0 = disabled:
// plugin absent/disabled, value missing, non-number or ≤ 0). Never panics.
func (m *BatteryMonitor) thresholdFor(ctx context.Context, app string) (n float64) {
	defer func() {
		if recover() != nil {
			n = 0
		}
	}()
	row, err := m.Plugins.Get(ctx, app, "fleet")
	if err != nil || row == nil || !row.Enabled || row.Config == nil {
		return 0
	}
	f, ok := row.Config.Get("batteryLowPercent").(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f <= 0 {
		return 0
	}
	return f
}

func (m *BatteryMonitor) dispatch(ctx context.Context, app, event string, payload *y.Map) {
	defer func() {
		if r := recover(); r != nil {
			m.warn(app, fmt.Sprintf("dispatch of %q failed", event), fmt.Errorf("%v", r))
		}
	}()
	var cb Callbacks
	if m.Callbacks != nil {
		cb = m.Callbacks()
	}
	if cb == nil {
		m.warn(app, fmt.Sprintf("dispatch of %q failed", event), fmt.Errorf("callbacks service unavailable"))
		return
	}
	if err := cb.Dispatch(ctx, app, event, payload); err != nil {
		m.warn(app, fmt.Sprintf("dispatch of %q failed", event), err)
		return
	}
	meta := y.NewMap()
	meta.Set("app", app)
	for _, k := range payload.Keys() {
		meta.Set(k, payload.Get(k))
	}
	m.log("info", fmt.Sprintf("emitted %q", event), meta)
}

func (m *BatteryMonitor) log(level, message string, meta any) {
	defer func() { _ = recover() }()
	if m.Logs == nil {
		return
	}
	if l := m.Logs(); l != nil {
		l.Write(level, "fleet-battery", message, meta, nil)
	}
}

func (m *BatteryMonitor) warn(app, message string, err error) {
	meta := y.NewMap()
	if app != "" {
		meta.Set("app", app)
	}
	meta.Set("error", err.Error())
	m.log("warn", message, meta)
}
