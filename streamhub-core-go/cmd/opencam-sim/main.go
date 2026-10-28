// Command opencam-sim simulates one or more OpenCam cameras against a real
// MQTT broker, speaking the StreamHub contract (api: 1): retained
// hello/status/state/thumb, events with seq/boot_id, and uniform command
// responses (accepted → progress → done/failed; expired, busy, conflict,
// unsupported). Useful to exercise the Cameras Studio App without hardware,
// and to the firmware developer as a reference of the expected behaviour.
//
//	opencam-sim -broker mqtt://localhost:1883 -devices stand-01,stand-02
//	opencam-sim -broker mqtt://localhost:1883 -n 4 -prefix sim- -state 5s
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/cameras/opencamsim"
)

func main() {
	broker := flag.String("broker", "mqtt://127.0.0.1:1883", "MQTT broker URL (mqtt:// tcp:// mqtts:// ssl:// ws:// wss://)")
	user := flag.String("user", "", "broker username")
	pass := flag.String("pass", "", "broker password")
	root := flag.String("root", "opencam", "topic root (mqtt.base_topic = <root>/%device)")
	devices := flag.String("devices", "", "comma-separated device ids")
	n := flag.Int("n", 0, "simulate N devices named <prefix>01..N (when -devices is empty)")
	prefix := flag.String("prefix", "sim-", "device id prefix for -n")
	state := flag.Duration("state", 10*time.Second, "state publish interval")
	rebootDelay := flag.Duration("reboot-delay", 3*time.Second, "how long a reboot keeps the camera offline")
	noPTZ := flag.Bool("no-ptz", false, "simulate a model without PTZ (caps without 'ptz')")
	silent := flag.String("silent", "", "comma-separated commands the cameras never answer (timeout tests)")
	fw := flag.String("fw", "0.3.0-sim", "firmware version reported in hello")
	flag.Parse()

	ids := []string{}
	for _, d := range strings.Split(*devices, ",") {
		if d = strings.TrimSpace(d); d != "" {
			ids = append(ids, d)
		}
	}
	if len(ids) == 0 {
		if *n <= 0 {
			*n = 1
		}
		for i := 1; i <= *n; i++ {
			ids = append(ids, fmt.Sprintf("%s%02d", *prefix, i))
		}
	}
	caps := opencamsim.DefaultCaps
	if *noPTZ {
		caps = []string{}
		for _, c := range opencamsim.DefaultCaps {
			if c != "ptz" {
				caps = append(caps, c)
			}
		}
	}
	quiet := map[string]bool{}
	for _, c := range strings.Split(*silent, ",") {
		if c = strings.TrimSpace(c); c != "" {
			quiet[c] = true
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dial := pahoDialer(normalizeBroker(*broker), *user, *pass)
	var wg sync.WaitGroup
	for _, id := range ids {
		dev := opencamsim.New(opencamsim.Options{
			Device: id, Root: *root, Fw: *fw, Caps: caps, StateInterval: *state, RebootDelay: *rebootDelay, Silent: quiet,
			Logf: log.Printf,
		}, dial)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := dev.Run(ctx); err != nil {
				log.Printf("%s: %v", id, err)
			}
		}()
	}
	log.Printf("simulating %d camera(s) on %s under %s/: %s", len(ids), *broker, *root, strings.Join(ids, ", "))
	wg.Wait()
}

func normalizeBroker(u string) string {
	switch {
	case strings.HasPrefix(u, "mqtt://"):
		return "tcp://" + strings.TrimPrefix(u, "mqtt://")
	case strings.HasPrefix(u, "mqtts://"):
		return "ssl://" + strings.TrimPrefix(u, "mqtts://")
	}
	return u
}

type pahoConn struct {
	c paho.Client
}

func (p pahoConn) Publish(topic string, payload []byte, retain bool) {
	p.c.Publish(topic, 1, retain, payload).WaitTimeout(5 * time.Second)
}

// Subscribe hands messages to one worker goroutine: commands run in arrival
// order (a ptz/stop never overtakes the ptz/dir before it) and the handler
// may publish without blocking paho's router.
func (p pahoConn) Subscribe(filter string, h func(topic string, payload []byte)) {
	q := make(chan paho.Message, 256)
	go func() {
		for m := range q {
			h(m.Topic(), m.Payload())
		}
	}()
	p.c.Subscribe(filter, 1, func(_ paho.Client, m paho.Message) {
		select {
		case q <- m:
		default: // overloaded: drop (the command expires on the server side)
		}
	}).WaitTimeout(5 * time.Second)
}

// Close: paho cannot drop the TCP session without a DISCONNECT (which
// suppresses the LWT), so an abrupt close publishes the LWT payload itself.
func (p pahoConn) Close(abrupt bool) {
	p.c.Disconnect(100)
}

func pahoDialer(broker, user, pass string) opencamsim.Dialer {
	return func(clientID, lwtTopic string, lwt []byte) (opencamsim.Conn, error) {
		o := paho.NewClientOptions().AddBroker(broker).SetClientID(clientID).SetCleanSession(true).
			SetAutoReconnect(false).SetConnectTimeout(10*time.Second).SetWill(lwtTopic, string(lwt), 1, true)
		if user != "" {
			o.SetUsername(user)
		}
		if pass != "" {
			o.SetPassword(pass)
		}
		var conn pahoConn
		o.SetOnConnectHandler(func(paho.Client) {})
		c := paho.NewClient(o)
		tok := c.Connect()
		if !tok.WaitTimeout(15 * time.Second) {
			return nil, errors.New("connect timeout")
		}
		if err := tok.Error(); err != nil {
			return nil, err
		}
		conn.c = c
		return lwtOnAbrupt{conn, lwtTopic, lwt}, nil
	}
}

type lwtOnAbrupt struct {
	pahoConn
	topic string
	lwt   []byte
}

func (l lwtOnAbrupt) Close(abrupt bool) {
	if abrupt {
		l.pahoConn.Publish(l.topic, l.lwt, true)
	}
	l.pahoConn.Close(abrupt)
}
