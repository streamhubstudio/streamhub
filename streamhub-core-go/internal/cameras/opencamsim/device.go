// Package opencamsim simulates an OpenCam camera speaking the StreamHub
// contract (opencameras/docs/STREAMHUB.md, api: 1) over MQTT: retained
// hello/status/state/thumb, event-log lines with seq/boot_id, and command
// answers with the uniform response (accepted → progress → done/failed,
// codes expired/busy/conflict/unsupported/bad_request). It drives the cameras
// module's tests (over MemBroker) and cmd/opencam-sim (over a real broker).
package opencamsim

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Conn is one MQTT session of the device.
type Conn interface {
	Publish(topic string, payload []byte, retain bool)
	Subscribe(filter string, h func(topic string, payload []byte))
	// Close ends the session; abrupt=true lets the broker fire the LWT.
	Close(abrupt bool)
}

// Dialer opens a session with the LWT (topic, payload, retained).
type Dialer func(clientID, lwtTopic string, lwt []byte) (Conn, error)

// Options configure a simulated camera.
type Options struct {
	Device        string
	Root          string        // topic root (default "opencam")
	Fw            string        // default "0.3.0-sim"
	Caps          []string      // default: the Cinnado D1 set
	StateInterval time.Duration // default 10s
	RebootDelay   time.Duration // offline time on reboot (default 3s)
	StepDelay     time.Duration // pace of long-command phases (default 300ms)
	// Silent lists commands the camera never answers (timeout tests).
	Silent map[string]bool
	// SeqJump makes the next event skip this many seq numbers (gap tests).
	SeqJump int64
	Logf    func(format string, a ...any)
}

// DefaultCaps is the Cinnado D1 (T23N) capability set.
var DefaultCaps = []string{"ptz", "sd", "record", "mic", "speaker", "voice", "rtmp", "thumb", "config_rev", "cmd_envelope"}

