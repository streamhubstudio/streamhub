package streamhub

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/channel"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/presets"
)

// ManagedOutputID is the id of the output a paired StreamHub drives per channel.
const ManagedOutputID = "streamhub"

// Manager is what the service needs from the channel manager.
type Manager interface {
	Sync(id string)
	SyncAll()
	RestartEngine(id string) bool
	Status() []channel.ChannelStatus
}

// Service runs the native pairing / device-plane integration.
type Service struct {
	Store   *config.Store
	Manager Manager
	Version string
	Model   string
	Caps    func() map[string]any // free-form capabilities for hello
	HTTP    *http.Client
	Log     *slog.Logger
	// AllowReboot lets the core reboot the box (command "reboot").
	AllowReboot bool
	Reboot      func() error

	mu        sync.Mutex
	state     PairState
	cancel    context.CancelFunc // pairing poll or link
	link      *Link
	lastApply string
	cpu       cpuSampler
	bootAt    time.Time
}

// PairState is what the API/UI show.
type PairState struct {
	State       string `json:"state"` // unpaired|pending|paired|connected|revoked|error
	BaseURL     string `json:"baseUrl,omitempty"`
	DisplayCode string `json:"displayCode,omitempty"`
	ExpiresAt   string `json:"expiresAt,omitempty"`
	DeviceID    string `json:"deviceId,omitempty"`
	App         string `json:"app,omitempty"`
	Link        string `json:"link,omitempty"` // connecting|connected|disconnected: …
	ConfigRev   int64  `json:"configRev,omitempty"`
	LastError   string `json:"lastError,omitempty"`
	PairedAt    string `json:"pairedAt,omitempty"`
}

func (s *Service) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// Boot connects the link if the box is already paired.
func (s *Service) Boot() {
	s.bootAt = time.Now()
	c := s.Store.Get()
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.StreamHub.Credential == "" {
		s.state = PairState{State: "unpaired"}
		return
	}
	s.state = PairState{State: "paired", BaseURL: c.StreamHub.BaseURL, DeviceID: c.StreamHub.DeviceID, PairedAt: c.StreamHub.PairedAt, ConfigRev: c.StreamHub.ConfigRev}
	s.startLinkLocked(c.StreamHub)
}

// State returns the pairing state.
func (s *Service) State() PairState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.state
	if s.link != nil {
		st.ConfigRev = s.link.LastRev()
	}
	if st.State == "" {
		st.State = "unpaired"
	}
	return st
}

// StartPairing asks baseURL for a code and polls until claimed/expired.
func (s *Service) StartPairing(ctx context.Context, baseURL string) (PairState, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		return PairState{}, errors.New("baseUrl must be http(s)://…")
	}
	c := s.Store.Get()
	st, err := StartPairing(ctx, s.HTTP, baseURL, PairStartRequest{Model: s.Model, Version: s.Version, Serial: c.Device.ID})
	if err != nil {
		return PairState{}, err
	}
	s.mu.Lock()
	s.stopLocked()
	s.state = PairState{State: "pending", BaseURL: baseURL, DisplayCode: st.DisplayCode, ExpiresAt: st.ExpiresAt, DeviceID: st.DeviceID}
	pctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	out := s.state
	s.mu.Unlock()
	go s.poll(pctx, baseURL, st)
	return out, nil
}

func (s *Service) poll(ctx context.Context, base string, st PairStart) {
	every := time.Duration(st.PollInterval) * time.Second
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
		rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		p, err := PollPairing(rctx, s.HTTP, base, st.DeviceID, st.PollToken)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, ErrPairingExpired) {
			s.mu.Lock()
			s.state = PairState{State: "unpaired", BaseURL: base, LastError: "pairing code expired; start again"}
			s.mu.Unlock()
			return
		}
		if err != nil {
			s.mu.Lock()
			s.state.LastError = err.Error()
			s.mu.Unlock()
			var ae *APIError
			if errors.As(err, &ae) && ae.Status == http.StatusTooManyRequests {
				every *= 2
			}
			continue
		}
		if p.Status != "claimed" {
			continue
		}
		now := time.Now().UTC().Format(time.RFC3339)
		sh := config.StreamHub{BaseURL: base, DeviceID: p.DeviceID, Credential: p.Credential, WSURL: p.WSURL, PairedAt: now}
		if sh.DeviceID == "" {
			sh.DeviceID = st.DeviceID
		}
		if _, err := s.Store.Update(func(c *config.Config) error { c.StreamHub = sh; return nil }); err != nil {
			s.mu.Lock()
			s.state.LastError = "persist credential: " + err.Error()
			s.mu.Unlock()
			return
		}
		s.log().Info("paired with StreamHub", "base", base, "device", sh.DeviceID, "app", p.App)
		s.mu.Lock()
		s.state = PairState{State: "paired", BaseURL: base, DeviceID: sh.DeviceID, App: p.App, PairedAt: now}
		s.startLinkLocked(sh)
		s.mu.Unlock()
		return
	}
}

