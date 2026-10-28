package mcpserver

import (
	"math"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Input validation reproducing zod 3 (which the TypeScript server's SDK ran
// against each tool's raw shape): same issue objects, same key order, same
// messages — the model sees the JSON.stringify(issues, null, 2) text. The
// rules are derived from the emitted JSON Schema (catalog.json), covering the
// constructs the catalogue uses: string, boolean, number/integer with
// minimum/exclusiveMinimum/maximum, enum, const true (z.literal), arrays of
// strings, records (additionalProperties) and integer|null (nullable).
// Unknown keys are stripped (z.object default), not rejected.

func parsedType(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64:
		if math.IsNaN(x) {
			return "nan"
		}
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case *y.Map:
		return "object"
	}
	if y.IsUndefined(v) {
		return "undefined"
	}
	return "object"
}

type issueList struct{ items []any }

func pathOf(path []any) []any { return append([]any{}, path...) }

func issue(kv ...any) *y.Map {
	m := y.NewMap()
	for i := 0; i+1 < len(kv); i += 2 {
		m.Set(kv[i].(string), kv[i+1])
	}
	return m
}

func typeMessage(expected, received string) string {
	if received == "undefined" {
		return "Required"
	}
	return "Expected " + expected + ", received " + received
}

// invalidType is the issue of a failed base type check.
func (l *issueList) invalidType(expected string, v any, path []any) {
	r := parsedType(v)
	l.items = append(l.items, issue("code", "invalid_type", "expected", expected, "received", r,
		"path", pathOf(path), "message", typeMessage(expected, r)))
}

func joinValues(vals []any) string {
	parts := make([]string, len(vals))
	for i, v := range vals {
		if s, ok := v.(string); ok {
			parts[i] = "'" + s + "'"
		} else {
			parts[i] = y.ToString(v)
		}
	}
	return strings.Join(parts, " | ")
}

// check validates v against one property schema.
func (l *issueList) check(s *y.Map, v any, path []any) {
	if any, ok := s.Get("anyOf").([]any); ok {
		if v == nil { // .nullable()
			return
		}
		for _, alt := range any {
			if m, ok := alt.(*y.Map); ok && m.Get("type") != "null" {
				l.check(m, v, path)
				return
			}
		}
		return
	}
	if c, ok := s.Lookup("const"); ok {
		if !strictEq(v, c) {
			m := y.NewMap()
			if !y.IsUndefined(v) {
				m.Set("received", v)
			}
			m.Set("code", "invalid_literal")
			m.Set("expected", c)
			m.Set("path", pathOf(path))
			cs, _ := y.Stringify(c)
			m.Set("message", "Invalid literal value, expected "+cs)
			l.items = append(l.items, m)
		}
		return
	}
	if enum, ok := s.Get("enum").([]any); ok {
		str, isStr := v.(string)
		if !isStr {
			r := parsedType(v)
			exp := joinValues(enum)
			l.items = append(l.items, issue("expected", exp, "received", r, "code", "invalid_type",
				"path", pathOf(path), "message", typeMessage(exp, r)))
			return
		}
		for _, e := range enum {
			if e == str {
				return
			}
		}
		l.items = append(l.items, issue("received", str, "code", "invalid_enum_value", "options", enum,
			"path", pathOf(path), "message", "Invalid enum value. Expected "+joinValues(enum)+", received '"+str+"'"))
		return
	}
	switch s.Get("type") {
	case "string":
		if _, ok := v.(string); !ok {
			l.invalidType("string", v, path)
		}
	case "boolean":
		if _, ok := v.(bool); !ok {
			l.invalidType("boolean", v, path)
		}
	case "integer", "number":
		f, ok := v.(float64)
		if !ok {
			l.invalidType("number", v, path)
			return
		}
		if s.Get("type") == "integer" && f != math.Trunc(f) {
			l.items = append(l.items, issue("code", "invalid_type", "expected", "integer", "received", "float",
				"message", "Expected integer, received float", "path", pathOf(path)))
		}
		if m, ok := s.Get("minimum").(float64); ok && f < m {
			l.bound("too_small", "minimum", m, true, path)
		}
		if m, ok := s.Get("exclusiveMinimum").(float64); ok && f <= m {
			l.bound("too_small", "minimum", m, false, path)
		}
		if m, ok := s.Get("maximum").(float64); ok && f > m {
			l.bound("too_big", "maximum", m, true, path)
		}
		if m, ok := s.Get("exclusiveMaximum").(float64); ok && f >= m {
			l.bound("too_big", "maximum", m, false, path)
		}
	case "array":
		arr, ok := v.([]any)
		if !ok {
			l.invalidType("array", v, path)
			return
		}
		if items, ok := s.Get("items").(*y.Map); ok {
			for i, e := range arr {
				l.check(items, e, append(pathOf(path), float64(i)))
			}
		}
	case "object":
		m, ok := v.(*y.Map)
		if !ok || m == nil {
			l.invalidType("object", v, path)
			return
		}
		if vs, ok := s.Get("additionalProperties").(*y.Map); ok && vs.Len() > 0 {
			for _, k := range m.Keys() {
				l.check(vs, m.Get(k), append(pathOf(path), k))
			}
		}
	}
}

func (l *issueList) bound(code, key string, limit float64, inclusive bool, path []any) {
	n := y.JSNumberString(limit)
	var msg string
	switch {
	case code == "too_small" && inclusive:
		msg = "Number must be greater than or equal to " + n
	case code == "too_small":
		msg = "Number must be greater than " + n
	case inclusive:
		msg = "Number must be less than or equal to " + n
	default:
		msg = "Number must be less than " + n
	}
	l.items = append(l.items, issue("code", code, key, limit, "type", "number", "inclusive", inclusive,
		"exact", false, "message", msg, "path", pathOf(path)))
}

func strictEq(a, b any) bool {
	switch x := b.(type) {
	case bool, string, float64:
		return a == x
	case nil:
		return a == nil
	}
	return false
}

// validateArgs is z.object(shape).safeParse(args): the stripped, validated
// arguments, or the zod issues.
func validateArgs(schema *y.Map, args any) (*y.Map, []any) {
	var l issueList
	in, ok := args.(*y.Map)
	if !ok || in == nil {
		l.invalidType("object", args, nil)
		return nil, l.items
	}
	props, _ := schema.Get("properties").(*y.Map)
	required := map[string]bool{}
	if req, ok := schema.Get("required").([]any); ok {
		for _, r := range req {
			if s, ok := r.(string); ok {
				required[s] = true
			}
		}
	}
	out := y.NewMap()
	if props == nil {
		return out, nil
	}
	for _, k := range props.Keys() {
		v := in.Get(k)
		if y.IsUndefined(v) && !required[k] {
			continue
		}
		before := len(l.items)
		if ps, ok := props.Get(k).(*y.Map); ok {
			l.check(ps, v, []any{k})
		}
		if len(l.items) == before && !y.IsUndefined(v) {
			out.Set(k, v)
		}
	}
	if len(l.items) > 0 {
		return nil, l.items
	}
	return out, nil
}
