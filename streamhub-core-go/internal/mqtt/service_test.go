package mqtt

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// ---------------------------------------------------------------------------
// fakes (mqtt.service.spec.ts FakeMqttClient)
// ---------------------------------------------------------------------------

type published struct {
	topic   string
	payload string
	qos     byte
	retain  bool
}

type fakeClient struct {
	opts      ConnectOptions
	ev        Events
	mu        sync.Mutex
	period    time.Duration
	published []published
	ended     bool
	publishFn func()
}

func (c *fakeClient) Publish(topic string, payload []byte, qos byte, retain bool, done func(error)) {
	if c.publishFn != nil {
		c.publishFn()
	}
	c.mu.Lock()
	c.published = append(c.published, published{topic, string(payload), qos, retain})
	c.mu.Unlock()
	if done != nil {
		done(nil)
	}
}
func (c *fakeClient) SetReconnectPeriod(d time.Duration) { c.mu.Lock(); c.period = d; c.mu.Unlock() }
func (c *fakeClient) End()                               { c.mu.Lock(); c.ended = true; c.mu.Unlock() }

type fakeApps struct {
	mu  sync.Mutex
	cfg *contracts.MqttConfig
	err error
}

func (f *fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	c := &contracts.AppConfig{}
	if f.cfg != nil {
		c.Mqtt = *f.cfg
	}
	return c, nil
}

func (f *fakeApps) set(c *contracts.MqttConfig) { f.mu.Lock(); f.cfg = c; f.mu.Unlock() }

type logLine struct {
	level, source, message string
	meta                   map[string]any
}

type fakeLogs struct {
	mu    sync.Mutex
	lines []logLine
}

func (f *fakeLogs) Write(level, source, message string, meta map[string]any) {
	f.mu.Lock()
	f.lines = append(f.lines, logLine{level, source, message, meta})
	f.mu.Unlock()
}

func (f *fakeLogs) count(contains string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, l := range f.lines {
		if strings.Contains(l.message, contains) {
			n++
		}
	}
	return n
}

func mqttConfig(mut ...func(*contracts.MqttConfig)) *contracts.MqttConfig {
	c := &contracts.MqttConfig{
		Enabled: true, URL: "mqtt://broker.test:1883", Username: "user1", Password: "pw-secret",
		TopicPrefix: "streamhub/live", Qos: 0, Events: []string{"all"},
		Logs: contracts.MqttLogsConfig{Enabled: false, Level: "info"},
	}
	for _, m := range mut {
		m(c)
	}
	return c
}

type harness struct {
	svc        *Service
	apps       *fakeApps
	logs       *fakeLogs
	created    []*fakeClient
	factoryErr error
	now        time.Time
}

func newHarness(cfg *contracts.MqttConfig) *harness {
	h := &harness{apps: &fakeApps{cfg: cfg}, logs: &fakeLogs{}, now: time.Unix(1_800_000_000, 0)}
	h.svc = New(h.apps, h.logs, func(o ConnectOptions, ev Events) (Client, error) {
		if h.factoryErr != nil {
			return nil, h.factoryErr
		}
		c := &fakeClient{opts: o, ev: ev, period: o.ReconnectPeriod}
		h.created = append(h.created, c)
		return c, nil
	}, nil)
	h.svc.Resolve = func(context.Context, string) ([]string, error) { return []string{"93.184.216.34"}, nil }
	h.svc.Now = func() time.Time { return h.now }
	return h
}

func (h *harness) last(t *testing.T) *fakeClient {
	t.Helper()
	if len(h.created) == 0 {
		t.Fatal("no client created")
	}
	return h.created[len(h.created)-1]
}

func obj(kv ...any) *yamljs.Map {
	m := yamljs.NewMap()
	for i := 0; i < len(kv); i += 2 {
		m.Set(kv[i].(string), kv[i+1])
	}
	return m
}

var bg = context.Background()

// ---------------------------------------------------------------------------
// mqtt.service.spec.ts
// ---------------------------------------------------------------------------

