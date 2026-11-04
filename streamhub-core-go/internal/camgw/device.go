package camgw

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"
)

// Version is reported as hello.fw ("streamhub-agent <Version>").
var Version = "0.1.0"

// Device is one camera behind the gateway, seen by the cloud as an OpenCam.
type Device struct {
	cfg   *Config
	cam   *Camera
	pipe  *Pipeline
	onvif *Onvif
	logf  func(string, ...any)

	mu        sync.Mutex
	client    paho.Client
	bootID    string
	bootAt    time.Time
	seq       int64
	ring      []map[string]any
	ptzOK     bool
	ptzStop   *time.Timer
	preset    string
	lastSnap  time.Time
	configRev int64
	overlay   map[string]any
	cmdQ      chan paho.Message
}

func NewDevice(cfg *Config, cam *Camera, logf func(string, ...any)) *Device {
	d := &Device{cfg: cfg, cam: cam, bootID: newBootID(), bootAt: time.Now(), configRev: 1, cmdQ: make(chan paho.Message, 64)}
	d.logf = func(f string, a ...any) { logf(cam.Device.ID+": "+f, a...) }
	d.pipe = NewPipeline(cfg.FFmpeg, cam, cfg.DataDir, d.logf, func(level, ev, msg string) {
		d.logf("%s %s: %s", level, ev, msg)
		d.event(level, "stream", ev, msg)
	})
	if cam.ONVIF != nil && cam.ONVIF.URL != "" {
		d.onvif = NewOnvif(*cam.ONVIF)
	}
	d.loadOverlay()
	return d
}

func newBootID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (d *Device) base() string { return d.cam.TopicBase() }

// Run keeps the device alive until ctx ends.
func (d *Device) Run(ctx context.Context) {
	if d.onvif != nil {
		pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := d.onvif.Probe(pctx)
		cancel()
		d.mu.Lock()
		d.ptzOK = err == nil
		d.mu.Unlock()
		if err != nil {
			d.logf("onvif: PTZ disabled: %v", err)
		} else {
			d.logf("onvif: PTZ ready")
		}
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); d.pipe.Run(ctx) }()
	go d.commandLoop(ctx)
	if truthy(d.cam.MQTT.Enabled) && d.cam.MQTT.Host != "" {
		d.connect()
	} else {
		d.logf("mqtt disabled: relay/record only")
	}
	tick := time.NewTicker(time.Duration(d.cfg.StateInterval) * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			d.mu.Lock()
			c := d.client
			d.mu.Unlock()
			if c != nil && c.IsConnected() {
				c.Publish(d.base()+"/status", 1, true, "offline").WaitTimeout(3 * time.Second)
				c.Disconnect(250)
			}
			wg.Wait()
			return
		case <-tick.C:
			d.publishState()
		}
	}
}

func (d *Device) connect() {
	m := d.cam.MQTT
	scheme := "tcp"
	if truthy(m.TLS) {
		scheme = "ssl"
	}
	port := m.Port
	if port == "" {
		port = map[string]string{"ssl": "8883", "tcp": "1883"}[scheme]
	}
	o := paho.NewClientOptions().AddBroker(scheme+"://"+m.Host+":"+port).
		SetClientID("opencam-"+d.cam.Device.ID).SetUsername(m.Username).SetPassword(m.Password).
		SetCleanSession(true).SetKeepAlive(30*time.Second).SetConnectTimeout(15*time.Second).
		SetAutoReconnect(true).SetConnectRetry(true).SetConnectRetryInterval(5*time.Second).
		SetMaxReconnectInterval(30*time.Second).SetOrderMatters(false).
		SetWill(d.base()+"/status", "offline", 1, true).
		SetTLSConfig(&tls.Config{ServerName: m.Host, MinVersion: tls.VersionTLS12})
	o.SetOnConnectHandler(func(c paho.Client) {
		c.Subscribe(d.base()+"/cmd/#", 1, func(_ paho.Client, msg paho.Message) {
			select {
			case d.cmdQ <- msg:
			default: // overloaded: the cloud times the command out
			}
		})
		c.Publish(d.base()+"/status", 1, true, "online")
		d.publishHello()
		d.event("info", "mqtt", "connected", "connected to broker")
		d.publishState()
		d.logf("mqtt: online on %s (%s)", m.Host, d.base())
	})
	o.SetConnectionLostHandler(func(_ paho.Client, err error) { d.logf("mqtt: lost: %v", err) })
	c := paho.NewClient(o)
	d.mu.Lock()
	d.client = c
	d.mu.Unlock()
	c.Connect() // ConnectRetry: keeps trying in the background
}

