package fleet

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// Port of fleet.service.ts. A periodic reconcile (plus an on-demand
// ensureForApp on every read) connects/drops one subscriber per app where the
// fleet plugin is installed + enabled AND the app's mqtt: broker is
// configured, and maintains the per-app fleet.db. Every path is best-effort.

const (
	reconnectBase  = time.Second
	reconnectMax   = 30 * time.Second
	connectTimeout = 10 * time.Second
	// ReconcileInterval is how often the reconcile + stale reaper runs.
	ReconcileInterval = 20 * time.Second
)

// Config are the resolved per-app fleet knobs (plugin config, defaults).
type Config struct {
	OfflineAfterSec   float64
	HistoryPoints     float64
	CommandTimeoutSec float64
}

// PluginRepo is the AppPluginsRepository slice fleet reads.
type PluginRepo interface {
	Get(ctx context.Context, app, pluginID string) (*plugins.Installed, error)
}

// Logs is LogsServiceContract.write.
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// InactiveError is FleetInactiveError (→ 409).
type InactiveError struct{ msg string }

func (e *InactiveError) Error() string { return e.msg }

type subscriber struct {
	client      Client
	fingerprint string
	prefix      string
	mu          sync.Mutex
	attempts    int
	errorLogged bool
}

// Deps wires the Service.
type Deps struct {
	Apps    contracts.AppsService
	Plugins PluginRepo
	Store   *Store
	Factory Factory
	// Logs is resolved at call time (nil getter / nil value = skip).
	Logs func() Logs
	Now  func() time.Time
}

// Service is FleetService.
type Service struct {
	apps    contracts.AppsService
	plugins PluginRepo
	store   *Store
	factory Factory
	logs    func() Logs
	now     func() time.Time

	mu   sync.Mutex
	subs map[string]*subscriber
}

// New builds the service (no background work until Start).
func New(d Deps) *Service {
	s := &Service{apps: d.Apps, plugins: d.Plugins, store: d.Store, factory: d.Factory, logs: d.Logs, now: d.Now, subs: map[string]*subscriber{}}
	if s.store == nil {
		s.store = NewStore()
	}
	if s.factory == nil {
		s.factory = DefaultFactory
	}
	if s.now == nil {
		s.now = time.Now
	}
	s.store.now = s.now
	return s
}

// Start runs the reconcile now and every ReconcileInterval (onModuleInit);
// cancelling ctx drops every subscriber and closes the stores.
func (s *Service) Start(ctx context.Context) {
	go func() {
		s.Reconcile(ctx)
		t := time.NewTicker(ReconcileInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				s.Close()
				return
			case <-t.C:
				s.Reconcile(ctx)
			}
		}
	}()
}

// Close drops every subscriber and closes the per-app DBs (onModuleDestroy).
func (s *Service) Close() {
	s.mu.Lock()
	apps := make([]string, 0, len(s.subs))
	for app := range s.subs {
		apps = append(apps, app)
	}
	s.mu.Unlock()
	for _, app := range apps {
		s.drop(app)
	}
	s.store.Close()
}

func (s *Service) log(level, message string, meta any) {
	if s.logs == nil {
		return
	}
	if l := s.logs(); l != nil {
		l.Write(level, "fleet", message, meta, nil)
	}
}

type warnMeta struct {
	App   string `json:"app"`
	Error string `json:"error"`
}

func (s *Service) warn(app, message string, err error) {
	s.log("warn", message, warnMeta{app, err.Error()})
}

// Reconcile brings subscribers in line with install state for every app and
// drops subscribers of vanished apps.
func (s *Service) Reconcile(ctx context.Context) {
	list, err := s.apps.List(ctx, nil)
	if err != nil {
		return
	}
	present := map[string]bool{}
	for _, a := range list {
		present[a.Name] = true
		if _, _, err := s.EnsureForApp(ctx, a.Name); err != nil {
			s.warn(a.Name, "reconcile failed", err)
		}
	}
	s.mu.Lock()
	var gone []string
	for app := range s.subs {
		if !present[app] {
			gone = append(gone, app)
		}
	}
	s.mu.Unlock()
	for _, app := range gone {
		s.drop(app)
	}
}

