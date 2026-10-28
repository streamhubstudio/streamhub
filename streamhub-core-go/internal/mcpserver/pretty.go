package mcpserver

import (
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Pretty is JSON.stringify(v, null, 2) over the yamljs value model:
// Undefined object members are skipped, Undefined array items become null.
func Pretty(v any) string {
	var b strings.Builder
	writePretty(&b, v, "")
	return b.String()
}

func writePretty(b *strings.Builder, v any, indent string) {
	inner := indent + "  "
	switch x := v.(type) {
	case *y.Map:
		if x == nil {
			b.WriteString("null")
			return
		}
		first := true
		for _, k := range x.Keys() {
			e := x.Get(k)
			if y.IsUndefined(e) {
				continue
			}
			if first {
				b.WriteString("{\n")
				first = false
			} else {
				b.WriteString(",\n")
			}
			ks, _ := y.Stringify(k)
			b.WriteString(inner + ks + ": ")
			writePretty(b, e, inner)
		}
		if first {
			b.WriteString("{}")
			return
		}
		b.WriteString("\n" + indent + "}")
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, e := range x {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(inner)
			writePretty(b, e, inner)
		}
		b.WriteString("\n" + indent + "]")
	default:
		s, err := y.Stringify(v)
		if err != nil {
			s = "null"
		}
		b.WriteString(s)
	}
}

// toText renders a tool/resource result like the TypeScript server:
// undefined → "null", strings verbatim, anything else pretty JSON.
func toText(v any) string {
	if y.IsUndefined(v) {
		return "null"
	}
	if s, ok := v.(string); ok {
		return s
	}
	return Pretty(v)
}
