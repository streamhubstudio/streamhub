// Package channel runs channels: for each enabled channel it owns the TS bus,
// the supervised engine process and one supervised process per enabled
// output, and reconciles them against the persisted config. Output changes
// are applied in place (hot add/remove/update) without touching the engine or
// the other outputs; only engine-relevant changes restart the engine (and even
// then the outputs keep running across the gap).
package channel

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sort"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/notify"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/pipeline"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/supervisor"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/tsbus"
)

// Resolver turns a "streamhub" output into a concrete rtmp/whip output by
// talking to StreamHub (create/reuse the ingress). Implemented in internal/streamhub.
type Resolver interface {
	Resolve(ctx context.Context, ch config.Channel, o config.Output) (resolved config.StreamHubOutput, concrete config.Output, err error)
	Release(ctx context.Context, o config.Output) error
}

// Deps wires the manager.
type Deps struct {
	Store     *config.Store
	Caps      pipeline.Caps
	Runner    supervisor.Runner
	GstLaunch string // default gst-launch-1.0
	FFmpeg    string // default ffmpeg
	Ports     *PortPool
	Resolver  Resolver
	Log       *slog.Logger
	Sup       supervisor.Options
	// StallTimeout: engine running but no TS for this long → restart (default 6 s).
	StallTimeout time.Duration
	// StartGrace: time an engine gets before the stall watchdog applies (default 20 s).
	StartGrace time.Duration
	Now        func() time.Time
	// Notify receives alarm raise/clear events (webhooks, SNMP); nil = none.
	Notify func(notify.Event)
	// DeviceID is put on alarm events.
	DeviceID string
}

// Manager reconciles runtime state with the config.
type Manager struct {
	d       Deps
	applyMu sync.Mutex // serialises reconciliation
	mu      sync.Mutex // guards chans
	chans   map[string]*chanRT
	alarms  *alarmBook
}

type chanRT struct {
	mu        sync.Mutex
	cfg       config.Channel
	bus       *tsbus.Bus
	busOpened time.Time
	thumbPort int
	pcmPort   int
	mon       *Monitor
	engine    *supervisor.Process
	built     pipeline.Engine
	buildErr  string
	outs      map[string]*outRT
	stalls    int
	startedAt time.Time
	stop      chan struct{}
	wg        sync.WaitGroup
	// secrets: every secret value this channel's processes were started with
	// (kept for the runtime's life: an old process's log lines may still echo a
	// replaced passphrase). Status and Logs are scrubbed with them.
	secrets []string
}

// addSecretsLocked records secret values (rt.mu held).
func (rt *chanRT) addSecretsLocked(vals []string) {
	for _, v := range vals {
		if v != "" && !slices.Contains(rt.secrets, v) {
			rt.secrets = append(rt.secrets, v)
		}
	}
}

type outRT struct {
	cfg      config.Output
	port     int
	proc     *supervisor.Process
	concrete *config.Output
	err      string
	cancel   context.CancelFunc
}

