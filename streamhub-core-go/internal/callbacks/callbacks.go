// Package callbacks is modules/callbacks: the outbound per-app signed
// webhook funnel every domain event converges on. dispatch() also feeds the
// MQTT tap and the in-process listeners (Streamflow trigger engine).
//
// Envelope POSTed to the app's callbacks.url:
//
//	{"id","event","app","room","ts","timestamp","data"}
//
// signed as X-StreamHub-Signature: sha256=<hex HMAC-SHA256(secret, body)>.
// Best-effort with bounded retries; never fails the caller.
package callbacks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logsink"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/mqtt"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

const (
	timeout     = 10 * time.Second
	maxAttempts = 3
	backoffBase = 500 * time.Millisecond
)

// ConfigSource is the apps surface the funnel reads (callbacks.{url,secret}).
type ConfigSource interface {
	GetConfig(ctx context.Context, name string) (*contracts.AppConfig, error)
}

// ResultRecorder is MetricsService.callbackResult (optional).
type ResultRecorder interface {
	CallbackResult(app, event, result string)
}

// EventPublisher is the MQTT tap (MqttService.publishEvent, optional).
type EventPublisher interface {
	PublishEvent(ctx context.Context, app, event string, payload any)
}

// Listener is notified for every dispatched event (the payload as given).
type Listener func(app, event string, payload any)

// Deps are the funnel's inputs; Metrics and MQTT are optional.
type Deps struct {
	Apps    ConfigSource
	Logs    logsink.Writer
	Metrics ResultRecorder
	MQTT    EventPublisher
	Log     *slog.Logger
	// Shadow (STREAMHUB_SHADOW=1): the core runs beside the live Node core,
	// so nothing is delivered — no webhook, no MQTT tap, no listeners.
	Shadow bool
}

// Service is CallbacksService.
type Service struct {
	apps    ConfigSource
	logs    logsink.Writer
	metrics ResultRecorder
	mqtt    EventPublisher
	shadow  bool

	// Resolve is the DNS seam of the egress SSRF guard (tests inject a fake).
	Resolve security.HostResolver
	// Client posts the webhooks (tests inject a fake transport).
	Client *http.Client
	// Sleep waits between attempts (tests skip the real backoff).
	Sleep func(time.Duration)
	// Now / NewID are seams for deterministic envelopes in tests.
	Now   func() time.Time
	NewID func() string

	mu        sync.Mutex
	nextID    int
	listeners map[int]Listener
}

// New builds the funnel.
func New(d Deps) *Service {
	s := &Service{
		apps: d.Apps, logs: logsink.Or(d.Logs, d.Log), metrics: d.Metrics, mqtt: d.MQTT, shadow: d.Shadow,
		Resolve:   security.DefaultHostResolver,
		Client:    &http.Client{},
		Sleep:     time.Sleep,
		Now:       time.Now,
		NewID:     func() string { return uuid.NewString() },
		listeners: map[int]Listener{},
	}
	return s
}

// SetMQTT wires the MQTT tap after construction (optional dependency).
func (s *Service) SetMQTT(p EventPublisher) { s.mqtt = p }

// OnDispatch registers an in-process listener for every dispatched event
// (even ones with no callback URL); returns the unsubscribe func. A
// panicking listener is swallowed — it can never affect dispatch.
func (s *Service) OnDispatch(l Listener) func() {
	s.mu.Lock()
	id := s.nextID
	s.nextID++
	s.listeners[id] = l
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.listeners, id)
		s.mu.Unlock()
	}
}