// Unpair forgets the credential and removes the StreamHub-managed outputs.
func (s *Service) Unpair() error {
	s.mu.Lock()
	s.stopLocked()
	s.state = PairState{State: "unpaired"}
	s.mu.Unlock()
	_, err := s.Store.Update(func(c *config.Config) error {
		c.StreamHub = config.StreamHub{}
		for i := range c.Channels {
			c.Channels[i].Outputs = withoutManaged(c.Channels[i].Outputs)
		}
		return nil
	})
	s.Manager.SyncAll()
	return err
}

func (s *Service) stopLocked() {
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.link = nil
}

func (s *Service) startLinkLocked(sh config.StreamHub) {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	l := &Link{WSURL: sh.WSURL, Credential: sh.Credential, Handler: s, HTTP: s.HTTP}
	l.SetLastRev(0) // the core re-sends config after hello; apply whatever it says
	l.OnState = func(st string) {
		s.mu.Lock()
		s.state.Link = st
		if st == "connected" {
			s.state.State = "connected"
		} else if s.state.State == "connected" {
			s.state.State = "paired"
		}
		s.mu.Unlock()
	}
	s.link = l
	go func() {
		err := l.Run(ctx)
		if errors.Is(err, ErrRevoked) {
			s.log().Warn("StreamHub revoked this device; back to unpaired")
			_ = s.Unpair()
			s.mu.Lock()
			s.state = PairState{State: "revoked", LastError: "the StreamHub operator revoked this encoder; pair again"}
			s.mu.Unlock()
		}
	}()
}

// ── Handler ─────────────────────────────────────────────────────────────────

// Hello implements Handler.
func (s *Service) Hello() Hello {
	c := s.Store.Get()
	chs := make([]ChannelRef, 0, len(c.Channels))
	for _, ch := range c.Channels {
		chs = append(chs, ChannelRef{ID: ch.ID, Name: ch.Name})
	}
	caps := map[string]any{}
	if s.Caps != nil {
		caps = s.Caps()
	}
	caps["channels"] = chs
	caps["protocols"] = []string{"rtmp", "srt"}
	return Hello{Model: s.Model, Version: s.Version, Serial: c.Device.ID, Capabilities: caps}
}

// Status implements Handler.
func (s *Service) Status() StatusFrame {
	st := StatusFrame{CPU: s.cpu.percent(), UptimeSec: int64(time.Since(s.bootAt).Seconds()), Channels: []ChannelStatus{}, Errors: []string{}}
	if g, ok := gpuUtil(); ok {
		st.GPU = &g
	}
	for _, cs := range s.Manager.Status() {
		e := ChannelStatus{ID: cs.ID, State: mapState(cs.State, cs.Enabled)}
		if cs.Stats != nil {
			e.BitrateKbps, e.FPS = cs.Stats.BitrateKbps, cs.Stats.FPS
		}
		msg := cs.Error
		for _, o := range cs.Outputs {
			if o.ID == ManagedOutputID && o.Error != "" {
				msg = "output: " + o.Error
			}
		}
		if msg != "" {
			e.Error = &msg
		}
		st.Channels = append(st.Channels, e)
	}
	s.mu.Lock()
	if s.lastApply != "" {
		st.Errors = append(st.Errors, s.lastApply)
	}
	s.mu.Unlock()
	return st
}

func mapState(s string, enabled bool) string {
	switch s {
	case channel.StateLive, channel.StateDegraded:
		return "live"
	case channel.StateStarting:
		return "starting"
	case channel.StateReconnecting:
		return "reconnecting"
	case channel.StateError:
		return "error"
	}
	if !enabled {
		return "stopped"
	}
	return "idle"
}

func withoutManaged(outs []config.Output) []config.Output {
	keep := outs[:0:0]
	for _, o := range outs {
		if o.ManagedBy != "streamhub" {
			keep = append(keep, o)
		}
	}
	return keep
}

// ManagedOutput converts a config channel entry into the encoder output.
func ManagedOutput(cc ConfigChannel) (config.Output, error) {
	o := config.Output{ID: ManagedOutputID, Name: "StreamHub " + cc.Room, Enabled: true, ManagedBy: "streamhub"}
	switch NormalizeProtocol(cc.Protocol) {
	case "rtmp":
		o.Type, o.URL = config.OutRTMP, cc.PublishURL
	case "srt":
		u, sid, err := SplitSRTPublish(cc.PublishURL)
		if err != nil {
			return o, err
		}
		o.Type, o.URL = config.OutSRT, u
		o.SRT = &config.SRTOptions{Mode: "caller", LatencyMs: 500, StreamID: sid}
	case "whip":
		o.Type, o.URL = config.OutWHIP, cc.PublishURL
		if cc.StreamKey != "" {
			o.WHIP = &config.WHIPOptions{BearerToken: cc.StreamKey}
		}
	default:
		return o, fmt.Errorf("unsupported protocol %q", cc.Protocol)
	}
	return o, nil
}

