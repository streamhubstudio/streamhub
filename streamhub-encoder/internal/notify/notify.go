// Package notify delivers encoder alarm events to external systems:
// HTTP webhooks (signed JSON POSTs) and SNMP managers (SNMPv2-Trap PDUs over
// SNMPv2c or SNMPv3/USM).
//
// Delivery is asynchronous: Send enqueues the event in a bounded in-memory
// queue (when full the OLDEST event is dropped and counted) and a single
// dispatcher goroutine fans each event out to every configured target
// concurrently, waiting for all of them before taking the next event. That
// keeps per-target ordering (a "cleared" never overtakes its "raised") at the
// cost of head-of-line blocking while a failing webhook is being retried.
//
// The target set can be hot-swapped with Update; Close drains the queue with
// a timeout. Nothing here dials the network until an event is delivered.
package notify

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// Event is one alarm occurrence (raise or clear). It is the JSON body of a
// webhook POST and maps 1:1 onto the varbinds of an SNMP trap.
type Event struct {
	ID       string    `json:"id"`       // unique per occurrence
	Type     string    `json:"type"`     // input_loss | black | freeze | silence | bitrate_drop | engine_restart | output_down | loudness | test
	Severity string    `json:"severity"` // critical | major | minor | warning | info
	Active   bool      `json:"active"`   // true = raised, false = cleared
	Channel  string    `json:"channel,omitempty"`
	Output   string    `json:"output,omitempty"`
	Message  string    `json:"message"`
	Value    float64   `json:"value,omitempty"`
	At       time.Time `json:"at"`
	Device   string    `json:"device"` // encoder device id
}

// Webhook is an HTTP endpoint that receives every event (or only Types).
type Webhook struct {
	URL    string   `json:"url"`
	Secret string   `json:"secret,omitempty"` // enables X-Encoder-Signature
	Types  []string `json:"types,omitempty"`  // empty = all event types
}

// SNMPTarget is an SNMP manager that receives traps.
//
// For Version "3" the USM security level follows from what is set:
// AuthPass+PrivPass = authPriv, AuthPass only = authNoPriv, neither =
// noAuthNoPriv (User is always required). AuthProto defaults to SHA and
// PrivProto to AES when the matching passphrase is set.
type SNMPTarget struct {
	Address   string `json:"address"`             // host:port (default port 162)
	Version   string `json:"version"`             // "2c" | "3"
	Community string `json:"community,omitempty"` // v2c; default "public"
	User      string `json:"user,omitempty"`      // v3 USM user name
	AuthProto string `json:"authProto,omitempty"` // SHA | SHA224 | SHA256 | SHA384 | SHA512 | MD5
	AuthPass  string `json:"authPass,omitempty"`  // >= 8 chars
	PrivProto string `json:"privProto,omitempty"` // AES | AES192 | AES256 | AES192C | AES256C | DES
	PrivPass  string `json:"privPass,omitempty"`  // >= 8 chars
	EngineID  string `json:"engineId,omitempty"`  // optional hex snmpEngineID (5..32 octets); default derived from the hostname
}

// Config is the full set of notification targets.
type Config struct {
	Webhooks []Webhook    `json:"webhooks"`
	SNMP     []SNMPTarget `json:"snmp"`
}

// Stats are cumulative delivery counters. Sent and Failed count per-target
// deliveries (one event to three targets counts three); Dropped counts events
// discarded by queue overflow, by Send after Close, or left over when Close
// timed out.
type Stats struct {
	Sent, Failed, Dropped int64
	LastError             string
}

// Defaults; tests override them through options.
const (
	defaultQueueSize    = 256
	defaultDrainTimeout = 10 * time.Second
	webhookTimeout      = 5 * time.Second
	snmpTimeout         = 5 * time.Second
)

// defaultBackoff is the wait before webhook retry 1, 2 and 3.
var defaultBackoff = []time.Duration{1 * time.Second, 3 * time.Second, 9 * time.Second}

type options struct {
	queueSize    int
	drainTimeout time.Duration
	backoff      []time.Duration
}

// targetSet is an immutable snapshot of the configured targets; Update
// replaces the pointer, in-flight deliveries keep using the old one.
type targetSet struct {
	webhooks []*webhookTarget
	snmp     []*snmpTarget
}