type appMeta struct {
	App string `json:"app"`
}

// EnsureForApp ensures a current subscriber iff fleet is enabled and the app
// has an MQTT broker; otherwise drops it. Also reaps stale agents. Returns
// the resolved topic prefix (active=false when fleet is inactive).
func (s *Service) EnsureForApp(ctx context.Context, app string) (prefix string, active bool, err error) {
	row, err := s.plugins.Get(ctx, app, "fleet")
	if err != nil {
		return "", false, err
	}
	if row == nil || !row.Enabled {
		s.drop(app)
		return "", false, nil
	}
	appCfg, err := s.apps.GetConfig(ctx, app)
	if err != nil {
		s.drop(app)
		return "", false, nil
	}
	appDir := s.apps.AppDir(app)
	cfg := appCfg.Mqtt
	if !cfg.Enabled || y.Trim(cfg.URL) == "" {
		s.drop(app)
		return "", false, nil
	}
	prefix = NormalizePrefix(y.Trim(cfg.TopicPrefix))
	if prefix == "" {
		prefix = "streamhub/" + app
	}

	fc := s.config(ctx, app)
	if flipped, err := s.store.ReapStale(ctx, app, appDir, fc.OfflineAfterSec*1000); err != nil {
		s.warn(app, "stale reap failed", err)
	} else {
		for _, id := range flipped {
			s.log("info", fmt.Sprintf("agent '%s' went offline (stale)", id), appMeta{app})
		}
	}
	s.ensureClient(app, cfg, prefix)
	return prefix, true, nil
}

type subscribedMeta struct {
	App    string `json:"app"`
	Prefix string `json:"prefix"`
}

func qosOf(q int) byte {
	if q == 1 || q == 2 {
		return byte(q)
	}
	return 0
}

func (s *Service) ensureClient(app string, cfg contracts.MqttConfig, prefix string) {
	fingerprint := strings.Join([]string{cfg.URL, cfg.Username, cfg.Password, fmt.Sprint(cfg.TLS), prefix}, " ")
	s.mu.Lock()
	existing := s.subs[app]
	s.mu.Unlock()
	if existing != nil && existing.fingerprint == fingerprint {
		return
	}
	if existing != nil {
		s.drop(app)
	}
	client, err := s.factory(ConnectOptions{
		URL: cfg.URL, Username: cfg.Username, Password: cfg.Password, TLS: cfg.TLS,
		ClientID:        "streamhub-fleet-" + app + "-" + uuid.NewString()[:8],
		ReconnectPeriod: reconnectBase, ConnectTimeout: connectTimeout,
	})
	if err != nil {
		s.warn(app, "fleet mqtt client creation failed", err)
		return
	}
	sub := &subscriber{client: client, fingerprint: fingerprint, prefix: prefix}
	s.mu.Lock()
	s.subs[app] = sub
	s.mu.Unlock()

	qos := qosOf(cfg.Qos)
	subscribe := func() {
		client.Subscribe(Subscriptions(prefix), qos, func(err error) {
			if err != nil {
				s.warn(app, "fleet subscribe failed", err)
			}
		})
	}
	client.Start(Events{
		OnConnect: func() {
			sub.mu.Lock()
			sub.attempts, sub.errorLogged = 0, false
			sub.mu.Unlock()
			client.SetReconnectPeriod(reconnectBase)
			subscribe()
			s.log("info", "subscribed to agent telemetry", subscribedMeta{app, prefix})
		},
		OnMessage: func(topic string, payload []byte) {
			s.OnMessage(context.Background(), app, prefix, topic, string(payload))
		},
		OnClose: func() {
			sub.mu.Lock()
			sub.attempts++
			d := time.Duration(math.Min(float64(reconnectMax), float64(reconnectBase)*math.Pow(2, math.Max(0, float64(sub.attempts-1)))))
			sub.mu.Unlock()
			client.SetReconnectPeriod(d)
		},
		OnError: func(err error) {
			sub.mu.Lock()
			logged := sub.errorLogged
			sub.errorLogged = true
			sub.mu.Unlock()
			if !logged {
				s.warn(app, "fleet broker connection error", err)
			}
		},
	})
	// An already-connected client (fake in tests) won't fire OnConnect.
	if client.Connected() {
		subscribe()
	}
}

