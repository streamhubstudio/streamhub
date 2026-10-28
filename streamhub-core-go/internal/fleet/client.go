package fleet

import (
	"errors"
	"sync"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/mqtt"
)

// Port of fleet-mqtt.factory.ts: the ONE seam between the subscribe-side
// services (fleet, iot) and the MQTT library. The publish-only mqtt.Client
// deliberately lacks subscribe + inbound messages, so this surface is a bit
// richer. Tests bind a fake Factory: nothing in a suite opens a socket.

// Events are the client lifecycle callbacks (mqtt.js 'connect' / 'message' /
// 'close' / 'error').
type Events struct {
	OnConnect func()
	OnMessage func(topic string, payload []byte)
	// OnMessageRetained, when set, is called instead of OnMessage with the
	// MQTT retain flag (cameras tells a retained replay from live traffic).
	OnMessageRetained func(topic string, payload []byte, retained bool)
	OnClose           func()
	OnError           func(error)
}

// Client is FleetMqttClientLike.
type Client interface {
	// Start attaches the handlers and begins connecting (mqtt.connect + the
	// synchronous .on(...) wiring in Node).
	Start(ev Events)
	Connected() bool
	Subscribe(topics []string, qos byte, done func(error))
	Publish(topic string, payload []byte, qos byte, retain bool, done func(error))
	// SetReconnectPeriod is read when the next reconnect is scheduled
	// (client.options.reconnectPeriod), which implements the backoff.
	SetReconnectPeriod(d time.Duration)
	// End force-closes the client and stops reconnecting.
	End()
}

// ConnectOptions is FleetMqttConnectOptions.
type ConnectOptions struct {
	URL             string
	Username        string
	Password        string
	TLS             bool
	ClientID        string
	ReconnectPeriod time.Duration
	ConnectTimeout  time.Duration
	// OrderMatters delivers inbound messages sequentially, in arrival order
	// (paho SetOrderMatters); handlers must then never block.
	OrderMatters bool
}

// Factory builds a client; an error (unsafe broker URL) keeps no client.
type Factory func(opts ConnectOptions) (Client, error)

// DefaultFactory is the production factory: paho with mqtt.js-like
// semantics (clean session, manual reconnect loop whose period the service
// mutates). Reuses the mqtt module's TLS resolution + SSRF guard.
func DefaultFactory(opts ConnectOptions) (Client, error) {
	target := mqtt.ResolveBrokerURL(opts.URL, opts.TLS)
	if err := mqtt.AssertSafeBrokerURL(target); err != nil {
		return nil, err
	}
	return &pahoClient{target: target, opts: opts, period: opts.ReconnectPeriod}, nil
}

type pahoClient struct {
	target string
	opts   ConnectOptions
	ev     Events
	c      paho.Client

	mu        sync.Mutex
	period    time.Duration
	connected bool
	ended     bool
	timer     *time.Timer
}

func (p *pahoClient) Start(ev Events) {
	p.ev = ev
	o := paho.NewClientOptions().
		AddBroker(p.target).
		SetClientID(p.opts.ClientID).
		SetCleanSession(true).
		SetAutoReconnect(false).
		SetConnectRetry(false).
		SetConnectTimeout(p.opts.ConnectTimeout).
		SetOrderMatters(p.opts.OrderMatters).
		SetDefaultPublishHandler(func(_ paho.Client, m paho.Message) {
			if p.ev.OnMessageRetained != nil {
				p.ev.OnMessageRetained(m.Topic(), m.Payload(), m.Retained())
			} else if p.ev.OnMessage != nil {
				p.ev.OnMessage(m.Topic(), m.Payload())
			}
		}).
		SetConnectionLostHandler(func(paho.Client, error) { p.lost() })
	if p.opts.Username != "" {
		o.SetUsername(p.opts.Username)
	}
	if p.opts.Password != "" {
		o.SetPassword(p.opts.Password)
	}
	p.c = paho.NewClient(o)
	go p.connect()
}

func (p *pahoClient) connect() {
	tok := p.c.Connect()
	var err error
	if !tok.WaitTimeout(p.opts.ConnectTimeout + time.Second) {
		err = errors.New("connack timeout")
	} else {
		err = tok.Error()
	}
	p.mu.Lock()
	if p.ended {
		p.mu.Unlock()
		if err == nil {
			p.c.Disconnect(0)
		}
		return
	}
	if err != nil {
		p.mu.Unlock()
		if p.ev.OnError != nil {
			p.ev.OnError(err)
		}
		p.closed()
		return
	}
	p.connected = true
	p.mu.Unlock()
	if p.ev.OnConnect != nil {
		p.ev.OnConnect()
	}
}

func (p *pahoClient) lost() {
	p.mu.Lock()
	p.connected = false
	p.mu.Unlock()
	p.closed()
}

func (p *pahoClient) closed() {
	if p.ev.OnClose != nil {
		p.ev.OnClose()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ended {
		return
	}
	p.timer = time.AfterFunc(p.period, p.connect)
}

func (p *pahoClient) Connected() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.connected
}

func (p *pahoClient) Subscribe(topics []string, qos byte, done func(error)) {
	filters := make(map[string]byte, len(topics))
	for _, t := range topics {
		filters[t] = qos
	}
	tok := p.c.SubscribeMultiple(filters, nil)
	go func() {
		tok.Wait()
		if done != nil {
			done(tok.Error())
		}
	}()
}

func (p *pahoClient) Publish(topic string, payload []byte, qos byte, retain bool, done func(error)) {
	if !p.Connected() {
		if done != nil {
			done(errors.New("client disconnecting"))
		}
		return
	}
	tok := p.c.Publish(topic, qos, retain, payload)
	go func() {
		tok.Wait()
		if done != nil {
			done(tok.Error())
		}
	}()
}

func (p *pahoClient) SetReconnectPeriod(d time.Duration) {
	p.mu.Lock()
	p.period = d
	p.mu.Unlock()
}

func (p *pahoClient) End() {
	p.mu.Lock()
	p.ended = true
	if p.timer != nil {
		p.timer.Stop()
	}
	connected := p.connected
	p.connected = false
	p.mu.Unlock()
	if p.c != nil && connected {
		p.c.Disconnect(0)
	}
}
