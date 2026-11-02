package notify

import (
	"context"
	"crypto/hmac"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fastOpts keeps the retry schedule shape (3 retries) but in milliseconds.
func fastOpts() options {
	return options{
		queueSize:    64,
		drainTimeout: 5 * time.Second,
		backoff:      []time.Duration{5 * time.Millisecond, 10 * time.Millisecond, 20 * time.Millisecond},
	}
}

func newTestNotifier(t *testing.T, cfg Config, o options) *Notifier {
	t.Helper()
	n := newNotifier(cfg, nil, o)
	n.SetDevice("enc-test-01")
	t.Cleanup(n.Close)
	return n
}

// waitFor polls cond until true or fails after 5 s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// hook is a recording webhook endpoint; status decides the reply per call
// (1-based call number).
type hook struct {
	srv    *httptest.Server
	mu     sync.Mutex
	reqs   []recorded
	calls  atomic.Int64
	status func(call int64) int
}

type recorded struct {
	header http.Header
	body   []byte
	event  Event
}

func newHook(t *testing.T, status func(call int64) int) *hook {
	t.Helper()
	h := &hook{status: status}
	if h.status == nil {
		h.status = func(int64) int { return http.StatusNoContent }
	}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := h.calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		var e Event
		_ = json.Unmarshal(body, &e)
		h.mu.Lock()
		h.reqs = append(h.reqs, recorded{header: r.Header.Clone(), body: body, event: e})
		h.mu.Unlock()
		w.WriteHeader(h.status(call))
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *hook) events() []Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Event, len(h.reqs))
	for i, r := range h.reqs {
		out[i] = r.event
	}
	return out
}

func sampleEvent(typ string, active bool) Event {
	return Event{
		ID:       "evt-" + typ,
		Type:     typ,
		Severity: "major",
		Active:   active,
		Channel:  "ch1",
		Output:   "out-srt",
		Message:  "no input for 5s",
		Value:    5.25,
		At:       time.Date(2026, 10, 29, 12, 34, 56, 700_000_000, time.UTC),
		Device:   "enc-abc",
	}
}

func TestWebhookHeadersAndSignature(t *testing.T) {
	h := newHook(t, nil)
	n := newTestNotifier(t, Config{Webhooks: []Webhook{{URL: h.srv.URL + "/hook?token=abc", Secret: "s3cr3t"}}}, fastOpts())

	want := sampleEvent("input_loss", true)
	n.Send(want)
	waitFor(t, "sent=1", func() bool { return n.Stats().Sent == 1 })

	h.mu.Lock()
	r := h.reqs[0]
	h.mu.Unlock()
	if got := r.header.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := r.header.Get("User-Agent"); got != "streamhub-encoder" {
		t.Errorf("User-Agent = %q", got)
	}
	if got := r.header.Get(HeaderEvent); got != "input_loss" {
		t.Errorf("%s = %q", HeaderEvent, got)
	}
	sig := r.header.Get(HeaderSignature)
	if !strings.HasPrefix(sig, "sha256=") || !hmac.Equal([]byte(sig), []byte(Sign("s3cr3t", r.body))) {
		t.Errorf("signature %q does not verify over the body", sig)
	}
	if !r.event.At.Equal(want.At) {
		t.Errorf("At = %v, want %v", r.event.At, want.At)
	}
	r.event.At = want.At
	if r.event != want {
		t.Errorf("body = %+v, want %+v", r.event, want)
	}
}

func TestWebhookNoSignatureWithoutSecret(t *testing.T) {
	h := newHook(t, nil)
	n := newTestNotifier(t, Config{Webhooks: []Webhook{{URL: h.srv.URL}}}, fastOpts())
	n.Send(Event{Type: "black", Severity: "minor", Active: true, Message: "black frame"})
	waitFor(t, "sent=1", func() bool { return n.Stats().Sent == 1 })
	h.mu.Lock()
	r := h.reqs[0]
	h.mu.Unlock()
	if v := r.header.Get(HeaderSignature); v != "" {
		t.Errorf("unexpected signature %q", v)
	}
	// Send fills ID, At and Device.
	if r.event.ID == "" || r.event.At.IsZero() || r.event.Device != "enc-test-01" {
		t.Errorf("defaults not filled: %+v", r.event)
	}
}

