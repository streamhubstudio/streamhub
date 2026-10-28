package appstool

import (
	"fmt"
	"math"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// ParseJSONObject is JSON.parse of a document that must be an object (key
// order kept).
func ParseJSONObject(raw []byte) (*y.Map, error) {
	v, err := y.ParseJSON(raw)
	if err != nil {
		return nil, err
	}
	m, ok := v.(*y.Map)
	if !ok {
		return nil, fmt.Errorf("not a JSON object")
	}
	return m, nil
}

// StringifyIndent is JSON.stringify(v, null, 2) over the yamljs value model:
// JS key order, JS number formatting, `{}`/`[]` for empty containers,
// undefined members dropped.
func StringifyIndent(v any) string {
	var b strings.Builder
	writeIndent(&b, v, "")
	return b.String()
}

func writeIndent(b *strings.Builder, v any, ind string) {
	inner := ind + "  "
	switch x := v.(type) {
	case *y.Map:
		keys := []string{}
		for _, k := range x.Keys() {
			if !y.IsUndefined(x.Get(k)) {
				keys = append(keys, k)
			}
		}
		if len(keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, k := range keys {
			b.WriteString(inner)
			ks, _ := y.Stringify(k)
			b.WriteString(ks)
			b.WriteString(": ")
			writeIndent(b, x.Get(k), inner)
			if i < len(keys)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(ind + "}")
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, e := range x {
			b.WriteString(inner)
			if y.IsUndefined(e) {
				b.WriteString("null")
			} else {
				writeIndent(b, e, inner)
			}
			if i < len(x)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(ind + "]")
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			b.WriteString("null")
		} else {
			b.WriteString(y.JSNumberString(x))
		}
	default:
		s, err := y.Stringify(x) // null, bool, string
		if err != nil {
			s = "null"
		}
		b.WriteString(s)
	}
}