func TestPublishesEnvelope(t *testing.T) {
	h := newHarness(mqttConfig())
	h.svc.PublishEvent(bg, "live", "stream_started", obj("room", "live-1", "streamId", "live-1/pub"))
	c := h.last(t)
	if len(c.published) != 1 {
		t.Fatalf("published %d", len(c.published))
	}
	p := c.published[0]
	if p.topic != "streamhub/live/connection/stream_started" || p.qos != 0 || p.retain {
		t.Fatalf("publish %+v", p)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(p.payload), &body); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(body))
	for k := range body {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "app,data,event,timestamp" {
		t.Fatalf("envelope keys %v", keys)
	}
	if body["timestamp"] != "2027-01-15T08:00:00.000Z" || body["event"] != "stream_started" || body["app"] != "live" {
		t.Fatalf("envelope %v", body)
	}
	if !strings.HasPrefix(p.payload, `{"event":"stream_started","app":"live","timestamp":`) ||
		!strings.HasSuffix(p.payload, `"data":{"room":"live-1","streamId":"live-1/pub"}}`) {
		t.Fatalf("key order: %s", p.payload)
	}
}

func TestTopicCategories(t *testing.T) {
	h := newHarness(mqttConfig())
	for _, ev := range []string{"vod_ready", "plugin_worker_error", "stream.latency_high", "chat_message", "ingress_started"} {
		h.svc.PublishEvent(bg, "live", ev, obj("room", "live-1"))
	}
	var topics []string
	for _, p := range h.last(t).published {
		topics = append(topics, p.topic)
	}
	want := []string{
		"streamhub/live/vod/vod_ready", "streamhub/live/plugin/plugin_worker_error",
		"streamhub/live/alert/stream.latency_high", "streamhub/live/interaction/chat_message",
		"streamhub/live/connection/ingress_started",
	}
	if strings.Join(topics, " ") != strings.Join(want, " ") {
		t.Fatalf("topics %v", topics)
	}
}

func TestEventCategoryTable(t *testing.T) {
	for ev, want := range map[string]string{
		"stream.latency_recovered": "alert", "health.degraded": "alert", "iot.data": "iot", "iot.custom": "iot",
		"plugin_worker_started": "plugin", "recording_failed": "vod", "vod_ready": "vod", "egress_ended": "vod",
		"snapshot_taken": "vod", "chat_message": "interaction", "reaction": "interaction",
		"room_started": "connection", "hls_ready": "connection", "network.threshold_exceeded": "connection",
	} {
		if got := EventCategory(ev); got != want {
			t.Errorf("%s → %s, want %s", ev, got, want)
		}
	}
	if EventTopic("a/b//", "vod_ready") != "a/b/vod/vod_ready" || LogTopic("p/", "warn") != "p/log/warn" {
		t.Fatal("prefix normalization")
	}
}

func TestCredentialsAndQos(t *testing.T) {
	h := newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.Qos = 1 }))
	h.svc.PublishEvent(bg, "live", "stream_started", obj("room", "r"))
	c := h.last(t)
	if len(h.created) != 1 || c.opts.URL != "mqtt://broker.test:1883" || c.opts.Username != "user1" || c.opts.Password != "pw-secret" {
		t.Fatalf("opts %+v", c.opts)
	}
	if c.published[0].qos != 1 || c.published[0].retain {
		t.Fatalf("qos %+v", c.published[0])
	}
	if !strings.HasPrefix(c.opts.ClientID, "streamhub-live-") || len(c.opts.ClientID) != len("streamhub-live-")+6 {
		t.Fatalf("clientId %s", c.opts.ClientID)
	}
	if c.opts.ReconnectPeriod != time.Second || c.opts.ConnectTimeout != 10*time.Second {
		t.Fatalf("timings %+v", c.opts)
	}
}

func TestPrefixFallback(t *testing.T) {
	h := newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.TopicPrefix = "" }))
	h.svc.PublishEvent(bg, "cam", "stream_started", obj("room", "r"))
	if got := h.last(t).published[0].topic; got != "streamhub/cam/connection/stream_started" {
		t.Fatalf("topic %s", got)
	}
}