func (d *Device) pub(topic string, v any, retain bool) {
	d.mu.Lock()
	c := d.client
	d.mu.Unlock()
	if c == nil || !c.IsConnected() {
		return
	}
	var b []byte
	switch x := v.(type) {
	case []byte:
		b = x
	default:
		b, _ = json.Marshal(v)
	}
	c.Publish(topic, 1, retain, b)
}

func (d *Device) caps() []string {
	c := []string{"rtmp", "cmd_envelope", "config_rev", "thumb"}
	if d.cfg.DataDir != "" {
		c = append(c, "record", "sd")
	}
	d.mu.Lock()
	if d.ptzOK {
		c = append(c, "ptz")
	}
	d.mu.Unlock()
	return c
}

func (d *Device) hello() map[string]any {
	streams := map[string]any{"main": map[string]any{"codecs": []string{"h264", "h265"}}}
	if d.cam.RTSPSub != "" {
		streams["sub"] = map[string]any{"codecs": []string{"h264"}}
	}
	caps := d.caps()
	d.mu.Lock()
	defer d.mu.Unlock()
	return map[string]any{
		"api": 1, "device": d.cam.Device.ID, "fw": "streamhub-agent " + Version, "image": "rtsp-onvif-gateway",
		"gateway": d.cfg.ID, "model": d.cam.Name, "config_schema": 1, "config_rev": d.configRev, "boot_id": d.bootID,
		"caps": caps, "streams": streams, "ts": time.Now().UTC().Format(time.RFC3339),
	}
}

func (d *Device) publishHello() { d.pub(d.base()+"/hello", d.hello(), true) }

// State is the `state` document (the fields STREAMHUB.md §3.2 lists).
func (d *Device) State() map[string]any {
	ps := d.pipe.Stats()
	d.mu.Lock()
	bootID, up, rev, preset, ptzOK := d.bootID, int64(time.Since(d.bootAt).Seconds()), d.configRev, d.preset, d.ptzOK
	d.mu.Unlock()
	mem := memAvailableKB()
	st := map[string]any{
		"api": 1, "config_rev": rev, "boot_id": bootID, "uptime_s": up,
		"net":       map[string]any{"iface": "eth0", "online": true, "ip": localIP()},
		"stream":    streamState(ps),
		"record":    map[string]any{"running": ps.Running && ps.Want.Record, "segment_min": d.cam.SegmentMin},
		"recording": map[string]any{"segment_minutes": d.cam.SegmentMin},
		"queue":     map[string]any{"files": 0, "bytes": 0, "oldest_s": 0, "items": 0},
		"health": map[string]any{"mem_free_kb": mem, "mem_kb": mem, "load1": load1(), "safe_mode": false,
			"last_reboot": map[string]any{"reason": "agent start", "ts": d.bootAt.UTC().Format(time.RFC3339)}},
		"talk": map[string]any{"active": false},
	}
	if d.cfg.DataDir != "" {
		total, free, ok := diskKB(d.cfg.DataDir)
		st["sd"] = map[string]any{"present": ok, "mounted": ok, "total_kb": total, "free_kb": free, "errors": 0}
	}
	if ptzOK {
		var p any
		if preset != "" {
			p = preset
		}
		st["ptz"] = map[string]any{"moving": false, "preset": p}
	}
	return st
}

func (d *Device) publishState() { d.pub(d.base()+"/state", d.State(), true) }

