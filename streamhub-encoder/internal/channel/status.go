package channel

import (
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/scte35"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/supervisor"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/tsbus"
)

// Channel states.
const (
	StateStopped      = "stopped"
	StateStarting     = "starting"
	StateLive         = "live"
	StateDegraded     = "degraded"     // live, but an enabled output is not running
	StateReconnecting = "reconnecting" // engine exited, restarting
	StateError        = "error"        // cannot build/start (config vs host capabilities)
)

// SCTE35Status is the injector state (own name for the OpenAPI schema).
type SCTE35Status scte35.Stats

// ChannelStatus is the runtime view of a channel.
type ChannelStatus struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	Enabled    bool               `json:"enabled"`
	State      string             `json:"state"`
	Error      string             `json:"error,omitempty"`
	Encoder    string             `json:"encoder,omitempty"` // resolved element, e.g. nvh265enc
	Backend    string             `json:"backend,omitempty"`
	Engine     *supervisor.Status `json:"engine,omitempty"`
	EngineProc *ProcStat          `json:"engineProc,omitempty"`
	Stats      *tsbus.Stats       `json:"stats,omitempty"`
	Stalls     int                `json:"stalls"`
	BusPort    int                `json:"busPort,omitempty"`
	Outputs    []OutputStatus     `json:"outputs"`
	UptimeS    float64            `json:"uptimeSeconds"`
	Monitor    *MonitorSnapshot   `json:"monitor,omitempty"`
	Alarms     []Alarm            `json:"alarms,omitempty"`
	SCTE35     *SCTE35Status      `json:"scte35,omitempty"`
}

// OutputStatus is the runtime view of one output.
type OutputStatus struct {
	ID      string             `json:"id"`
	Name    string             `json:"name"`
	Type    string             `json:"type"`
	Enabled bool               `json:"enabled"`
	State   string             `json:"state"` // stopped|resolving|running|backoff|error
	Error   string             `json:"error,omitempty"`
	Target  string             `json:"target,omitempty"` // concrete URL (streamhub → resolved)
	Process *supervisor.Status `json:"process,omitempty"`
	Proc    *ProcStat          `json:"proc,omitempty"`
	Bus     *tsbus.SinkStats   `json:"bus,omitempty"`
}

// Status returns every configured channel, running or not.
func (m *Manager) Status() []ChannelStatus {
	cfg := m.d.Store.Get()
	out := make([]ChannelStatus, 0, len(cfg.Channels))
	for _, ch := range cfg.Channels {
		out = append(out, m.channelStatus(ch))
	}
	return out
}

// ChannelStatusByID returns one channel's status.
func (m *Manager) ChannelStatusByID(id string) (ChannelStatus, bool) {
	cfg := m.d.Store.Get()
	i := cfg.FindChannel(id)
	if i < 0 {
		return ChannelStatus{}, false
	}
	return m.channelStatus(cfg.Channels[i]), true
}

func (m *Manager) channelStatus(ch config.Channel) ChannelStatus {
	cs := ChannelStatus{ID: ch.ID, Name: ch.Name, Enabled: ch.Enabled, State: StateStopped, Outputs: []OutputStatus{}}
	m.mu.Lock()
	rt := m.chans[ch.ID]
	m.mu.Unlock()
	if rt == nil {
		for _, o := range ch.Outputs {
			cs.Outputs = append(cs.Outputs, OutputStatus{ID: o.ID, Name: o.Name, Type: o.Type, Enabled: o.Enabled, State: "stopped"})
		}
		return cs
	}
	es := rt.engine.Status()
	stats := rt.bus.Stats()
	ps := ReadProcTreeStat(es.Pid)
	rt.mu.Lock()
	defer rt.mu.Unlock()
	cs.Engine, cs.Stats, cs.Stalls, cs.BusPort = &es, &stats, rt.stalls, rt.bus.Port()
	cs.EngineProc = &ps
	cs.Encoder, cs.Backend = rt.built.Element, rt.built.Backend
	cs.UptimeS = time.Since(rt.startedAt).Seconds()
	if rt.mon != nil {
		ms := rt.mon.Snapshot()
		cs.Monitor = &ms
	}
	cs.Alarms = m.alarms.activeFor(ch.ID)
	if inj := rt.bus.Injector(); inj != nil {
		st := SCTE35Status(inj.Stats())
		cs.SCTE35 = &st
	}
	sinks := rt.bus.SinkStats()
	now := m.d.Now()
	fresh := !stats.LastPacketAt.IsZero() && now.Sub(stats.LastPacketAt) < 2*time.Second
	switch {
	case rt.buildErr != "":
		cs.State, cs.Error = StateError, rt.buildErr
	case es.State == supervisor.Backoff:
		cs.State, cs.Error = StateReconnecting, es.LastExit
	case fresh:
		cs.State = StateLive
	default:
		cs.State = StateStarting
	}
	for _, o := range ch.Outputs {
		os := OutputStatus{ID: o.ID, Name: o.Name, Type: o.Type, Enabled: o.Enabled, State: "stopped"}
		if ort := rt.outs[o.ID]; ort != nil {
			os.Error = ort.err
			if ort.concrete != nil {
				os.Target = ort.concrete.URL
			}
			switch {
			case ort.proc == nil || (ort.concrete == nil && o.Type == config.OutStreamHub && ort.err == ""):
				os.State = "resolving"
			case ort.err != "" && ort.concrete == nil:
				os.State = "error"
			default:
				ps := ort.proc.Status()
				os.Process = &ps
				pst := ReadProcTreeStat(ps.Pid)
				os.Proc = &pst
				os.State = string(ps.State)
				if ps.State == supervisor.Backoff {
					os.Error = ps.LastExit
				}
			}
			if s, ok := sinks[o.ID]; ok {
				os.Bus = &s
			}
			if cs.State == StateLive && os.State != "running" {
				cs.State = StateDegraded
			}
		}
		cs.Outputs = append(cs.Outputs, os)
	}
	scrubStatus(&cs, append(config.ChannelSecrets(ch), rt.secrets...))
	return cs
}

// scrubStatus masks every secret in the free-text parts of a status: command
// lines, exit reasons, errors and output targets (they feed the API, the UI,
// alarms/webhooks/SNMP and the StreamHub status frame).
func scrubStatus(cs *ChannelStatus, sec []string) {
	cs.Error = config.Scrub(cs.Error, sec)
	scrubProc := func(p *supervisor.Status) *supervisor.Status {
		if p == nil {
			return nil
		}
		c := *p
		c.Command = config.ScrubAll(c.Command, sec)
		c.LastExit = config.Scrub(c.LastExit, sec)
		return &c
	}
	cs.Engine = scrubProc(cs.Engine)
	for i := range cs.Outputs {
		o := &cs.Outputs[i]
		o.Error = config.Scrub(o.Error, sec)
		o.Target = config.Scrub(config.RedactURL(o.Target), sec)
		o.Process = scrubProc(o.Process)
	}
}