// Notifier fans events out to webhooks and SNMP managers. All methods are
// safe for concurrent use.
type Notifier struct {
	log    *slog.Logger
	opts   options
	client *http.Client

	start       time.Time // sysUpTime / snmpEngineTime origin
	engineBoots uint32    // snmpEngineBoots (see snmp.go)
	engineID    string    // default snmpEngineID (raw octets)

	ctx    context.Context // cancelled when Close gives up draining
	cancel context.CancelFunc
	wake   chan struct{} // cap 1: "queue changed or closing"
	done   chan struct{} // closed when the dispatcher exits

	mu        sync.Mutex
	targets   *targetSet
	queue     []Event
	closed    bool
	device    string
	lastError string

	sent, failed, dropped atomic.Int64
	closeOnce             sync.Once
}

// New builds a Notifier for cfg and starts its dispatcher goroutine. Invalid
// targets (bad URL, unknown SNMP version/protocol, short passphrase) are
// logged and every delivery to them counts as Failed with the config error.
// log may be nil.
func New(cfg Config, log *slog.Logger) *Notifier {
	return newNotifier(cfg, log, options{
		queueSize:    defaultQueueSize,
		drainTimeout: defaultDrainTimeout,
		backoff:      defaultBackoff,
	})
}

func newNotifier(cfg Config, log *slog.Logger, o options) *Notifier {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if o.queueSize < 1 {
		o.queueSize = 1
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "streamhub-encoder"
	}
	ctx, cancel := context.WithCancel(context.Background())
	n := &Notifier{
		log:  log.With("component", "notify"),
		opts: o,
		client: &http.Client{
			// A redirect on a POST would silently become a GET; treat any
			// 3xx as a (non-retryable) failure instead of following it.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		start:  time.Now(),
		ctx:    ctx,
		cancel: cancel,
		wake:   make(chan struct{}, 1),
		done:   make(chan struct{}),
		device: host,
	}
	n.engineBoots = engineBootsAt(n.start)
	n.engineID = defaultEngineID(host)
	n.targets = n.buildTargets(cfg)
	go n.dispatch()
	return n
}

// SetDevice sets the encoder device id stamped on events whose Device is
// empty (and on Test events). It defaults to the hostname.
func (n *Notifier) SetDevice(id string) {
	n.mu.Lock()
	n.device = id
	n.mu.Unlock()
}

// Update atomically replaces the target set (hot reload). Events already
// being delivered finish against the previous targets; queued events go to
// the new ones.
func (n *Notifier) Update(cfg Config) {
	ts := n.buildTargets(cfg) // SNMPv3 key localisation happens here, outside the lock
	n.mu.Lock()
	n.targets = ts
	n.mu.Unlock()
	n.log.Info("notification targets updated", "webhooks", len(ts.webhooks), "snmp", len(ts.snmp))
}

func (n *Notifier) buildTargets(cfg Config) *targetSet {
	ts := &targetSet{}
	for _, w := range cfg.Webhooks {
		t := newWebhookTarget(w)
		if t.err != nil {
			n.log.Warn("invalid webhook target", "target", t.label, "err", t.err)
		}
		ts.webhooks = append(ts.webhooks, t)
	}
	for _, s := range cfg.SNMP {
		t := newSNMPTarget(s, n.engineID, n.engineBoots)
		if t.err != nil {
			n.log.Warn("invalid snmp target", "target", t.label, "err", t.err)
		}
		ts.snmp = append(ts.snmp, t)
	}
	return ts
}

// Send enqueues e for asynchronous delivery and never blocks. Empty ID, At
// and Device are filled in. When the queue is full the oldest queued event is
// discarded and counted in Stats.Dropped. After Close, Send only counts a drop.
func (n *Notifier) Send(e Event) {
	n.mu.Lock()
	n.fill(&e)
	if n.closed {
		n.mu.Unlock()
		n.dropped.Add(1)
		n.log.Warn("event dropped: notifier closed", "type", e.Type, "id", e.ID)
		return
	}
	if len(n.queue) >= n.opts.queueSize {
		old := n.queue[0]
		copy(n.queue, n.queue[1:])
		n.queue = n.queue[:len(n.queue)-1]
		n.dropped.Add(1)
		n.log.Warn("notification queue full, dropped oldest event", "type", old.Type, "id", old.ID)
	}
	n.queue = append(n.queue, e)
	n.mu.Unlock()
	n.signal()
}

// fill completes the optional fields of e. Caller holds n.mu.
func (n *Notifier) fill(e *Event) {
	if e.ID == "" {
		e.ID = newID()
	}
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	if e.Device == "" {
		e.Device = n.device
	}
}

func (n *Notifier) signal() {
	select {
	case n.wake <- struct{}{}:
	default:
	}
}

// dispatch is the single consumer of the queue.
func (n *Notifier) dispatch() {
	defer close(n.done)
	for {
		n.mu.Lock()
		for len(n.queue) == 0 {
			if n.closed {
				n.mu.Unlock()
				return
			}
			n.mu.Unlock()
			select {
			case <-n.wake:
			case <-n.ctx.Done():
				return
			}
			n.mu.Lock()
		}
		if n.ctx.Err() != nil { // Close gave up; leftovers are counted there
			n.mu.Unlock()
			return
		}
		e := n.queue[0]
		copy(n.queue, n.queue[1:])
		n.queue = n.queue[:len(n.queue)-1]
		ts := n.targets
		n.mu.Unlock()

		n.deliver(n.ctx, ts, e)
	}
}

// deliver sends e to every matching target concurrently (with webhook
// retries) and waits for all of them.
func (n *Notifier) deliver(ctx context.Context, ts *targetSet, e Event) {
	var wg sync.WaitGroup
	for _, w := range ts.webhooks {
		if !w.wants(e.Type) {
			continue
		}
		wg.Go(func() { n.record(w.label, e, n.sendWebhook(ctx, w, e, true)) })
	}
	for _, s := range ts.snmp {
		wg.Go(func() { n.record(s.label, e, n.sendTrap(ctx, s, e)) })
	}
	wg.Wait()
}

// record updates the counters for one per-target delivery outcome.
func (n *Notifier) record(label string, e Event, err error) {
	if err == nil {
		n.sent.Add(1)
		n.log.Debug("notification delivered", "target", label, "type", e.Type, "id", e.ID)
		return
	}
	n.failed.Add(1)
	msg := label + ": " + err.Error()
	n.mu.Lock()
	n.lastError = msg
	n.mu.Unlock()
	n.log.Warn("notification failed", "target", label, "type", e.Type, "id", e.ID, "err", err)
}

// Close stops accepting events and drains the queue, waiting at most the
// drain timeout (10 s); after that in-flight deliveries and retry back-offs
// are aborted and whatever is still queued is counted as Dropped. Close is
// idempotent.
func (n *Notifier) Close() {
	n.closeOnce.Do(func() {
		n.mu.Lock()
		n.closed = true
		n.mu.Unlock()
		n.signal()

		t := time.NewTimer(n.opts.drainTimeout)
		defer t.Stop()
		select {
		case <-n.done:
		case <-t.C:
			n.log.Warn("notification drain timed out, aborting in-flight deliveries")
			n.cancel()
			<-n.done
		}
		n.cancel()

		n.mu.Lock()
		if left := len(n.queue); left > 0 {
			n.dropped.Add(int64(left))
			n.log.Warn("notification events dropped at close", "count", left)
		}
		n.queue = nil
		n.mu.Unlock()
	})
}

// Stats returns a snapshot of the delivery counters.
func (n *Notifier) Stats() Stats {
	n.mu.Lock()
	last := n.lastError
	n.mu.Unlock()
	return Stats{Sent: n.sent.Load(), Failed: n.failed.Load(), Dropped: n.dropped.Load(), LastError: last}
}

// Test synchronously sends a "test" event (severity info, active) to every
// configured target, ignoring webhook type filters and without retries. The
// result has one entry per target — webhooks first, then SNMP targets, in
// config order — nil meaning delivered (for SNMP: handed to the network, as
// traps are unacknowledged). Outcomes also count in Stats.
func (n *Notifier) Test(ctx context.Context) []error {
	n.mu.Lock()
	ts := n.targets
	e := Event{
		Type:     "test",
		Severity: "info",
		Active:   true,
		Message:  "StreamHub Encoder notification test",
	}
	n.fill(&e)
	n.mu.Unlock()

	errs := make([]error, len(ts.webhooks)+len(ts.snmp))
	var wg sync.WaitGroup
	for i, w := range ts.webhooks {
		wg.Go(func() {
			err := n.sendWebhook(ctx, w, e, false)
			n.record(w.label, e, err)
			if err != nil {
				errs[i] = fmt.Errorf("%s: %w", w.label, err)
			}
		})
	}
	for i, s := range ts.snmp {
		j := len(ts.webhooks) + i
		wg.Go(func() {
			err := n.sendTrap(ctx, s, e)
			n.record(s.label, e, err)
			if err != nil {
				errs[j] = fmt.Errorf("%s: %w", s.label, err)
			}
		})
	}
	wg.Wait()
	return errs
}

// newID returns a random 128-bit hex identifier.
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand never fails on supported platforms; keep a unique-ish fallback.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// errConfig marks a target whose configuration is invalid.
var errConfig = errors.New("invalid target config")
