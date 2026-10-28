package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// Port of fleet-battery-monitor.service.spec.ts: drives the latched per-agent
// state machine directly (no DB, no MQTT) with a fake plugin config, agent
// registry and callbacks funnel.

type dispatched struct {
	app, event string
	payload    *y.Map
}

type fakeCallbacks struct {
	calls []dispatched
	err   error
}

func (f *fakeCallbacks) Dispatch(_ context.Context, app, event string, payload any) error {
	if f.err != nil {
		return f.err
	}
	f.calls = append(f.calls, dispatched{app, event, payload.(*y.Map)})
	return nil
}

func (f *fakeCallbacks) events() []string {
	out := []string{}
	for _, c := range f.calls {
		out = append(out, c.event)
	}
	return out
}

type batteryFixture struct {
	m        *BatteryMonitor
	cb       *fakeCallbacks
	logs     *fakeLogs
	repo     *fakeRepo
	rows     []AgentRow
	appsErr  error
	listErr  error
	listHits int
}

func agentRow(id string, battery any) AgentRow {
	t := y.NewMap()
	if battery != nil {
		t.Set("battery", battery)
	}
	return AgentRow{AgentID: id, Status: "online", FirstSeen: "2026-01-01T00:00:00.000Z", LastSeen: "2026-01-01T00:00:00.000Z", Telemetry: t}
}

func newBatteryFixture() *batteryFixture {
	f := &batteryFixture{cb: &fakeCallbacks{}, logs: &fakeLogs{}, repo: &fakeRepo{}}
	f.threshold(20.0) // 20 % by default
	f.m = &BatteryMonitor{
		ListApps: func(context.Context) ([]contracts.AppRecord, error) {
			if f.appsErr != nil {
				return nil, f.appsErr
			}
			return []contracts.AppRecord{{Name: app}}, nil
		},
		AppDir:  func(string) string { return "/data/apps/live" },
		Plugins: f.repo,
		Agents: func(context.Context, string, string) ([]AgentRow, error) {
			f.listHits++
			if f.listErr != nil {
				return nil, f.listErr
			}
			return f.rows, nil
		},
		Callbacks: func() Callbacks { return f.cb },
		Logs:      func() Logs { return f.logs },
	}
	return f
}

func (f *batteryFixture) threshold(v any) {
	cfg := y.NewMap()
	cfg.Set("batteryLowPercent", v)
	f.repo.row = &plugins.Installed{PluginID: "fleet", Enabled: true, Config: cfg}
}

func TestBatteryLowFiresOnceAndLatches(t *testing.T) {
	f := newBatteryFixture()
	f.rows = []AgentRow{agentRow("cam-1", 15.0)}
	f.m.TickOnce(bg)
	f.m.TickOnce(bg) // still low — no duplicate
	if len(f.cb.calls) != 1 {
		t.Fatalf("%+v", f.cb.calls)
	}
	c := f.cb.calls[0]
	if c.app != app || c.event != "fleet.battery_low" {
		t.Fatalf("%+v", c)
	}
	// payload shape + key order are the documented contract
	if got := js(c.payload); got != `{"agentId":"cam-1","batteryPercent":15,"thresholdPercent":20}` {
		t.Fatal(got)
	}
	if len(f.logs.msgs) != 1 || f.logs.msgs[0] != `info:emitted "fleet.battery_low"` {
		t.Fatal(f.logs.msgs)
	}
}

func TestBatteryStaysLatchedInsideMargin(t *testing.T) {
	f := newBatteryFixture()
	f.rows = []AgentRow{agentRow("cam-1", 15.0)}
	f.m.TickOnce(bg)                             // breach at 15 %
	f.rows = []AgentRow{agentRow("cam-1", 28.0)} // +8, margin is 10
	f.m.TickOnce(bg)
	f.rows = []AgentRow{agentRow("cam-1", 30.0)} // exactly threshold+margin: still latched
	f.m.TickOnce(bg)
	if got := f.cb.events(); !reflect.DeepEqual(got, []string{"fleet.battery_low"}) {
		t.Fatal(got)
	}
}

func TestBatteryRecoversPastMargin(t *testing.T) {
	f := newBatteryFixture()
	f.rows = []AgentRow{agentRow("cam-1", 15.0)}
	f.m.TickOnce(bg)
	f.rows = []AgentRow{agentRow("cam-1", 35.0)} // +15, past the margin
	f.m.TickOnce(bg)
	f.m.TickOnce(bg) // no duplicate recovery
	if got := f.cb.events(); !reflect.DeepEqual(got, []string{"fleet.battery_low", "fleet.battery_recovered"}) {
		t.Fatal(got)
	}
	if got := js(f.cb.calls[1].payload); got != `{"agentId":"cam-1","batteryPercent":35,"thresholdPercent":20}` {
		t.Fatal(got)
	}
}

func TestBatteryNeverFiresAboveThreshold(t *testing.T) {
	f := newBatteryFixture()
	f.rows = []AgentRow{agentRow("cam-1", 80.0)}
	f.m.TickOnce(bg)
	if len(f.cb.calls) != 0 {
		t.Fatal(f.cb.events())
	}
}

func TestBatteryAbsentIsSkippedNotZero(t *testing.T) {
	f := newBatteryFixture()
	f.rows = []AgentRow{agentRow("desktop-1", nil), {AgentID: "no-telemetry"}, agentRow("bad", "x")}
	f.m.TickOnce(bg)
	if len(f.cb.calls) != 0 {
		t.Fatal(f.cb.events())
	}
}

