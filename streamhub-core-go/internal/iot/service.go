// Package iot is the port of src/modules/iot: the generic per-app MQTT
// data-IN subscriber. Each app opting in with a `mqtt.subscribe: [{topic}]`
// list (read from the RAW config.yaml) gets one subscriber whose every
// inbound message becomes a single dispatch(app, 'iot.data', …) through the
// callbacks funnel. It reuses the fleet client seam and SSRF-guarded factory.
// No HTTP routes.
package iot

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/fleet"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

const (
	reconnectBase  = time.Second
	reconnectMax   = 30 * time.Second
	connectTimeout = 10 * time.Second
	// ReconcileInterval is how often subscribers are re-aligned with config.
	ReconcileInterval = 20 * time.Second
	// MaxSubscriptions caps the filters per app.
	MaxSubscriptions = 64
	// MaxMessageBytes bounds the forwarded body (UTF-16 units, as Node).
	MaxMessageBytes = 64 * 1024
)

// Callbacks is CallbacksServiceContract.dispatch.
type Callbacks interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// Logs is LogsServiceContract.write.
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Deps wires the Service.
type Deps struct {
	DataDir   string
	Apps      contracts.AppsService
	Factory   fleet.Factory
	Callbacks func() Callbacks
	Logs      func() Logs
}

type subscriber struct {
	client      fleet.Client
	fingerprint string
	mu          sync.Mutex
	attempts    int
	errorLogged bool
}

// Service is IotMqttInService.
type Service struct {
	dataDir   string
	apps      contracts.AppsService
	factory   fleet.Factory
	callbacks func() Callbacks
	logs      func() Logs

	mu   sync.Mutex
	subs map[string]*subscriber
}

// New builds the service (no background work until Start).
func New(d Deps) *Service {
	s := &Service{dataDir: d.DataDir, apps: d.Apps, factory: d.Factory, callbacks: d.Callbacks, logs: d.Logs, subs: map[string]*subscriber{}}
	if s.factory == nil {
		s.factory = fleet.DefaultFactory
	}
	return s
}

// Start reconciles now and every ReconcileInterval; cancelling ctx drops
// every subscriber.
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

// Close drops every subscriber.
func (s *Service) Close() {
	s.mu.Lock()
	apps := make([]string, 0, len(s.subs))
	for a := range s.subs {
		apps = append(apps, a)
	}
	s.mu.Unlock()
	for _, a := range apps {
		s.drop(a)
	}
}

func (s *Service) log(level, message string, meta any) {
	if s.logs == nil {
		return
	}
	if l := s.logs(); l != nil {
		l.Write(level, "iot", message, meta, nil)
	}
}

type warnMeta struct {
	App   string `json:"app"`
	Error string `json:"error"`
}

func (s *Service) warn(app, message string, err error) {
	s.log("warn", message, warnMeta{app, err.Error()})
}

// Reconcile aligns subscribers with every app's mqtt.subscribe config.
func (s *Service) Reconcile(ctx context.Context) {
	list, err := s.apps.List(ctx, nil)
	if err != nil {
		return
	}
	present := map[string]bool{}
	for _, a := range list {
		present[a.Name] = true
		s.EnsureForApp(ctx, a.Name)
	}
	s.mu.Lock()
	var gone []string
	for a := range s.subs {
		if !present[a] {
			gone = append(gone, a)
		}
	}
	s.mu.Unlock()
	for _, a := range gone {
		s.drop(a)
	}
}

// EnsureForApp keeps a current subscriber iff mqtt is enabled with a broker
// URL AND the subscribe list is non-empty; returns the topics (nil = inactive).
func (s *Service) EnsureForApp(ctx context.Context, app string) []string {
	appCfg, err := s.apps.GetConfig(ctx, app)
	if err != nil {
		s.drop(app)
		return nil
	}
	cfg := appCfg.Mqtt
	if !cfg.Enabled || y.Trim(cfg.URL) == "" {
		s.drop(app)
		return nil
	}
	topics := s.ReadSubscriptions(app)
	if len(topics) == 0 {
		s.drop(app)
		return nil
	}
	s.ensureClient(app, cfg, topics)
	return topics
}

type subscribedMeta struct {
	App    string   `json:"app"`
	Topics []string `json:"topics"`
}

func qosOf(q int) byte {
	if q == 1 || q == 2 {
		return byte(q)
	}
	return 0
}