func TestNoClientWhenOff(t *testing.T) {
	for name, h := range map[string]*harness{
		"disabled":  newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.Enabled = false })),
		"empty url": newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.URL = "  " })),
		"app gone":  func() *harness { h := newHarness(nil); h.apps.err = errors.New("no such app"); return h }(),
	} {
		h.svc.PublishEvent(bg, "live", "stream_started", obj("room", "r"))
		if len(h.created) != 0 {
			t.Fatalf("%s: client created", name)
		}
	}
}

func TestDropsClientWhenTurnedOff(t *testing.T) {
	h := newHarness(mqttConfig())
	h.svc.PublishEvent(bg, "live", "stream_started", obj("room", "r"))
	c := h.last(t)
	h.apps.set(mqttConfig(func(c *contracts.MqttConfig) { c.Enabled = false }))
	h.svc.PublishEvent(bg, "live", "stream_ended", obj()) // still cached
	if len(c.published) != 2 {
		t.Fatalf("cache TTL not honoured: %d", len(c.published))
	}
	h.now = h.now.Add(11 * time.Second)
	h.svc.PublishEvent(bg, "live", "stream_ended", obj())
	if !c.ended || len(c.published) != 2 {
		t.Fatalf("ended=%v published=%d", c.ended, len(c.published))
	}
}

func TestEventFilter(t *testing.T) {
	h := newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.Events = []string{"vod_ready", "stream.latency_high"} }))
	for _, ev := range []string{"stream_started", "vod_ready", "stream.latency_high"} {
		h.svc.PublishEvent(bg, "live", ev, obj("room", "r"))
	}
	c := h.last(t)
	if len(c.published) != 2 || c.published[0].topic != "streamhub/live/vod/vod_ready" || c.published[1].topic != "streamhub/live/alert/stream.latency_high" {
		t.Fatalf("published %+v", c.published)
	}
	h2 := newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.Events = nil }))
	h2.svc.PublishEvent(bg, "live", "anything", obj())
	if len(h2.last(t).published) != 1 {
		t.Fatal("empty events list must publish everything")
	}
}

func TestReconfigureRebuildsClient(t *testing.T) {
	h := newHarness(mqttConfig())
	h.svc.PublishEvent(bg, "live", "stream_started", obj("room", "r"))
	first := h.last(t)
	h.apps.set(mqttConfig(func(c *contracts.MqttConfig) { c.URL = "mqtts://other.test:8883"; c.TLS = true }))
	h.now = h.now.Add(11 * time.Second)
	h.svc.PublishEvent(bg, "live", "stream_ended", obj("room", "r"))
	if len(h.created) != 2 || !first.ended || h.created[1].opts.URL != "mqtts://other.test:8883" || len(h.created[1].published) != 1 {
		t.Fatalf("created=%d ended=%v", len(h.created), first.ended)
	}
}

func TestDisconnectApp(t *testing.T) {
	h := newHarness(mqttConfig())
	h.svc.PublishEvent(bg, "live", "stream_started", obj())
	first := h.last(t)
	h.svc.DisconnectApp("live")
	if !first.ended {
		t.Fatal("not ended")
	}
	h.svc.PublishEvent(bg, "live", "stream_ended", obj())
	if len(h.created) != 2 {
		t.Fatalf("created %d", len(h.created))
	}
}

func TestReconnectBackoff(t *testing.T) {
	h := newHarness(mqttConfig())
	h.svc.PublishEvent(bg, "live", "stream_started", obj())
	c := h.last(t)
	steps := []struct {
		emit string
		want time.Duration
	}{
		{"", time.Second}, {"close", time.Second}, {"close", 2 * time.Second}, {"close", 4 * time.Second},
	}
	for _, s := range steps {
		if s.emit == "close" {
			c.ev.OnClose()
		}
		if c.period != s.want {
			t.Fatalf("after %q period %v, want %v", s.emit, c.period, s.want)
		}
	}
	for i := 0; i < 10; i++ {
		c.ev.OnClose()
	}
	if c.period != 30*time.Second {
		t.Fatalf("cap: %v", c.period)
	}
	c.ev.OnConnect()
	if c.period != time.Second {
		t.Fatalf("reset: %v", c.period)
	}
}

