package streamflow

import (
	"math"
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of boxes/path.ts: SAFE dotted-path get/set + template resolution over
// the run bag. Values use the yamljs model (*y.Map in JS key order, []any,
// float64, string, bool, nil, y.Undefined). __proto__ / prototype /
// constructor segments are refused.

var forbiddenKeys = map[string]bool{"__proto__": true, "prototype": true, "constructor": true}

// splitPath splits a dotted path, dropping empty segments.
func splitPath(path string) []string {
	var out []string
	for _, s := range strings.Split(path, ".") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// getPath reads a value at a dotted path; Undefined when any segment is
// missing or unsafe.
func getPath(bag any, path string) any {
	cur := bag
	for _, seg := range splitPath(path) {
		if forbiddenKeys[seg] || y.IsNullish(cur) {
			return y.Undefined
		}
		switch c := cur.(type) {
		case []any:
			n := y.StringToNumber(seg)
			if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < 0 || n >= float64(len(c)) {
				return y.Undefined
			}
			cur = c[int(n)]
		case *y.Map:
			cur = c.Get(seg)
		default:
			return y.Undefined
		}
	}
	return cur
}

// setPath sets a value at a dotted path on a plain object, creating
// intermediate objects; refuses forbidden keys.
func setPath(root *y.Map, path string, value any) {
	segs := splitPath(path)
	if len(segs) == 0 {
		return
	}
	for _, s := range segs {
		if forbiddenKeys[s] {
			return
		}
	}
	cur := root
	for _, seg := range segs[:len(segs)-1] {
		next, ok := cur.Get(seg).(*y.Map)
		if !ok || next == nil {
			next = y.NewMap()
			cur.Set(seg, next)
		}
		cur = next
	}
	cur.Set(segs[len(segs)-1], value)
}

var (
	fullTemplate   = regexp.MustCompile(`^\{\{\s*([^}]+?)\s*\}\}$`)
	inlineTemplate = regexp.MustCompile(`\{\{\s*([^}]+?)\s*\}\}`)
)

// resolveValue resolves a config value against the bag: an exact `{{ path }}`
// string → the typed value; embedded templates → interpolation; arrays and
// objects deep-resolved; anything else unchanged.
func resolveValue(value, bag any) any {
	switch v := value.(type) {
	case string:
		if m := fullTemplate.FindStringSubmatch(v); m != nil {
			return getPath(bag, m[1])
		}
		if strings.Contains(v, "{{") {
			return inlineTemplate.ReplaceAllStringFunc(v, func(s string) string {
				return stringifyValue(getPath(bag, inlineTemplate.FindStringSubmatch(s)[1]))
			})
		}
		return v
	case []any:
		out := make([]any, len(v))
		for i, e := range v {
			out[i] = resolveValue(e, bag)
		}
		return out
	case *y.Map:
		if v == nil {
			return v
		}
		out := y.NewMap()
		for _, k := range v.Keys() {
			if forbiddenKeys[k] {
				continue
			}
			out.Set(k, resolveValue(v.Get(k), bag))
		}
		return out
	}
	return value
}

// stringifyValue coerces a resolved value for inline interpolation.
func stringifyValue(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64, bool:
		return y.ToString(x)
	}
	if y.IsUndefined(v) {
		return ""
	}
	s, err := y.Stringify(v)
	if err != nil {
		return ""
	}
	return s
}

// resolveString resolves a value to a string ("" when missing).
func resolveString(value, bag any) string { return stringifyValue(resolveValue(value, bag)) }

// jsonString is JSON.stringify for the value model (Go values pass through
// JSON first so struct field order is kept).
func jsonString(v any) string {
	if v == nil || y.IsUndefined(v) {
		s, _ := y.Stringify(v)
		return s
	}
	switch v.(type) {
	case *y.Map, []any, string, float64, bool:
		s, _ := y.Stringify(v)
		return s
	}
	raw, err := jsx.Stringify(v)
	if err != nil {
		return "null"
	}
	parsed, err := y.ParseJSON([]byte(raw))
	if err != nil {
		return raw
	}
	s, _ := y.Stringify(parsed)
	return s
}

// toValue converts a Go value to the value model (through JSON).
func toValue(v any) any {
	switch v.(type) {
	case nil, *y.Map, []any, string, float64, bool:
		return v
	}
	if y.IsUndefined(v) {
		return v
	}
	parsed, err := y.ParseJSON([]byte(jsonString(v)))
	if err != nil {
		return nil
	}
	return parsed
}

// asObject is `v && typeof v === 'object' && !Array.isArray(v) ? v : {}`.
func asObject(v any) *y.Map {
	if m, ok := v.(*y.Map); ok && m != nil {
		return m
	}
	return y.NewMap()
}
