package plugins

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

// stringifyJS is JSON.stringify for the JSON value model.
func stringifyJS(v any) (string, error) { return y.Stringify(v) }

// indentJSON renders a parsed value like JSON.stringify(v, null, 2).
func indentJSON(v any, pad string) string {
	inner := pad + "  "
	switch x := v.(type) {
	case *y.Map:
		keys := x.Keys()
		var parts []string
		for _, k := range keys {
			val := x.Get(k)
			if y.IsUndefined(val) {
				continue
			}
			key, _ := y.Stringify(k)
			parts = append(parts, inner+key+": "+indentJSON(val, inner))
		}
		if len(parts) == 0 {
			return "{}"
		}
		return "{\n" + strings.Join(parts, ",\n") + "\n" + pad + "}"
	case []any:
		if len(x) == 0 {
			return "[]"
		}
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = inner + indentJSON(e, inner)
		}
		return "[\n" + strings.Join(parts, ",\n") + "\n" + pad + "]"
	}
	s, _ := y.Stringify(v)
	return s
}

// gzipBytes gzips b (tests / round trips).
func gzipBytes(b []byte) []byte {
	var out bytes.Buffer
	zw := gzip.NewWriter(&out)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return out.Bytes()
}