func (s *Service) drop(app string) {
	s.mu.Lock()
	sub := s.subs[app]
	delete(s.subs, app)
	s.mu.Unlock()
	if sub != nil {
		sub.client.End()
	}
}

type resolvedMeta struct {
	App     string `json:"app"`
	AgentID string `json:"agentId"`
}

// OnMessage routes one inbound message into the store. Never fails.
func (s *Service) OnMessage(ctx context.Context, app, prefix, topic, payload string) {
	agentID, kind, ok := ParseTopic(prefix, topic)
	if !ok {
		return
	}
	appDir := s.apps.AppDir(app)
	cfg := s.config(ctx, app)
	var err error
	switch kind {
	case KindTelemetry:
		t := ParseTelemetry(payload)
		if t == nil {
			return
		}
		err = s.store.RecordTelemetry(ctx, app, appDir, agentID, t, cfg.HistoryPoints)
	case KindStatus:
		status, version := parseStatus(payload)
		err = s.store.SetStatus(ctx, app, appDir, agentID, status, version)
	case KindCmdResult:
		res := parseResult(payload)
		if res == nil || res.Get("id") == "" {
			return
		}
		var applied bool
		applied, err = s.store.ResolveCommand(ctx, app, appDir, res)
		if err == nil && applied {
			verdict := "error"
			if res.Get("ok") == true {
				verdict = "ok"
			}
			s.log("info", fmt.Sprintf("command '%s' resolved (%s)", res.Get("id"), verdict), resolvedMeta{app, agentID})
		}
	}
	if err != nil {
		s.warn(app, "failed to handle "+kind, err)
	}
}

// AgentMetrics are an agent's latest metrics.
type FleetAgentMetrics struct {
	Cpu     *float64 `json:"cpu"`
	Mem     *float64 `json:"mem"`
	Temp    *float64 `json:"temp"`
	Uptime  *float64 `json:"uptime"`
	Cameras *float64 `json:"cameras"`
	Disk    *float64 `json:"disk"`
	// Battery is the percent 0–100, null on hosts with no battery (most of the fleet).
	Battery *float64 `json:"battery"`
	Relay   *string  `json:"relay"`
}

// AgentView is the serializable agent of the data route.
type FleetAgentView struct {
	AgentID  string            `json:"agentId"`
	Online   bool              `json:"online"`
	Status   string            `json:"status"`
	Version  *string           `json:"version"`
	LastSeen string            `json:"lastSeen"`
	AgeMs    *int64            `json:"ageMs"`
	Metrics  FleetAgentMetrics `json:"metrics"`
}

// Data is the GET agents payload.
type FleetData struct {
	Agents      []FleetAgentView `json:"agents"`
	GeneratedAt string           `json:"generatedAt"`
}

// AgentDetail is the GET agents/:agentId payload.
type FleetAgentDetail struct {
	Agent    *FleetAgentView     `json:"agent"`
	History  []FleetHistoryPoint `json:"history"`
	Commands []FleetCommandRow   `json:"commands"`
}

// GetData lists the app's agents (and wakes the subscriber).
func (s *Service) GetData(ctx context.Context, app string) (*FleetData, error) {
	if _, _, err := s.EnsureForApp(ctx, app); err != nil {
		return nil, err
	}
	rows, err := s.store.ListAgents(ctx, app, s.apps.AppDir(app))
	if err != nil {
		return nil, err
	}
	out := &FleetData{Agents: make([]FleetAgentView, 0, len(rows)), GeneratedAt: jsx.ISO(s.now())}
	for _, r := range rows {
		out.Agents = append(out.Agents, s.view(r))
	}
	return out, nil
}

