package mqtt

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

type dispatched struct {
	app, event string
	payload    string
}

type fakeDispatcher struct {
	mu    sync.Mutex
	calls []dispatched
}

func (f *fakeDispatcher) Dispatch(_ context.Context, app, event string, payload any) error {
	s, _ := yamljs.Stringify(payload)
	f.mu.Lock()
	f.calls = append(f.calls, dispatched{app, event, s})
	f.mu.Unlock()
	return nil
}

func (f *fakeDispatcher) count(event string) int {
	n := 0
	for _, c := range f.calls {
		if c.event == event {
			n++
		}
	}
	return n
}

type latencyApps struct {
	alert contracts.LatencyAlertConfig
	err   error
}

func (a *latencyApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	if a.err != nil {
		return nil, a.err
	}
	return &contracts.AppConfig{LatencyAlert: a.alert}, nil
}

type latencyHarness struct {
	mon    *LatencyMonitor
	cb     *fakeDispatcher
	apps   *latencyApps
	probe  ProbeResult
	probes int
	panic  bool
}

var t0 = time.UnixMilli(1_750_000_000_000)

func newLatencyHarness(t *testing.T) *latencyHarness {
	store, _, _ := testutil.Store(t)
	adb, err := store.App(context.Background(), "live")
	if err != nil {
		t.Fatal(err)
	}
	testutil.Exec(t, adb, `INSERT INTO streams (app_id, stream_id, type, room, status) VALUES (1, 's1', 'webrtc', 'live-1', 'active'), (1, 's2', 'rtmp', 'live-1', 'active'), (1, 's3', 'rtmp', 'old', 'ended')`)
	h := &latencyHarness{
		cb:   &fakeDispatcher{},
		apps: &latencyApps{alert: contracts.LatencyAlertConfig{Enabled: true, ThresholdMs: 1000, CooldownSeconds: 60, IntervalSeconds: 10}},
	}
	h.mon = &LatencyMonitor{
		ListApps: func(context.Context) ([]contracts.AppRecord, error) {
			return []contracts.AppRecord{{Name: "live"}}, nil
		},
		Config:    h.apps,
		AppDB:     func(ctx context.Context, app string) (*sql.DB, error) { return store.App(ctx, app) },
		Callbacks: h.cb,
		Logs:      &fakeLogs{},
		Probe: func(_ context.Context, room string) ProbeResult {
			h.probes++
			if h.panic {
				panic("probe down")
			}
			return h.probe
		},
	}
	return h
}

func (h *latencyHarness) rtt(ms float64, counts ...int) {
	h.probe = ProbeResult{OK: true, RttMs: ms}
	if len(counts) == 2 {
		h.probe.Participants, h.probe.Publishers = &counts[0], &counts[1]
	}
}

func (h *latencyHarness) tick(offset time.Duration) {
	h.mon.TickOnce(context.Background(), t0.Add(offset))
}

func TestLatencyHighThroughFunnel(t *testing.T) {
	h := newLatencyHarness(t)
	h.rtt(2500, 3, 1)
	h.tick(0)
	if len(h.cb.calls) != 1 {
		t.Fatalf("dispatched %d (distinct rooms only)", len(h.cb.calls))
	}
	c := h.cb.calls[0]
	want := `{"room":"live-1","rttMs":2500,"thresholdMs":1000,"metric":"livekit_room_probe_rtt_ms","participants":3,"publishers":1}`
	if c.app != "live" || c.event != "stream.latency_high" || c.payload != want {
		t.Fatalf("got %+v", c)
	}
}

func TestLatencyLatchRecoverCooldown(t *testing.T) {
	h := newLatencyHarness(t)
	h.rtt(2000)
	h.tick(0)
	h.tick(10 * time.Second)
	h.tick(20 * time.Second)
	if len(h.cb.calls) != 1 {
		t.Fatalf("latched: %d alerts", len(h.cb.calls))
	}

	h = newLatencyHarness(t)
	h.rtt(2000)
	h.tick(0)
	h.rtt(120)
	h.tick(10 * time.Second)
	if len(h.cb.calls) != 2 || h.cb.calls[1].event != "stream.latency_recovered" ||
		h.cb.calls[1].payload != `{"room":"live-1","rttMs":120,"thresholdMs":1000,"metric":"livekit_room_probe_rtt_ms"}` {
		t.Fatalf("recovered %+v", h.cb.calls)
	}
	h.rtt(2000)
	h.tick(20 * time.Second) // re-breach inside the 60 s cooldown
	if h.cb.count("stream.latency_high") != 1 {
		t.Fatal("cooldown not honoured")
	}
	h.tick(70 * time.Second)
	if h.cb.count("stream.latency_high") != 2 {
		t.Fatal("no alert after the cooldown")
	}
}

func TestLatencyDisabledAndInterval(t *testing.T) {
	h := newLatencyHarness(t)
	h.apps.alert.Enabled = false
	h.rtt(9999)
	h.tick(0)
	if h.probes != 0 || len(h.cb.calls) != 0 {
		t.Fatal("disabled monitor probed")
	}

	h = newLatencyHarness(t)
	h.rtt(100)
	h.tick(0)
	h.tick(4 * time.Second)
	if h.probes != 1 {
		t.Fatalf("interval not honoured: %d probes", h.probes)
	}
	h.tick(10 * time.Second)
	if h.probes != 2 {
		t.Fatalf("probes %d", h.probes)
	}
}

func TestLatencyUnprobeableAndNeverPanics(t *testing.T) {
	h := newLatencyHarness(t)
	h.rtt(2000)
	h.tick(0)
	h.probe = ProbeResult{OK: false, Error: "room gone"}
	h.tick(10 * time.Second)
	if len(h.cb.calls) != 1 {
		t.Fatal("unprobeable sample changed state")
	}

	h = newLatencyHarness(t)
	h.panic = true
	h.tick(0)
	h.apps.err = errors.New("app gone")
	h.tick(10 * time.Second)
	if len(h.cb.calls) != 0 {
		t.Fatal("dispatched on failure")
	}
}

func TestLivekitProbeUnconfiguredNeverDials(t *testing.T) {
	p := NewLivekitProbe("ws://127.0.0.1:7880", "", "")
	if r := p(context.Background(), "x"); r.OK || r.Error != "livekit not configured" {
		t.Fatalf("%+v", r)
	}
}
