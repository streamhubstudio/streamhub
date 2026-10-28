package opencamsim

import (
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/fleet"
)

// MemBroker is an in-memory MQTT broker for tests: topic filters with + and
// #, retained messages (an empty retained payload clears), LWT, and ordered
// asynchronous delivery per client. No sockets.
type MemBroker struct {
	mu       sync.Mutex
	retained map[string][]byte
	clients  map[*memClient]bool
}

// NewBroker builds an empty broker.
func NewBroker() *MemBroker {
	return &MemBroker{retained: map[string][]byte{}, clients: map[*memClient]bool{}}
}

type delivery struct {
	topic    string
	payload  []byte
	retained bool
}

type memSub struct {
	filter string
	h      func(topic string, payload []byte, retained bool)
}

type memClient struct {
	b         *MemBroker
	mu        sync.Mutex
	subs      []memSub
	q         chan delivery
	done      chan struct{}
	lwtTopic  string
	lwtBody   []byte
	connected bool
	closeOnce sync.Once
}

func (b *MemBroker) newClient(lwtTopic string, lwt []byte) *memClient {
	c := &memClient{b: b, q: make(chan delivery, 4096), done: make(chan struct{}), lwtTopic: lwtTopic, lwtBody: lwt, connected: true}
	b.mu.Lock()
	b.clients[c] = true
	b.mu.Unlock()
	go func() {
		for {
			select {
			case d := <-c.q:
				c.mu.Lock()
				subs := append([]memSub(nil), c.subs...)
				c.mu.Unlock()
				for _, s := range subs {
					if Match(s.filter, d.topic) {
						s.h(d.topic, d.payload, d.retained)
					}
				}
			case <-c.done:
				return
			}
		}
	}()
	return c
}

func (c *memClient) subscribe(filter string, h func(string, []byte, bool)) {
	c.mu.Lock()
	c.subs = append(c.subs, memSub{filter, h})
	c.mu.Unlock()
	c.b.mu.Lock()
	var replay []delivery
	for t, p := range c.b.retained {
		if Match(filter, t) {
			replay = append(replay, delivery{t, p, true})
		}
	}
	c.b.mu.Unlock()
	// deliver only to this filter's handler (a real broker replays per subscription)
	go func() {
		for _, d := range replay {
			h(d.topic, d.payload, true)
		}
	}()
}

func (c *memClient) publish(topic string, payload []byte, retain bool) {
	b := c.b
	b.mu.Lock()
	if retain {
		if len(payload) == 0 {
			delete(b.retained, topic)
		} else {
			b.retained[topic] = append([]byte(nil), payload...)
		}
	}
	targets := make([]*memClient, 0, len(b.clients))
	for cl := range b.clients {
		targets = append(targets, cl)
	}
	b.mu.Unlock()
	for _, cl := range targets {
		select {
		case cl.q <- delivery{topic, append([]byte(nil), payload...), false}:
		case <-cl.done:
		}
	}
}

// close disconnects; abrupt=true fires the LWT (like a dropped TCP session).
func (c *memClient) close(abrupt bool) {
	c.closeOnce.Do(func() {
		c.b.mu.Lock()
		delete(c.b.clients, c)
		c.b.mu.Unlock()
		c.mu.Lock()
		c.connected = false
		c.mu.Unlock()
		close(c.done)
		if abrupt && c.lwtTopic != "" {
			(&memClient{b: c.b}).publish(c.lwtTopic, c.lwtBody, true)
		}
	})
}

// Retained returns a copy of a retained payload (nil = none).
func (b *MemBroker) Retained(topic string) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	if p, ok := b.retained[topic]; ok {
		return append([]byte(nil), p...)
	}
	return nil
}

// Subscribe observes messages from outside any client (tests).
func (b *MemBroker) Subscribe(filter string, h func(topic string, payload []byte)) {
	b.newClient("", nil).subscribe(filter, func(t string, p []byte, _ bool) { h(t, p) })
}

// Publish injects a message from outside any client.
func (b *MemBroker) Publish(topic string, payload []byte, retain bool) {
	(&memClient{b: b}).publish(topic, payload, retain)
}

// --- the device side: Dialer -------------------------------------------------

type memConn struct{ c *memClient }

func (m memConn) Publish(topic string, payload []byte, retain bool) {
	m.c.publish(topic, payload, retain)
}
func (m memConn) Subscribe(filter string, h func(topic string, payload []byte)) {
	m.c.subscribe(filter, func(t string, p []byte, _ bool) { h(t, p) })
}
func (m memConn) Close(abrupt bool) { m.c.close(abrupt) }

// Dialer returns a device Dialer bound to the broker.
func (b *MemBroker) Dialer() Dialer {
	return func(_ string, lwtTopic string, lwt []byte) (Conn, error) {
		return memConn{b.newClient(lwtTopic, lwt)}, nil
	}
}

// --- the service side: fleet.Factory ----------------------------------------

type fleetClient struct {
	b  *MemBroker
	c  *memClient
	ev fleet.Events
	mu sync.Mutex
}

// Factory returns a fleet.Factory whose clients live on this broker
// (connected immediately: OnConnect fires from Start).
func (b *MemBroker) Factory() fleet.Factory {
	return func(fleet.ConnectOptions) (fleet.Client, error) {
		return &fleetClient{b: b}, nil
	}
}

func (f *fleetClient) Start(ev fleet.Events) {
	f.mu.Lock()
	f.ev = ev
	f.c = f.b.newClient("", nil)
	f.mu.Unlock()
	if ev.OnConnect != nil {
		go ev.OnConnect()
	}
}

func (f *fleetClient) Connected() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.c != nil && f.c.connected
}

func (f *fleetClient) Subscribe(topics []string, _ byte, done func(error)) {
	f.mu.Lock()
	c, ev := f.c, f.ev
	f.mu.Unlock()
	for _, t := range topics {
		c.subscribe(t, func(topic string, payload []byte, retained bool) {
			switch {
			case ev.OnMessageRetained != nil:
				ev.OnMessageRetained(topic, payload, retained)
			case ev.OnMessage != nil:
				ev.OnMessage(topic, payload)
			}
		})
	}
	if done != nil {
		done(nil)
	}
}

func (f *fleetClient) Publish(topic string, payload []byte, _ byte, retain bool, done func(error)) {
	f.mu.Lock()
	c := f.c
	f.mu.Unlock()
	c.publish(topic, payload, retain)
	if done != nil {
		done(nil)
	}
}

func (f *fleetClient) SetReconnectPeriod(time.Duration) {}

func (f *fleetClient) End() {
	f.mu.Lock()
	c := f.c
	f.mu.Unlock()
	if c != nil {
		c.close(false)
	}
}

// Match reports whether an MQTT topic filter (+, #) matches topic.
func Match(filter, topic string) bool {
	fp := strings.Split(filter, "/")
	tp := strings.Split(topic, "/")
	for i, f := range fp {
		if f == "#" {
			return true
		}
		if i >= len(tp) {
			return false
		}
		if f != "+" && f != tp[i] {
			return false
		}
	}
	return len(fp) == len(tp)
}
