package mqtt

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logsink"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of latency-monitor.service.ts: per-app stream latency monitor
// (config latency_alert:). Every intervalSeconds it probes each ACTIVE room
// and drives a latched threshold state machine per room; alerts go through
// the callbacks funnel (webhook + its MQTT tap).

// LatencyMetric is stamped into every alert payload.
const LatencyMetric = "livekit_room_probe_rtt_ms"

const (
	latencyTick     = 5 * time.Second
	maxRoomsPerApp  = 25
	latencyStateTTL = 10 * time.Minute
)

// ProbeResult is one health sample of a live room.
type ProbeResult struct {
	// OK=false: the room could not be probed (skip, no alert).
	OK           bool
	RttMs        float64
	Participants *int
	Publishers   *int
	Error        string
}

// Probe samples one room.
type Probe func(ctx context.Context, room string) ProbeResult

// NewLivekitProbe times a RoomService.ListParticipants round-trip. Without
// LiveKit credentials it never dials (ok=false), as in Node.
func NewLivekitProbe(url, key, secret string) Probe {
	host := url
	if strings.HasPrefix(strings.ToLower(host), "ws:") {
		host = "http:" + host[3:]
	} else if strings.HasPrefix(strings.ToLower(host), "wss:") {
		host = "https:" + host[4:]
	}
	if host == "" || key == "" || secret == "" {
		return func(context.Context, string) ProbeResult {
			return ProbeResult{OK: false, Error: "livekit not configured"}
		}
	}
	client := lksdk.NewRoomServiceClient(host, key, secret)
	return func(ctx context.Context, room string) ProbeResult {
		t0 := time.Now()
		res, err := client.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
		rtt := float64(time.Since(t0).Milliseconds())
		if err != nil {
			return ProbeResult{OK: false, RttMs: rtt, Error: err.Error()}
		}
		n, pubs := len(res.Participants), 0
		for _, p := range res.Participants {
			if len(p.Tracks) > 0 {
				pubs++
			}
		}
		return ProbeResult{OK: true, RttMs: rtt, Participants: &n, Publishers: &pubs}
	}
}

// Dispatcher is the callbacks funnel.
type Dispatcher interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

type roomState struct {
	breached    bool
	lastAlertAt time.Time
	lastSeen    time.Time
}

// LatencyMonitor is LatencyMonitorService.
type LatencyMonitor struct {
	ListApps  func(ctx context.Context) ([]contracts.AppRecord, error)
	Config    ConfigSource
	AppDB     func(ctx context.Context, app string) (*sql.DB, error)
	Callbacks Dispatcher
	Logs      logsink.Writer
	Probe     Probe

	mu           sync.Mutex
	ticking      bool
	states       map[string]*roomState
	lastSampleAt map[string]time.Time
}

// Start runs the 5 s scheduler until ctx is cancelled.
func (m *LatencyMonitor) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(latencyTick)
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
func (m *LatencyMonitor) TickOnce(ctx context.Context, now time.Time) {
	m.mu.Lock()
	if m.ticking {
		m.mu.Unlock()
		return
	}
	m.ticking = true
	if m.states == nil {
		m.states = map[string]*roomState{}
		m.lastSampleAt = map[string]time.Time{}
	}
	m.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			m.warn("", "monitor pass failed", fmt.Errorf("%v", r))
		}
		m.mu.Lock()
		m.ticking = false
		m.mu.Unlock()
	}()
	apps, err := m.ListApps(ctx)
	if err != nil {
		m.warn("", "monitor pass failed", err)
		return
	}
	for _, a := range apps {
		m.sampleApp(ctx, a.Name, now)
	}
	m.prune(now)
}

