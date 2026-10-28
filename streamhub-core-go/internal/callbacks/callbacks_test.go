package callbacks

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type fakeApps struct {
	cfg *contracts.AppConfig
	err error
}

func (f *fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	return f.cfg, f.err
}

func withCallbacks(url, secret string) *fakeApps {
	return &fakeApps{cfg: &contracts.AppConfig{Callbacks: contracts.CallbacksConfig{URL: url, Secret: secret}}}
}

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
	defer f.mu.Unlock()
	f.lines = append(f.lines, logLine{level, source, message, meta})
}

func (f *fakeLogs) find(level, contains string) *logLine {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.lines {
		if f.lines[i].level == level && strings.Contains(f.lines[i].message, contains) {
			return &f.lines[i]
		}
	}
	return nil
}

type call struct {
	url     string
	headers http.Header
	body    string
}

// fakeTransport answers from a status script (0 = transport error).
type fakeTransport struct {
	mu     sync.Mutex
	script []int
	calls  []call
}

func (t *fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	b, _ := io.ReadAll(r.Body)
	t.calls = append(t.calls, call{url: r.URL.String(), headers: r.Header.Clone(), body: string(b)})
	status := 200
	if len(t.script) > 0 {
		status = t.script[0]
		if len(t.script) > 1 {
			t.script = t.script[1:]
		}
	}
	if status == 0 {
		return nil, errors.New("ECONNREFUSED")
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
}

type fakeMetrics struct {
	mu      sync.Mutex
	results []string
}

func (f *fakeMetrics) CallbackResult(app, event, result string) {
	f.mu.Lock()
	f.results = append(f.results, app+"|"+event+"|"+result)
	f.mu.Unlock()
}

type fakeMQTT struct {
	mu    sync.Mutex
	calls []string
	ch    chan struct{}
	boom  bool
}

func (f *fakeMQTT) PublishEvent(_ context.Context, app, event string, _ any) {
	f.mu.Lock()
	f.calls = append(f.calls, app+"|"+event)
	f.mu.Unlock()
	if f.ch != nil {
		f.ch <- struct{}{}
	}
	if f.boom {
		panic("mqtt exploded")
	}
}

type harness struct {
	svc     *Service
	logs    *fakeLogs
	tr      *fakeTransport
	metrics *fakeMetrics
	sleeps  []time.Duration
}

func newHarness(apps ConfigSource, script ...int) *harness {
	h := &harness{logs: &fakeLogs{}, tr: &fakeTransport{script: script}, metrics: &fakeMetrics{}}
	h.svc = New(Deps{Apps: apps, Logs: h.logs, Metrics: h.metrics})
	h.svc.Client = &http.Client{Transport: h.tr}
	h.svc.Resolve = func(context.Context, string) ([]string, error) { return []string{"93.184.216.34"}, nil }
	h.svc.Sleep = func(d time.Duration) { h.sleeps = append(h.sleeps, d) }
	return h
}

func payload(kv ...any) *yamljs.Map {
	m := yamljs.NewMap()
	for i := 0; i < len(kv); i += 2 {
		m.Set(kv[i].(string), kv[i+1])
	}
	return m
}

// ---------------------------------------------------------------------------
// Node vectors: byte-identical body + signature
// ---------------------------------------------------------------------------

type vector struct {
	Name        string `json:"name"`
	App         string `json:"app"`
	Event       string `json:"event"`
	Secret      string `json:"secret"`
	PayloadJSON string `json:"payloadJson"`
	Ts          string `json:"ts"`
	ID          string `json:"id"`
	Body        string `json:"body"`
	Signature   string `json:"signature"`
}

func TestSignatureVectorsMatchNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/signatures.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []vector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			ts, _ := time.Parse(time.RFC3339Nano, v.Ts)
			h := newHarness(withCallbacks("https://hook.test/cb", v.Secret))
			h.svc.Now = func() time.Time { return ts }
			h.svc.NewID = func() string { return v.ID }
			p, err := yamljs.ParseJSON([]byte(v.PayloadJSON))
			if err != nil {
				t.Fatal(err)
			}
			body, _, err := h.svc.BuildBody(v.App, v.Event, p)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != v.Body {
				t.Fatalf("body\n got %s\nwant %s", body, v.Body)
			}
			if got := "sha256=" + Sign(v.Secret, body); got != v.Signature {
				t.Fatalf("signature %s, want %s", got, v.Signature)
			}
			// End-to-end: the wire body and header are the same bytes.
			h.svc.Dispatch(context.Background(), v.App, v.Event, p)
			if len(h.tr.calls) != 1 || h.tr.calls[0].body != v.Body || h.tr.calls[0].headers.Get("X-StreamHub-Signature") != v.Signature {
				t.Fatalf("wire mismatch: %+v", h.tr.calls)
			}
		})
	}
}