func (s *Service) ensureClient(app string, cfg contracts.MqttConfig, topics []string) {
	sorted := append([]string(nil), topics...)
	sort.Strings(sorted)
	fingerprint := strings.Join([]string{cfg.URL, cfg.Username, cfg.Password, fmt.Sprint(cfg.TLS), strings.Join(sorted, ",")}, " ")
	s.mu.Lock()
	existing := s.subs[app]
	s.mu.Unlock()
	if existing != nil && existing.fingerprint == fingerprint {
		return
	}
	if existing != nil {
		s.drop(app)
	}
	client, err := s.factory(fleet.ConnectOptions{
		URL: cfg.URL, Username: cfg.Username, Password: cfg.Password, TLS: cfg.TLS,
		ClientID:        "streamhub-iot-" + app + "-" + uuid.NewString()[:8],
		ReconnectPeriod: reconnectBase, ConnectTimeout: connectTimeout,
	})
	if err != nil {
		// A rejected/unsafe broker URL (SSRF guard) lands here.
		s.warn(app, "iot mqtt client creation failed", err)
		return
	}
	sub := &subscriber{client: client, fingerprint: fingerprint}
	s.mu.Lock()
	s.subs[app] = sub
	s.mu.Unlock()

	qos := qosOf(cfg.Qos)
	subscribe := func() {
		client.Subscribe(topics, qos, func(err error) {
			if err != nil {
				s.warn(app, "iot subscribe failed", err)
			}
		})
	}
	client.Start(fleet.Events{
		OnConnect: func() {
			sub.mu.Lock()
			sub.attempts, sub.errorLogged = 0, false
			sub.mu.Unlock()
			client.SetReconnectPeriod(reconnectBase)
			subscribe()
			s.log("info", "subscribed to inbound MQTT topics", subscribedMeta{app, topics})
		},
		OnMessage: func(topic string, payload []byte) { s.OnMessage(app, topic, string(payload)) },
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
				s.warn(app, "iot broker connection error", err)
			}
		},
	})
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

// DataEvent is the iot.data payload ({topic, deviceId: undefined, data,
// source: 'mqtt'} — deviceId is undefined, so absent on the wire).
type DataEvent struct {
	Topic  string `json:"topic"`
	Data   any    `json:"data"`
	Source string `json:"source"`
}

// OnMessage routes one inbound message as iot.data: data is the parsed JSON
// (JS key order) or the raw (bounded) string. Fire-and-forget; never fails.
func (s *Service) OnMessage(app, topic, payload string) {
	if topic == "" {
		return
	}
	raw := payload
	if jsx.UTF16Len(raw) > MaxMessageBytes {
		raw = jsx.UTF16Slice(raw, MaxMessageBytes)
	}
	var data any = raw
	if v, err := y.ParseJSON([]byte(raw)); err == nil {
		data = v
	}
	if s.callbacks == nil {
		return
	}
	cb := s.callbacks()
	if cb == nil {
		return
	}
	go func() { _ = cb.Dispatch(context.Background(), app, "iot.data", DataEvent{topic, data, "mqtt"}) }()
}

var whitespace = regexp.MustCompile(`[\s\x{0b}\x{feff}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}]`)

// topicOf extracts a bounded, non-empty, whitespace-free topic filter from a
// subscribe entry (a bare string or {topic}).
func topicOf(entry any) string {
	var raw any = entry
	if m, ok := entry.(*y.Map); ok && m != nil {
		raw = m.Get("topic")
	}
	str, ok := raw.(string)
	if !ok {
		return ""
	}
	t := y.Trim(str)
	if t == "" || jsx.UTF16Len(t) > 256 || whitespace.MatchString(t) {
		return ""
	}
	return t
}

// ReadSubscriptions reads mqtt.subscribe from the RAW config.yaml (deduped,
// capped at MaxSubscriptions; [] on any problem).
func (s *Service) ReadSubscriptions(app string) []string {
	b, err := os.ReadFile(filepath.Join(s.dataDir, "apps", app, "config.yaml"))
	if err != nil {
		return nil
	}
	doc, err := y.Load(string(b))
	if err != nil {
		return nil
	}
	root, ok := doc.(*y.Map)
	if !ok || root == nil {
		return nil
	}
	mq, ok := root.Get("mqtt").(*y.Map)
	if !ok || mq == nil {
		return nil
	}
	list, ok := mq.Get("subscribe").([]any)
	if !ok {
		return nil
	}
	var topics []string
	for _, e := range list {
		t := topicOf(e)
		dup := false
		for _, x := range topics {
			dup = dup || x == t
		}
		if t != "" && !dup {
			topics = append(topics, t)
		}
		if len(topics) >= MaxSubscriptions {
			break
		}
	}
	return topics
}
