package netmetrics

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logsink"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of net-threshold-monitor.service.ts: every 5 min compare each app's
// rolling-24h bytes with its network.threshold_gb_day and drive a latched
// state machine with hysteresis (exceeded at ≥100 %, recovered < 90 %).
// Events go through the callbacks funnel (webhook + MQTT tap).

const (
	thresholdTick   = 5 * time.Minute
	recoverFraction = 0.9
)

// Dispatcher is the callbacks funnel.
type Dispatcher interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// UsageSource is the 24 h usage read (Service.Summary).
type UsageSource interface {
	Summary(ctx context.Context, app string, now time.Time, thresholdGBDay float64) Summary
}

// ThresholdMonitor is NetThresholdMonitorService.
type ThresholdMonitor struct {
	Net       UsageSource
	ListApps  func(ctx context.Context) ([]contracts.AppRecord, error)
	AppDir    func(app string) string
	Callbacks Dispatcher
	Logs      logsink.Writer
	// Threshold reads an app's cap (default ReadThresholdGBDay(AppDir(app))).
	Threshold func(app string) float64

	mu       sync.Mutex
	ticking  bool
	breached map[string]bool
}

// Start runs the 5-minute pass until ctx is cancelled.
func (m *ThresholdMonitor) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(thresholdTick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.TickOnce(ctx, time.Now())
			}
		}
	}()
}

// TickOnce is one pass over every app (never overlaps; never panics).
func (m *ThresholdMonitor) TickOnce(ctx context.Context, now time.Time) {
	m.mu.Lock()
	if m.ticking {
		m.mu.Unlock()
		return
	}
	m.ticking = true
	if m.breached == nil {
		m.breached = map[string]bool{}
	}
	m.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			m.warn("", "threshold pass failed", fmt.Errorf("%v", r))
		}
		m.mu.Lock()
		m.ticking = false
		m.mu.Unlock()
	}()
	apps, err := m.ListApps(ctx)
	if err != nil {
		m.warn("", "threshold pass failed", err)
		return
	}
	live := map[string]bool{}
	for _, a := range apps {
		live[a.Name] = true
		m.checkApp(ctx, a.Name, now)
	}
	m.mu.Lock()
	for name := range m.breached {
		if !live[name] {
			delete(m.breached, name)
		}
	}
	m.mu.Unlock()
}

func (m *ThresholdMonitor) checkApp(ctx context.Context, app string, now time.Time) {
	gb := m.thresholdFor(app)
	thresholdBytes := GBToBytes(gb)
	if thresholdBytes <= 0 {
		m.mu.Lock()
		delete(m.breached, app) // threshold removed → forget any latch
		m.mu.Unlock()
		return
	}
	usage := float64(m.Net.Summary(ctx, app, now, 0).Last24h.Total)
	m.mu.Lock()
	breached, known := m.breached[app]
	if !known {
		m.breached[app] = false
	}
	event := ""
	switch {
	case !breached && usage >= thresholdBytes:
		m.breached[app] = true
		event = "network.threshold_exceeded"
	case breached && usage < thresholdBytes*recoverFraction:
		m.breached[app] = false
		event = "network.threshold_recovered"
	}
	m.mu.Unlock()
	if event == "" {
		return
	}
	payload := yamljs.NewMap()
	payload.Set("usageBytes", usage)
	payload.Set("thresholdBytes", thresholdBytes)
	payload.Set("thresholdGbDay", gb)
	payload.Set("windowHours", 24.0)
	m.dispatch(ctx, app, event, payload)
}

func (m *ThresholdMonitor) thresholdFor(app string) (gb float64) {
	defer func() {
		if recover() != nil {
			gb = 0
		}
	}()
	if m.Threshold != nil {
		return m.Threshold(app)
	}
	return ReadThresholdGBDay(m.AppDir(app))
}

func (m *ThresholdMonitor) dispatch(ctx context.Context, app, event string, payload *yamljs.Map) {
	defer func() {
		if r := recover(); r != nil {
			m.warn(app, fmt.Sprintf("dispatch of %q failed", event), fmt.Errorf("%v", r))
		}
	}()
	if err := m.Callbacks.Dispatch(ctx, app, event, payload); err != nil {
		m.warn(app, fmt.Sprintf("dispatch of %q failed", event), err)
		return
	}
	meta := map[string]any{"app": app}
	for _, k := range payload.Keys() {
		meta[k] = payload.Get(k)
	}
	m.Logs.Write("info", "net-threshold", fmt.Sprintf("emitted %q", event), meta)
}

func (m *ThresholdMonitor) warn(app, message string, err error) {
	defer func() { _ = recover() }()
	meta := map[string]any{"error": err.Error()}
	if app != "" {
		meta["app"] = app
	}
	m.Logs.Write("warn", "net-threshold", message, meta)
}