func streamState(ps PipeStats) map[string]any {
	on := ps.Running && ps.Want.Stream
	state := "stopped"
	switch {
	case on:
		state = "pushing"
	case ps.Want.Stream:
		state = "reconnecting"
	}
	st := map[string]any{"running": on, "pushing": on, "state": state, "source": ps.Want.Source,
		"bitrate_kbps": ps.BitrateKbps, "reconnects_1h": ps.Restarts1h, "last_error": ps.LastError}
	if ps.Frames > 0 { // ffmpeg reports no frame count for some copy/tee outputs
		st["video_frames"], st["dropped"] = ps.Frames, ps.Dropped
	}
	if on {
		st["uptime_sec"] = int64(time.Since(ps.StartedAt).Seconds())
	}
	return st
}

// localIP is the first non-loopback IPv4 address (state.net.ip).
func localIP() string {
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
			return n.IP.String()
		}
	}
	return ""
}

func (d *Device) event(level, src, ev, msg string) {
	d.mu.Lock()
	d.seq++
	now := time.Now().UTC()
	e := map[string]any{"seq": d.seq, "boot_id": d.bootID, "ts": now.Unix(), "time": now.Format(time.RFC3339),
		"device": d.cam.Device.ID, "level": level, "src": src, "event": ev, "msg": msg}
	d.ring = append(d.ring, e)
	if len(d.ring) > 200 {
		d.ring = d.ring[len(d.ring)-200:]
	}
	d.mu.Unlock()
	d.pub(d.base()+"/event", e, false)
}

// --- commands ----------------------------------------------------------------

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
	if cmd != "ptz/dir" || !ok {
		d.logf("cmd %s: %s ok=%v %s %s", cmd, phase, ok, code, msg)
	}
	d.pub(d.base()+"/res/"+cmd, res{id, cmd, ok, phase, result, code, msg, time.Now().UTC().Format(time.RFC3339)}, false)
}
func (d *Device) done(cmd, id string, result any) { d.reply(cmd, id, "done", true, result, "", "") }
func (d *Device) fail(cmd, id, code, msg string)  { d.reply(cmd, id, "failed", false, nil, code, msg) }

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

func strArg(a map[string]any, k string) string {
	switch v := a[k].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
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
	// Whole seconds, like the firmware: the core stamps ts truncated to the
	// second, so a sub-second comparison expires ptz/dir (exp 1) at random.
	return float64(time.Now().Unix()-ts.Unix()) > exp
}

func (d *Device) commandLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case m := <-d.cmdQ:
			d.onCommand(ctx, m.Topic(), m.Payload())
		}
	}
}

func (d *Device) onCommand(ctx context.Context, topic string, payload []byte) {
	cmd := strings.TrimPrefix(topic, d.base()+"/cmd/")
	args := map[string]any{}
	if len(bytes.TrimSpace(payload)) > 0 {
		if err := json.Unmarshal(payload, &args); err != nil {
			d.fail(cmd, "", "bad_request", "payload is not a JSON object")
			return
		}
	}
	id, _ := args["id"].(string)
	if expired(args) {
		d.fail(cmd, id, "expired", "command arrived after exp")
		return
	}
	if cmd != "ptz/dir" && cmd != "status" {
		d.event("info", "mqtt", "command", cmd)
	}
	d.handle(ctx, cmd, id, args)
	if cmd != "ptz/dir" {
		go func() { time.Sleep(300 * time.Millisecond); d.publishState() }()
	}
}

var ptzVec = map[string][2]float64{
	"up": {0, 1}, "down": {0, -1}, "left": {-1, 0}, "right": {1, 0},
	"ul": {-1, 1}, "ur": {1, 1}, "dl": {-1, -1}, "dr": {1, -1},
}