func TestBrokerErrorLoggedOncePerEpisode(t *testing.T) {
	h := newHarness(mqttConfig())
	h.svc.PublishEvent(bg, "live", "stream_started", obj())
	c := h.last(t)
	c.ev.OnError(errors.New("ECONNREFUSED"))
	c.ev.OnError(errors.New("ECONNREFUSED"))
	if n := h.logs.count("broker connection error"); n != 1 {
		t.Fatalf("logged %d", n)
	}
	c.ev.OnConnect()
	c.ev.OnError(errors.New("boom"))
	if n := h.logs.count("broker connection error"); n != 2 {
		t.Fatalf("logged %d", n)
	}
}

func TestLogForwarding(t *testing.T) {
	h := newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.Logs = contracts.MqttLogsConfig{Enabled: true, Level: "warn"} }))
	h.svc.PublishLog(bg, "live", "info", "recording", "below level", nil)
	h.svc.PublishLog(bg, "live", "error", "recording", "upload failed", obj("app", "live"))
	c := h.last(t)
	if len(c.published) != 1 || c.published[0].topic != "streamhub/live/log/error" {
		t.Fatalf("published %+v", c.published)
	}
	if !strings.HasSuffix(c.published[0].payload, `"data":{"level":"error","source":"recording","message":"upload failed","meta":{"app":"live"}}}`) ||
		!strings.HasPrefix(c.published[0].payload, `{"event":"log","app":"live",`) {
		t.Fatalf("payload %s", c.published[0].payload)
	}

	off := newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.Logs = contracts.MqttLogsConfig{Enabled: false, Level: "info"} }))
	off.svc.PublishLog(bg, "live", "error", "recording", "x", nil)
	loop := newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.Logs = contracts.MqttLogsConfig{Enabled: true, Level: "trace"} }))
	loop.svc.PublishLog(bg, "live", "warn", "mqtt", "publish failed", nil)
	if len(off.created)+len(loop.created) != 0 {
		t.Fatal("logs forwarded when disabled / loop guard broken")
	}
}

func TestNeverPanics(t *testing.T) {
	h := newHarness(mqttConfig())
	h.factoryErr = errors.New("cannot connect")
	h.svc.PublishEvent(bg, "live", "stream_started", obj("room", "r"))
	if h.logs.count("client creation failed") != 1 {
		t.Fatalf("logs %+v", h.logs.lines)
	}
	h2 := newHarness(mqttConfig())
	h2.svc.PublishEvent(bg, "live", "stream_started", obj())
	h2.last(t).publishFn = func() { panic("not connected") }
	h2.svc.PublishEvent(bg, "live", "stream_ended", obj()) // must not panic
}

func TestPublishRaw(t *testing.T) {
	h := newHarness(mqttConfig())
	h.svc.PublishRaw(bg, "live", "gate/plate", obj("plate", "ABC"), &PublishOptions{Qos: 1, Retain: true})
	p := h.last(t).published[0]
	if p.topic != "streamhub/live/gate/plate" || p.payload != `{"plate":"ABC"}` || p.qos != 1 || !p.retain {
		t.Fatalf("raw %+v", p)
	}
	h.svc.PublishRaw(bg, "live", "streamhub/live/raw", "hello", nil)
	p = h.last(t).published[1]
	if p.topic != "streamhub/live/raw" || p.payload != "hello" {
		t.Fatalf("raw %+v", p)
	}
	off := newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.Enabled = false }))
	off.svc.PublishRaw(bg, "live", "x/y", obj("a", 1.0), nil)
	if len(off.created) != 0 {
		t.Fatal("client created while disabled")
	}
}

