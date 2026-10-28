// Package cameras is the in-core Studio App «Cameras»: a fleet console for
// OpenCam cameras (Thingino firmware) over MQTT. One always-on subscriber per
// app (the app's `mqtt:` broker, like fleet), a per-app cameras.db
// (inventory + last hello/state + bounded state history + commands + a
// bounded event log) and a command sender with the OpenCam envelope and the
// uniform response correlation, exposed at /apps/:app/plugins/cameras.
//
// The wire contract is opencameras/docs/STREAMHUB.md (api: 1) +
// docs/MQTT.md; internal design notes §4 is the design.
package cameras

import (
	"math"
	"regexp"
	"sort"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// PluginID is the built-in id (builtins.json).
const PluginID = "cameras"

// DefaultBaseTopic is the topic root (`mqtt.base_topic = opencam/%device`).
const DefaultBaseTopic = "opencam"

// Topic layout (STREAMHUB.md §3), with root = the configured base topic:
//
//	<root>/<dev>/hello          ← retained identity + caps
//	<root>/<dev>/status         ← retained online/offline (LWT)
//	<root>/<dev>/state          ← retained full state
//	<root>/<dev>/event          ← one event-log line
//	<root>/<dev>/res/<g>/<a>    ← command response
//	<root>/<dev>/thumb          ← retained 320px JPEG
//	<root>/<dev>/cmd/<g>/<a>    → command

// Topic kinds.
const (
	KindHello  = "hello"
	KindStatus = "status"
	KindState  = "state"
	KindEvent  = "event"
	KindRes    = "res"
	KindThumb  = "thumb"
)

// NormalizeRoot trims blanks and slashes; "" → DefaultBaseTopic.
func NormalizeRoot(root string) string {
	r := strings.Trim(y.Trim(root), "/")
	if r == "" {
		return DefaultBaseTopic
	}
	return r
}

// Subscriptions are the wildcard filters opened per app.
func Subscriptions(root string) []string {
	r := NormalizeRoot(root)
	return []string{r + "/+/hello", r + "/+/status", r + "/+/state", r + "/+/event", r + "/+/res/#", r + "/+/thumb"}
}

// CommandTopic is where cmd ("ptz/dir", "reboot") for device is published.
func CommandTopic(root, device, cmd string) string {
	return NormalizeRoot(root) + "/" + device + "/cmd/" + cmd
}

// ParseTopic splits an inbound topic into (device, kind, rest); rest is the
// command name of a res topic ("ptz/goto"). ok=false for anything else.
func ParseTopic(root, topic string) (device, kind, rest string, ok bool) {
	prefix := NormalizeRoot(root) + "/"
	if !strings.HasPrefix(topic, prefix) {
		return "", "", "", false
	}
	parts := strings.Split(topic[len(prefix):], "/")
	if len(parts) < 2 || !ValidDevice(parts[0]) {
		return "", "", "", false
	}
	switch parts[1] {
	case KindHello, KindStatus, KindState, KindEvent, KindThumb:
		if len(parts) != 2 {
			return "", "", "", false
		}
		return parts[0], parts[1], "", true
	case KindRes:
		if len(parts) < 3 || len(parts) > 4 {
			return "", "", "", false
		}
		return parts[0], KindRes, strings.Join(parts[2:], "/"), true
	}
	return "", "", "", false
}

var deviceRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// ValidDevice: a device id is one safe topic level (no wildcards, no '/').
func ValidDevice(id string) bool { return deviceRe.MatchString(id) }

// ---------------------------------------------------------------------------
// Command catalog (docs/MQTT.md "Comandos" + STREAMHUB.md)
// ---------------------------------------------------------------------------

// CommandSpec describes one allowlisted command.
type CommandSpec struct {
	// Cap is the hello capability the command needs ("" = none).
	Cap string
	// Long commands answer `accepted` first, then progress, then done/failed.
	Long bool
	// Dangerous commands need an explicit confirm and are audited.
	Dangerous bool
	// Config commands carry `if_rev`.
	Config bool
	// Ephemeral commands (the PTZ deadman repeat) are published but not
	// persisted: the pad repeats them every 300 ms.
	Ephemeral bool
}

// Commands is the allowlist.
var Commands = map[string]CommandSpec{
	"status": {}, "hello": {}, "events": {},
	"reboot": {Long: true, Dangerous: true},

	"stream/start": {}, "stream/stop": {}, "stream/status": {}, "stream/set": {},
	"snapshot/take": {}, "snapshot/set": {},
	"video/set":    {},
	"record/start": {Cap: "record"}, "record/stop": {Cap: "record"}, "record/status": {Cap: "record"}, "record/list": {Cap: "record"},

	"ptz/move": {Cap: "ptz"}, "ptz/goto": {Cap: "ptz"}, "ptz/dir": {Cap: "ptz", Ephemeral: true},
	"ptz/stop": {Cap: "ptz"}, "ptz/home": {Cap: "ptz"}, "ptz/status": {Cap: "ptz"}, "ptz/presets": {Cap: "ptz"},
	"ptz/preset": {Cap: "ptz"}, "ptz/preset-save": {Cap: "ptz"}, "ptz/preset-delete": {Cap: "ptz"},

	"queue/status": {}, "queue/flush": {}, "queue/purge": {Dangerous: true},
	"wifi/status": {}, "wifi/add": {}, "wifi/remove": {Dangerous: true}, "wifi/failover": {},
	"config/get": {}, "config/set": {Config: true}, "config/import": {Config: true},
	"voice/say": {Cap: "voice"}, "voice/list": {Cap: "voice"},
	"system/status": {}, "system/reboot": {Long: true, Dangerous: true}, "system/safe-clear": {},
	"firmware/check": {}, "firmware/upgrade": {Long: true, Dangerous: true},
	"recovery/status": {},
	"ini/status":      {}, "ini/export": {}, "ini/reset": {Long: true, Dangerous: true},
	"sd/status": {Cap: "sd"}, "sd/list": {Cap: "sd"}, "sd/format": {Cap: "sd", Dangerous: true},
}

// rebootLike commands end with the camera reconnecting: a fresh `hello`
// (new boot_id) after `accepted` resolves them as done.
var rebootLike = map[string]bool{"reboot": true, "system/reboot": true, "ini/reset": true, "firmware/upgrade": true}

// CommandNames is the sorted allowlist (error messages, docs).
func CommandNames() []string {
	out := make([]string, 0, len(Commands))
	for k := range Commands {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// CommandError is a 400.
type CommandError struct{ msg string }

func (e *CommandError) Error() string { return e.msg }

func cmdErr(msg string) error { return &CommandError{msg} }

var (
	httpURL   = regexp.MustCompile(`(?i)^https?://`)
	sha256Re  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	ptzDirs   = map[string]bool{"up": true, "down": true, "left": true, "right": true, "ul": true, "ur": true, "dl": true, "dr": true}
	reserved  = map[string]bool{"id": true, "ts": true, "exp": true, "if_rev": true}
	holdMsMin = 100.0
	holdMsMax = 5000.0
)

// ValidateCommand checks cmd against the allowlist and normalizes its args
// (a decoded JSON object or nil). Envelope keys in args are dropped: the
// service owns id/ts/exp/if_rev.
func ValidateCommand(device, cmd string, args any) (CommandSpec, *y.Map, error) {
	spec, ok := Commands[cmd]
	if !ok {
		return spec, nil, cmdErr("unknown command '" + cmd + "'")
	}
	in, _ := args.(*y.Map)
	if args != nil && !y.IsUndefined(args) && in == nil {
		return spec, nil, cmdErr("args must be an object")
	}
	out := y.NewMap()
	if in != nil {
		for _, k := range in.Keys() {
			if !reserved[k] {
				out.Set(k, in.Get(k))
			}
		}
	}
	switch cmd {
	case "ptz/dir":
		d, _ := out.Get("dir").(string)
		if !ptzDirs[d] {
			return spec, nil, cmdErr("ptz/dir requires dir (up|down|left|right|ul|ur|dl|dr)")
		}
		if v, ok := num(out.Get("hold_ms")); ok {
			out.Set("hold_ms", math.Round(math.Min(holdMsMax, math.Max(holdMsMin, v))))
		}
	case "ptz/preset", "ptz/preset-delete":
		if !present(out.Get("preset")) {
			return spec, nil, cmdErr(cmd + " requires 'preset'")
		}
	case "voice/say":
		if s, _ := out.Get("key").(string); y.Trim(s) == "" {
			return spec, nil, cmdErr("voice/say requires 'key'")
		}
	case "firmware/check", "firmware/upgrade":
		u, _ := out.Get("url").(string)
		sha, _ := out.Get("sha256").(string)
		if !httpURL.MatchString(u) {
			return spec, nil, cmdErr(cmd + " requires an http(s) 'url'")
		}
		sha = strings.ToLower(y.Trim(sha))
		if !sha256Re.MatchString(sha) {
			return spec, nil, cmdErr(cmd + " requires a 64-hex 'sha256'")
		}
		out.Set("sha256", sha)
	case "config/set":
		if s, _ := out.Get("key").(string); y.Trim(s) == "" {
			return spec, nil, cmdErr("config/set requires 'key'")
		}
	case "config/import":
		if c, ok := out.Get("config").(*y.Map); !ok || c == nil || c.Len() == 0 {
			return spec, nil, cmdErr("config/import requires a non-empty 'config' object")
		}
	case "sd/format":
		if c, _ := out.Get("confirm").(string); c != device {
			return spec, nil, cmdErr("sd/format requires confirm = the device id")
		}
	}
	return spec, out, nil
}

func present(v any) bool { return v != nil && !y.IsUndefined(v) && v != "" }

func num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		if !math.IsNaN(x) && !math.IsInf(x, 0) {
			return x, true
		}
	case string:
		n := y.StringToNumber(x)
		if !math.IsNaN(n) && !math.IsInf(n, 0) {
			return n, true
		}
	}
	return 0, false
}

// ---------------------------------------------------------------------------
// Inbound payloads
// ---------------------------------------------------------------------------

func parseObject(raw []byte) *y.Map {
	v, err := y.ParseJSON(raw)
	if err != nil {
		return nil
	}
	m, _ := v.(*y.Map)
	return m
}

// parseStatus reads the LWT: plain `online`/`offline`, or {"status": …}.
func parseStatus(raw []byte) string {
	s := strings.ToLower(y.Trim(string(raw)))
	if m := parseObject(raw); m != nil {
		s, _ = m.Get("status").(string)
		s = strings.ToLower(s)
	}
	if s == "online" {
		return "online"
	}
	return "offline"
}

// Response is the uniform `res` (STREAMHUB.md §4.2), normalized.
type Response struct {
	ID     string
	Cmd    string
	OK     bool
	Phase  string // accepted | progress | done | failed
	Code   string
	Error  string
	Result any
	Pct    *float64
	Raw    *y.Map
}

// ParseResponse normalizes a res body. A legacy body (no `phase`) is final:
// done when ok (or when `ok` is absent and result.ok is not false), else
// failed. nil when the body is not an object.
func ParseResponse(cmdFromTopic string, raw []byte) *Response {
	m := parseObject(raw)
	if m == nil {
		return nil
	}
	r := &Response{Raw: m, Result: m.Get("result")}
	r.ID, _ = m.Get("id").(string)
	r.Cmd, _ = m.Get("cmd").(string)
	if r.Cmd == "" {
		r.Cmd = cmdFromTopic
	}
	r.Code, _ = m.Get("code").(string)
	r.Error, _ = m.Get("error").(string)
	if y.IsUndefined(r.Result) {
		r.Result = nil
	}
	res, _ := r.Result.(*y.Map)
	if ok, isBool := m.Get("ok").(bool); isBool {
		r.OK = ok
	} else {
		r.OK = res == nil || res.Get("ok") != false
	}
	if res != nil && r.Error == "" {
		r.Error, _ = res.Get("error").(string)
	}
	switch p, _ := m.Get("phase").(string); p {
	case "accepted", "progress":
		r.Phase = p
		if !r.OK {
			r.Phase = "failed"
		}
	case "done", "failed":
		r.Phase = p
		if p == "done" && !r.OK {
			r.Phase = "failed"
		}
	default:
		r.Phase = "done"
		if !r.OK {
			r.Phase = "failed"
		}
	}
	if res != nil {
		if n, ok := num(res.Get("pct")); ok {
			r.Pct = &n
		}
	}
	return r
}

// Event is one parsed event-log line (MQTT.md "Eventos").
type Event struct {
	Seq    *int64
	BootID string
	Ts     string // ISO (from `time`, or epoch `ts`, or receipt time)
	Level  string
	Src    string
	Event  string
	Msg    string
	Raw    *y.Map
}

// ParseEvent reads an event body; nil when not a JSON object.
func ParseEvent(raw []byte) *Event {
	m := parseObject(raw)
	if m == nil {
		return nil
	}
	e := &Event{Raw: m}
	if n, ok := num(m.Get("seq")); ok && n >= 0 {
		v := int64(n)
		e.Seq = &v
	}
	e.BootID, _ = m.Get("boot_id").(string)
	e.Ts, _ = m.Get("time").(string)
	e.Level, _ = m.Get("level").(string)
	switch e.Level {
	case "info", "warn", "error", "debug":
	default:
		e.Level = "info"
	}
	e.Src, _ = m.Get("src").(string)
	e.Event, _ = m.Get("event").(string)
	e.Msg, _ = m.Get("msg").(string)
	return e
}

// dig walks nested objects: dig(state, "net", "rssi").
func dig(m *y.Map, path ...string) any {
	var cur any = m
	for _, k := range path {
		mm, ok := cur.(*y.Map)
		if !ok || mm == nil {
			return nil
		}
		cur = mm.Get(k)
	}
	if y.IsUndefined(cur) {
		return nil
	}
	return cur
}

func digNum(m *y.Map, path ...string) *float64 {
	if n, ok := num(dig(m, path...)); ok {
		return &n
	}
	return nil
}

func digStr(m *y.Map, path ...string) *string {
	if s, ok := dig(m, path...).(string); ok {
		return &s
	}
	return nil
}

func digBool(m *y.Map, path ...string) *bool {
	if b, ok := dig(m, path...).(bool); ok {
		return &b
	}
	return nil
}

// capsOf reads hello.caps (nil = unknown: an api-0 camera).
func capsOf(hello *y.Map) []string {
	arr, ok := dig(hello, "caps").([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
