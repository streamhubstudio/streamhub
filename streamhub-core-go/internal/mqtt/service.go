// Package mqtt is modules/mqtt: per-app MQTT event publishing (fed by the
// callbacks funnel and the logs service) plus the stream latency monitor.
// Outbound only — the per-app config endpoints live in the apps module.
package mqtt

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logsink"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

var levelRank = map[string]int{"trace": 0, "debug": 1, "info": 2, "warn": 3, "error": 4, "fatal": 5}

const (
	// Reconnect backoff: 1s → 2s → 4s … capped at 30s; reset on connect.
	reconnectBase  = time.Second
	reconnectMax   = 30 * time.Second
	connectTimeout = 10 * time.Second
	// configTTL: how long a resolved per-app mqtt config stays cached (log
	// lines burst).
	configTTL = 10 * time.Second
)

// ConfigSource is the apps surface the service reads.
type ConfigSource interface {
	GetConfig(ctx context.Context, name string) (*contracts.AppConfig, error)
}

type clientEntry struct {
	client      Client
	fingerprint string
	attempts    int
	errorLogged bool
}

type cachedConfig struct {
	cfg *contracts.MqttConfig
	exp time.Time
}

// Service is the per-app client manager + publisher. Every method is
// best-effort and never fails the caller (same contract as callbacks).
type Service struct {
	apps    ConfigSource
	logs    logsink.Writer
	factory Factory

	// Resolve is the DNS seam of the egress SSRF guard (tests inject a fake).
	Resolve security.HostResolver
	// Now is injectable for tests.
	Now func() time.Time
	// Shadow (STREAMHUB_SHADOW=1): never connect nor publish.
	Shadow bool

	mu      sync.Mutex
	clients map[string]*clientEntry
	cache   map[string]cachedConfig
}

// New builds the service; a nil factory means DefaultFactory (paho).
func New(apps ConfigSource, logs logsink.Writer, factory Factory, log *slog.Logger) *Service {
	if factory == nil {
		factory = DefaultFactory
	}
	return &Service{
		apps: apps, logs: logsink.Or(logs, log), factory: factory,
		Resolve: security.DefaultHostResolver, Now: time.Now,
		clients: map[string]*clientEntry{}, cache: map[string]cachedConfig{},
	}
}

// Close ends every client (onModuleDestroy).
func (s *Service) Close() {
	s.mu.Lock()
	names := make([]string, 0, len(s.clients))
	for n := range s.clients {
		names = append(names, n)
	}
	s.mu.Unlock()
	for _, n := range names {
		s.dropClient(n)
	}
}

// envelope is {event, app, timestamp, data} — field order as Node.
type envelope struct {
	Event     string `json:"event"`
	App       string `json:"app"`
	Timestamp string `json:"timestamp"`
	Data      any    `json:"data"`
}

// PublishEvent mirrors a dispatched callback event to the app's broker.
func (s *Service) PublishEvent(ctx context.Context, app, event string, payload any) {
	if s.suppressed(app, "event "+event) {
		return
	}
	defer s.recoverWarn(app, fmt.Sprintf("publishEvent(%q) failed", event))
	cfg := s.mqttConfig(ctx, app)
	if cfg == nil || !eventAllowed(cfg.Events, event) {
		return
	}
	s.publish(app, cfg, EventTopic(s.prefix(app, cfg), event), envelope{
		Event: event, App: app, Timestamp: jsx.ISO(s.Now()), Data: Object(payload),
	})
}

// PublishOptions are publishRaw's {qos, retain}.
type PublishOptions struct {
	Qos    int
	Retain bool
}

// PublishRaw publishes a raw payload on an arbitrary topic under the app's
// prefix (Streamflow action.mqtt): a topic outside the prefix is namespaced
// under it. Objects are JSON-encoded, a string is sent as-is. No-op when MQTT
// is off for the app or the broker fails the SSRF guard.
func (s *Service) PublishRaw(ctx context.Context, app, topic string, payload any, opts *PublishOptions) {
	if s.suppressed(app, "raw "+topic) {
		return
	}
	defer s.recoverWarn(app, "publishRaw failed")
	t := yamljs.Trim(topic)
	if t == "" {
		return
	}
	cfg := s.mqttConfig(ctx, app)
	if cfg == nil {
		return
	}
	prefix := s.prefix(app, cfg)
	full := t
	if t != prefix && !strings.HasPrefix(t, prefix+"/") {
		full = prefix + "/" + t
	}
	entry := s.ensureClient(app, cfg)
	if entry == nil {
		return
	}
	var body string
	if str, ok := payload.(string); ok {
		body = str
	} else {
		if payload == nil {
			payload = yamljs.NewMap()
		}
		var err error
		if body, err = stringify(payload); err != nil {
			s.warn(app, "publishRaw failed", err)
			return
		}
	}
	qos, retain := 0, false
	if opts != nil {
		qos, retain = opts.Qos, opts.Retain
	}
	entry.client.Publish(full, []byte(body), qosOf(qos), retain, func(err error) {
		if err != nil {
			s.warn(app, fmt.Sprintf("publishRaw to %q failed", full), err)
		}
	})
}