func (m *LatencyMonitor) sampleApp(ctx context.Context, app string, now time.Time) {
	cfg, err := m.Config.GetConfig(ctx, app)
	if err != nil || cfg == nil {
		return // app vanished mid-pass
	}
	alert := cfg.LatencyAlert
	if !alert.Enabled {
		return
	}
	iv := alert.IntervalSeconds
	if iv == 0 || math.IsNaN(iv) {
		iv = 10
	}
	interval := time.Duration(math.Max(2, iv) * float64(time.Second))
	m.mu.Lock()
	last := m.lastSampleAt[app]
	if !last.IsZero() && now.Sub(last) < interval {
		m.mu.Unlock()
		return
	}
	m.lastSampleAt[app] = now
	m.mu.Unlock()
	for _, room := range m.activeRooms(ctx, app) {
		m.sampleRoom(ctx, app, room, alert, now)
	}
}

func (m *LatencyMonitor) sampleRoom(ctx context.Context, app, room string, alert contracts.LatencyAlertConfig, now time.Time) {
	res := m.safeProbe(ctx, room)
	if !res.OK {
		return // unprobeable sample — no state change, no alert
	}
	key := app + " " + room
	m.mu.Lock()
	st := m.states[key]
	if st == nil {
		st = &roomState{}
		m.states[key] = st
	}
	st.lastSeen = now
	threshold := alert.ThresholdMs
	cooldown := time.Duration(math.Max(0, alert.CooldownSeconds) * float64(time.Second))
	var event string
	payload := yamljs.NewMap()
	payload.Set("room", room)
	payload.Set("rttMs", res.RttMs)
	payload.Set("thresholdMs", threshold)
	payload.Set("metric", LatencyMetric)
	switch {
	case res.RttMs > threshold:
		if !st.breached && now.Sub(st.lastAlertAt) >= cooldown {
			st.breached = true
			st.lastAlertAt = now
			event = "stream.latency_high"
			if res.Participants != nil {
				payload.Set("participants", float64(*res.Participants))
			}
			if res.Publishers != nil {
				payload.Set("publishers", float64(*res.Publishers))
			}
		}
	case st.breached:
		st.breached = false
		event = "stream.latency_recovered"
	}
	m.mu.Unlock()
	if event != "" {
		m.dispatch(ctx, app, event, payload)
	}
}

func (m *LatencyMonitor) safeProbe(ctx context.Context, room string) (res ProbeResult) {
	defer func() {
		if r := recover(); r != nil {
			res = ProbeResult{OK: false, Error: fmt.Sprint(r)}
		}
	}()
	return m.Probe(ctx, room)
}

// activeRooms are the distinct active rooms of the app (never fails).
func (m *LatencyMonitor) activeRooms(ctx context.Context, app string) []string {
	db, err := m.AppDB(ctx, app)
	if err == nil {
		var rows *sql.Rows
		rows, err = db.QueryContext(ctx, `SELECT DISTINCT room FROM streams
            WHERE status = 'active' AND room IS NOT NULL
            LIMIT ?`, maxRoomsPerApp)
		if err == nil {
			defer rows.Close()
			var out []string
			for rows.Next() {
				var r string
				if err = rows.Scan(&r); err != nil {
					break
				}
				out = append(out, r)
			}
			if err == nil {
				err = rows.Err()
			}
			if err == nil {
				return out
			}
		}
	}
	m.warn(app, "active-room lookup failed", err)
	return nil
}

func (m *LatencyMonitor) dispatch(ctx context.Context, app, event string, payload *yamljs.Map) {
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
	m.Logs.Write("info", "latency-monitor", fmt.Sprintf("emitted %q", event), meta)
}

func (m *LatencyMonitor) prune(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, st := range m.states {
		if now.Sub(st.lastSeen) > latencyStateTTL {
			delete(m.states, k)
		}
	}
}

func (m *LatencyMonitor) warn(app, message string, err error) {
	defer func() { _ = recover() }()
	meta := map[string]any{"error": fmt.Sprint(err)}
	if app != "" {
		meta["app"] = app
	}
	m.Logs.Write("warn", "latency-monitor", message, meta)
}