// New creates a manager.
func New(d Deps) *Manager {
	if d.GstLaunch == "" {
		d.GstLaunch = pipeline.GstLaunch
	}
	if d.FFmpeg == "" {
		d.FFmpeg = pipeline.FFmpeg
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.StallTimeout == 0 {
		d.StallTimeout = 6 * time.Second
	}
	if d.StartGrace == 0 {
		d.StartGrace = 20 * time.Second
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Ports == nil {
		d.Ports = NewPortPool(41000, 41999)
	}
	return &Manager{d: d, chans: map[string]*chanRT{}, alarms: newAlarmBook(d.Notify, d.DeviceID)}
}

// SyncAll reconciles every channel with the stored config.
func (m *Manager) SyncAll() {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	cfg := m.d.Store.Get()
	want := map[string]bool{}
	for _, ch := range cfg.Channels {
		want[ch.ID] = true
		m.reconcile(ch)
	}
	m.mu.Lock()
	var gone []*chanRT
	for id, rt := range m.chans {
		if !want[id] {
			gone = append(gone, rt)
			delete(m.chans, id)
		}
	}
	m.mu.Unlock()
	for _, rt := range gone {
		m.stopChannel(rt, true)
	}
}

// Sync reconciles one channel (or stops it if it no longer exists).
func (m *Manager) Sync(id string) {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	cfg := m.d.Store.Get()
	if i := cfg.FindChannel(id); i >= 0 {
		m.reconcile(cfg.Channels[i])
		return
	}
	m.mu.Lock()
	rt := m.chans[id]
	delete(m.chans, id)
	m.mu.Unlock()
	if rt != nil {
		m.stopChannel(rt, true)
	}
}

// Shutdown stops everything (process exit); StreamHub ingresses are kept.
func (m *Manager) Shutdown() {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	m.mu.Lock()
	all := make([]*chanRT, 0, len(m.chans))
	for id, rt := range m.chans {
		all = append(all, rt)
		delete(m.chans, id)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, rt := range all {
		wg.Add(1)
		go func(rt *chanRT) { defer wg.Done(); m.stopChannel(rt, false) }(rt)
	}
	wg.Wait()
}

// engineKey is the part of a channel that requires an engine restart.
func engineKey(ch config.Channel) string {
	ch.Outputs, ch.Name, ch.Enabled = nil, "", false
	ch.SCTE35, ch.Alarms = nil, nil // applied live, no engine restart
	b, _ := json.Marshal(ch)
	return string(b)
}

// outputKey ignores fields the encoder itself writes back (resolution results).
func outputKey(ch config.Channel, o config.Output) string {
	if o.StreamHub != nil {
		s := *o.StreamHub
		s.IngressID, s.ResolvedURL, s.StreamKey = "", "", ""
		o.StreamHub = &s
	}
	o.Name = ""
	// The output process depends on codec/audio of the channel too.
	b, _ := json.Marshal(struct {
		O     config.Output
		Codec string
		NoAud bool
	}{o, ch.Video.Codec, ch.Audio.Disabled})
	return string(b)
}

func (m *Manager) reconcile(ch config.Channel) {
	m.mu.Lock()
	rt := m.chans[ch.ID]
	m.mu.Unlock()
	if !ch.Enabled {
		if rt != nil {
			m.mu.Lock()
			delete(m.chans, ch.ID)
			m.mu.Unlock()
			m.stopChannel(rt, false)
		}
		return
	}
	if rt == nil {
		rt = m.startChannel(ch)
		if rt == nil {
			return
		}
		m.mu.Lock()
		m.chans[ch.ID] = rt
		m.mu.Unlock()
		return
	}
	rt.mu.Lock()
	prev := rt.cfg
	rt.cfg = ch
	rt.mu.Unlock()
	m.applySCTE35(rt, ch)
	if engineKey(prev) != engineKey(ch) {
		m.d.Log.Info("engine config changed; restarting engine (outputs keep running)", "channel", ch.ID)
		m.rebuildEngine(rt, ch)
	} else {
		rt.mu.Lock()
		failed := rt.buildErr != ""
		rt.mu.Unlock()
		if failed { // e.g. a HW encoder that appeared after a re-probe
			m.rebuildEngine(rt, ch)
		}
	}
	m.reconcileOutputs(rt, prev, ch)
}

func (m *Manager) startChannel(ch config.Channel) *chanRT {
	port, err := m.d.Ports.Allocate()
	if err != nil {
		m.d.Log.Error("channel start", "channel", ch.ID, "err", err)
		return nil
	}
	bus, err := tsbus.Listen(port)
	if err != nil {
		m.d.Ports.Release(port)
		m.d.Log.Error("channel bus", "channel", ch.ID, "err", err)
		return nil
	}
	rt := &chanRT{cfg: ch, bus: bus, busOpened: m.d.Now(), outs: map[string]*outRT{}, stop: make(chan struct{}), startedAt: m.d.Now()}
	// confidence taps (thumbnails + PCM); a failure only disables monitoring
	if p, err := m.d.Ports.Allocate(); err == nil {
		rt.thumbPort = p
	}
	if p, err := m.d.Ports.Allocate(); err == nil {
		rt.pcmPort = p
	}
	m.applySCTE35(rt, ch)
	sup := m.d.Sup
	rt.engine = supervisor.New(supervisor.Spec{Name: ch.ID + "/engine", Path: m.d.GstLaunch}, m.d.Runner, sup)
	m.rebuildEngine(rt, ch)
	// Outputs first would lose nothing either way (the bus drops until a sink
	// registers); starting them alongside keeps first-frame latency low.
	m.reconcileOutputs(rt, config.Channel{}, ch)
	rt.wg.Add(1)
	go m.watchdog(rt)
	m.d.Log.Info("channel started", "channel", ch.ID, "bus", port)
	return rt
}

// rebuildEngine (re)builds the engine command and (re)starts it.
func (m *Manager) rebuildEngine(rt *chanRT, ch config.Channel) {
	eng, err := pipeline.BuildEngineWith(ch, pipeline.Ports{Bus: rt.bus.Port(), Thumb: rt.thumbPort, PCM: rt.pcmPort}, m.d.Caps)
	m.restartMonitor(rt, ch)
	rt.mu.Lock()
	rt.addSecretsLocked(config.ChannelSecrets(ch))
	if err != nil {
		rt.buildErr = err.Error()
		rt.mu.Unlock()
		m.d.Log.Error("engine build", "channel", ch.ID, "err", err)
		rt.engine.Stop()
		return
	}
	rt.buildErr = ""
	rt.built = eng
	rt.startedAt = m.d.Now()
	rt.mu.Unlock()
	path, args := eng.Command(m.d.GstLaunch, m.d.FFmpeg)
	spec := supervisor.Spec{Name: ch.ID + "/engine", Path: path, Args: args}
	if st := rt.engine.Status(); st.State == supervisor.Stopped {
		rt.engine.SetSpec(spec)
		rt.engine.Start()
	} else {
		rt.engine.SetSpec(spec)
		rt.engine.Restart()
	}
}

func (m *Manager) reconcileOutputs(rt *chanRT, prev, ch config.Channel) {
	want := map[string]config.Output{}
	for _, o := range ch.Outputs {
		if o.Enabled {
			want[o.ID] = o
		}
	}
	prevByID := map[string]config.Output{}
	for _, o := range prev.Outputs {
		prevByID[o.ID] = o
	}
	rt.mu.Lock()
	var stop []*outRT
	var stopIDs []string
	for id, ort := range rt.outs {
		o, ok := want[id]
		if !ok || outputKey(ch, o) != outputKey(prev, ort.cfg) {
			stop = append(stop, ort)
			stopIDs = append(stopIDs, id)
			delete(rt.outs, id)
		}
	}
	rt.mu.Unlock()
	for i, ort := range stop {
		m.stopOutput(rt, stopIDs[i], ort)
		// Output removed from the config entirely: release StreamHub resources.
		if _, still := ch.FindOutputCfg(stopIDs[i]); !still && ort.cfg.Type == config.OutStreamHub && m.d.Resolver != nil {
			go func(o config.Output) {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				if err := m.d.Resolver.Release(ctx, o); err != nil {
					m.d.Log.Warn("streamhub release", "output", o.ID, "err", err)
				}
			}(ort.cfg)
		}
	}
	ids := make([]string, 0, len(want))
	for id := range want {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		rt.mu.Lock()
		_, running := rt.outs[id]
		rt.mu.Unlock()
		if !running {
			m.startOutput(rt, ch, want[id])
		}
	}
}

func (m *Manager) startOutput(rt *chanRT, ch config.Channel, o config.Output) {
	port, err := m.d.Ports.Allocate()
	ort := &outRT{cfg: o, port: port}
	if err != nil {
		ort.err = err.Error()
		rt.mu.Lock()
		rt.outs[o.ID] = ort
		rt.mu.Unlock()
		return
	}
	ort.proc = supervisor.New(supervisor.Spec{Name: ch.ID + "/" + o.ID}, m.d.Runner, m.d.Sup)
	rt.mu.Lock()
	rt.outs[o.ID] = ort
	rt.mu.Unlock()
	if o.Type == config.OutStreamHub {
		ctx, cancel := context.WithCancel(context.Background())
		ort.cancel = cancel
		go m.resolveLoop(ctx, rt, ch, ort)
		return
	}
	m.launchOutput(rt, ch, ort, o)
}

func (m *Manager) launchOutput(rt *chanRT, ch config.Channel, ort *outRT, concrete config.Output) {
	cmd, err := pipeline.BuildOutput(ch, concrete, ort.port, m.d.Now())
	if err != nil {
		rt.mu.Lock()
		ort.err = err.Error()
		rt.mu.Unlock()
		m.d.Log.Error("output build", "channel", ch.ID, "output", ort.cfg.ID, "err", err)
		return
	}
	if concrete.Type == config.OutRecord {
		_ = os.MkdirAll(concrete.URL, 0o755)
	}
	path := cmd.Path
	switch path {
	case pipeline.GstLaunch:
		path = m.d.GstLaunch
	case pipeline.FFmpeg:
		path = m.d.FFmpeg
	}
	rt.mu.Lock()
	c := concrete
	ort.concrete = &c
	rt.addSecretsLocked(config.OutputSecrets(concrete))
	ort.err = ""
	rt.mu.Unlock()
	ort.proc.SetSpec(supervisor.Spec{Name: ch.ID + "/" + ort.cfg.ID, Path: path, Args: cmd.Args, Env: cmd.Env})
	rt.bus.AddSink(ort.cfg.ID, ort.port)
	ort.proc.Start()
	m.d.Log.Info("output started", "channel", ch.ID, "output", ort.cfg.ID, "type", concrete.Type)
}

// resolveLoop resolves a streamhub output with retry/backoff, persists the
// resolution (so restarts reuse the same ingress/key) and launches it.
func (m *Manager) resolveLoop(ctx context.Context, rt *chanRT, ch config.Channel, ort *outRT) {
	delay := 2 * time.Second
	for {
		if m.d.Resolver == nil {
			rt.mu.Lock()
			ort.err = "no StreamHub resolver configured"
			rt.mu.Unlock()
			return
		}
		rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		resolved, concrete, err := m.d.Resolver.Resolve(rctx, ch, ort.cfg)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			m.persistResolution(ch.ID, ort.cfg.ID, resolved)
			// keep the resolution on the runtime copy too: Release (deleteOnRemove)
			// needs the ingress id even if no reconcile happened since.
			rt.mu.Lock()
			r := resolved
			ort.cfg.StreamHub = &r
			rt.mu.Unlock()
			m.launchOutput(rt, ch, ort, concrete)
			return
		}
		rt.mu.Lock()
		ort.err = "streamhub: " + err.Error()
		rt.mu.Unlock()
		m.d.Log.Warn("streamhub resolve", "channel", ch.ID, "output", ort.cfg.ID, "err", err, "retry", delay)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay *= 2; delay > 60*time.Second {
			delay = 60 * time.Second
		}
	}
}

func (m *Manager) persistResolution(chID, outID string, r config.StreamHubOutput) {
	_, err := m.d.Store.Update(func(c *config.Config) error {
		i := c.FindChannel(chID)
		if i < 0 {
			return fmt.Errorf("channel gone")
		}
		j := c.Channels[i].FindOutput(outID)
		if j < 0 || c.Channels[i].Outputs[j].StreamHub == nil {
			return fmt.Errorf("output gone")
		}
		s := c.Channels[i].Outputs[j].StreamHub
		s.IngressID, s.ResolvedURL, s.StreamKey = r.IngressID, r.ResolvedURL, r.StreamKey
		return nil
	})
	if err != nil {
		m.d.Log.Warn("persist streamhub resolution", "channel", chID, "output", outID, "err", err)
	}
}

func (m *Manager) stopOutput(rt *chanRT, id string, ort *outRT) {
	if ort.cancel != nil {
		ort.cancel()
	}
	rt.bus.RemoveSink(id)
	if ort.proc != nil {
		ort.proc.Stop()
	}
	m.d.Ports.Release(ort.port)
	m.d.Log.Info("output stopped", "channel", rt.cfg.ID, "output", id)
}

func (m *Manager) stopChannel(rt *chanRT, removed bool) {
	close(rt.stop)
	rt.wg.Wait()
	rt.mu.Lock()
	outs := rt.outs
	rt.outs = map[string]*outRT{}
	rt.mu.Unlock()
	var wg sync.WaitGroup
	for id, ort := range outs {
		wg.Add(1)
		go func(id string, ort *outRT) { defer wg.Done(); m.stopOutput(rt, id, ort) }(id, ort)
	}
	rt.engine.Stop()
	wg.Wait()
	rt.mu.Lock()
	mon := rt.mon
	rt.mon = nil
	rt.mu.Unlock()
	if mon != nil {
		mon.Close()
	}
	m.d.Ports.Release(rt.thumbPort)
	m.d.Ports.Release(rt.pcmPort)
	m.alarms.clearChannel(m.d.Now(), rt.cfg.ID)
	port := rt.bus.Port()
	rt.bus.Close()
	m.d.Ports.Release(port)
	if removed && m.d.Resolver != nil {
		for _, o := range rt.cfg.Outputs {
			if o.Type == config.OutStreamHub {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				_ = m.d.Resolver.Release(ctx, o)
				cancel()
			}
		}
	}
	m.d.Log.Info("channel stopped", "channel", rt.cfg.ID)
}

// watchdog restarts an engine that runs but produces no TS (wedged pipeline,
// e.g. a capture driver that stopped delivering without erroring out).
func (m *Manager) watchdog(rt *chanRT) {
	defer rt.wg.Done()
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-rt.stop:
			return
		case <-t.C:
		}
		m.evaluateAlarms(rt, m.d.Now())
		st := rt.engine.Status()
		if st.State != supervisor.Running {
			continue
		}
		since := m.d.Now().Sub(st.StartedAt)
		if since < m.d.StartGrace {
			continue
		}
		last := rt.bus.Stats().LastPacketAt
		idle := since
		if !last.IsZero() && last.After(st.StartedAt) {
			idle = m.d.Now().Sub(last)
		}
		if idle > m.d.StallTimeout {
			rt.mu.Lock()
			rt.stalls++
			rt.mu.Unlock()
			m.d.Log.Warn("engine stalled (no TS); restarting", "channel", rt.cfg.ID, "idle", idle.Round(time.Millisecond))
			rt.engine.Logs().Add(fmt.Sprintf("[watchdog] no TS for %s; restarting engine", idle.Round(time.Millisecond)))
			rt.engine.Restart()
		}
	}
}