type preset struct {
	ID   int     `json:"id"`
	Name string  `json:"name"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

// Device is one simulated camera.
type Device struct {
	o    Options
	dial Dialer

	mu         sync.Mutex
	conn       Conn
	bootID     string
	bootAt     time.Time
	seq        int64
	configRev  int64
	config     map[string]any
	x, y       float64
	moving     bool
	moveDir    string
	moveSpeed  float64
	moveUntil  time.Time
	preset     int
	presets    []preset
	streaming  bool
	source     int
	recording  bool
	busy       string // long command in progress
	rebooting  bool
	stateTimer *time.Timer
	lastReboot string
	commands   int
	logRing    []map[string]any
}

// New builds a device (nothing happens until Run).
func New(o Options, dial Dialer) *Device {
	if o.Root == "" {
		o.Root = "opencam"
	}
	if o.Fw == "" {
		o.Fw = "0.3.0-sim"
	}
	if o.Caps == nil {
		o.Caps = DefaultCaps
	}
	if o.StateInterval <= 0 {
		o.StateInterval = 10 * time.Second
	}
	if o.RebootDelay <= 0 {
		o.RebootDelay = 3 * time.Second
	}
	if o.StepDelay <= 0 {
		o.StepDelay = 300 * time.Millisecond
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	return &Device{o: o, dial: dial, configRev: 1, x: 1800, y: 450, source: 1, streaming: true, recording: true,
		config: map[string]any{
			"stream": map[string]any{"url": "rtmp://media.local/live", "key": "********", "source": 1, "audio": 1},
			"ptz":    map[string]any{"home_after_s": 0},
			"mqtt":   map[string]any{"state_interval": 10, "pass": "********"},
		},
		presets: []preset{{1, "entrada", 1200, 300}, {2, "conteo", 1800, 450}}, preset: 2, lastReboot: "power"}
}

func (d *Device) base() string { return d.o.Root + "/" + d.o.Device }

// Run connects and keeps the camera alive until ctx ends (reboots reconnect).
func (d *Device) Run(ctx context.Context) error {
	if err := d.connect(); err != nil {
		return err
	}
	tick := time.NewTicker(d.o.StateInterval)
	defer tick.Stop()
	ptz := time.NewTicker(100 * time.Millisecond)
	defer ptz.Stop()
	for {
		select {
		case <-ctx.Done():
			d.mu.Lock()
			c := d.conn
			d.conn = nil
			d.mu.Unlock()
			if c != nil {
				c.Publish(d.base()+"/status", []byte("offline"), true)
				c.Close(false)
			}
			return nil
		case <-tick.C:
			d.publishState()
		case <-ptz.C:
			d.stepPTZ()
		}
	}
}

func newBootID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (d *Device) connect() error {
	conn, err := d.dial("opencam-"+d.o.Device, d.base()+"/status", []byte("offline"))
	if err != nil {
		return err
	}
	d.mu.Lock()
	d.conn = conn
	d.bootID = newBootID()
	d.bootAt = time.Now()
	d.seq = 0
	d.rebooting = false
	d.mu.Unlock()
	conn.Subscribe(d.base()+"/cmd/#", d.onCommand)
	conn.Publish(d.base()+"/status", []byte("online"), true)
	d.publishHello()
	conn.Publish(d.base()+"/thumb", d.thumb(), true)
	d.event("info", "system", "boot", "opencam started", nil)
	d.event("info", "mqtt", "connecting", "connected to broker", nil)
	d.publishState()
	d.o.Logf("%s: online (boot %s)", d.o.Device, d.bootID)
	return nil
}

func (d *Device) pub(topic string, v any, retain bool) {
	d.mu.Lock()
	c := d.conn
	d.mu.Unlock()
	if c == nil {
		return
	}
	b, _ := json.Marshal(v)
	c.Publish(topic, b, retain)
}

func (d *Device) hello() map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	return map[string]any{
		"api": 1, "device": d.o.Device, "fw": d.o.Fw, "image": "cinnado_d1_t23n_sc2331_atbm6012bx",
		"soc": "T23N", "sensor": "sc2331", "flash_mb": 8, "config_schema": 1, "config_rev": d.configRev,
		"boot_id": d.bootID, "caps": d.o.Caps,
		"streams": map[string]any{
			"main": map[string]any{"w": 1920, "h": 1080, "fps_max": 25, "codecs": []string{"h264", "h265"}},
			"sub":  map[string]any{"w": 640, "h": 360, "fps_max": 25, "codecs": []string{"h264"}},
		},
		"ptz": map[string]any{"pan": []int{0, 3600}, "tilt": []int{0, 900}, "presets_max": 8},
		"app": "", "ts": time.Now().UTC().Format(time.RFC3339),
	}
}

func (d *Device) publishHello() { d.pub(d.base()+"/hello", d.hello(), true) }

func (d *Device) has(cap string) bool {
	for _, c := range d.o.Caps {
		if c == cap {
			return true
		}
	}
	return false
}

// State is the current `state` document.
func (d *Device) State() map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	up := int64(time.Since(d.bootAt).Seconds())
	rssi := -61 + int(time.Now().Unix()%7) - 3
	st := map[string]any{
		"api": 1, "config_rev": d.configRev, "boot_id": d.bootID, "uptime_s": up,
		"net":    map[string]any{"iface": "wlan0", "ssid": "Shopping-Stands", "rssi": rssi, "ip": "10.0.4.22", "online": true},
		"stream": map[string]any{"running": d.streaming, "source": d.source, "bitrate_kbps": map[bool]int{true: 600, false: 0}[d.streaming], "reconnects_1h": 0},
		"record": map[string]any{"running": d.recording, "segment_min": 30},
		"sd":     map[string]any{"present": true, "mounted": true, "total_kb": 31166976, "free_kb": 20111360, "fs": "vfat", "mounted_ro": false, "errors": 0},
		"queue":  map[string]any{"files": 0, "bytes": 0, "oldest_s": 0},
		"health": map[string]any{"mem_free_kb": 3100, "load1": 0.8, "safe_mode": false, "last_reboot": map[string]any{"reason": d.lastReboot, "ts": d.bootAt.UTC().Format(time.RFC3339)}},
		"talk":   map[string]any{"active": false},
	}
	if d.has("ptz") {
		var p any
		if d.preset > 0 {
			p = d.preset
		}
		st["ptz"] = map[string]any{"x": math.Round(d.x), "y": math.Round(d.y), "moving": d.moving, "preset": p}
	}
	return st
}

func (d *Device) publishState() { d.pub(d.base()+"/state", d.State(), true) }

// stateSoon publishes state ~300 ms after a command (debounced).
func (d *Device) stateSoon() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stateTimer != nil {
		return
	}
	d.stateTimer = time.AfterFunc(300*time.Millisecond, func() {
		d.mu.Lock()
		d.stateTimer = nil
		d.mu.Unlock()
		d.publishState()
	})
}

func (d *Device) event(level, src, ev, msg string, extra map[string]any) {
	d.mu.Lock()
	d.seq += 1 + d.o.SeqJump
	d.o.SeqJump = 0
	now := time.Now().UTC()
	e := map[string]any{"seq": d.seq, "boot_id": d.bootID, "ts": now.Unix(), "time": now.Format(time.RFC3339), "device": d.o.Device,
		"level": level, "src": src, "event": ev, "msg": msg}
	for k, v := range extra {
		e[k] = v
	}
	d.logRing = append(d.logRing, e)
	if len(d.logRing) > 500 {
		d.logRing = d.logRing[len(d.logRing)-500:]
	}
	d.mu.Unlock()
	d.pub(d.base()+"/event", e, false)
}

func (d *Device) thumb() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 320, 180))
	h := 0
	for _, c := range d.o.Device {
		h = h*31 + int(c)
	}
	bg := color.RGBA{uint8(40 + h%60), uint8(60 + (h/7)%80), uint8(90 + (h/13)%100), 255}
	for y := 0; y < 180; y++ {
		for x := 0; x < 320; x++ {
			c := bg
			if (x/40+y/40)%2 == 0 {
				c.R, c.G, c.B = c.R+20, c.G+20, c.B+20
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 60})
	return buf.Bytes()
}

// --- commands ---------------------------------------------------------------

type res struct {
	ID     string `json:"id,omitempty"`
	Cmd    string `json:"cmd"`
	OK     bool   `json:"ok"`
	Phase  string `json:"phase"`
	Result any    `json:"result,omitempty"`
	Code   string `json:"code,omitempty"`
	Error  string `json:"error,omitempty"`
	Ts     string `json:"ts"`
}

func (d *Device) reply(cmd, id, phase string, ok bool, result any, code, msg string) {
	d.pub(d.base()+"/res/"+cmd, res{id, cmd, ok, phase, result, code, msg, time.Now().UTC().Format(time.RFC3339)}, false)
}

func (d *Device) done(cmd, id string, result any) { d.reply(cmd, id, "done", true, result, "", "") }
func (d *Device) fail(cmd, id, code, msg string)  { d.reply(cmd, id, "failed", false, nil, code, msg) }
func (d *Device) phase(cmd, id, phase string, result any) {
	d.reply(cmd, id, phase, true, result, "", "")
}

func numArg(a map[string]any, k string, def float64) float64 {
	switch v := a[k].(type) {
	case float64:
		return v
	case string:
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n
		}
	}
	return def
}

func expired(a map[string]any) bool {
	exp := numArg(a, "exp", 0)
	if exp <= 0 {
		return false
	}
	var ts time.Time
	switch v := a["ts"].(type) {
	case string:
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return false
		}
		ts = t
	case float64:
		ts = time.Unix(int64(v), 0)
	default:
		return false
	}
	return time.Since(ts) > time.Duration(exp*float64(time.Second))
}

func (d *Device) onCommand(topic string, payload []byte) {
	cmd := strings.TrimPrefix(topic, d.base()+"/cmd/")
	args := map[string]any{}
	if len(bytes.TrimSpace(payload)) > 0 {
		if err := json.Unmarshal(payload, &args); err != nil {
			d.fail(cmd, "", "bad_request", "payload is not a JSON object")
			return
		}
	}
	id, _ := args["id"].(string)
	d.mu.Lock()
	d.commands++
	silent := d.o.Silent[cmd]
	d.mu.Unlock()
	if silent {
		return
	}
	if expired(args) {
		d.fail(cmd, id, "expired", "command arrived after exp")
		return
	}
	if cmd != "ptz/dir" && cmd != "status" {
		d.event("info", "mqtt", "command", cmd, nil)
	}
	d.handle(cmd, id, args)
	d.stateSoon()
}

func (d *Device) handle(cmd, id string, a map[string]any) {
	group := strings.SplitN(cmd, "/", 2)[0]
	if (group == "ptz" && !d.has("ptz")) || (group == "voice" && !d.has("voice")) || (group == "record" && !d.has("record")) {
		d.fail(cmd, id, "unsupported", "not available on this model")
		return
	}
	switch cmd {
	case "status":
		d.done(cmd, id, d.State())
	case "hello":
		d.publishHello()
		d.done(cmd, id, map[string]any{"ok": true})
	case "events":
		n := int(numArg(a, "n", 20))
		d.mu.Lock()
		list := d.logRing
		if n >= 0 && n < len(list) {
			list = list[len(list)-n:]
		}
		list = append([]map[string]any(nil), list...)
		d.mu.Unlock()
		d.done(cmd, id, map[string]any{"events": list})

	case "stream/start", "stream/stop":
		d.mu.Lock()
		d.streaming = cmd == "stream/start"
		on := d.streaming
		d.mu.Unlock()
		if on {
			d.event("info", "stream", "started", "rtmp push ok", nil)
		} else {
			d.event("info", "stream", "stopped", "rtmp push stopped", nil)
		}
		d.done(cmd, id, map[string]any{"ok": true, "running": on})
	case "stream/status":
		d.done(cmd, id, d.State()["stream"])
	case "stream/set":
		if src, ok := a["source"].(float64); ok {
			if src != 0 && src != 1 {
				d.fail(cmd, id, "bad_request", "source must be 0 or 1")
				return
			}
			d.mu.Lock()
			d.source = int(src)
			d.mu.Unlock()
		}
		d.event("info", "stream", "configured", "stream destination updated", nil)
		d.done(cmd, id, map[string]any{"ok": true})
	case "snapshot/take":
		d.event("info", "upload", "snapshot_sent", "snapshot uploaded", nil)
		d.done(cmd, id, map[string]any{"ok": true, "file": fmt.Sprintf("snap-%d.jpg", time.Now().Unix()), "bytes": 48213})
	case "record/start", "record/stop":
		d.mu.Lock()
		d.recording = cmd == "record/start"
		d.mu.Unlock()
		d.done(cmd, id, map[string]any{"ok": true})

	case "ptz/dir":
		dir, _ := a["dir"].(string)
		if !validDirs[dir] {
			d.fail(cmd, id, "bad_request", "bad dir")
			return
		}
		hold := numArg(a, "hold_ms", 500)
		d.mu.Lock()
		was := d.moving
		d.moving, d.moveDir, d.moveSpeed, d.preset = true, dir, numArg(a, "speed", 5), 0
		d.moveUntil = time.Now().Add(time.Duration(hold) * time.Millisecond)
		d.mu.Unlock()
		if !was {
			d.event("info", "ptz", "moving", "pad "+dir, nil)
		}
		d.done(cmd, id, map[string]any{"ok": true})
	case "ptz/stop":
		d.stopPTZ()
		d.done(cmd, id, d.ptzPos())
	case "ptz/home", "ptz/preset", "ptz/goto", "ptz/move":
		var tx, ty float64
		var target int
		d.mu.Lock()
		switch cmd {
		case "ptz/home":
			tx, ty = 1800, 450
		case "ptz/goto":
			tx, ty = numArg(a, "x", d.x), numArg(a, "y", d.y)
		case "ptz/move":
			tx, ty = d.x+numArg(a, "x", 0), d.y+numArg(a, "y", 0)
		case "ptz/preset":
			want := int(numArg(a, "preset", -1))
			found := false
			for _, p := range d.presets {
				if p.ID == want {
					tx, ty, target, found = p.X, p.Y, p.ID, true
				}
			}
			if !found {
				d.mu.Unlock()
				d.fail(cmd, id, "bad_request", "unknown preset")
				return
			}
		}
		d.mu.Unlock()
		d.event("info", "ptz", "moving", cmd, nil)
		time.AfterFunc(d.o.StepDelay, func() {
			d.mu.Lock()
			d.x, d.y = clamp(tx, 0, 3600), clamp(ty, 0, 900)
			d.preset, d.moving = target, false
			d.mu.Unlock()
			extra := map[string]any{"x": tx, "y": ty}
			if target > 0 {
				extra["preset"] = target
			}
			d.event("info", "ptz", "stopped", "arrived", extra)
			d.done(cmd, id, d.ptzPos())
			d.publishState()
		})
	case "ptz/status":
		d.done(cmd, id, d.ptzPos())
	case "ptz/presets":
		d.mu.Lock()
		list := append([]preset(nil), d.presets...)
		d.mu.Unlock()
		d.done(cmd, id, list)
	case "ptz/preset-save":
		d.mu.Lock()
		p := preset{len(d.presets) + 1, fmt.Sprint(a["name"]), d.x, d.y}
		d.presets = append(d.presets, p)
		d.mu.Unlock()
		d.done(cmd, id, p)
	case "ptz/preset-delete":
		d.done(cmd, id, map[string]any{"ok": true})

	case "voice/say":
		key, _ := a["key"].(string)
		if key == "" {
			d.fail(cmd, id, "bad_request", "key required")
			return
		}
		d.done(cmd, id, map[string]any{"ok": true, "key": key})
	case "voice/list":
		d.done(cmd, id, []map[string]any{{"key": "network_offline", "text": "Sin conexión", "enabled": true}, {"key": "config_mode", "text": "Modo configuración", "enabled": true}})

	case "config/get":
		d.mu.Lock()
		c := d.config
		d.mu.Unlock()
		d.done(cmd, id, map[string]any{"config_rev": d.rev(), "config": c})
	case "config/set", "config/import":
		if r, ok := a["if_rev"].(float64); ok && int64(r) != d.rev() {
			d.fail(cmd, id, "conflict", fmt.Sprintf("config_rev is %d", d.rev()))
			return
		}
		d.mu.Lock()
		d.configRev++
		rev := d.configRev
		d.mu.Unlock()
		d.event("info", "config", "imported", "config applied", nil)
		d.done(cmd, id, map[string]any{"ok": true, "config_rev": rev})

	case "system/status":
		d.done(cmd, id, d.State()["health"])
	case "system/safe-clear":
		d.done(cmd, id, map[string]any{"ok": true})
	case "system/reboot", "reboot":
		if !d.startLong(cmd, id) {
			return
		}
		reason, _ := a["reason"].(string)
		if reason == "" {
			reason = "mqtt"
		}
		d.phase(cmd, id, "accepted", nil)
		d.event("warn", "system", "reboot", "reboot requested: "+reason, nil)
		go d.reboot(reason, "")
	case "firmware/upgrade":
		if !d.startLong(cmd, id) {
			return
		}
		d.phase(cmd, id, "accepted", nil)
		go func() {
			d.event("info", "firmware", "downloading", "", nil)
			for _, pct := range []int{25, 50, 75, 100} {
				time.Sleep(d.o.StepDelay)
				d.phase(cmd, id, "progress", map[string]any{"pct": pct})
			}
			d.event("info", "firmware", "verified", "", nil)
			d.event("warn", "firmware", "flashing", "", nil)
			d.reboot("ota", bumpFw(d.o.Fw))
		}()
	case "firmware/check":
		d.done(cmd, id, map[string]any{"ok": true, "verified": true})

	default:
		d.fail(cmd, id, "unsupported", "unknown command "+cmd)
	}
}

func (d *Device) rev() int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.configRev
}

// startLong reserves the single long-command slot (a second one → busy).
func (d *Device) startLong(cmd, id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.busy != "" || d.rebooting {
		go d.fail(cmd, id, "busy", "another long command is running ("+d.busy+")")
		return false
	}
	d.busy = cmd
	return true
}

func (d *Device) reboot(reason, newFw string) {
	time.Sleep(d.o.StepDelay)
	d.mu.Lock()
	d.rebooting = true
	c := d.conn
	d.conn = nil
	if d.stateTimer != nil {
		d.stateTimer.Stop()
		d.stateTimer = nil
	}
	d.mu.Unlock()
	if c != nil {
		c.Close(true) // LWT → status offline
	}
	d.o.Logf("%s: rebooting (%s)", d.o.Device, reason)
	time.Sleep(d.o.RebootDelay)
	d.mu.Lock()
	d.busy = ""
	d.lastReboot = reason
	d.moving = false
	if newFw != "" {
		d.o.Fw = newFw
	}
	d.mu.Unlock()
	if err := d.connect(); err != nil {
		d.o.Logf("%s: reconnect failed: %v", d.o.Device, err)
		return
	}
	if newFw != "" {
		d.event("info", "firmware", "booted", "version "+newFw, map[string]any{"version": newFw})
	}
}

func bumpFw(v string) string {
	base, suffix, _ := strings.Cut(v, "-")
	parts := strings.Split(base, ".")
	if n, err := strconv.Atoi(parts[len(parts)-1]); err == nil {
		parts[len(parts)-1] = strconv.Itoa(n + 1)
	}
	out := strings.Join(parts, ".")
	if suffix != "" {
		out += "-" + suffix
	}
	return out
}

func (d *Device) ptzPos() map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	return map[string]any{"x": math.Round(d.x), "y": math.Round(d.y), "moving": d.moving}
}

func (d *Device) stopPTZ() {
	d.mu.Lock()
	was := d.moving
	d.moving = false
	x, y := d.x, d.y
	d.mu.Unlock()
	if was {
		d.event("info", "ptz", "stopped", "", map[string]any{"x": math.Round(x), "y": math.Round(y)})
	}
}

// stepPTZ advances a pad move; the deadman stops it when no ptz/dir arrived
// within hold_ms.
func (d *Device) stepPTZ() {
	d.mu.Lock()
	if !d.moving || d.moveDir == "" {
		d.mu.Unlock()
		return
	}
	if time.Now().After(d.moveUntil) {
		d.mu.Unlock()
		d.stopPTZ()
		d.publishState()
		return
	}
	step := 4 * math.Max(1, d.moveSpeed)
	dir := d.moveDir
	switch dir {
	case "left", "ul", "dl":
		d.x -= step
	case "right", "ur", "dr":
		d.x += step
	}
	switch dir {
	case "up", "ul", "ur":
		d.y -= step
	case "down", "dl", "dr":
		d.y += step
	}
	d.x, d.y = clamp(d.x, 0, 3600), clamp(d.y, 0, 900)
	d.mu.Unlock()
}

var validDirs = map[string]bool{"up": true, "down": true, "left": true, "right": true, "ul": true, "ur": true, "dl": true, "dr": true}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// Moving reports whether the PTZ is moving (tests).
func (d *Device) Moving() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.moving
}

// Source is the current stream source (0 main, 1 sub).
func (d *Device) Source() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.source
}

// BootID is the current boot id.
func (d *Device) BootID() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.bootID
}

// SetSeqJump makes the next event skip n seq numbers.
func (d *Device) SetSeqJump(n int64) {
	d.mu.Lock()
	d.o.SeqJump = n
	d.mu.Unlock()
}

// Emit publishes an arbitrary event line (tests, the CLI's -event flag).
func (d *Device) Emit(level, src, ev, msg string) { d.event(level, src, ev, msg, nil) }
