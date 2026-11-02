package channel

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/pipeline"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/supervisor"
)

type fproc struct {
	pid  int
	exit chan error
	once sync.Once
}

func (p *fproc) Pid() int         { return 0 } // no /proc sampling in tests
func (p *fproc) Wait() error      { return <-p.exit }
func (p *fproc) end()             { p.once.Do(func() { p.exit <- errors.New("signal") }) }
func (p *fproc) Interrupt() error { p.end(); return nil }
func (p *fproc) Kill() error      { p.end(); return nil }

type frunner struct {
	mu     sync.Mutex
	starts map[string]int
	alive  map[string]bool
	specs  map[string]supervisor.Spec
}

func newRunner() *frunner {
	return &frunner{starts: map[string]int{}, alive: map[string]bool{}, specs: map[string]supervisor.Spec{}}
}

func (r *frunner) Start(s supervisor.Spec, out io.Writer) (supervisor.Proc, error) {
	r.mu.Lock()
	r.starts[s.Name]++
	r.alive[s.Name] = true
	r.specs[s.Name] = s
	r.mu.Unlock()
	p := &fproc{exit: make(chan error, 1)}
	go func() {
		<-p.exit
		p.exit <- errors.New("signal") // re-arm for Wait
	}()
	wrapped := &wproc{fproc: p, onExit: func() { r.mu.Lock(); r.alive[s.Name] = false; r.mu.Unlock() }}
	return wrapped, nil
}

type wproc struct {
	*fproc
	onExit func()
}

func (w *wproc) Wait() error { err := w.fproc.Wait(); w.onExit(); return err }

func (r *frunner) count(name string) int { r.mu.Lock(); defer r.mu.Unlock(); return r.starts[name] }
func (r *frunner) isAlive(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.alive[name]
}
func (r *frunner) spec(name string) supervisor.Spec {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.specs[name]
}