// RestartEngine force-restarts a channel's engine.
func (m *Manager) RestartEngine(id string) bool {
	m.mu.Lock()
	rt := m.chans[id]
	m.mu.Unlock()
	if rt == nil {
		return false
	}
	rt.engine.Restart()
	return true
}

// RestartOutput force-restarts one output process.
func (m *Manager) RestartOutput(chID, outID string) bool {
	m.mu.Lock()
	rt := m.chans[chID]
	m.mu.Unlock()
	if rt == nil {
		return false
	}
	rt.mu.Lock()
	ort := rt.outs[outID]
	rt.mu.Unlock()
	if ort == nil || ort.proc == nil {
		return false
	}
	ort.proc.Restart()
	return true
}

// Logs returns the log lines of a channel's engine ("engine") or an output.
func (m *Manager) Logs(chID, proc string) ([]string, bool) {
	m.mu.Lock()
	rt := m.chans[chID]
	m.mu.Unlock()
	if rt == nil {
		return nil, false
	}
	rt.mu.Lock()
	sec := append(config.ChannelSecrets(rt.cfg), rt.secrets...)
	ort := rt.outs[proc]
	rt.mu.Unlock()
	if proc == "" || proc == "engine" {
		return config.ScrubAll(rt.engine.Logs().Lines(), sec), true
	}
	if ort == nil || ort.proc == nil {
		return nil, false
	}
	return config.ScrubAll(ort.proc.Logs().Lines(), sec), true
}