func TestWebhookRetryOn500ThenSuccess(t *testing.T) {
	h := newHook(t, func(call int64) int {
		if call <= 2 {
			return http.StatusInternalServerError
		}
		return http.StatusOK
	})
	n := newTestNotifier(t, Config{Webhooks: []Webhook{{URL: h.srv.URL}}}, fastOpts())
	n.Send(sampleEvent("freeze", true))
	waitFor(t, "sent=1", func() bool { return n.Stats().Sent == 1 })
	if c := h.calls.Load(); c != 3 {
		t.Errorf("calls = %d, want 3 (2×500 then 200)", c)
	}
	if s := n.Stats(); s.Failed != 0 {
		t.Errorf("failed = %d, want 0", s.Failed)
	}
}

func TestWebhookRetriesExhausted(t *testing.T) {
	h := newHook(t, func(int64) int { return http.StatusServiceUnavailable })
	n := newTestNotifier(t, Config{Webhooks: []Webhook{{URL: h.srv.URL}}}, fastOpts())
	n.Send(sampleEvent("freeze", true))
	waitFor(t, "failed=1", func() bool { return n.Stats().Failed == 1 })
	if c := h.calls.Load(); c != 4 {
		t.Errorf("calls = %d, want 4 (1 + 3 retries)", c)
	}
	if le := n.Stats().LastError; !strings.Contains(le, "503") || !strings.Contains(le, "4 attempts") {
		t.Errorf("LastError = %q", le)
	}
}

func TestWebhookNoRetryOn400(t *testing.T) {
	h := newHook(t, func(int64) int { return http.StatusBadRequest })
	n := newTestNotifier(t, Config{Webhooks: []Webhook{{URL: h.srv.URL + "/x?secret=leak"}}}, fastOpts())
	n.Send(sampleEvent("silence", true))
	waitFor(t, "failed=1", func() bool { return n.Stats().Failed == 1 })
	time.Sleep(60 * time.Millisecond) // longer than the whole fast back-off schedule
	if c := h.calls.Load(); c != 1 {
		t.Errorf("calls = %d, want 1 (4xx is final)", c)
	}
	le := n.Stats().LastError
	if !strings.Contains(le, "400") {
		t.Errorf("LastError = %q, want status 400", le)
	}
	if strings.Contains(le, "leak") {
		t.Errorf("LastError leaks the query string: %q", le)
	}
}

func TestWebhookNetworkErrorRetried(t *testing.T) {
	h := newHook(t, nil)
	url := h.srv.URL
	h.srv.Close() // connection refused from now on
	n := newTestNotifier(t, Config{Webhooks: []Webhook{{URL: url}}}, fastOpts())
	n.Send(sampleEvent("output_down", true))
	waitFor(t, "failed=1", func() bool { return n.Stats().Failed == 1 })
	if le := n.Stats().LastError; !strings.Contains(le, "4 attempts") {
		t.Errorf("LastError = %q, want retried 4 attempts", le)
	}
}

func TestWebhookTypeFilter(t *testing.T) {
	only := newHook(t, nil)
	all := newHook(t, nil)
	n := newTestNotifier(t, Config{Webhooks: []Webhook{
		{URL: only.srv.URL, Types: []string{"input_loss"}},
		{URL: all.srv.URL},
	}}, fastOpts())
	n.Send(sampleEvent("black", true))
	n.Send(sampleEvent("input_loss", true))
	n.Send(sampleEvent("input_loss", false))
	n.Close()

	if got := only.events(); len(got) != 2 || got[0].Type != "input_loss" || got[1].Type != "input_loss" || got[1].Active {
		t.Errorf("filtered hook got %+v, want input_loss raise+clear only", got)
	}
	if got := all.events(); len(got) != 3 {
		t.Errorf("unfiltered hook got %d events, want 3", len(got))
	}
	if s := n.Stats(); s.Sent != 5 || s.Failed != 0 {
		t.Errorf("stats = %+v, want sent=5", s)
	}
}

