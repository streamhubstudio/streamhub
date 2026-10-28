// Package visionapps is modules/vision-apps: the four vision Studio Apps
// (occupancy / counting / crowd / demography) served by ONE model-
// parametrized service — per-(app, model) SQLite stores, per-room settings
// overrides resolved over model defaults + tag configs, the detection sink
// the plugins event channel taps, and the idempotent boot migration that
// split the retired monolithic `vision` plugin.
package visionapps

import (
	"fmt"
	"math"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of vision-settings.ts + vision.types.ts: pure per-model settings
// validation/normalization (coordinates clamped to [0,1], 4-decimal
// rounding, unknown keys dropped).

// Models are the four model-app ids (a model id IS a plugin id).
var Models = []string{"occupancy", "counting", "crowd", "demography"}

// IsModel reports one of the four model ids.
func IsModel(v string) bool {
	for _, m := range Models {
		if m == v {
			return true
		}
	}
	return false
}

// EventModel maps a `<family>.<name>` event to its model ("" = none).
func EventModel(event string) string {
	switch {
	case strings.HasPrefix(event, "occupancy."):
		return "occupancy"
	case strings.HasPrefix(event, "count."):
		return "counting"
	case strings.HasPrefix(event, "crowd."):
		return "crowd"
	case strings.HasPrefix(event, "demography."):
		return "demography"
	}
	return ""
}

// SettingsError is VisionSettingsError (→ 400).
type SettingsError struct{ Msg string }

func (e *SettingsError) Error() string { return e.Msg }

func fail(format string, a ...any) { panic(&SettingsError{fmt.Sprintf(format, a...)}) }

// jsRound is Math.round (half toward +∞).
func jsRound(x float64) float64 { return math.Floor(x+0.5) + 0 }

func round4(n float64) float64 { return jsRound(n*10000) / 10000 }

// num coerces `typeof v === 'string' ? Number(v) : v` to a finite number.
func num(v any) (float64, bool) {
	if s, ok := v.(string); ok {
		v = y.StringToNumber(s)
	}
	f, ok := v.(float64)
	return f, ok && !math.IsNaN(f) && !math.IsInf(f, 0)
}

func clamp01(v any) float64 {
	f, ok := num(v)
	if !ok {
		fail("coordinate must be a finite number")
	}
	return round4(math.Min(1, math.Max(0, f)))
}

// optNum: absent/null/” → (0,false); non-numeric → error; else clamped.
func optNum(v any, lo, hi float64, label string) (float64, bool) {
	if y.IsNullish(v) || v == "" {
		return 0, false
	}
	f, ok := num(v)
	if !ok {
		fail("%s must be a number", label)
	}
	return math.Min(hi, math.Max(lo, f)), true
}

func asObject(raw any, label string) *y.Map {
	m, ok := raw.(*y.Map)
	if !ok || m == nil {
		fail("%s must be an object", label)
	}
	return m
}

func normPoints(raw any, label string) []any {
	list, ok := raw.([]any)
	if !ok {
		fail("%s must be an array of [x,y] points", label)
	}
	out := make([]any, 0, len(list))
	for _, p := range list {
		pt, ok := p.([]any)
		if !ok || len(pt) < 2 {
			fail("%s point must be [x,y]", label)
		}
		out = append(out, []any{clamp01(pt[0]), clamp01(pt[1])})
	}
	return out
}

func trimID(v any, fallback string) string {
	if s, ok := v.(string); ok {
		if t := y.Trim(s); t != "" {
			return t
		}
	}
	return fallback
}

func trimTag(v any) string {
	if s, ok := v.(string); ok {
		return y.Trim(s)
	}
	return ""
}

func obj(kv ...any) *y.Map {
	m := y.NewMap()
	for i := 0; i+1 < len(kv); i += 2 {
		m.Set(kv[i].(string), kv[i+1])
	}
	return m
}

func validateZone(raw any, i int) *y.Map {
	o := asObject(raw, fmt.Sprintf("zone[%d]", i))
	points := normPoints(o.Get("points"), fmt.Sprintf("zone[%d].points", i))
	if len(points) < 3 {
		fail("zone[%d] needs at least 3 points", i)
	}
	detect := "personas"
	if o.Get("detect") == "vehiculos" {
		detect = "vehiculos"
	}
	if d := o.Get("detect"); !y.IsUndefined(d) {
		if s := y.ToString(d); s != "personas" && s != "vehiculos" {
			fail("zone[%d].detect must be personas|vehiculos", i)
		}
	}
	zone := obj("id", trimID(o.Get("id"), fmt.Sprintf("zone-%d", i+1)), "tag", trimTag(o.Get("tag")), "detect", detect, "points", points)
	if c, ok := optNum(o.Get("confidence"), 0, 1, fmt.Sprintf("zone[%d].confidence", i)); ok {
		zone.Set("confidence", round4(c))
	}
	if c, ok := optNum(o.Get("alertLimit"), 0, 100000, fmt.Sprintf("zone[%d].alertLimit", i)); ok {
		zone.Set("alertLimit", jsRound(c))
	}
	if c, ok := optNum(o.Get("alertAfterSec"), 0, 86400, fmt.Sprintf("zone[%d].alertAfterSec", i)); ok {
		zone.Set("alertAfterSec", jsRound(c))
	}
	return zone
}

func validateZones(raw *y.Map) *y.Map {
	zones := []any{}
	switch z := raw.Get("zones").(type) {
	case []any:
		for i, e := range z {
			zones = append(zones, validateZone(e, i))
		}
	default:
		if !y.IsUndefined(z) {
			fail("zones must be an array")
		}
	}
	return obj("zones", zones)
}

func validatePois(raw *y.Map) ([]any, bool) {
	v := raw.Get("pois")
	if y.IsUndefined(v) {
		return nil, false
	}
	list, ok := v.([]any)
	if !ok {
		fail("pois must be an array")
	}
	out := []any{}
	for i, p := range list {
		o := asObject(p, fmt.Sprintf("poi[%d]", i))
		points := normPoints(o.Get("points"), fmt.Sprintf("poi[%d].points", i))
		if len(points) < 3 {
			fail("poi[%d] needs at least 3 points", i)
		}
		out = append(out, obj("id", trimID(o.Get("id"), fmt.Sprintf("poi-%d", i+1)), "tag", trimTag(o.Get("tag")), "points", points))
	}
	return out, true
}

var insides = map[string]bool{"top": true, "bottom": true, "left": true, "right": true}

func validateLine(raw any, i int) *y.Map {
	o := asObject(raw, fmt.Sprintf("line[%d]", i))
	length, ok := optNum(o.Get("length"), 0, 2, fmt.Sprintf("line[%d].length", i))
	if !ok || length <= 0 {
		fail("line[%d] needs a positive length", i)
	}
	inside := y.ToString(y.Coalesce(o.Get("inside"), ""))
	if !insides[inside] {
		fail("line[%d].inside must be top|bottom|left|right", i)
	}
	angle, _ := optNum(o.Get("angle"), -360, 360, fmt.Sprintf("line[%d].angle", i))
	return obj("id", trimID(o.Get("id"), fmt.Sprintf("line-%d", i+1)), "tag", trimTag(o.Get("tag")),
		"x", clamp01(o.Get("x")), "y", clamp01(o.Get("y")), "length", round4(length), "angle", round4(angle), "inside", inside)
}

func validateLines(raw *y.Map) *y.Map {
	lines := []any{}
	switch l := raw.Get("lines").(type) {
	case []any:
		for i, e := range l {
			lines = append(lines, validateLine(e, i))
		}
	default:
		if !y.IsUndefined(l) {
			fail("lines must be an array")
		}
	}
	fps, ok := optNum(raw.Get("fps"), 0.5, 30, "fps")
	if !ok {
		fps = 3.5
	}
	out := obj("lines", lines, "fps", round4(fps))
	if c, ok := optNum(raw.Get("capacity"), 0, 1000000, "capacity"); ok {
		out.Set("capacity", jsRound(c))
	}
	if pois, ok := validatePois(raw); ok {
		out.Set("pois", pois)
	}
	return out
}

var engines = map[string]bool{"local": true, "openai": true, "deepseek": true}

func validateDemography(raw *y.Map) *y.Map {
	engine := y.ToString(y.Coalesce(raw.Get("engine"), "local"))
	if !engines[engine] {
		fail("engine must be local|openai|deepseek")
	}
	interval, ok := optNum(raw.Get("intervalSec"), 5, 86400, "intervalSec")
	if !ok {
		interval = 120
	}
	out := obj("intervalSec", jsRound(interval), "engine", engine)
	if roi := raw.Get("roi"); !y.IsNullish(roi) {
		o := asObject(roi, "roi")
		points := normPoints(o.Get("points"), "roi.points")
		if len(points) < 3 {
			fail("roi needs at least 3 points")
		}
		out.Set("roi", obj("points", points))
	}
	if pois, ok := validatePois(raw); ok {
		out.Set("pois", pois)
	}
	if p := raw.Get("aiPrompt"); !y.IsUndefined(p) {
		s, ok := p.(string)
		if !ok {
			fail("aiPrompt must be a string")
		}
		if t := y.Trim(s); t != "" {
			out.Set("aiPrompt", jsx.UTF16Slice(t, 2000))
		}
	}
	if b, ok := optNum(raw.Get("aiBudgetMonthly"), 0, 1000000, "aiBudgetMonthly"); ok {
		out.Set("aiBudgetMonthly", round4(b))
	}
	return out
}

// ValidateModelSettings validates + normalizes a per-model config_json.
func ValidateModelSettings(model string, raw any) (out *y.Map, err error) {
	defer func() {
		if r := recover(); r != nil {
			se, ok := r.(*SettingsError)
			if !ok {
				panic(r)
			}
			out, err = nil, se
		}
	}()
	if !IsModel(model) {
		fail("unknown model '%s'", model)
	}
	var o *y.Map
	if y.IsNullish(raw) {
		o = y.NewMap()
	} else {
		o = asObject(raw, "config")
	}
	switch model {
	case "occupancy", "crowd":
		return validateZones(o), nil
	case "counting":
		return validateLines(o), nil
	}
	return validateDemography(o), nil
}

// EmptyModelSettings is the canonical empty config_json of a model.
func EmptyModelSettings(model string) *y.Map {
	switch model {
	case "occupancy", "crowd":
		return obj("zones", []any{})
	case "counting":
		return obj("lines", []any{}, "fps", 3.5)
	}
	return obj("intervalSec", 120.0, "engine", "local")
}