func (d *Device) handle(ctx context.Context, cmd, id string, a map[string]any) {
	group := strings.SplitN(cmd, "/", 2)[0]
	d.mu.Lock()
	ptzOK := d.ptzOK
	d.mu.Unlock()
	if group == "ptz" && !ptzOK {
		d.fail(cmd, id, "unsupported", "camera has no ONVIF PTZ")
		return
	}
	if group == "record" && d.cfg.DataDir == "" {
		d.fail(cmd, id, "unsupported", "recording is not configured")
		return
	}
	octx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	switch cmd {
	case "status":
		d.done(cmd, id, d.State())
	case "hello":
		d.publishHello()
		d.done(cmd, id, map[string]any{"ok": true})
	case "events":
		n := int(numArg(a, "n", 20))
		d.mu.Lock()
		list := d.ring
		if n >= 0 && n < len(list) {
			list = list[len(list)-n:]
		}
		list = append([]map[string]any(nil), list...)
		d.mu.Unlock()
		d.done(cmd, id, map[string]any{"events": list})

	case "stream/start", "stream/stop":
		on := cmd == "stream/start"
		if on && d.cam.PushURL() == "" {
			d.fail(cmd, id, "bad_request", "no stream url/key configured")
			return
		}
		d.pipe.Set(func(w *Want) { w.Stream = on })
		d.done(cmd, id, map[string]any{"ok": true, "running": on})
	case "stream/status":
		d.done(cmd, id, d.State()["stream"])
	case "stream/set":
		if s, ok := a["source"]; ok {
			src := int(numArg(map[string]any{"s": s}, "s", -1))
			if src != 0 && src != 1 {
				d.fail(cmd, id, "bad_request", "source must be 0 or 1")
				return
			}
			if src == 1 && d.cam.RTSPSub == "" {
				d.fail(cmd, id, "unsupported", "no sub stream configured")
				return
			}
			d.pipe.Set(func(w *Want) { w.Source = src })
		}
		if u, k := strArg(a, "url"), strArg(a, "key"); u != "" || k != "" {
			if u != "" {
				d.cam.Stream.URL = u
			}
			if k != "" {
				d.cam.Stream.Key = k
			}
			d.pipe.Restart()
		}
		d.done(cmd, id, map[string]any{"ok": true})

	case "snapshot/take":
		go d.snapshot(ctx, cmd, id, "manual")

	case "record/start", "record/stop":
		on := cmd == "record/start"
		d.pipe.Set(func(w *Want) { w.Record = on })
		d.done(cmd, id, map[string]any{"ok": true, "running": on})
	case "record/status":
		d.done(cmd, id, d.State()["record"])
	case "record/list":
		d.done(cmd, id, d.listSegments(int(numArg(a, "n", 50))))

	case "ptz/dir":
		v, ok := ptzVec[strArg(a, "dir")]
		if !ok {
			d.fail(cmd, id, "bad_request", "bad dir")
			return
		}
		speed := numArg(a, "speed", 5) / 10
		if speed <= 0 || speed > 1 {
			speed = 0.5
		}
		hold := time.Duration(numArg(a, "hold_ms", 500)) * time.Millisecond
		d.mu.Lock()
		moving := d.ptzStop != nil
		if moving {
			d.ptzStop.Reset(hold) // deadman repeat: keep moving
		} else {
			d.ptzStop = time.AfterFunc(hold, func() {
				d.mu.Lock()
				d.ptzStop = nil
				d.mu.Unlock()
				sctx, c := context.WithTimeout(context.Background(), 5*time.Second)
				defer c()
				_ = d.onvif.Stop(sctx)
			})
		}
		d.preset = ""
		d.mu.Unlock()
		if !moving {
			if err := d.onvif.Move(octx, v[0]*speed, v[1]*speed); err != nil {
				d.fail(cmd, id, "io", err.Error())
				return
			}
		}
		d.done(cmd, id, map[string]any{"ok": true})
	case "ptz/stop":
		d.mu.Lock()
		if d.ptzStop != nil {
			d.ptzStop.Stop()
			d.ptzStop = nil
		}
		d.mu.Unlock()
		d.ptzResult(cmd, id, d.onvif.Stop(octx), nil)
	case "ptz/home":
		d.setPreset("")
		d.ptzResult(cmd, id, d.onvif.Home(octx), nil)
	case "ptz/presets":
		p, err := d.onvif.Presets(octx)
		list := []map[string]any{}
		for i, x := range p {
			list = append(list, map[string]any{"id": i + 1, "name": x.Name, "token": x.Token})
		}
		d.ptzResult(cmd, id, err, map[string]any{"presets": list})
	case "ptz/preset", "ptz/preset-delete":
		ref := strArg(a, "preset") // `id` is the command envelope's UUID
		tok, err := d.presetToken(octx, ref)
		if err != nil {
			d.fail(cmd, id, "bad_request", err.Error())
			return
		}
		if cmd == "ptz/preset-delete" {
			d.ptzResult(cmd, id, d.onvif.RemovePreset(octx, tok), nil)
			return
		}
		err = d.onvif.GotoPreset(octx, tok)
		if err == nil {
			d.setPreset(ref)
		}
		d.ptzResult(cmd, id, err, map[string]any{"preset": ref})
	case "ptz/preset-save":
		tok, err := d.onvif.SavePreset(octx, strArg(a, "name"))
		num := 0
		if err == nil {
			if p, perr := d.onvif.Presets(octx); perr == nil {
				for i, x := range p {
					if x.Token == tok {
						num = i + 1
					}
				}
			}
		}
		d.ptzResult(cmd, id, err, map[string]any{"id": num, "token": tok})
	case "ptz/status":
		x, y, moving, err := d.onvif.Status(octx)
		d.ptzResult(cmd, id, err, map[string]any{"x": x, "y": y, "moving": moving})

	case "config/get":
		d.done(cmd, id, d.config())
	case "config/import", "config/set":
		patch := map[string]any{}
		if cmd == "config/import" {
			c, ok := a["config"].(map[string]any)
			if !ok {
				d.fail(cmd, id, "bad_request", "config must be an object")
				return
			}
			patch = c
		} else {
			key := strArg(a, "key")
			if key == "" {
				d.fail(cmd, id, "bad_request", "key is required")
				return
			}
			setPath(patch, key, a["value"])
		}
		rev, err := d.applyConfig(patch, a["if_rev"])
		if err != nil {
			code := "bad_request"
			if errors.Is(err, errConflict) {
				code = "conflict"
			}
			d.fail(cmd, id, code, err.Error())
			return
		}
		d.publishHello()
		d.done(cmd, id, map[string]any{"ok": true, "config_rev": rev})
	case "system/status":
		d.done(cmd, id, d.State()["health"])
	case "system/reboot", "reboot":
		// A gateway cannot power-cycle the camera: it restarts its own side
		// (relay + MQTT session, new boot_id), which is what clears a stuck
		// pipeline. The fresh hello resolves the command (rebootLike).
		d.reply(cmd, id, "accepted", true, nil, "", "")
		go d.reboot(strArg(a, "reason"))
	default:
		d.fail(cmd, id, "unsupported", "not available on an RTSP/ONVIF camera")
	}
}