func TestQueueOverflowDropsOldest(t *testing.T) {
	release := make(chan struct{})
	first := make(chan struct{})
	var once sync.Once
	var mu sync.Mutex
	var ids []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var e Event
		_ = json.NewDecoder(r.Body).Decode(&e)
		mu.Lock()
		ids = append(ids, e.ID)
		mu.Unlock()
		once.Do(func() { close(first); <-release })
	}))
	defer srv.Close()

	o := fastOpts()
	o.queueSize = 2
	n := newTestNotifier(t, Config{Webhooks: []Webhook{{URL: srv.URL}}}, o)

	n.Send(Event{ID: "e1", Type: "black"})
	<-first // e1 is in flight, the queue is empty
	for _, id := range []string{"e2", "e3", "e4", "e5", "e6"} {
		n.Send(Event{ID: id, Type: "black"})
	}
	if d := n.Stats().Dropped; d != 3 {
		t.Fatalf("dropped = %d, want 3", d)
	}
	close(release)
	n.Close()

	mu.Lock()
	defer mu.Unlock()
	if strings.Join(ids, ",") != "e1,e5,e6" {
		t.Errorf("delivered %v, want e1,e5,e6 (oldest dropped)", ids)
	}
	if s := n.Stats(); s.Sent != 3 || s.Dropped != 3 {
		t.Errorf("stats = %+v", s)
	}
}

func TestCloseDrainsInOrder(t *testing.T) {
	h := newHook(t, nil)
	n := newTestNotifier(t, Config{Webhooks: []Webhook{{URL: h.srv.URL}}}, fastOpts())
	const total = 20
	for i := range total {
		n.Send(Event{ID: string(rune('a' + i)), Type: "freeze"})
	}
	n.Close()
	got := h.events()
	if len(got) != total {
		t.Fatalf("delivered %d, want %d", len(got), total)
	}
	for i, e := range got {
		if e.ID != string(rune('a'+i)) {
			t.Fatalf("event %d id %q: order not preserved", i, e.ID)
		}
	}
	if s := n.Stats(); s.Sent != total {
		t.Errorf("sent = %d", s.Sent)
	}
	// Send after Close is a counted drop, not a panic or a delivery.
	n.Send(Event{Type: "freeze"})
	if s := n.Stats(); s.Dropped != 1 {
		t.Errorf("dropped after close = %d, want 1", s.Dropped)
	}
	n.Close() // idempotent
}

func TestCloseTimeoutAbortsRetries(t *testing.T) {
	h := newHook(t, func(int64) int { return http.StatusBadGateway })
	o := fastOpts()
	o.backoff = []time.Duration{time.Hour}
	o.drainTimeout = 100 * time.Millisecond
	n := newNotifier(Config{Webhooks: []Webhook{{URL: h.srv.URL}}}, nil, o)
	n.Send(Event{ID: "a", Type: "black"})
	n.Send(Event{ID: "b", Type: "black"})
	n.Send(Event{ID: "c", Type: "black"})
	waitFor(t, "first attempt", func() bool { return h.calls.Load() >= 1 })

	start := time.Now()
	n.Close()
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("Close took %v", el)
	}
	s := n.Stats()
	if s.Failed != 1 || s.Dropped != 2 {
		t.Errorf("stats = %+v, want failed=1 (aborted) dropped=2 (left in queue)", s)
	}
	if !strings.Contains(s.LastError, "retry aborted") {
		t.Errorf("LastError = %q", s.LastError)
	}
}

func TestUpdateSwitchesTargets(t *testing.T) {
	a := newHook(t, nil)
	b := newHook(t, nil)
	n := newTestNotifier(t, Config{Webhooks: []Webhook{{URL: a.srv.URL}}}, fastOpts())

	n.Send(Event{ID: "1", Type: "black"})
	waitFor(t, "a got 1", func() bool { return a.calls.Load() == 1 })

	n.Update(Config{Webhooks: []Webhook{{URL: b.srv.URL}}})
	n.Send(Event{ID: "2", Type: "black"})
	waitFor(t, "b got 1", func() bool { return b.calls.Load() == 1 })

	n.Update(Config{})
	n.Send(Event{ID: "3", Type: "black"})
	n.Close()

	if a.calls.Load() != 1 || b.calls.Load() != 1 {
		t.Errorf("a=%d b=%d, want 1/1", a.calls.Load(), b.calls.Load())
	}
	if ev := b.events(); ev[0].ID != "2" {
		t.Errorf("b got %q", ev[0].ID)
	}
	if s := n.Stats(); s.Sent != 2 || s.Failed != 0 {
		t.Errorf("stats = %+v", s)
	}
}