// PublishLog forwards an app-attributed log line to <prefix>/log/<level>
// when mqtt.logs is on and the level is at/above the configured one.
func (s *Service) PublishLog(ctx context.Context, app, level, source, message string, meta any) error {
	defer s.recoverWarn(app, "publishLog failed")
	if source == "mqtt" { // loop guard: never forward our own lines
		return nil
	}
	if s.suppressed(app, "log") {
		return nil
	}
	cfg := s.mqttConfig(ctx, app)
	if cfg == nil || !cfg.Logs.Enabled {
		return nil
	}
	min, ok := levelRank[cfg.Logs.Level]
	if !ok {
		min = levelRank["info"]
	}
	rank, ok := levelRank[level]
	if !ok {
		rank = levelRank["info"]
	}
	if rank < min {
		return nil
	}
	data := yamljs.NewMap()
	data.Set("level", level)
	data.Set("source", source)
	data.Set("message", message)
	if meta != nil {
		data.Set("meta", Object(meta))
	}
	s.publish(app, cfg, LogTopic(s.prefix(app, cfg), level), envelope{
		Event: "log", App: app, Timestamp: jsx.ISO(s.Now()), Data: data,
	})
	return nil
}

// suppressed reports (and logs at debug) a publish skipped in shadow mode.
func (s *Service) suppressed(app, what string) bool {
	if !s.Shadow {
		return false
	}
	s.logs.Write("debug", "mqtt", "shadow: suppressed", map[string]any{"app": app, "what": what})
	return true
}

// DisconnectApp drops the app's client and cached config (hot-reload/delete).
func (s *Service) DisconnectApp(app string) {
	s.mu.Lock()
	delete(s.cache, app)
	s.mu.Unlock()
	s.dropClient(app)
}

// mqttConfig is the resolved mqtt: block, or nil when publishing is off
// (disabled / no URL / app gone / broker rejected by the SSRF guard). Cached
// for configTTL; a nil result drops any live client.
func (s *Service) mqttConfig(ctx context.Context, app string) *contracts.MqttConfig {
	now := s.Now()
	s.mu.Lock()
	hit, ok := s.cache[app]
	s.mu.Unlock()
	if ok && hit.exp.After(now) {
		return hit.cfg
	}
	var cfg *contracts.MqttConfig
	if appCfg, err := s.apps.GetConfig(ctx, app); err == nil && appCfg != nil {
		m := appCfg.Mqtt
		if m.Enabled && yamljs.Trim(m.URL) != "" {
			cfg = &m
		}
	}
	// SSRF guard (P0-1): the broker URL is tenant-controlled.
	if cfg != nil {
		err := security.AssertSafeEgressURL(ctx, cfg.URL, security.EgressOptions{
			AllowedSchemes: security.MQTTSchemes,
			Label:          "MQTT broker URL",
			AllowPrivate:   security.EnvFlag(os.Getenv(security.AllowPrivateMQTTBrokerEnv)),
			Resolve:        s.Resolve,
		})
		if err != nil {
			s.warn(app, "broker URL rejected by the egress SSRF guard", err)
			cfg = nil
		}
	}
	s.mu.Lock()
	s.cache[app] = cachedConfig{cfg: cfg, exp: now.Add(configTTL)}
	s.mu.Unlock()
	if cfg == nil {
		s.dropClient(app)
	}
	return cfg
}

func (s *Service) prefix(app string, cfg *contracts.MqttConfig) string {
	if p := NormalizePrefix(yamljs.Trim(cfg.TopicPrefix)); p != "" {
		return p
	}
	return "streamhub/" + app
}

func eventAllowed(events []string, event string) bool {
	if len(events) == 0 {
		return true
	}
	for _, e := range events {
		if e == "all" || e == event {
			return true
		}
	}
	return false
}

func qosOf(v int) byte {
	if v == 1 || v == 2 {
		return byte(v)
	}
	return 0
}

// publish is the fire-and-forget publish over the app's (lazy) client.
func (s *Service) publish(app string, cfg *contracts.MqttConfig, topic string, env envelope) {
	entry := s.ensureClient(app, cfg)
	if entry == nil {
		return
	}
	body, err := stringify(env)
	if err != nil {
		s.warn(app, fmt.Sprintf("failed to serialize %q", env.Event), err)
		return
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				s.warn(app, fmt.Sprintf("publish to %q threw", topic), fmt.Errorf("%v", r))
			}
		}()
		entry.client.Publish(topic, []byte(body), qosOf(cfg.Qos), false, func(err error) {
			if err != nil {
				s.warn(app, fmt.Sprintf("publish to %q failed", topic), err)
			}
		})
	}()
}

