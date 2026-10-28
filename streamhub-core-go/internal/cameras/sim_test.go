package cameras

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/cameras/opencamsim"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// The service against the simulator over the in-memory broker: the whole
// contract end to end with no sockets (retained replay, LWT, phases,
// deadman, busy, expired, conflict, unsupported).

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type simEnv struct {
	f      *fixture
	broker *opencamsim.MemBroker
	dev    *opencamsim.Device
	cancel context.CancelFunc
}

func newSimEnv(t *testing.T, o opencamsim.Options) *simEnv {
	b := opencamsim.NewBroker()
	f := newFixture(t, b.Factory(), true)
	if o.Device == "" {
		o.Device = "stand-02"
	}
	o.RebootDelay = 200 * time.Millisecond
	o.StepDelay = 50 * time.Millisecond
	o.StateInterval = time.Hour
	dev := opencamsim.New(o, b.Dialer())
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = dev.Run(ctx) }()
	// the camera boots BEFORE the core subscribes: everything arrives as a
	// retained replay
	eventually(t, "retained hello", func() bool { return b.Retained("opencam/"+o.Device+"/hello") != nil })
	if _, _, err := f.svc.EnsureForApp(bg, app); err != nil {
		t.Fatal(err)
	}
	return &simEnv{f, b, dev, cancel}
}

func (e *simEnv) camera(t *testing.T) CameraView {
	t.Helper()
	d, err := e.f.svc.Get(bg, app, "stand-02")
	if err != nil {
		t.Fatal(err)
	}
	if d == nil { // not ingested yet
		return CameraView{Summary: CameraSummary{}}
	}
	return d.Camera
}

func TestSimInventoryAndCommands(t *testing.T) {
	e := newSimEnv(t, opencamsim.Options{})
	svc := e.f.svc
	eventually(t, "online + hello + state + thumb", func() bool {
		d, _ := svc.Get(bg, app, "stand-02")
		return d != nil && d.Camera.Online && d.Camera.Fw != nil && d.Camera.State != nil && d.Camera.ThumbAt != nil
	})
	c := e.camera(t)
	if *c.API != 1 || !c.CapsKnown || !contains(c.Caps, "ptz") || *c.Summary.PtzPreset != 2 || *c.Summary.StreamSource != 1 {
		t.Fatalf("%+v", c.Summary)
	}

	// short command: done with a result
	row, err := svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "snapshot/take", Wait: 3 * time.Second})
	if err != nil || row.Status != "done" || row.Result.(*y.Map).Get("ok") != true {
		t.Fatal(row, err)
	}
	// preset goto: the camera moves, then answers done with its position
	row, _ = svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "ptz/preset", Args: obj(t, `{"preset":1}`), Wait: 3 * time.Second})
	if row.Status != "done" || row.Result.(*y.Map).Get("x") != 1200.0 {
		t.Fatal(row)
	}
	eventually(t, "state preset 1", func() bool { p := e.camera(t).Summary.PtzPreset; return p != nil && *p == 1 })
	// bad preset → failed bad_request
	row, _ = svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "ptz/preset", Args: obj(t, `{"preset":99}`), Wait: 3 * time.Second})
	if row.Status != "failed" || *row.Code != "bad_request" {
		t.Fatal(row)
	}
	// config: stale if_rev → conflict; current → done (and config_rev bumps)
	stale := 0.0
	row, _ = svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "config/import", Args: obj(t, `{"config":{"ptz":{"home_after_s":30}}}`), IfRev: &stale, Wait: 3 * time.Second})
	if row.Status != "failed" || *row.Code != "conflict" {
		t.Fatal(row)
	}
	row, _ = svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "config/import", Args: obj(t, `{"config":{"ptz":{"home_after_s":30}}}`), Wait: 3 * time.Second})
	if row.Status != "done" {
		t.Fatal(row)
	}
	eventually(t, "config_rev 2", func() bool { r := e.camera(t).Summary.ConfigRev; return r != nil && *r == 2 })
	// stream stop/start reflected in state + events
	if row, _ = svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "stream/stop", Wait: 3 * time.Second}); row.Status != "done" {
		t.Fatal(row)
	}
	eventually(t, "stream stopped", func() bool { r := e.camera(t).Summary.StreamRunning; return r != nil && !*r })
	evs, _ := svc.Events(bg, app, "stand-02", EventQuery{Src: "stream"})
	if len(evs) == 0 || *evs[0].Event != "stopped" {
		t.Fatal(evs)
	}
	// HD: stream/set {source:0}
	if _, until, err := svc.SetHD(bg, app, "stand-02", true, 1, ""); err != nil || until == nil {
		t.Fatal(err)
	}
	eventually(t, "main stream", func() bool { return e.dev.Source() == 0 })
	if _, _, err := svc.SetHD(bg, app, "stand-02", false, 0, ""); err != nil {
		t.Fatal(err)
	}
	eventually(t, "sub stream", func() bool { return e.dev.Source() == 1 })
}