// presetToken maps the contract's numeric preset id (1..N, the order ONVIF
// lists them) to the camera's ONVIF token; a token is accepted as is.
func (d *Device) presetToken(ctx context.Context, ref string) (string, error) {
	if ref == "" {
		return "", errors.New("id is required")
	}
	p, err := d.onvif.Presets(ctx)
	if err != nil {
		return "", err
	}
	if n, err := strconv.Atoi(ref); err == nil && n >= 1 && n <= len(p) {
		return p[n-1].Token, nil
	}
	for _, x := range p {
		if x.Token == ref {
			return ref, nil
		}
	}
	return "", errors.New("unknown preset " + ref)
}

func (d *Device) setPreset(p string) {
	d.mu.Lock()
	d.preset = p
	d.mu.Unlock()
}

func (d *Device) ptzResult(cmd, id string, err error, result any) {
	if err != nil {
		d.fail(cmd, id, "io", err.Error())
		return
	}
	if result == nil {
		result = map[string]any{"ok": true}
	}
	d.done(cmd, id, result)
}

func (d *Device) config() map[string]any {
	src := 1
	if d.cam.RTSPSub == "" {
		src = 0
	}
	c := map[string]any{
		"stream": map[string]any{"url": d.cam.Stream.URL, "key": "********", "source": src, "rtsp": redactURL(d.cam.RTSP)},
		"record": map[string]any{"enabled": d.cam.Record, "segment_min": d.cam.SegmentMin},
		"mqtt":   map[string]any{"host": d.cam.MQTT.Host, "user": d.cam.MQTT.Username, "pass": "********", "state_interval": d.cfg.StateInterval},
	}
	if d.cam.ONVIF != nil {
		c["onvif"] = map[string]any{"url": d.cam.ONVIF.URL, "user": d.cam.ONVIF.User, "pass": "********"}
	}
	d.mu.Lock()
	for k, v := range d.overlay {
		if _, set := c[k]; !set {
			c[k] = v
		}
	}
	d.mu.Unlock()
	if w, ok := getPath(c, "upload.webhook").(map[string]any); ok {
		w = maps.Clone(w)
		w["token"] = "********"
		c["upload"] = map[string]any{"webhook": w}
	}
	return c
}