// ensureClient returns the app's client when its connection config is
// unchanged; otherwise it ends the stale one and builds a fresh client.
func (s *Service) ensureClient(app string, cfg *contracts.MqttConfig) *clientEntry {
	fingerprint := strings.Join([]string{cfg.URL, cfg.Username, cfg.Password, fmt.Sprint(cfg.TLS)}, " ")
	s.mu.Lock()
	existing := s.clients[app]
	s.mu.Unlock()
	if existing != nil && existing.fingerprint == fingerprint {
		return existing
	}
	if existing != nil {
		s.dropClient(app)
	}

	entry := &clientEntry{fingerprint: fingerprint}
	ev := Events{
		OnConnect: func() {
			s.mu.Lock()
			entry.attempts = 0
			entry.errorLogged = false
			c := entry.client
			s.mu.Unlock()
			if c != nil {
				c.SetReconnectPeriod(reconnectBase)
			}
			s.logs.Write("info", "mqtt", "connected to broker", map[string]any{"app": app, "url": cfg.URL})
		},
		OnClose: func() {
			s.mu.Lock()
			entry.attempts++
			period := backoff(entry.attempts)
			c := entry.client
			s.mu.Unlock()
			if c != nil {
				c.SetReconnectPeriod(period)
			}
		},
		OnError: func(err error) {
			s.mu.Lock()
			if entry.errorLogged { // once per disconnected episode
				s.mu.Unlock()
				return
			}
			entry.errorLogged = true
			s.mu.Unlock()
			s.warn(app, "broker connection error", err)
		},
	}
	client, err := s.safeFactory(ConnectOptions{
		URL: cfg.URL, Username: cfg.Username, Password: cfg.Password, TLS: cfg.TLS,
		ClientID:        "streamhub-" + app + "-" + randHex(3),
		ReconnectPeriod: reconnectBase, ConnectTimeout: connectTimeout,
	}, ev)
	if err != nil {
		s.warn(app, "mqtt client creation failed", err)
		return nil
	}
	s.mu.Lock()
	entry.client = client
	s.clients[app] = entry
	s.mu.Unlock()
	return entry
}

func (s *Service) safeFactory(o ConnectOptions, ev Events) (c Client, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return s.factory(o, ev)
}

// backoff is min(30s, 1s · 2^max(0, attempts-1)).
func backoff(attempts int) time.Duration {
	exp := math.Pow(2, math.Max(0, float64(attempts-1)))
	d := time.Duration(math.Min(float64(reconnectMax), float64(reconnectBase)*exp))
	return d
}

// dropClient cleanly ends and forgets an app's client.
func (s *Service) dropClient(app string) {
	s.mu.Lock()
	entry := s.clients[app]
	delete(s.clients, app)
	s.mu.Unlock()
	if entry == nil || entry.client == nil {
		return
	}
	func() {
		defer func() { _ = recover() }()
		entry.client.End()
	}()
}

func (s *Service) warn(app, message string, err error) {
	defer func() { _ = recover() }()
	s.logs.Write("warn", "mqtt", message, map[string]any{"app": app, "error": err.Error()})
}

func (s *Service) recoverWarn(app, message string) {
	if r := recover(); r != nil {
		s.warn(app, message, fmt.Errorf("%v", r))
	}
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Object normalizes a payload to an ordered JS object: *yamljs.Map as-is,
// anything else through JSON (struct field order kept). nil → {}.
func Object(payload any) any {
	switch p := payload.(type) {
	case nil:
		return yamljs.NewMap()
	case *yamljs.Map:
		if p == nil {
			return yamljs.NewMap()
		}
		return p
	}
	raw, err := jsx.Stringify(payload)
	if err != nil {
		return yamljs.NewMap()
	}
	v, err := yamljs.ParseJSON([]byte(raw))
	if err != nil {
		return yamljs.NewMap()
	}
	return v
}

// stringify is JSON.stringify over structs / value-model values.
func stringify(v any) (string, error) {
	switch v.(type) {
	case *yamljs.Map, []any:
		return yamljs.Stringify(v)
	}
	raw, err := jsx.Stringify(v)
	if err != nil {
		return "", err
	}
	// Re-render through the value model so nested *yamljs.Map values and
	// numbers print exactly as JSON.stringify.
	parsed, err := yamljs.ParseJSON([]byte(raw))
	if err != nil {
		return "", err
	}
	return yamljs.Stringify(parsed)
}