func TestSimPTZDeadman(t *testing.T) {
	e := newSimEnv(t, opencamsim.Options{})
	svc := e.f.svc
	eventually(t, "online", func() bool { return e.camera(t).Online })
	x0 := *e.camera(t).Summary.PtzX
	move := func() {
		if _, err := svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "ptz/dir", Args: obj(t, `{"dir":"right","speed":5,"hold_ms":300}`)}); err != nil {
			t.Fatal(err)
		}
	}
	move()
	eventually(t, "moving", e.dev.Moving)
	// the pad repeats while held…
	for i := 0; i < 3; i++ {
		time.Sleep(150 * time.Millisecond)
		move()
		if !e.dev.Moving() {
			t.Fatal("stopped while held")
		}
	}
	// …and the deadman stops it once the repeats stop (no ptz/stop sent)
	eventually(t, "deadman stop", func() bool { return !e.dev.Moving() })
	eventually(t, "moved right", func() bool { x := e.camera(t).Summary.PtzX; return x != nil && *x > x0 })
	evs, _ := svc.Events(bg, app, "stand-02", EventQuery{Src: "ptz"})
	if len(evs) < 2 || *evs[0].Event != "stopped" {
		t.Fatal(evs)
	}
	// explicit stop while moving
	move()
	eventually(t, "moving again", e.dev.Moving)
	if row, _ := svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "ptz/stop", Wait: 3 * time.Second}); row.Status != "done" || e.dev.Moving() {
		t.Fatal(row)
	}
}

func TestSimRebootBusyAndUpgrade(t *testing.T) {
	e := newSimEnv(t, opencamsim.Options{})
	svc := e.f.svc
	eventually(t, "online", func() bool { return e.camera(t).Online })
	boot0 := e.dev.BootID()

	row, err := svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "system/reboot", Args: obj(t, `{"reason":"test"}`), Confirm: true, Wait: 3 * time.Second})
	if err != nil || row.Status != "accepted" {
		t.Fatal(row, err)
	}
	// a second long command while rebooting → busy
	busy, _ := svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "reboot", Confirm: true, Wait: 3 * time.Second})
	if busy.Status != "failed" || *busy.Code != "busy" {
		t.Fatal(busy)
	}
	eventually(t, "LWT offline", func() bool { return e.camera(t).Status == "offline" })
	eventually(t, "back online", func() bool { return e.camera(t).Online && e.dev.BootID() != boot0 })
	eventually(t, "reboot done", func() bool {
		r, _ := svc.GetCommand(bg, app, "stand-02", row.ID)
		return r.Status == "done"
	})
	eventually(t, "state after reboot", func() bool {
		c := e.camera(t)
		return *c.BootID != boot0 && c.Summary.LastRebootReason != nil && *c.Summary.LastRebootReason == "test"
	})

	// OTA: accepted → progress (pct) → reboot with the new fw → done
	up, _ := svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "firmware/upgrade", Confirm: true,
		Args: obj(t, `{"url":"https://fw.example.com/oc.bin","sha256":"`+strings.Repeat("c", 64)+`"}`)})
	eventually(t, "progress", func() bool {
		r, _ := svc.GetCommand(bg, app, "stand-02", up.ID)
		return r.Pct != nil && *r.Pct >= 50
	})
	eventually(t, "upgrade done", func() bool {
		r, _ := svc.GetCommand(bg, app, "stand-02", up.ID)
		return r.Status == "done"
	})
	eventually(t, "new fw", func() bool { return *e.camera(t).Fw == "0.3.1-sim" })
	eventually(t, "booted event", func() bool {
		evs, _ := svc.Events(bg, app, "stand-02", EventQuery{Src: "firmware"})
		return len(evs) > 0 && *evs[0].Event == "booted"
	})
}

func TestSimTimeoutUnsupportedAndGap(t *testing.T) {
	e := newSimEnv(t, opencamsim.Options{Silent: map[string]bool{"ini/status": true}, Caps: []string{"sd", "voice"}})
	svc := e.f.svc
	e.f.setEnabled(true, obj(t, `{"commandExpSec":1}`))
	eventually(t, "online", func() bool { return e.camera(t).Online })

	// a model without PTZ: the core refuses before publishing
	if _, err := svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "ptz/home"}); err == nil || !strings.Contains(err.Error(), "does not support") {
		t.Fatal(err)
	}
	// a camera that never answers → timeout after exp + 10 s (swept)
	row, _ := svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "ini/status"})
	if row.ExpSec != 1 {
		t.Fatal(row.ExpSec)
	}
	// unknown to this firmware (allowlisted on the core) → unsupported
	r2, _ := svc.SendCommand(bg, app, "stand-02", CommandRequest{Cmd: "recovery/status", Wait: 3 * time.Second})
	if r2.Status != "failed" || *r2.Code != "unsupported" {
		t.Fatal(r2)
	}
	// expired: a command that sat in a queue past its exp
	expired := make(chan string, 1)
	e.broker.Subscribe("opencam/stand-02/res/status", func(_ string, p []byte) {
		if strings.Contains(string(p), `"late-1"`) {
			expired <- string(p)
		}
	})
	e.broker.Publish("opencam/stand-02/cmd/status", []byte(`{"id":"late-1","ts":"2020-01-01T00:00:00Z","exp":5}`), false)
	select {
	case p := <-expired:
		if !strings.Contains(p, `"code":"expired"`) || !strings.Contains(p, `"phase":"failed"`) {
			t.Fatal(p)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no expired answer")
	}
	// seq gap → eventsLost + refill request answered by the camera
	e.dev.SetSeqJump(4)
	e.dev.Emit("warn", "network", "offline", "uplink lost")
	eventually(t, "gap detected", func() bool { return e.camera(t).EventsLost == 4 })
	eventually(t, "refill command done", func() bool {
		d, _ := svc.Get(bg, app, "stand-02")
		for _, c := range d.Commands {
			if c.Cmd == "events" && c.Status == "done" && *c.Actor == "system:backfill" {
				return true
			}
		}
		return false
	})
	if got, _ := svc.GetCommand(bg, app, "stand-02", row.ID); got.Status != "pending" {
		t.Fatal(got.Status)
	}
	e.f.advance(12 * time.Second)
	svc.Sweep(bg)
	if got, _ := svc.GetCommand(bg, app, "stand-02", row.ID); got.Status != "timeout" {
		t.Fatal(got.Status)
	}
}