// ---------------------------------------------------------------------------
// mqtt.ssrf.spec.ts
// ---------------------------------------------------------------------------

func TestBrokerSSRFGuard(t *testing.T) {
	resolve := func(_ context.Context, host string) ([]string, error) {
		switch host {
		case "broker.evil.tld":
			return []string{"10.1.2.3"}, nil
		case "broker.example.com":
			return []string{"93.184.216.34"}, nil
		case "mqtt.onprem.lan":
			return []string{"192.168.1.50"}, nil
		}
		return nil, errors.New("ENOTFOUND")
	}
	cases := []struct {
		url, allowPrivate string
		connects          bool
	}{
		{"mqtt://169.254.169.254:1883", "", false},
		{"mqtt://broker.evil.tld:1883", "", false},
		{"mqtt://broker.example.com:1883", "", true},
		{"mqtt://mqtt.onprem.lan:1883", "1", true},
		{"mqtt://10.0.0.5:1883", "", false},
	}
	for _, c := range cases {
		t.Run(c.url, func(t *testing.T) {
			t.Setenv(security.AllowPrivateMQTTBrokerEnv, c.allowPrivate)
			h := newHarness(mqttConfig(func(m *contracts.MqttConfig) { m.URL = c.url }))
			h.svc.Resolve = resolve
			h.svc.PublishEvent(bg, "live", "stream_started", obj())
			if got := len(h.created) == 1; got != c.connects {
				t.Fatalf("connects=%v, want %v", got, c.connects)
			}
			if !c.connects && h.logs.count("SSRF") != 1 {
				t.Fatalf("logs %+v", h.logs.lines)
			}
		})
	}
}

func TestAssertSafeBrokerURL(t *testing.T) {
	t.Setenv(security.AllowPrivateMQTTBrokerEnv, "")
	for _, u := range []string{"mqtt://169.254.169.254:1883", "mqtt://127.0.0.1:1883", "ws://[::1]:9001", "http://broker.example.com"} {
		if AssertSafeBrokerURL(u) == nil {
			t.Errorf("%s accepted", u)
		}
	}
	for _, u := range []string{"mqtt://broker.example.com:1883", "mqtts://8.8.8.8:8883", "wss://broker.example.com/mqtt", "tcp://broker.example.com"} {
		if err := AssertSafeBrokerURL(u); err != nil {
			t.Errorf("%s rejected: %v", u, err)
		}
	}
	t.Setenv(security.AllowPrivateMQTTBrokerEnv, "1")
	if AssertSafeBrokerURL("mqtt://10.0.0.5:1883") != nil {
		t.Error("escape hatch must admit a private literal")
	}
	if AssertSafeBrokerURL("http://10.0.0.5") == nil {
		t.Error("escape hatch must not open the scheme allowlist")
	}
}

func TestResolveBrokerURL(t *testing.T) {
	for in, want := range map[string]string{
		" mqtt://b:1883 ": "mqtts://b:1883", "TCP://b": "mqtts://b", "ws://b/mqtt": "wss://b/mqtt", "mqtts://b": "mqtts://b",
	} {
		if got := ResolveBrokerURL(in, true); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
	if ResolveBrokerURL(" mqtt://b ", false) != "mqtt://b" {
		t.Error("tls=false must only trim")
	}
}

func TestShadowNeverConnects(t *testing.T) {
	h := newHarness(mqttConfig(func(c *contracts.MqttConfig) { c.Logs = contracts.MqttLogsConfig{Enabled: true, Level: "trace"} }))
	h.svc.Shadow = true
	h.svc.PublishEvent(bg, "live", "stream_started", obj("room", "r"))
	h.svc.PublishRaw(bg, "live", "a/b", obj(), nil)
	if err := h.svc.PublishLog(bg, "live", "error", "recording", "x", nil); err != nil {
		t.Fatal(err)
	}
	if len(h.created) != 0 {
		t.Fatal("client created in shadow mode")
	}
	if h.logs.count("shadow: suppressed") != 3 {
		t.Fatalf("logs %+v", h.logs.lines)
	}
}