func (s *Service) emitToListeners(app, event string, payload any) {
	s.mu.Lock()
	ids := make([]int, 0, len(s.listeners))
	for id := range s.listeners {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	// Registration order, as a JS Set iterates.
	slices.Sort(ids)
	for _, id := range ids {
		s.mu.Lock()
		l := s.listeners[id]
		s.mu.Unlock()
		if l == nil {
			continue
		}
		func() {
			defer func() { _ = recover() }()
			l(app, event, payload)
		}()
	}
}

// DispatchAsync is `void callbacks.dispatch(...)`: fire-and-forget.
func (s *Service) DispatchAsync(ctx context.Context, app, event string, payload any) {
	ctx = context.WithoutCancel(ctx)
	go func() { _ = s.Dispatch(ctx, app, event, payload) }()
}

// Dispatch delivers the event (blocking through the retries, like awaiting
// the Node promise), then notifies the in-process listeners. Never panics
// and always returns nil (the Node promise never rejects); the error return
// only fits the callers' Callbacks interfaces. The caller's cancellation
// does not abort a delivery in flight.
func (s *Service) Dispatch(ctx context.Context, app, event string, payload any) error {
	if s.shadow {
		s.logs.Write("debug", "callbacks", "shadow: suppressed", map[string]any{"app": app, "event": event})
		return nil
	}
	ctx = context.WithoutCancel(ctx)
	defer s.emitToListeners(app, event, payload)
	defer func() {
		if r := recover(); r != nil {
			s.logs.Write("error", "callbacks", fmt.Sprintf("dispatch of %q panicked", event), map[string]any{"app": app, "error": fmt.Sprint(r)})
		}
	}()
	s.dispatchInner(ctx, app, event, payload)
	return nil
}

// envelope keeps Node's key order (the signature covers the exact bytes).
type envelope struct {
	ID        string  `json:"id"`
	Event     string  `json:"event"`
	App       string  `json:"app"`
	Room      *string `json:"room"`
	Ts        string  `json:"ts"`
	Timestamp string  `json:"timestamp"`
	Data      any     `json:"data"`
}

func (s *Service) dispatchInner(ctx context.Context, app, event string, payload any) {
	// MQTT fan-out tap: independent of the webhook URL, fire-and-forget.
	if s.mqtt != nil {
		go func() {
			defer func() { _ = recover() }()
			s.mqtt.PublishEvent(ctx, app, event, payload)
		}()
	}

	cfg, err := s.apps.GetConfig(ctx, app)
	if err != nil || cfg == nil {
		msg := "app config unavailable"
		if err != nil {
			msg = errMsg(err)
		}
		s.logs.Write("warn", "callbacks", fmt.Sprintf("skipped %q — could not load config for app %q", event, app), map[string]any{"error": msg})
		return
	}

	url := yamljs.Trim(cfg.Callbacks.URL)
	if url == "" {
		s.logs.Write("debug", "callbacks", fmt.Sprintf("no callback URL for app %q — skipping %q", app, event), nil)
		s.result(app, event, "dropped")
		return
	}

	// Fire-time SSRF guard (P0-1): tenant-controlled URL; deny-private by
	// default, STREAMHUB_CALLBACK_ALLOW_HOSTS exempts known-internal targets.
	if err := security.AssertSafeEgressURL(ctx, url, security.EgressOptions{
		AllowedSchemes: security.HTTPSchemes,
		Label:          "callback URL",
		Allowlist:      security.ParseAllowlistEnv(os.Getenv(security.CallbackAllowHostsEnv)),
		Resolve:        s.Resolve,
	}); err != nil {
		s.logs.Write("error", "callbacks", fmt.Sprintf("blocked %q for app %q — callback URL rejected by the egress SSRF guard", event, app), map[string]any{"url": url, "error": errMsg(err)})
		s.result(app, event, "dropped")
		return
	}

	body, env, err := s.BuildBody(app, event, payload)
	if err != nil {
		s.logs.Write("error", "callbacks", fmt.Sprintf("failed to serialize %q payload for app %q", event, app), map[string]any{"error": err.Error()})
		return
	}
	headers := map[string]string{
		"content-type":          "application/json",
		"user-agent":            "streamhub-core/callbacks",
		"x-streamhub-event":     event,
		"x-streamhub-delivery":  env.ID,
		"x-streamhub-timestamp": env.Timestamp,
	}
	if secret := cfg.Callbacks.Secret; secret != "" {
		headers["x-streamhub-signature"] = "sha256=" + Sign(secret, body)
	}
	s.post(ctx, app, event, url, body, headers, env.ID)
}

// BuildBody renders the envelope exactly as JSON.stringify would.
func (s *Service) BuildBody(app, event string, payload any) ([]byte, envelope, error) {
	now := jsx.ISO(s.Now())
	data := mqtt.Object(payload)
	var room *string
	if m, ok := data.(*yamljs.Map); ok {
		if r, ok := m.Get("room").(string); ok {
			room = &r
		}
	}
	env := envelope{ID: s.NewID(), Event: event, App: app, Room: room, Ts: now, Timestamp: now, Data: data}
	raw, err := jsx.Stringify(env)
	return []byte(raw), env, err
}

// Sign is the hex HMAC-SHA256 of body under secret.
func Sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// post delivers with bounded retries + exponential backoff. 4xx other than
// 408/429 is final; 5xx/408/429 and transport errors retry.
func (s *Service) post(ctx context.Context, app, event, url string, body []byte, headers map[string]string, delivery string) {
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		status, err := s.do(ctx, url, body, headers)
		if err == nil {
			if status >= 200 && status < 300 {
				s.logs.Write("info", "callbacks", fmt.Sprintf("delivered %q", event), map[string]any{
					"app": app, "url": url, "status": status, "delivery": delivery, "attempt": attempt,
				})
				s.result(app, event, "delivered")
				return
			}
			retryable := status >= 500 || status == 408 || status == 429
			level := "error"
			if retryable {
				level = "warn"
			}
			s.logs.Write(level, "callbacks", fmt.Sprintf("%q returned HTTP %d", event, status), map[string]any{
				"app": app, "url": url, "delivery": delivery, "attempt": attempt, "retryable": retryable,
			})
			if !retryable {
				s.result(app, event, "failed")
				return
			}
		} else {
			s.logs.Write("warn", "callbacks", fmt.Sprintf("%q delivery error", event), map[string]any{
				"app": app, "url": url, "delivery": delivery, "attempt": attempt, "error": err.Error(),
			})
		}
		if attempt < maxAttempts {
			s.Sleep(backoffBase * time.Duration(1<<(attempt-1)))
		}
	}
	s.logs.Write("error", "callbacks", fmt.Sprintf("gave up delivering %q after %d attempts", event, maxAttempts), map[string]any{
		"app": app, "url": url, "delivery": delivery,
	})
	s.result(app, event, "failed")
}

func (s *Service) do(ctx context.Context, url string, body []byte, headers map[string]string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := s.Client.Do(req)
	if err != nil {
		return 0, err
	}
	_ = res.Body.Close()
	return res.StatusCode, nil
}

func (s *Service) result(app, event, result string) {
	if s.metrics != nil {
		s.metrics.CallbackResult(app, event, result)
	}
}

func errMsg(err error) string {
	if he, ok := err.(*httpx.Error); ok {
		return he.Error()
	}
	return err.Error()
}
