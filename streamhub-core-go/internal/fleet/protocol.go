// Package fleet is the port of src/modules/fleet: the in-core MQTT glue of the
// `fleet` plugin — an always-on per-app subscriber to agent telemetry/status/
// command results, a per-app fleet.db (registry + rolling history + commands)
// and the command publisher, exposed at /apps/:app/plugins/fleet.
package fleet

import (
	"math"
	"regexp"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of fleet.protocol.ts — the topic layout + payload schemas shared with
// the StreamHub Agent (https://streamhub.studio/docs/features/fleet):
//
//	<prefix>/agents/<agentId>/telemetry    agent → broker (retained)
//	<prefix>/agents/<agentId>/status       agent → broker (retained, LWT)
//	<prefix>/agents/<agentId>/cmd          broker → agent
//	<prefix>/agents/<agentId>/cmd/result   agent → broker

// Subscriptions are the wildcard filters the core opens per app.
func Subscriptions(prefix string) []string {
	base := NormalizePrefix(prefix)
	return []string{base + "/agents/+/telemetry", base + "/agents/+/status", base + "/agents/+/cmd/result"}
}

// CommandTopic is the topic a command for agentID is published to.
func CommandTopic(prefix, agentID string) string {
	return NormalizePrefix(prefix) + "/agents/" + agentID + "/cmd"
}

// AgentsRoot is the root every fleet topic sits under.
func AgentsRoot(prefix string) string { return NormalizePrefix(prefix) + "/agents/" }

// NormalizePrefix strips trailing slashes.
func NormalizePrefix(prefix string) string { return strings.TrimRight(prefix, "/") }

// Topic kinds.
const (
	KindTelemetry = "telemetry"
	KindStatus    = "status"
	KindCmdResult = "cmd_result"
)

// ParseTopic splits an inbound topic into (agentID, kind); ok=false when the
// topic is not a fleet topic.
func ParseTopic(prefix, topic string) (agentID, kind string, ok bool) {
	root := AgentsRoot(prefix)
	if !strings.HasPrefix(topic, root) {
		return "", "", false
	}
	parts := strings.Split(topic[len(root):], "/")
	if parts[0] == "" {
		return "", "", false
	}
	switch strings.Join(parts[1:], "/") {
	case "telemetry":
		return parts[0], KindTelemetry, true
	case "status":
		return parts[0], KindStatus, true
	case "cmd/result":
		return parts[0], KindCmdResult, true
	}
	return "", "", false
}

// Commands are the four supported commands.
var Commands = []string{"restart", "ota", "config", "ping"}

// CommandError is FleetCommandError (→ 400).
type CommandError struct{ msg string }

func (e *CommandError) Error() string { return e.msg }

var (
	httpURL  = regexp.MustCompile(`(?i)^https?://`)
	sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ValidateCommand validates + normalizes {command, args} into the published
// args (JS key order kept). command/args are decoded JSON values.
func ValidateCommand(command, args any) (string, *y.Map, error) {
	name, _ := command.(string)
	known := false
	for _, c := range Commands {
		known = known || name == c
	}
	if !known {
		return "", nil, &CommandError{"unknown command '" + y.ToString(command) + "' (allowed: " + strings.Join(Commands, ", ") + ")"}
	}
	bag, ok := args.(*y.Map)
	if !ok || bag == nil {
		bag = y.NewMap()
	}
	switch name {
	case "ota":
		url, version := str(bag.Get("url")), str(bag.Get("version"))
		sha := strings.ToLower(str(bag.Get("sha256")))
		if url == "" {
			return "", nil, &CommandError{"ota requires 'url'"}
		}
		if !httpURL.MatchString(url) {
			return "", nil, &CommandError{"ota url must be http(s)"}
		}
		if version == "" {
			return "", nil, &CommandError{"ota requires 'version'"}
		}
		if !sha256Re.MatchString(sha) {
			return "", nil, &CommandError{"ota requires a 64-hex sha256"}
		}
		out := y.NewMap()
		out.Set("url", url)
		out.Set("version", version)
		out.Set("sha256", sha)
		return name, out, nil
	case "config":
		cfg := bag
		if inner, ok := bag.Get("config").(*y.Map); ok && inner != nil {
			cfg = inner
		}
		if cfg.Len() == 0 {
			return "", nil, &CommandError{"config requires a non-empty object"}
		}
		out := y.NewMap()
		out.Set("config", cfg)
		return name, out, nil
	}
	return name, y.NewMap(), nil
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return y.Trim(s)
	}
	return ""
}

// Num coerces a JSON value to a finite number clamped to [min,max]
// (typeof number, or Number(string)); ok=false mirrors undefined.
func Num(v any, min, max float64) (float64, bool) {
	var n float64
	switch x := v.(type) {
	case float64:
		n = x
	case string:
		n = y.StringToNumber(x)
	default:
		return 0, false
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, false
	}
	return math.Min(max, math.Max(min, n)), true
}

func numValue(v any, min, max float64) any {
	if n, ok := Num(v, min, max); ok {
		return n
	}
	return y.Undefined
}

// ParseTelemetry parses an inbound telemetry body into the normalized
// snapshot ({...src, cpu, mem, temp, uptime, cameras, disk, battery,
// agentVersion, relay}); a {data:{…}} envelope is unwrapped. nil on non-JSON / non-object.
func ParseTelemetry(raw string) *y.Map {
	v, err := y.ParseJSON([]byte(raw))
	if err != nil {
		return nil
	}
	o, ok := v.(*y.Map)
	if !ok || o == nil {
		return nil
	}
	src := o
	if d, ok := o.Get("data").(*y.Map); ok && d != nil {
		src = d
	}
	out := src.Clone()
	inf := math.Inf(1)
	out.Set("cpu", numValue(src.Get("cpu"), 0, 100))
	out.Set("mem", numValue(src.Get("mem"), 0, 100))
	out.Set("temp", numValue(src.Get("temp"), math.Inf(-1), inf))
	out.Set("uptime", numValue(src.Get("uptime"), 0, inf))
	out.Set("cameras", numValue(src.Get("cameras"), 0, inf))
	out.Set("disk", numValue(src.Get("disk"), 0, 100))
	// battery: percent 0–100, omitted by AC-only hosts (most of the fleet).
	out.Set("battery", numValue(src.Get("battery"), 0, 100))
	if s, ok := src.Get("agentVersion").(string); ok {
		out.Set("agentVersion", s)
	} else {
		out.Set("agentVersion", y.Undefined)
	}
	if s, ok := src.Get("relay").(string); ok {
		out.Set("relay", s)
	} else {
		out.Set("relay", y.Undefined)
	}
	return out
}

// parseStatus reads a status message; a non-JSON body is a bare LWT
// ("online"/"offline"). Returns the status and the agentVersion ("" = none).
func parseStatus(raw string) (string, string) {
	v, err := y.ParseJSON([]byte(raw))
	if err != nil || v == nil {
		if strings.ToLower(y.Trim(raw)) == "online" {
			return "online", ""
		}
		return "offline", ""
	}
	o, _ := v.(*y.Map)
	if o == nil {
		return "offline", ""
	}
	status := "offline"
	if o.Get("status") == "online" {
		status = "online"
	}
	ver, _ := o.Get("agentVersion").(string)
	return status, ver
}

// parseResult reads a cmd/result body: {...o, id, command, ok, message, ts};
// nil unless an object carrying a string id.
func parseResult(raw string) *y.Map {
	v, err := y.ParseJSON([]byte(raw))
	if err != nil {
		return nil
	}
	o, ok := v.(*y.Map)
	if !ok || o == nil {
		return nil
	}
	id, ok := o.Get("id").(string)
	if !ok {
		return nil
	}
	out := o.Clone()
	out.Set("id", id)
	for _, k := range []string{"command"} {
		if s, ok := o.Get(k).(string); ok {
			out.Set(k, s)
		} else {
			out.Set(k, y.Undefined)
		}
	}
	out.Set("ok", o.Get("ok") == true)
	for _, k := range []string{"message", "ts"} {
		if s, ok := o.Get(k).(string); ok {
			out.Set(k, s)
		} else {
			out.Set(k, y.Undefined)
		}
	}
	return out
}