func TestBatteryDisabledAppIsSkipped(t *testing.T) {
	for name, set := range map[string]func(f *batteryFixture){
		"threshold 0":     func(f *batteryFixture) { f.threshold(0.0) },
		"negative":        func(f *batteryFixture) { f.threshold(-5.0) },
		"string":          func(f *batteryFixture) { f.threshold("20") },
		"plugin disabled": func(f *batteryFixture) { f.repo.row.Enabled = false },
		"not installed":   func(f *batteryFixture) { f.repo.row = nil },
		"no key":          func(f *batteryFixture) { f.repo.row.Config = y.NewMap() },
	} {
		t.Run(name, func(t *testing.T) {
			f := newBatteryFixture()
			set(f)
			f.rows = []AgentRow{agentRow("cam-1", 1.0)}
			f.m.TickOnce(bg)
			if len(f.cb.calls) != 0 || f.listHits != 0 {
				t.Fatalf("events %v, listAgents hits %d", f.cb.events(), f.listHits)
			}
		})
	}
}

func TestBatteryAgentsAreIndependent(t *testing.T) {
	f := newBatteryFixture()
	f.rows = []AgentRow{agentRow("cam-1", 15.0), agentRow("cam-2", 90.0)}
	f.m.TickOnce(bg)
	if len(f.cb.calls) != 1 || f.cb.calls[0].payload.Get("agentId") != "cam-1" {
		t.Fatal(f.cb.events())
	}
}

func TestBatteryLatchForgottenWhenAgentDisappears(t *testing.T) {
	f := newBatteryFixture()
	f.rows = []AgentRow{agentRow("cam-1", 15.0)}
	f.m.TickOnce(bg) // latched low
	f.rows = nil     // agent gone
	f.m.TickOnce(bg)
	f.rows = []AgentRow{agentRow("cam-1", 15.0)} // reappears, still low
	f.m.TickOnce(bg)
	// two separate emissions: the latch was cleared in between
	if got := f.cb.events(); !reflect.DeepEqual(got, []string{"fleet.battery_low", "fleet.battery_low"}) {
		t.Fatal(got)
	}
}

func TestBatteryNeverPanics(t *testing.T) {
	f := newBatteryFixture()
	f.appsErr = errors.New("db gone")
	f.m.TickOnce(bg)
	if len(f.logs.msgs) != 1 || f.logs.msgs[0] != "warn:battery threshold pass failed" {
		t.Fatal(f.logs.msgs)
	}

	f = newBatteryFixture()
	f.listErr = errors.New("db locked")
	f.m.TickOnce(bg)
	if len(f.cb.calls) != 0 || len(f.logs.msgs) != 1 || f.logs.msgs[0] != "warn:listAgents failed" {
		t.Fatal(f.cb.events(), f.logs.msgs)
	}

	// a failing funnel is logged, not raised; a panicking registry is recovered
	f = newBatteryFixture()
	f.cb.err = errors.New("webhook down")
	f.rows = []AgentRow{agentRow("cam-1", 15.0)}
	f.m.TickOnce(bg)
	if len(f.logs.msgs) != 1 || f.logs.msgs[0] != `warn:dispatch of "fleet.battery_low" failed` {
		t.Fatal(f.logs.msgs)
	}
	f.m.Agents = func(context.Context, string, string) ([]AgentRow, error) { panic("boom") }
	f.m.TickOnce(bg)
	f.m.TickOnce(bg) // the ticking guard was released
	if n := len(f.logs.msgs); n != 3 || f.logs.msgs[2] != "warn:battery threshold pass failed" {
		t.Fatal(f.logs.msgs)
	}
}

// The Service-backed monitor reads the real registry: a telemetry message with
// a battery reaches the monitor, and the agent view carries it.
func TestBatteryMonitorOverService(t *testing.T) {
	f := newFixture(t)
	cfg := y.NewMap()
	cfg.Set("batteryLowPercent", 25.0)
	f.setFleet(true, cfg)
	_, _, _ = f.svc.EnsureForApp(bg, app)
	c := f.last(t)
	c.emit("streamhub/live/agents/cam-9/telemetry", `{"cpu":5,"battery":"12"}`)
	c.emit("streamhub/live/agents/desk-1/telemetry", `{"cpu":5}`)
	cb := &fakeCallbacks{}
	m := NewBatteryMonitor(f.svc, func() Callbacks { return cb })
	m.TickOnce(bg)
	if len(cb.calls) != 1 || js(cb.calls[0].payload) != `{"agentId":"cam-9","batteryPercent":12,"thresholdPercent":25}` {
		t.Fatalf("%+v", cb.calls)
	}
	d, err := f.svc.GetData(bg, app)
	if err != nil || len(d.Agents) != 2 {
		t.Fatal(d, err)
	}
	b, _ := json.Marshal(d.Agents[0].Metrics)
	if string(b) != `{"cpu":5,"mem":null,"temp":null,"uptime":null,"cameras":null,"disk":null,"battery":12,"relay":null}` {
		t.Fatal(string(b))
	}
	if d.Agents[1].Metrics.Battery != nil {
		t.Fatal("AC-only host must report battery null")
	}
}

// The interval drives a pass (the Node spec's fake-timer case).
func TestBatteryStartTicks(t *testing.T) {
	f := newBatteryFixture()
	f.rows = []AgentRow{agentRow("cam-1", 15.0)}
	ran := make(chan struct{}, 1)
	f.m.Callbacks = func() Callbacks {
		select {
		case ran <- struct{}{}:
		default:
		}
		return f.cb
	}
	f.m.Interval = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(bg)
	defer cancel()
	f.m.Start(ctx)
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("no pass ran")
	}
}
