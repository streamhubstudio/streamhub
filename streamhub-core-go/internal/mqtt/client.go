package mqtt

import (
	"errors"
	"os"
	"regexp"
	"sync"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// The ONE seam between the service and the MQTT library (mqtt-client.factory.ts):
// the service only talks to Client, so tests bind a fake Factory and nothing
// in the suite can open a socket.

// Client is the slice of an mqtt.js client the service uses.
type Client interface {
	// Publish is fire-and-forget; done (optional) receives the outcome.
	Publish(topic string, payload []byte, qos byte, retain bool, done func(error))
	// SetReconnectPeriod is read each time the next reconnect is scheduled
	// (mqtt.js options.reconnectPeriod), which implements the backoff.
	SetReconnectPeriod(d time.Duration)
	// End force-closes the client and stops reconnecting.
	End()
}

// Events are the client lifecycle callbacks (mqtt.js 'connect'/'close'/'error').
type Events struct {
	OnConnect func()
	OnClose   func()
	OnError   func(error)
}

// ConnectOptions are resolved from the app's mqtt: block.
type ConnectOptions struct {
	URL      string
	Username string
	Password string
	// TLS forces mqtt://→mqtts:// and ws://→wss:// before connecting.
	TLS             bool
	ClientID        string
	ReconnectPeriod time.Duration
	ConnectTimeout  time.Duration
}

// Factory builds a client; it may return an error (no client is kept).
type Factory func(opts ConnectOptions, ev Events) (Client, error)

var (
	mqttScheme = regexp.MustCompile(`(?i)^mqtt://`)
	tcpScheme  = regexp.MustCompile(`(?i)^tcp://`)
	wsScheme   = regexp.MustCompile(`(?i)^ws://`)
)

// ResolveBrokerURL applies the tls flag by upgrading plaintext schemes.
func ResolveBrokerURL(url string, tls bool) string {
	trimmed := yamljs.Trim(url)
	if !tls {
		return trimmed
	}
	trimmed = mqttScheme.ReplaceAllString(trimmed, "mqtts://")
	trimmed = tcpScheme.ReplaceAllString(trimmed, "mqtts://")
	return wsScheme.ReplaceAllString(trimmed, "wss://")
}

// AssertSafeBrokerURL is the synchronous factory-level SSRF check: scheme
// allowlist + private IP-literal rejection (hostnames are DNS-checked by the
// async guard in the service). STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER=1 skips
// only the private-address check, never the scheme allowlist.
func AssertSafeBrokerURL(url string) error {
	return security.AssertSafeEgressURLSync(url, security.EgressOptions{
		AllowedSchemes: security.MQTTSchemes,
		Label:          "MQTT broker URL",
		AllowPrivate:   security.EnvFlag(os.Getenv(security.AllowPrivateMQTTBrokerEnv)),
	})
}

// DefaultFactory connects with paho, reproducing mqtt.js semantics: lazy
// connect, offline queue flushed on connect, and a reconnect loop whose
// period the service mutates for backoff.
func DefaultFactory(opts ConnectOptions, ev Events) (Client, error) {
	target := ResolveBrokerURL(opts.URL, opts.TLS)
	if err := AssertSafeBrokerURL(target); err != nil {
		return nil, err
	}
	c := &pahoClient{ev: ev, period: opts.ReconnectPeriod, timeout: opts.ConnectTimeout}
	o := paho.NewClientOptions().
		AddBroker(target).
		SetClientID(opts.ClientID).
		SetCleanSession(true).
		SetAutoReconnect(false).
		SetConnectRetry(false).
		SetConnectTimeout(opts.ConnectTimeout).
		SetOrderMatters(false).
		SetConnectionLostHandler(func(paho.Client, error) { c.lost() })
	if opts.Username != "" {
		o.SetUsername(opts.Username)
	}
	if opts.Password != "" {
		o.SetPassword(opts.Password)
	}
	c.c = paho.NewClient(o)
	go c.connect()
	return c, nil
}

type queued struct {
	topic   string
	payload []byte
	qos     byte
	retain  bool
	done    func(error)
}

// maxOffline bounds the offline queue (mqtt.js queues without a bound).
const maxOffline = 1000

type pahoClient struct {
	c       paho.Client
	ev      Events
	timeout time.Duration

	mu        sync.Mutex
	period    time.Duration
	connected bool
	ended     bool
	queue     []queued
	timer     *time.Timer
}

func (p *pahoClient) connect() {
	tok := p.c.Connect()
	var err error
	if !tok.WaitTimeout(p.timeout + time.Second) {
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
	pending := p.queue
	p.queue = nil
	p.mu.Unlock()
	if p.ev.OnConnect != nil {
		p.ev.OnConnect()
	}
	for _, q := range pending {
		p.send(q)
	}
}

func (p *pahoClient) lost() {
	p.mu.Lock()
	p.connected = false
	p.mu.Unlock()
	p.closed()
}

// closed emits 'close' then schedules the next attempt with the period the
// close handler may just have changed.
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

func (p *pahoClient) send(q queued) {
	tok := p.c.Publish(q.topic, q.qos, q.retain, q.payload)
	if q.done == nil {
		return
	}
	go func() {
		tok.Wait()
		q.done(tok.Error())
	}()
}

func (p *pahoClient) Publish(topic string, payload []byte, qos byte, retain bool, done func(error)) {
	q := queued{topic, payload, qos, retain, done}
	p.mu.Lock()
	if p.ended {
		p.mu.Unlock()
		if done != nil {
			done(errors.New("client disconnecting"))
		}
		return
	}
	if !p.connected {
		if len(p.queue) < maxOffline {
			p.queue = append(p.queue, q)
		}
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	p.send(q)
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
	p.queue = nil
	p.mu.Unlock()
	p.c.Disconnect(0)
}