func eventually(t *testing.T, what string, f func() bool) {
	t.Helper()
	for i := 0; i < 300; i++ {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout: %s", what)
}

type fakeResolver struct {
	mu       sync.Mutex
	calls    int
	released []string
}

func (f *fakeResolver) Resolve(ctx context.Context, ch config.Channel, o config.Output) (config.StreamHubOutput, config.Output, error) {
	f.mu.Lock()
	f.calls++
	n := f.calls
	f.mu.Unlock()
	if n == 1 {
		return config.StreamHubOutput{}, config.Output{}, errors.New("core unreachable")
	}
	r := *o.StreamHub
	r.IngressID, r.StreamKey, r.ResolvedURL = "IN_1", "key1", "rtmp://sh:1935/live/key1"
	return r, config.Output{ID: o.ID, Type: "rtmp", Enabled: true, URL: r.ResolvedURL}, nil
}

func (f *fakeResolver) Release(ctx context.Context, o config.Output) error {
	f.mu.Lock()
	f.released = append(f.released, o.ID)
	f.mu.Unlock()
	return nil
}

func setup(t *testing.T) (*Manager, *config.Store, *frunner, *fakeResolver) {
	t.Helper()
	st, err := config.Open(filepath.Join(t.TempDir(), "c.json"))
	if err != nil {
		t.Fatal(err)
	}
	r := newRunner()
	res := &fakeResolver{}
	m := New(Deps{Store: st, Caps: pipeline.StaticCaps{"x264enc": true, "x265enc": true}, Runner: r, Resolver: res,
		Ports: NewPortPool(46000, 46999), Sup: supervisor.Options{MinBackoff: 10 * time.Millisecond, StopTimeout: 50 * time.Millisecond},
		StartGrace: time.Hour, StallTimeout: time.Hour})
	t.Cleanup(m.Shutdown)
	return m, st, r, res
}

func testChannel() config.Channel {
	return config.Channel{ID: "ch1", Enabled: true, Input: config.Input{Type: "test"},
		Video: config.Video{Codec: "h264", Encoder: "x264", Width: 1280, Height: 720, FPS: "30", BitrateKbps: 3000},
		Outputs: []config.Output{
			{ID: "srt", Type: "srt", Enabled: true, URL: "srt://10.0.0.1:9000"},
			{ID: "udp", Type: "udp", Enabled: true, URL: "udp://239.1.1.1:5000"},
			{ID: "off", Type: "udp", Enabled: false, URL: "udp://239.1.1.1:5002"},
		}}
}

func mustUpdate(t *testing.T, st *config.Store, fn func(c *config.Config)) {
	t.Helper()
	if _, err := st.Update(func(c *config.Config) error { fn(c); return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestChannelLifecycleAndHotOutputs(t *testing.T) {
	m, st, r, _ := setup(t)
	mustUpdate(t, st, func(c *config.Config) { c.Channels = append(c.Channels, testChannel()) })
	m.SyncAll()
	eventually(t, "engine+2 outputs", func() bool {
		return r.isAlive("ch1/engine") && r.isAlive("ch1/srt") && r.isAlive("ch1/udp")
	})
	if r.count("ch1/off") != 0 {
		t.Fatal("disabled output started")
	}
	cs, _ := m.ChannelStatusByID("ch1")
	eng := strings.Join(r.spec("ch1/engine").Args, " ")
	if !strings.Contains(eng, "x264enc") || !strings.Contains(eng, "port="+strconv.Itoa(cs.BusPort)) {
		t.Fatalf("engine spec: %s (bus %d)", eng, cs.BusPort)
	}

	// hot add: only the new output starts
	mustUpdate(t, st, func(c *config.Config) {
		c.Channels[0].Outputs = append(c.Channels[0].Outputs, config.Output{ID: "rtmp", Type: "rtmp", Enabled: true, URL: "rtmp://yt/live2/k"})
	})
	m.Sync("ch1")
	eventually(t, "rtmp up", func() bool { return r.isAlive("ch1/rtmp") })
	if r.count("ch1/engine") != 1 || r.count("ch1/srt") != 1 || r.count("ch1/udp") != 1 {
		t.Fatalf("hot add disturbed others: engine=%d srt=%d udp=%d", r.count("ch1/engine"), r.count("ch1/srt"), r.count("ch1/udp"))
	}

	// hot remove: only that output stops
	mustUpdate(t, st, func(c *config.Config) {
		c.Channels[0].Outputs = []config.Output{c.Channels[0].Outputs[1], c.Channels[0].Outputs[3]}
	})
	m.Sync("ch1")
	eventually(t, "srt stopped", func() bool { return !r.isAlive("ch1/srt") })
	if !r.isAlive("ch1/udp") || !r.isAlive("ch1/rtmp") || !r.isAlive("ch1/engine") || r.count("ch1/engine") != 1 {
		t.Fatal("hot remove disturbed others")
	}

	// output edit restarts only that output
	mustUpdate(t, st, func(c *config.Config) { c.Channels[0].Outputs[0].URL = "udp://239.1.1.9:5000" })
	m.Sync("ch1")
	eventually(t, "udp restarted", func() bool { return r.count("ch1/udp") == 2 && r.isAlive("ch1/udp") })
	if r.count("ch1/rtmp") != 1 || r.count("ch1/engine") != 1 {
		t.Fatal("output edit disturbed others")
	}

	// engine change restarts the engine only; outputs keep running
	mustUpdate(t, st, func(c *config.Config) { c.Channels[0].Video.BitrateKbps = 4500 })
	m.Sync("ch1")
	eventually(t, "engine restarted", func() bool { return r.count("ch1/engine") == 2 && r.isAlive("ch1/engine") })
	if !strings.Contains(strings.Join(r.spec("ch1/engine").Args, " "), "bitrate=4500") {
		t.Fatal("engine not rebuilt with the new bitrate")
	}
	if r.count("ch1/rtmp") != 1 || r.count("ch1/udp") != 2 {
		t.Fatal("engine change restarted outputs")
	}

	// disable: everything stops, ports go back to the pool
	mustUpdate(t, st, func(c *config.Config) { c.Channels[0].Enabled = false })
	m.Sync("ch1")
	if r.isAlive("ch1/engine") || r.isAlive("ch1/udp") || r.isAlive("ch1/rtmp") {
		t.Fatal("disable left processes running")
	}
	if m.d.Ports.InUse() != 0 {
		t.Fatalf("ports leaked: %d", m.d.Ports.InUse())
	}
	if cs, _ := m.ChannelStatusByID("ch1"); cs.State != StateStopped {
		t.Fatalf("state %s", cs.State)
	}
}

func TestWatchdogRestartsStalledEngine(t *testing.T) {
	m, st, r, _ := setup(t)
	m.d.StartGrace, m.d.StallTimeout = 50*time.Millisecond, 100*time.Millisecond
	c := testChannel()
	c.Outputs = nil
	mustUpdate(t, st, func(cfg *config.Config) { cfg.Channels = append(cfg.Channels, c) })
	m.SyncAll()
	eventually(t, "stall restart", func() bool { return r.count("ch1/engine") >= 2 })
	cs, _ := m.ChannelStatusByID("ch1")
	if cs.Stalls < 1 {
		t.Fatalf("stalls = %d", cs.Stalls)
	}
	lines, _ := m.Logs("ch1", "engine")
	if !strings.Contains(strings.Join(lines, "\n"), "[watchdog] no TS") {
		t.Fatal("watchdog did not log")
	}
}

func TestStreamHubOutputResolvesWithRetryAndPersists(t *testing.T) {
	m, st, r, res := setup(t)
	c := testChannel()
	c.Outputs = []config.Output{{ID: "sh", Type: "streamhub", Enabled: true, StreamHub: &config.StreamHubOutput{BaseURL: "https://sh.example", App: "live", Token: "sk_1", DeleteOnRemove: true}}}
	mustUpdate(t, st, func(cfg *config.Config) { cfg.Channels = append(cfg.Channels, c) })
	m.SyncAll()
	// first resolve fails, retry after 2 s succeeds
	eventually(t, "resolution error visible", func() bool {
		cs, _ := m.ChannelStatusByID("ch1")
		return len(cs.Outputs) == 1 && strings.Contains(cs.Outputs[0].Error, "core unreachable")
	})
	time.Sleep(2100 * time.Millisecond)
	eventually(t, "rtmp launched", func() bool { return r.isAlive("ch1/sh") })
	args := strings.Join(r.spec("ch1/sh").Args, " ")
	if !strings.Contains(args, "rtmp2sink") || !strings.Contains(args, "rtmp://sh:1935/live/key1") {
		t.Fatalf("concrete output: %s", args)
	}
	got := st.Get().Channels[0].Outputs[0].StreamHub
	if got.IngressID != "IN_1" || got.StreamKey != "key1" {
		t.Fatalf("resolution not persisted: %+v", got)
	}
	// persisting the resolution must not restart the output
	m.Sync("ch1")
	time.Sleep(50 * time.Millisecond)
	if r.count("ch1/sh") != 1 {
		t.Fatal("resolution write-back restarted the output")
	}
	cs, _ := m.ChannelStatusByID("ch1")
	if cs.Outputs[0].Target != "rtmp://sh:1935/live/***" { // the resolved stream key never leaves the box
		t.Fatalf("target %q", cs.Outputs[0].Target)
	}
	// removing it releases the ingress
	mustUpdate(t, st, func(cfg *config.Config) { cfg.Channels[0].Outputs = nil })
	m.Sync("ch1")
	eventually(t, "released", func() bool { res.mu.Lock(); defer res.mu.Unlock(); return len(res.released) == 1 })
}

func TestBuildErrorSurfacesAsState(t *testing.T) {
	m, st, _, _ := setup(t)
	c := testChannel()
	c.Video.Encoder = "nvenc" // not in StaticCaps
	mustUpdate(t, st, func(cfg *config.Config) { cfg.Channels = append(cfg.Channels, c) })
	m.SyncAll()
	cs, _ := m.ChannelStatusByID("ch1")
	if cs.State != StateError || !strings.Contains(cs.Error, "nvh264enc") {
		t.Fatalf("state=%s err=%s", cs.State, cs.Error)
	}
}

func TestPortPool(t *testing.T) {
	p := NewPortPool(47000, 47010)
	seen := map[int]bool{}
	for i := 0; i < 5; i++ {
		port, err := p.Allocate()
		if err != nil || seen[port] {
			t.Fatalf("alloc %d %v", port, err)
		}
		seen[port] = true
	}
	if p.InUse() != 5 {
		t.Fatal("inuse")
	}
	for port := range seen {
		p.Release(port)
	}
	if p.InUse() != 0 {
		t.Fatal("release")
	}
}