func TestStructPayloadKeepsFieldOrder(t *testing.T) {
	h := newHarness(withCallbacks("https://hook.test/cb", "s"))
	h.svc.Now = func() time.Time { return time.Date(2026, 10, 27, 12, 34, 56, 789e6, time.UTC) }
	h.svc.NewID = func() string { return "11111111-2222-4333-8444-555555555555" }
	type started struct {
		Room         string `json:"room"`
		StreamID     string `json:"streamId"`
		Participants int    `json:"participants"`
	}
	body, _, _ := h.svc.BuildBody("live", "stream_started", started{"live_cam1", "cam1", 2})
	want := `{"id":"11111111-2222-4333-8444-555555555555","event":"stream_started","app":"live","room":"live_cam1","ts":"2026-10-27T12:34:56.789Z","timestamp":"2026-10-27T12:34:56.789Z","data":{"room":"live_cam1","streamId":"cam1","participants":2}}`
	if string(body) != want {
		t.Fatalf("got %s", body)
	}
}

// ---------------------------------------------------------------------------
// callbacks.service.spec.ts
// ---------------------------------------------------------------------------

func TestSignedDispatch(t *testing.T) {
	h := newHarness(withCallbacks("https://hook.test/cb", "s3cr3t"))
	h.svc.Dispatch(context.Background(), "live", "stream_started", payload("room", "live-1", "streamId", "abc"))
	if len(h.tr.calls) != 1 {
		t.Fatalf("POSTs = %d, want 1", len(h.tr.calls))
	}
	c := h.tr.calls[0]
	if c.url != "https://hook.test/cb" {
		t.Fatalf("url %s", c.url)
	}
	if want := "sha256=" + Sign("s3cr3t", []byte(c.body)); c.headers.Get("X-StreamHub-Signature") != want {
		t.Fatalf("signature does not cover the exact body")
	}
	var env map[string]any
	if err := json.Unmarshal([]byte(c.body), &env); err != nil {
		t.Fatal(err)
	}
	if env["event"] != "stream_started" || env["app"] != "live" || env["room"] != "live-1" || env["ts"] != env["timestamp"] {
		t.Fatalf("envelope %v", env)
	}
	if data := env["data"].(map[string]any); data["streamId"] != "abc" {
		t.Fatalf("data %v", data)
	}
	for k, want := range map[string]string{
		"Content-Type": "application/json", "User-Agent": "streamhub-core/callbacks",
		"X-StreamHub-Event": "stream_started", "X-StreamHub-Delivery": env["id"].(string), "X-StreamHub-Timestamp": env["timestamp"].(string),
	} {
		if got := c.headers.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if l := h.logs.find("info", `delivered "stream_started"`); l == nil || l.meta["status"] != 200 || l.meta["attempt"] != 1 {
		t.Fatalf("delivered log %+v", l)
	}
	if h.metrics.results[0] != "live|stream_started|delivered" {
		t.Fatalf("metrics %v", h.metrics.results)
	}
}

func TestRoomNullWhenAbsentOrNonString(t *testing.T) {
	for _, p := range []any{payload(), payload("room", 7.0), nil} {
		h := newHarness(withCallbacks("https://hook.test/cb", ""))
		h.svc.Dispatch(context.Background(), "live", "room_started", p)
		if !strings.Contains(h.tr.calls[0].body, `"room":null`) {
			t.Fatalf("body %s", h.tr.calls[0].body)
		}
		if p == nil && !strings.Contains(h.tr.calls[0].body, `"data":{}`) {
			t.Fatalf("nil payload must become {}: %s", h.tr.calls[0].body)
		}
	}
}

func TestForwardsAnyEventVerbatim(t *testing.T) {
	for _, ev := range []string{"stream_started", "vod_ready", "recording_failed", "participant_joined", "plugin_worker_error", "stream.latency_high", "network.threshold_exceeded", "iot.data", "custom.thing"} {
		h := newHarness(withCallbacks("https://hook.test/cb", "s"))
		h.svc.Dispatch(context.Background(), "live", ev, payload("room", "r"))
		if len(h.tr.calls) != 1 || h.tr.calls[0].headers.Get("X-StreamHub-Event") != ev || !strings.Contains(h.tr.calls[0].body, `"event":"`+ev+`"`) {
			t.Fatalf("%s not forwarded verbatim", ev)
		}
	}
}

func TestNoURLNoFire(t *testing.T) {
	for name, apps := range map[string]*fakeApps{
		"empty":      withCallbacks("", "s"),
		"whitespace": withCallbacks("   ", "s"),
		"missing":    {cfg: &contracts.AppConfig{}},
	} {
		h := newHarness(apps)
		h.svc.Dispatch(context.Background(), "live", "stream_started", payload("room", "r"))
		if len(h.tr.calls) != 0 {
			t.Fatalf("%s: fired", name)
		}
		if h.metrics.results[0] != "live|stream_started|dropped" {
			t.Fatalf("%s: metrics %v", name, h.metrics.results)
		}
	}
}

func TestGetConfigErrorSkips(t *testing.T) {
	h := newHarness(&fakeApps{err: errors.New(`app "live" not found`)})
	h.svc.Dispatch(context.Background(), "live", "stream_started", payload())
	if len(h.tr.calls) != 0 {
		t.Fatal("fired without config")
	}
	if l := h.logs.find("warn", `skipped "stream_started" — could not load config for app "live"`); l == nil || l.meta["error"] != `app "live" not found` {
		t.Fatalf("log %+v", l)
	}
}

func TestUnsignedDispatchOmitsSignature(t *testing.T) {
	h := newHarness(withCallbacks("https://hook.test/cb", ""))
	h.svc.Dispatch(context.Background(), "live", "stream_started", payload("room", "r"))
	if len(h.tr.calls) != 1 {
		t.Fatal("not posted")
	}
	if _, ok := h.tr.calls[0].headers["X-Streamhub-Signature"]; ok {
		t.Fatal("signature header present without a secret")
	}
}

func TestDeliveryLoop(t *testing.T) {
	cases := []struct {
		name     string
		script   []int
		calls    int
		sleeps   []time.Duration
		logLevel string
		logText  string
		result   string
	}{
		{"2xx once", []int{200}, 1, nil, "info", `delivered "stream_started"`, "delivered"},
		{"400 not retried", []int{400}, 1, nil, "error", "HTTP 400", "failed"},
		{"500 retried then gives up", []int{500}, 3, []time.Duration{500 * time.Millisecond, time.Second}, "error", `gave up delivering "stream_started" after 3 attempts`, "failed"},
		{"429 retried", []int{429, 200}, 2, []time.Duration{500 * time.Millisecond}, "info", `delivered "stream_started"`, "delivered"},
		{"408 retried", []int{408, 204}, 2, []time.Duration{500 * time.Millisecond}, "info", `delivered "stream_started"`, "delivered"},
		{"network error retried", []int{0}, 3, []time.Duration{500 * time.Millisecond, time.Second}, "warn", `"stream_started" delivery error`, "failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(withCallbacks("https://hook.test/cb", "s"), c.script...)
			h.svc.Dispatch(context.Background(), "live", "stream_started", payload("room", "live-1"))
			if len(h.tr.calls) != c.calls {
				t.Fatalf("calls %d, want %d", len(h.tr.calls), c.calls)
			}
			if len(h.sleeps) != len(c.sleeps) {
				t.Fatalf("sleeps %v, want %v", h.sleeps, c.sleeps)
			}
			for i := range c.sleeps {
				if h.sleeps[i] != c.sleeps[i] {
					t.Fatalf("sleeps %v, want %v", h.sleeps, c.sleeps)
				}
			}
			if h.logs.find(c.logLevel, c.logText) == nil {
				t.Fatalf("missing %s log %q in %+v", c.logLevel, c.logText, h.logs.lines)
			}
			if got := h.metrics.results[len(h.metrics.results)-1]; got != "live|stream_started|"+c.result {
				t.Fatalf("result %s", got)
			}
		})
	}
	h := newHarness(withCallbacks("https://hook.test/cb", "s"), 400)
	h.svc.Dispatch(context.Background(), "live", "stream_started", payload())
	if l := h.logs.find("error", "HTTP 400"); l.meta["retryable"] != false {
		t.Fatalf("retryable meta %+v", l.meta)
	}
	h = newHarness(withCallbacks("https://hook.test/cb", "s"), 429, 200)
	h.svc.Dispatch(context.Background(), "live", "stream_started", payload())
	if l := h.logs.find("info", "delivered"); l.meta["attempt"] != 2 {
		t.Fatalf("attempt meta %+v", l.meta)
	}
}