func TestTestReportsPerTarget(t *testing.T) {
	ok := newHook(t, nil)
	bad := newHook(t, func(int64) int { return http.StatusBadRequest })
	addr, traps := startTrapListener(t, v2cListenerParams())
	n := newTestNotifier(t, Config{
		Webhooks: []Webhook{
			{URL: ok.srv.URL, Types: []string{"input_loss"}}, // filters do not apply to Test
			{URL: bad.srv.URL},
			{URL: "ftp://nope"},
		},
		SNMP: []SNMPTarget{
			{Address: addr, Version: "2c"},
			{Address: addr, Version: "1"},
		},
	}, fastOpts())

	errs := n.Test(context.Background())
	if len(errs) != 5 {
		t.Fatalf("len(errs) = %d, want 5", len(errs))
	}
	if errs[0] != nil || errs[3] != nil {
		t.Errorf("expected success for ok webhook / v2c target: %v / %v", errs[0], errs[3])
	}
	if errs[1] == nil || !strings.Contains(errs[1].Error(), "400") {
		t.Errorf("errs[1] = %v, want 400", errs[1])
	}
	if errs[2] == nil || !strings.Contains(errs[2].Error(), "scheme") {
		t.Errorf("errs[2] = %v, want scheme error", errs[2])
	}
	if errs[4] == nil || !strings.Contains(errs[4].Error(), "unsupported snmp version") {
		t.Errorf("errs[4] = %v, want version error", errs[4])
	}
	if bad.calls.Load() != 1 {
		t.Errorf("Test must not retry: %d calls", bad.calls.Load())
	}
	got := ok.events()
	if len(got) != 1 || got[0].Type != "test" || got[0].Severity != "info" || got[0].Device != "enc-test-01" {
		t.Errorf("test event = %+v", got)
	}
	select {
	case p := <-traps:
		assertTrap(t, p, got[0], OIDAlarmRaised)
	case <-time.After(3 * time.Second):
		t.Fatal("no test trap received")
	}
	if s := n.Stats(); s.Sent != 2 || s.Failed != 3 {
		t.Errorf("stats = %+v, want sent=2 failed=3", s)
	}
}

func TestHelpers(t *testing.T) {
	for _, c := range []struct {
		in   string
		host string
		port uint16
		bad  bool
	}{
		{"10.0.0.5", "10.0.0.5", 162, false},
		{"nms.local:1162", "nms.local", 1162, false},
		{"[::1]:163", "::1", 163, false},
		{"::1", "::1", 162, false},
		{"host:0", "", 0, true},
		{"", "", 0, true},
	} {
		h, p, err := splitHostPort(c.in)
		if (err != nil) != c.bad || h != c.host || p != c.port {
			t.Errorf("splitHostPort(%q) = %q,%d,%v", c.in, h, p, err)
		}
	}
	if id, err := parseEngineID("0x80:00:00:00:01:02"); err != nil || id != "\x80\x00\x00\x00\x01\x02" {
		t.Errorf("parseEngineID = %x, %v", id, err)
	}
	if _, err := parseEngineID("8000"); err == nil {
		t.Error("short engine id accepted")
	}
	if id := defaultEngineID("host"); id != "\x80\x01\x86\x9f\x04host" {
		t.Errorf("defaultEngineID = %x", id)
	}
	if got := truncate("ab€", 3); got != "ab" {
		t.Errorf("truncate = %q", got)
	}
	if got := dateAndTime(time.Date(2026, 10, 29, 12, 34, 56, 700_000_000, time.UTC)); string(got) != "\x07\xea\x0a\x1d\x0c\x22\x38\x07+\x00\x00" {
		t.Errorf("dateAndTime = %x", got)
	}
	if severityCode("CRITICAL") != SeverityCritical || severityCode("bogus") != SeverityIndeterminate {
		t.Error("severityCode")
	}
}

// A webhook URL that does not parse must not echo its credentials or query
// token into the per-target error (shown by POST /notify/test) or Stats.
func TestInvalidWebhookURLErrorHidesCredentials(t *testing.T) {
	n := newTestNotifier(t, Config{Webhooks: []Webhook{
		{URL: "https://hookUser:hookPass-0077@hooks.example.com:99x/x?token=hookTok-0078"},
	}}, fastOpts())
	errs := n.Test(context.Background())
	if len(errs) != 1 || errs[0] == nil {
		t.Fatalf("errs = %v, want one config error", errs)
	}
	for _, s := range []string{errs[0].Error(), n.Stats().LastError} {
		if strings.Contains(s, "hookPass-0077") || strings.Contains(s, "hookTok-0078") {
			t.Errorf("credential leaked: %s", s)
		}
	}
}