// ApplyConfig implements Handler: the managed output of every listed channel
// is set to the publish target; channels absent from the frame lose it.
func (s *Service) ApplyConfig(cf ConfigFrame) error {
	want := map[string]ConfigChannel{}
	for _, cc := range cf.Channels {
		want[cc.ID] = cc
	}
	var problems []string
	_, err := s.Store.Update(func(c *config.Config) error {
		for i := range c.Channels {
			ch := &c.Channels[i]
			ch.Outputs = withoutManaged(ch.Outputs)
			cc, ok := want[ch.ID]
			if !ok {
				continue
			}
			delete(want, ch.ID)
			o, err := ManagedOutput(cc)
			if err != nil {
				problems = append(problems, ch.ID+": "+err.Error())
				continue
			}
			o.ApplyDefaults(ch.ID)
			if errs := o.Validate(ch); len(errs) > 0 {
				problems = append(problems, ch.ID+": "+errs.Error())
				continue
			}
			ch.Outputs = append(ch.Outputs, o)
		}
		for id := range want {
			problems = append(problems, "unknown channel "+id)
		}
		c.StreamHub.ConfigRev = cf.Rev
		return nil
	})
	if err != nil {
		problems = append(problems, err.Error())
	}
	s.mu.Lock()
	s.lastApply = strings.Join(problems, "; ")
	s.state.App = cf.Device.App
	s.mu.Unlock()
	s.Manager.SyncAll()
	s.log().Info("StreamHub config applied", "rev", cf.Rev, "channels", len(cf.Channels), "problems", len(problems))
	if len(problems) > 0 {
		return errors.New(s.lastApply)
	}
	return nil
}

// Command implements Handler.
func (s *Service) Command(c Command) (bool, string) {
	setEnabled := func(on bool) (bool, string) {
		_, err := s.Store.Update(func(cfg *config.Config) error {
			i := cfg.FindChannel(c.Channel)
			if i < 0 {
				return fmt.Errorf("unknown channel %q", c.Channel)
			}
			cfg.Channels[i].Enabled = on
			return nil
		})
		if err != nil {
			return false, err.Error()
		}
		s.Manager.Sync(c.Channel)
		if on {
			return true, "started"
		}
		return true, "stopped"
	}
	switch c.Action {
	case "start":
		return setEnabled(true)
	case "stop":
		return setEnabled(false)
	case "restart":
		if s.Manager.RestartEngine(c.Channel) {
			return true, "restarted"
		}
		return setEnabled(true)
	case "apply_preset":
		p, ok := presets.FindProfile(c.Preset)
		if !ok {
			return false, "unknown preset " + strconv.Quote(c.Preset)
		}
		_, err := s.Store.Update(func(cfg *config.Config) error {
			i := cfg.FindChannel(c.Channel)
			if i < 0 {
				return fmt.Errorf("unknown channel %q", c.Channel)
			}
			presets.ApplyProfile(&cfg.Channels[i], p)
			return nil
		})
		if err != nil {
			return false, err.Error()
		}
		s.Manager.Sync(c.Channel)
		return true, "preset " + p.ID + " applied"
	case "reboot":
		if !s.AllowReboot || s.Reboot == nil {
			return false, "reboot is disabled on this encoder (ENCODERD_ALLOW_REBOOT)"
		}
		go func() { time.Sleep(2 * time.Second); _ = s.Reboot() }()
		return true, "rebooting"
	}
	return false, "unknown action " + strconv.Quote(c.Action)
}

// ── host metrics for status frames ──────────────────────────────────────────

type cpuSampler struct {
	mu          sync.Mutex
	idle, total uint64
}

func (c *cpuSampler) percent() float64 {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	line := strings.SplitN(string(b), "\n", 2)[0]
	f := strings.Fields(line)
	if len(f) < 5 {
		return 0
	}
	var total, idle uint64
	for i, v := range f[1:] {
		n, _ := strconv.ParseUint(v, 10, 64)
		total += n
		if i == 3 || i == 4 { // idle + iowait
			idle += n
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	dt, di := total-c.total, idle-c.idle
	first := c.total == 0
	c.total, c.idle = total, idle
	if first || dt == 0 {
		return 0
	}
	return float64(int64((1-float64(di)/float64(dt))*1000)) / 10
}
