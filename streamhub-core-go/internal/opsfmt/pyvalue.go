// Package opsfmt renders the cluster/appstore REST responses for the
// deploy/streamhub ops CLI (`streamhub-core opsfmt <view>`). It replaces the
// `python3 -c` one-liners the script used to parse JSON, so the host needs
// no Python for operations.
//
// The contract is byte-for-byte parity with those Python snippets, so this
// file carries a small model of Python's value semantics over decoded JSON:
// insertion-ordered objects, str()/repr() of JSON values, truthiness,
// float() coercion and json.dumps(indent=2) (ensure_ascii). Edge cases where
// Python would crash (a non-object where an object is expected) are handled
// leniently instead — only the success-path output is part of the contract.
package opsfmt

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// obj is an insertion-ordered JSON object (Python dict semantics: a repeated
// key keeps its first position and takes the last value).
type obj struct {
	keys []string
	vals map[string]any
}

func (o *obj) get(k string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[k]
	return v, ok
}

// getOr is dict.get(k, def): the default only when the key is absent.
func (o *obj) getOr(k string, def any) any {
	if v, ok := o.get(k); ok {
		return v
	}
	return def
}

// asObj returns v as an object, or an empty one (the `x or {}` idiom).
func asObj(v any) *obj {
	if o, ok := v.(*obj); ok {
		return o
	}
	return &obj{vals: map[string]any{}}
}

func asList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

// decode reads one JSON document into ordered values (numbers stay json.Number
// so int vs float literals keep Python's int/float distinction).
func decode(r io.Reader) (any, error) {
	dec := json.NewDecoder(r)
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("extra data after the JSON document")
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := &obj{vals: map[string]any{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, _ := kt.(string)
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				if _, dup := o.vals[k]; !dup {
					o.keys = append(o.keys, k)
				}
				o.vals[k] = v
			}
			_, err := dec.Token()
			return o, err
		case '[':
			l := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				l = append(l, v)
			}
			_, err := dec.Token()
			return l, err
		}
		return nil, fmt.Errorf("unexpected %v", t)
	default:
		return tok, nil // string, json.Number, bool, nil
	}
}

func isIntLiteral(n json.Number) bool { return !strings.ContainsAny(string(n), ".eE") }

// pyInt renders an integer literal the way Python's int prints it.
func pyInt(n json.Number) string {
	b, ok := new(big.Int).SetString(string(n), 10)
	if !ok {
		return string(n)
	}
	return b.String()
}

// pyFloat is Python's repr(float): shortest round-trip digits, ".0" for
// integral values, scientific notation when the exponent is < -4 or >= 16.
func pyFloat(f float64) string {
	switch {
	case math.IsInf(f, 1):
		return "inf"
	case math.IsInf(f, -1):
		return "-inf"
	case math.IsNaN(f):
		return "nan"
	}
	if f == 0 {
		if math.Signbit(f) {
			return "-0.0"
		}
		return "0.0"
	}
	exp := int(math.Floor(math.Log10(math.Abs(f))))
	// Log10 can be off by one near powers of ten — read it back from %e.
	e := strconv.FormatFloat(f, 'e', -1, 64)
	if i := strings.IndexByte(e, 'e'); i >= 0 {
		if x, err := strconv.Atoi(e[i+1:]); err == nil {
			exp = x
		}
	}
	if exp < -4 || exp >= 16 {
		return e // Go's shortest %e matches Python: "1e+16", "1.5e-05"
	}
	s := strconv.FormatFloat(f, 'f', -1, 64)
	if !strings.ContainsAny(s, ".") {
		s += ".0"
	}
	return s
}

func numFloat(n json.Number) float64 {
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// pyStr is Python's str() of a decoded JSON value.
func pyStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return pyRepr(v)
}

