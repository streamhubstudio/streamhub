// Package jsx holds the small JavaScript-runtime compatibility helpers the
// port needs to stay byte-compatible with the Node core: JSON.stringify
// output (hash chains, stored meta_json), Date#toISOString / Date.parse,
// encodeURIComponent and UTF-16 string lengths.
package jsx

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf16"
)

// ISOLayout is Date#toISOString (always UTC, millisecond precision).
const ISOLayout = "2006-01-02T15:04:05.000Z"

// ISO formats t like Date#toISOString.
func ISO(t time.Time) string { return t.UTC().Format(ISOLayout) }

// NowISO is new Date().toISOString().
func NowISO() string { return ISO(time.Now()) }

// ParseDate is a Date.parse subset covering the timestamps the core stores:
// ISO-8601 with zone (toISOString) and SQLite's datetime('now') form (which V8
// reads as local time). ok=false mirrors NaN.
func ParseDate(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z07:00", "2006-01-02T15:04Z07:00"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02T15:04:05.000"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, true
		}
	}
	if t, err := time.Parse("2006-01-02", s); err == nil { // date-only = UTC
		return t, true
	}
	return time.Time{}, false
}

// Stringify is JSON.stringify(v) for plain data: no HTML escaping and raw
// U+2028/U+2029 (encoding/json escapes both). Struct field order is kept;
// map keys come out sorted, so callers needing insertion order use structs.
func Stringify(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	out := strings.TrimSuffix(buf.String(), "\n")
	out = strings.ReplaceAll(out, `\u2028`, "\u2028")
	out = strings.ReplaceAll(out, `\u2029`, "\u2029")
	return out, nil
}

// UTF16Len is String#length.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// UTF16Slice is String#slice(0, n) (a split surrogate pair is dropped).
func UTF16Slice(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if n >= len(u) {
		return s
	}
	if n > 0 && utf16.IsSurrogate(rune(u[n-1])) && u[n-1] < 0xDC00 {
		n-- // drop the split high surrogate
	}
	return string(utf16.Decode(u[:n]))
}

// EncodeURIComponent escapes everything except A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func EncodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}
