package yamljs

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// JS abstract operations over the value model, for code that ports Node
// logic reading loosely-typed parsed YAML (`!!v`, `Number(v)`, `String(v)`,
// object spread).

// Truthy is JS ToBoolean (`!!v`).
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil, undefinedT:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// IsNullish is `v === null || v === undefined`.
func IsNullish(v any) bool { return v == nil || IsUndefined(v) }

// Coalesce is `a ?? b`.
func Coalesce(a, b any) any {
	if IsNullish(a) {
		return b
	}
	return a
}

// ToString is JS String(v).
func ToString(v any) string { return jsString(v) }

// ToNumber is JS Number(v).
func ToNumber(v any) float64 {
	switch x := v.(type) {
	case undefinedT:
		return math.NaN()
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return StringToNumber(x)
	case time.Time:
		return float64(x.UnixMilli())
	case []any:
		return StringToNumber(jsString(x))
	}
	return math.NaN()
}

var decimalLiteral = regexp.MustCompile(`^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity)$`)

// StringToNumber is the JS StringToNumber grammar: trimmed, "" → 0,
// decimal / Infinity / 0x 0o 0b literals, anything else NaN.
func StringToNumber(s string) float64 {
	s = strings.TrimFunc(s, isJSSpace)
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			n, ok := parseRadix(s[2:], base)
			if !ok {
				return math.NaN()
			}
			return n
		}
	}
	if !decimalLiteral.MatchString(s) {
		return math.NaN()
	}
	switch strings.TrimLeft(s, "+-") {
	case "Infinity":
		if s[0] == '-' {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !isRangeErr(err) {
		return math.NaN()
	}
	return f
}

// parseRadix accumulates a 0x/0o/0b literal's digits as a float64.
func parseRadix(digits string, base int) (float64, bool) {
	if digits == "" {
		return 0, false
	}
	var f float64
	for _, c := range digits {
		var d int
		switch {
		case c >= '0' && c <= '9':
			d = int(c - '0')
		case c >= 'a' && c <= 'z':
			d = int(c-'a') + 10
		case c >= 'A' && c <= 'Z':
			d = int(c-'A') + 10
		default:
			return 0, false
		}
		if d >= base {
			return 0, false
		}
		f = f*float64(base) + float64(d)
	}
	return f, true
}

// isJSSpace is JS WhiteSpace ∪ LineTerminator (String#trim).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// Trim is String#trim.
func Trim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// Spread returns a fresh object holding v's own enumerable properties, as
// `{ ...v }` does: an object is cloned (shallow), a string / array spreads its
// indices, anything else yields {}.
func Spread(v any) *Map {
	switch x := v.(type) {
	case *Map:
		if x != nil {
			return x.Clone()
		}
	case []any:
		m := NewMap()
		for i, e := range x {
			m.Set(strconv.Itoa(i), e)
		}
		return m
	case string:
		m := NewMap()
		for i, u := range utf16.Encode([]rune(x)) {
			m.Set(strconv.Itoa(i), string(utf16.Decode([]uint16{u})))
		}
		return m
	}
	return NewMap()
}

// Assign copies src's own properties onto dst (Object.assign / a spread
// after other spreads) and returns dst.
func Assign(dst *Map, src any) *Map {
	s := Spread(src)
	for _, k := range s.Keys() {
		dst.Set(k, s.Get(k))
	}
	return dst
}

// IsPlainObject is `typeof v === 'object' && v !== null && !Array.isArray(v)`
// restricted to the value model (a Date is an object too).
func IsPlainObject(v any) bool {
	m, ok := v.(*Map)
	return ok && m != nil
}

// IsObject is `typeof v === 'object' && v !== null` (arrays and Dates
// included).
func IsObject(v any) bool {
	switch x := v.(type) {
	case *Map:
		return x != nil
	case []any, time.Time:
		return true
	}
	return false
}

// MapAt returns m[k] when it is a *Map, else nil.
func MapAt(m *Map, k string) *Map {
	if m == nil {
		return nil
	}
	sub, _ := m.Get(k).(*Map)
	return sub
}
