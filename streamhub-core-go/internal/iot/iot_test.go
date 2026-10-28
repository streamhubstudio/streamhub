package iot

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/fleet"
)

var bg = context.Background()

const app = "live"

type fakeClient struct {
	ev         fleet.Events
	subscribed []string
	ended      bool
}

func (f *fakeClient) Start(ev fleet.Events)                           { f.ev = ev }
func (f *fakeClient) Connected() bool                                 { return true }
func (f *fakeClient) Subscribe(t []string, _ byte, done func(error))  { f.subscribed = t; done(nil) }
func (f *fakeClient) Publish(string, []byte, byte, bool, func(error)) {}
func (f *fakeClient) SetReconnectPeriod(time.Duration)                {}
func (f *fakeClient) End()                                            { f.ended = true }

type fakeApps struct{ mqtt contracts.MqttConfig }

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	return []contracts.AppRecord{{Name: app}}, nil
}
func (f *fakeApps) Get(context.Context, string) (*contracts.AppRecord, error) { return nil, nil }
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	return &contracts.AppConfig{Mqtt: f.mqtt}, nil
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (f *fakeApps) AppDir(string) string { return "" }

type call struct {
	app, event string
	payload    string
}

type fakeCallbacks struct {
	mu    sync.Mutex
	calls []call
	done  chan struct{}
}

func (f *fakeCallbacks) Dispatch(_ context.Context, app, event string, payload any) error {
	b, _ := json.Marshal(payload)
	f.mu.Lock()
	f.calls = append(f.calls, call{app, event, string(b)})
	f.mu.Unlock()
	f.done <- struct{}{}
	return nil
}

type fixture struct {
	svc     *Service
	dir     string
	apps    *fakeApps
	cb      *fakeCallbacks
	created []*fakeClient
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{dir: t.TempDir(), apps: &fakeApps{mqtt: contracts.MqttConfig{Enabled: true, URL: "mqtt://broker.test:1883"}},
		cb: &fakeCallbacks{done: make(chan struct{}, 8)}}
	f.svc = New(Deps{DataDir: f.dir, Apps: f.apps, Callbacks: func() Callbacks { return f.cb },
		Factory: func(fleet.ConnectOptions) (fleet.Client, error) {
			c := &fakeClient{}
			f.created = append(f.created, c)
			return c, nil
		}})
	t.Cleanup(f.svc.Close)
	return f
}

func (f *fixture) writeConfig(t *testing.T, body string) {
	dir := filepath.Join(f.dir, "apps", app)
	_ = os.MkdirAll(dir, 0o755)
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) next(t *testing.T) call {
	t.Helper()
	select {
	case <-f.cb.done:
	case <-time.After(2 * time.Second):
		t.Fatal("no dispatch")
	}
	f.cb.mu.Lock()
	defer f.cb.mu.Unlock()
	return f.cb.calls[len(f.cb.calls)-1]
}

func TestSubscribesAndRoutesIotData(t *testing.T) {
	f := newFixture(t)
	f.writeConfig(t, "mqtt:\n  subscribe:\n    - topic: sensors/+/temp\n    - topic: \"devices/#\"\n    - sensors/+/temp\n")
	topics := f.svc.EnsureForApp(bg, app)
	if !reflect.DeepEqual(topics, []string{"sensors/+/temp", "devices/#"}) || len(f.created) != 1 ||
		!reflect.DeepEqual(f.created[0].subscribed, topics) {
		t.Fatalf("%v", topics)
	}
	c := f.created[0]
	c.ev.OnMessage("sensors/a/temp", []byte(`{"c":22,"a":[1]}`))
	if got := f.next(t); got.event != "iot.data" || got.app != app || got.payload != `{"topic":"sensors/a/temp","data":{"c":22,"a":[1]},"source":"mqtt"}` {
		t.Fatalf("%+v", got)
	}
	c.ev.OnMessage("devices/x", []byte("hello"))
	if got := f.next(t); got.payload != `{"topic":"devices/x","data":"hello","source":"mqtt"}` {
		t.Fatalf("%+v", got)
	}
	// Bounded body: an oversize non-JSON payload is truncated to 64 KiB.
	c.ev.OnMessage("devices/big", []byte(strings.Repeat("x", MaxMessageBytes+10)))
	var ev struct{ Data string }
	_ = json.Unmarshal([]byte(f.next(t).payload), &ev)
	if len(ev.Data) != MaxMessageBytes {
		t.Fatal(len(ev.Data))
	}
	// Same config → same client.
	f.svc.EnsureForApp(bg, app)
	if len(f.created) != 1 {
		t.Fatal("client recreated")
	}
}

func TestNoSubscribeListNoClient(t *testing.T) {
	f := newFixture(t)
	f.writeConfig(t, "mqtt:\n  enabled: true\n")
	if f.svc.EnsureForApp(bg, app) != nil || len(f.created) != 0 {
		t.Fatal("no client expected")
	}
	g := newFixture(t) // no config.yaml at all
	if g.svc.EnsureForApp(bg, app) != nil || len(g.created) != 0 {
		t.Fatal("no client expected")
	}
}

func TestDropsWhenMqttDisabled(t *testing.T) {
	f := newFixture(t)
	f.writeConfig(t, "mqtt:\n  subscribe:\n    - topic: a/b\n")
	f.svc.EnsureForApp(bg, app)
	f.apps.mqtt.Enabled = false
	if f.svc.EnsureForApp(bg, app) != nil || !f.created[0].ended {
		t.Fatal("subscriber must be dropped")
	}
}

func TestIgnoresInvalidEntries(t *testing.T) {
	f := newFixture(t)
	f.writeConfig(t, "mqtt:\n  subscribe:\n    - topic: \"bad topic\"\n    - nope: 1\n    - topic: good/one\n    - 5\n    - topic: \"tab\\tx\"\n    - topic: \""+strings.Repeat("a", 257)+"\"\n")
	if got := f.svc.EnsureForApp(bg, app); !reflect.DeepEqual(got, []string{"good/one"}) {
		t.Fatal(got)
	}
	var b strings.Builder
	b.WriteString("mqtt:\n  subscribe:\n")
	for i := 0; i < 70; i++ {
		b.WriteString("    - t/" + strings.Repeat("x", i+1) + "\n")
	}
	f.writeConfig(t, b.String())
	if got := f.svc.ReadSubscriptions(app); len(got) != MaxSubscriptions {
		t.Fatal(len(got))
	}
}

func TestMalformedMessageNeverFails(t *testing.T) {
	f := newFixture(t)
	f.svc.OnMessage(app, "", "x")
	select {
	case <-f.cb.done:
		t.Fatal("empty topic must not dispatch")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestFactoryRejectionKeepsNoClient(t *testing.T) {
	f := newFixture(t)
	f.writeConfig(t, "mqtt:\n  subscribe:\n    - a/b\n")
	f.svc.factory = func(fleet.ConnectOptions) (fleet.Client, error) { return nil, errors.New("unsafe") }
	if got := f.svc.EnsureForApp(bg, app); len(got) != 1 {
		t.Fatal(got)
	}
	f.svc.mu.Lock()
	n := len(f.svc.subs)
	f.svc.mu.Unlock()
	if n != 0 {
		t.Fatal("no subscriber kept on factory error")
	}
}