// ---------------------------------------------------------------------------
// callbacks.ssrf.spec.ts
// ---------------------------------------------------------------------------

func TestSSRFGuard(t *testing.T) {
	resolve := func(_ context.Context, host string) ([]string, error) {
		switch host {
		case "intranet.evil.tld":
			return []string{"10.20.30.40"}, nil
		case "hooks.internal.lan":
			return []string{"192.168.7.7"}, nil
		case "hook.example.com":
			return []string{"93.184.216.34"}, nil
		}
		return nil, errors.New("ENOTFOUND " + host)
	}
	cases := []struct {
		url, allow string
		fires      bool
	}{
		{"http://169.254.169.254/latest/meta-data/", "", false},
		{"https://intranet.evil.tld/hook", "", false},
		{"http://127.0.0.1:3020/api/v1/health", "", false},
		{"http://[::1]:6379/", "", false},
		{"http://0.0.0.0:8080/x", "", false},
		{"file:///etc/passwd", "", false},
		{"gopher://127.0.0.1:6379/_SET%20x%20y", "", false},
		{"http://10.0.0.1/hook", "", false},
		{"https://hook.example.com/cb", "", true},
		{"https://hooks.internal.lan/cb", "hooks.internal.lan", true},
		{"https://intranet.evil.tld/hook", "hooks.internal.lan", false},
	}
	for _, c := range cases {
		t.Run(c.url+"|"+c.allow, func(t *testing.T) {
			t.Setenv(security.CallbackAllowHostsEnv, c.allow)
			h := newHarness(withCallbacks(c.url, "s"))
			h.svc.Resolve = resolve
			h.svc.Dispatch(context.Background(), "live", "stream_started", payload("room", "live-1"))
			if fired := len(h.tr.calls) == 1; fired != c.fires {
				t.Fatalf("fired=%v, want %v", fired, c.fires)
			}
			if !c.fires {
				l := h.logs.find("error", "SSRF")
				if l == nil || l.meta["url"] != c.url {
					t.Fatalf("blocked log %+v", l)
				}
				if h.metrics.results[0] != "live|stream_started|dropped" {
					t.Fatalf("metrics %v", h.metrics.results)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// callbacks.mqtt-tap.spec.ts
// ---------------------------------------------------------------------------

func TestMQTTTap(t *testing.T) {
	cases := []struct {
		name string
		apps *fakeApps
		boom bool
		post int
	}{
		{"mirrors with a webhook", withCallbacks("https://hook.test/cb", "s"), false, 1},
		{"no callback URL", withCallbacks("", ""), false, 0},
		{"config load fails", &fakeApps{err: errors.New("boom")}, false, 0},
		{"exploding sink never breaks the webhook", withCallbacks("https://hook.test/cb", "s"), true, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(c.apps)
			m := &fakeMQTT{ch: make(chan struct{}, 1), boom: c.boom}
			h.svc.SetMQTT(m)
			h.svc.Dispatch(context.Background(), "live", "vod_ready", payload("room", "r"))
			select {
			case <-m.ch:
			case <-time.After(2 * time.Second):
				t.Fatal("MQTT tap not called")
			}
			if m.calls[0] != "live|vod_ready" {
				t.Fatalf("tap %v", m.calls)
			}
			if len(h.tr.calls) != c.post {
				t.Fatalf("posts %d, want %d", len(h.tr.calls), c.post)
			}
		})
	}
	// works without a sink at all
	h := newHarness(withCallbacks("https://hook.test/cb", "s"))
	h.svc.Dispatch(context.Background(), "live", "vod_ready", payload())
	if len(h.tr.calls) != 1 {
		t.Fatal("dispatch without MQTT sink failed")
	}
}

// ---------------------------------------------------------------------------
// callbacks.dispatch-hook.spec.ts
// ---------------------------------------------------------------------------

func TestOnDispatch(t *testing.T) {
	h := newHarness(withCallbacks("", ""))
	var got []string
	var gotPayload any
	unsub := h.svc.OnDispatch(func(app, event string, p any) {
		got = append(got, app+"|"+event)
		gotPayload = p
	})
	h.svc.OnDispatch(func(string, string, any) { panic("listener boom") })
	p := payload("room", "r")
	h.svc.Dispatch(context.Background(), "live", "stream_started", p)
	if len(got) != 1 || got[0] != "live|stream_started" || gotPayload != p {
		t.Fatalf("listener got %v %v (fires even without a URL)", got, gotPayload)
	}
	// A throwing listener never breaks the webhook.
	h2 := newHarness(withCallbacks("https://hook.test/cb", "s"))
	h2.svc.OnDispatch(func(string, string, any) { panic("boom") })
	h2.svc.Dispatch(context.Background(), "live", "stream_started", p)
	if len(h2.tr.calls) != 1 {
		t.Fatal("webhook broken by listener")
	}
	unsub()
	h.svc.Dispatch(context.Background(), "live", "stream_ended", p)
	if len(got) != 1 {
		t.Fatalf("unsubscribed listener still invoked: %v", got)
	}
}

func TestShadowSuppressesEverything(t *testing.T) {
	h := newHarness(withCallbacks("https://hook.test/cb", "s"))
	h.svc = New(Deps{Apps: withCallbacks("https://hook.test/cb", "s"), Logs: h.logs, Metrics: h.metrics, Shadow: true})
	h.svc.Client = &http.Client{Transport: h.tr}
	m := &fakeMQTT{}
	h.svc.SetMQTT(m)
	called := false
	h.svc.OnDispatch(func(string, string, any) { called = true })
	if err := h.svc.Dispatch(context.Background(), "live", "stream_started", payload("room", "r")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if len(h.tr.calls) != 0 || len(m.calls) != 0 || called || len(h.metrics.results) != 0 {
		t.Fatalf("shadow delivered: posts=%d mqtt=%d listener=%v metrics=%v", len(h.tr.calls), len(m.calls), called, h.metrics.results)
	}
	if l := h.logs.find("debug", "shadow: suppressed"); l == nil || l.meta["event"] != "stream_started" {
		t.Fatalf("log %+v", h.logs.lines)
	}
}