func (d *Device) snapshot(ctx context.Context, cmd, id, kind string) {
	d.mu.Lock()
	if time.Since(d.lastSnap) < 3*time.Second {
		d.mu.Unlock()
		d.fail(cmd, id, "busy", "a snapshot was just taken")
		return
	}
	d.lastSnap = time.Now()
	d.mu.Unlock()
	src := d.cam.RTSPSub
	if src == "" {
		src = d.cam.RTSP
	}
	jpg, err := grabJPEG(ctx, d.cfg.FFmpeg, src, 1280)
	if err != nil {
		code := "io"
		if errors.Is(err, errLowMemory) {
			code = "busy"
		}
		d.event("warn", "upload", "snapshot_failed", err.Error())
		d.fail(cmd, id, code, err.Error())
		return
	}
	if th, err := thumbnail(jpg); err == nil {
		d.pub(d.base()+"/thumb", th, true)
	}
	at := time.Now()
	if d.cam.Webhook.URL != "" {
		if err := uploadSnapshot(ctx, d.cam.Webhook.URL, d.cam.Webhook.Token, kind, jpg, at); err != nil {
			d.event("warn", "upload", "snapshot_failed", err.Error())
			d.fail(cmd, id, "network", err.Error())
			return
		}
	}
	d.event("info", "upload", "snapshot_sent", "snapshot uploaded")
	d.done(cmd, id, map[string]any{"ok": true, "file": "snap-" + strconv.FormatInt(at.Unix(), 10) + ".jpg", "bytes": len(jpg)})
}

// listSegments is the record/list result: a list of {file, size, mtime}, newest first.
func (d *Device) listSegments(n int) []map[string]any {
	dir := filepath.Join(d.cfg.DataDir, d.cam.Device.ID)
	ents, _ := os.ReadDir(dir)
	out := []map[string]any{}
	for _, e := range ents {
		if info, err := e.Info(); err == nil && strings.HasSuffix(e.Name(), ".mp4") {
			out = append(out, map[string]any{"file": e.Name(), "size": info.Size(), "mtime": info.ModTime().Unix()})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["file"].(string) > out[j]["file"].(string) })
	if n > 0 && len(out) > n {
		out = out[:n]
	}
	return out
}

func (d *Device) reboot(reason string) {
	d.event("warn", "system", "reboot", "gateway restart: "+reason)
	d.mu.Lock()
	c := d.client
	d.mu.Unlock()
	if c != nil && c.IsConnected() {
		c.Publish(d.base()+"/status", 1, true, "offline").WaitTimeout(3 * time.Second)
		c.Disconnect(250)
	}
	d.pipe.Restart()
	time.Sleep(2 * time.Second)
	d.mu.Lock()
	d.bootID, d.bootAt, d.seq = newBootID(), time.Now(), 0
	d.mu.Unlock()
	if truthy(d.cam.MQTT.Enabled) && d.cam.MQTT.Host != "" {
		d.connect()
	}
}