// GetAgent returns one agent + its history + its 20 newest commands.
func (s *Service) GetAgent(ctx context.Context, app, agentID string) (*FleetAgentDetail, error) {
	if _, _, err := s.EnsureForApp(ctx, app); err != nil {
		return nil, err
	}
	appDir := s.apps.AppDir(app)
	row, err := s.store.GetAgent(ctx, app, appDir, agentID)
	if err != nil {
		return nil, err
	}
	cfg := s.config(ctx, app)
	hist, err := s.store.History(ctx, app, appDir, agentID, cfg.HistoryPoints)
	if err != nil {
		return nil, err
	}
	cmds, err := s.store.CommandsFor(ctx, app, appDir, agentID, 20)
	if err != nil {
		return nil, err
	}
	out := &FleetAgentDetail{History: hist, Commands: cmds}
	if out.History == nil {
		out.History = []FleetHistoryPoint{}
	}
	if row != nil {
		v := s.view(*row)
		out.Agent = &v
	}
	return out, nil
}

type commandEnvelope struct {
	ID      string `json:"id"`
	Command string `json:"command"`
	Args    *y.Map `json:"args"`
	Ts      string `json:"ts"`
}

type commandMeta struct {
	App     string `json:"app"`
	AgentID string `json:"agentId"`
	Command string `json:"command"`
}

// SendCommand validates, publishes the command to the agent cmd topic and
// records it pending. *CommandError → 400, *InactiveError → 409.
func (s *Service) SendCommand(ctx context.Context, app, agentID string, command, args any) (*FleetCommandRow, error) {
	id := uuid.NewString()
	name, normArgs, err := ValidateCommand(command, args)
	if err != nil {
		return nil, err
	}
	prefix, active, err := s.EnsureForApp(ctx, app)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	sub := s.subs[app]
	s.mu.Unlock()
	if !active || sub == nil {
		return nil, &InactiveError{fmt.Sprintf("fleet is not active for app '%s' (install+enable the fleet plugin and configure mqtt)", app)}
	}
	appDir := s.apps.AppDir(app)
	if err := s.store.RecordCommand(ctx, app, appDir, id, agentID, name, normArgs); err != nil {
		return nil, err
	}
	payload, _ := jsx.Stringify(commandEnvelope{id, name, normArgs, jsx.ISO(s.now())})
	sub.client.Publish(CommandTopic(prefix, agentID), []byte(payload), 1, false, func(err error) {
		if err != nil {
			s.warn(app, fmt.Sprintf("command publish to '%s' failed", agentID), err)
		}
	})
	s.log("info", fmt.Sprintf("command '%s' → agent '%s' (%s)", name, agentID, id), commandMeta{app, agentID, name})
	return s.store.GetCommand(ctx, app, appDir, id)
}

// config resolves the fleet plugin config (positive finite numbers or the
// defaults 90 / 120 / 30).
func (s *Service) config(ctx context.Context, app string) Config {
	var c *y.Map
	if row, err := s.plugins.Get(ctx, app, "fleet"); err == nil && row != nil {
		c = row.Config
	}
	get := func(k string, def float64) float64 {
		if c == nil {
			return def
		}
		var n float64
		switch v := c.Get(k).(type) {
		case float64:
			n = v
		case string:
			n = y.StringToNumber(v)
		default:
			return def
		}
		if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
			return def
		}
		return n
	}
	return Config{get("offlineAfterSec", 90), get("historyPoints", 120), get("commandTimeoutSec", 30)}
}

func metric(t *y.Map, k string) *float64 {
	if t == nil {
		return nil
	}
	if f, ok := t.Get(k).(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
		return &f
	}
	return nil
}

func (s *Service) view(r AgentRow) FleetAgentView {
	v := FleetAgentView{AgentID: r.AgentID, Online: r.Status == "online", Status: r.Status, Version: r.Version, LastSeen: r.LastSeen}
	if v.Version == nil && r.Telemetry != nil {
		if av, ok := r.Telemetry.Get("agentVersion").(string); ok {
			v.Version = &av
		}
	}
	if r.LastSeen != "" {
		if t, ok := jsx.ParseDate(r.LastSeen); ok {
			ms := s.now().UnixMilli() - t.UnixMilli()
			v.AgeMs = &ms
		}
	}
	t := r.Telemetry
	v.Metrics = FleetAgentMetrics{metric(t, "cpu"), metric(t, "mem"), metric(t, "temp"), metric(t, "uptime"), metric(t, "cameras"), metric(t, "disk"), metric(t, "battery"), nil}
	if t != nil {
		if relay, ok := t.Get("relay").(string); ok {
			v.Metrics.Relay = &relay
		}
	}
	return v
}