// pyRepr is Python's repr() of a decoded JSON value.
func pyRepr(v any) string {
	switch t := v.(type) {
	case nil:
		return "None"
	case bool:
		if t {
			return "True"
		}
		return "False"
	case json.Number:
		if isIntLiteral(t) {
			return pyInt(t)
		}
		return pyFloat(numFloat(t))
	case string:
		return pyReprStr(t)
	case []any:
		parts := make([]string, len(t))
		for i, x := range t {
			parts[i] = pyRepr(x)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case *obj:
		parts := make([]string, len(t.keys))
		for i, k := range t.keys {
			parts[i] = pyReprStr(k) + ": " + pyRepr(t.vals[k])
		}
		return "{" + strings.Join(parts, ", ") + "}"
	}
	return fmt.Sprint(v)
}

// pyReprStr is repr(str): single quotes unless the text has a ' and no ",
// with Python's escapes for backslash, the quote and non-printables.
func pyReprStr(s string) string {
	q := byte('\'')
	if strings.ContainsRune(s, '\'') && !strings.ContainsRune(s, '"') {
		q = '"'
	}
	var b strings.Builder
	b.WriteByte(q)
	for _, r := range s {
		switch {
		case r == rune(q) || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\x%02x`, r)
		case r < 0x80 || unicode.IsPrint(r):
			b.WriteRune(r)
		case r <= 0xff:
			fmt.Fprintf(&b, `\x%02x`, r)
		case r <= 0xffff:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			fmt.Fprintf(&b, `\U%08x`, r)
		}
	}
	b.WriteByte(q)
	return b.String()
}

// truthy is Python's bool() of a decoded JSON value.
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case json.Number:
		f := numFloat(t)
		return f != 0 || math.IsNaN(f)
	case []any:
		return len(t) > 0
	case *obj:
		return len(t.keys) > 0
	}
	return true
}

// or is Python's `a or b`.
func or(a, b any) any {
	if truthy(a) {
		return a
	}
	return b
}

// pyFloatOf is float(x); ok=false where Python raises TypeError/ValueError.
func pyFloatOf(v any) (float64, bool) {
	switch t := v.(type) {
	case json.Number:
		return numFloat(t), true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// pyEq approximates Python == across decoded JSON values (numbers and bools
// compare numerically; strings exactly; containers by repr).
func pyEq(a, b any) bool {
	fa, na := numeric(a)
	fb, nb := numeric(b)
	if na && nb {
		return fa == fb
	}
	if na || nb {
		return false
	}
	switch x := a.(type) {
	case nil:
		return b == nil
	case string:
		y, ok := b.(string)
		return ok && x == y
	}
	if _, ok := b.(string); ok || b == nil {
		return false
	}
	return pyRepr(a) == pyRepr(b)
}

func numeric(v any) (float64, bool) {
	switch v.(type) {
	case json.Number, bool:
		return pyFloatOf(v)
	}
	return 0, false
}

// width is len() of a Python str (code points).
func width(s string) int { return utf8.RuneCountInString(s) }

// ljust is str.ljust(w).
func ljust(s string, w int) string {
	if n := width(s); n < w {
		return s + strings.Repeat(" ", w-n)
	}
	return s
}

// head is s[:n] over code points.
func head(s string, n int) string {
	i := 0
	for j := range s {
		if i == n {
			return s[:j]
		}
		i++
	}
	return s
}

// dumpIndent is json.dumps(v, indent=2) with Python's defaults
// (ensure_ascii=True, separators (",", ": ")).
func dumpIndent(b *strings.Builder, v any, level int) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		if isIntLiteral(t) {
			b.WriteString(pyInt(t))
			return
		}
		f := numFloat(t)
		switch {
		case math.IsInf(f, 1):
			b.WriteString("Infinity")
		case math.IsInf(f, -1):
			b.WriteString("-Infinity")
		case math.IsNaN(f):
			b.WriteString("NaN")
		default:
			b.WriteString(pyFloat(f))
		}
	case string:
		dumpString(b, t)
	case []any:
		if len(t) == 0 {
			b.WriteString("[]")
			return
		}
		inner := strings.Repeat("  ", level+1)
		b.WriteString("[\n")
		for i, x := range t {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(inner)
			dumpIndent(b, x, level+1)
		}
		b.WriteString("\n" + strings.Repeat("  ", level) + "]")
	case *obj:
		if len(t.keys) == 0 {
			b.WriteString("{}")
			return
		}
		inner := strings.Repeat("  ", level+1)
		b.WriteString("{\n")
		for i, k := range t.keys {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(inner)
			dumpString(b, k)
			b.WriteString(": ")
			dumpIndent(b, t.vals[k], level+1)
		}
		b.WriteString("\n" + strings.Repeat("  ", level) + "}")
	}
}

func dumpString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			switch {
			case r < 0x20 || (r >= 0x7f && r <= 0xffff): // ensure_ascii escapes all but 0x20-0x7e
				fmt.Fprintf(b, `\u%04x`, r)
			case r > 0xffff:
				r -= 0x10000
				fmt.Fprintf(b, `\u%04x\u%04x`, 0xd800+(r>>10), 0xdc00+(r&0x3ff))
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
