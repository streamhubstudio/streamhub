package yamljs

// Golden vectors in testdata/ are produced by the js-yaml copy the Node core
// ships. Regenerate (historical — needs the retired NestJS core, branch
// legacy/node-2.x / tag 2.24.0) with:
//
//	cd streamhub-core && node ../streamhub-core-go/internal/platform/yamljs/testdata/gen.js

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fromTagged decodes gen.js's tagged JSON rendering into the value model.
func fromTagged(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	trimmed := strings.TrimSpace(string(raw))
	switch {
	case strings.HasPrefix(trimmed, "["):
		var items []json.RawMessage
		mustJSON(t, raw, &items)
		out := make([]any, len(items))
		for i, it := range items {
			out[i] = fromTagged(t, it)
		}
		return out
	case strings.HasPrefix(trimmed, "{"):
		var obj map[string]json.RawMessage
		mustJSON(t, raw, &obj)
		if n, ok := obj["$num"]; ok {
			var s string
			mustJSON(t, n, &s)
			return parseJSNum(t, s)
		}
		if d, ok := obj["$date"]; ok {
			var s string
			mustJSON(t, d, &s)
			tm, err := time.Parse(time.RFC3339Nano, s)
			if err != nil {
				t.Fatalf("bad $date %q: %v", s, err)
			}
			return tm
		}
		if _, ok := obj["$undefined"]; ok {
			return Undefined
		}
		var pairs [][2]json.RawMessage
		mustJSON(t, obj["$obj"], &pairs)
		m := NewMap()
		for _, p := range pairs {
			var k string
			mustJSON(t, p[0], &k)
			m.Set(k, fromTagged(t, p[1]))
		}
		return m
	}
	var v any
	mustJSON(t, raw, &v)
	return v // nil, bool, string
}

func parseJSNum(t *testing.T, s string) float64 {
	t.Helper()
	switch s {
	case "-0":
		return math.Copysign(0, -1)
	case "NaN":
		return math.NaN()
	case "Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	var f float64
	if _, err := fmt.Sscan(s, &f); err != nil {
		t.Fatalf("bad $num %q: %v", s, err)
	}
	return f
}

func mustJSON(t *testing.T, raw []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("json: %v (%s)", err, raw)
	}
}

// describe renders a value with explicit types so mismatches are readable
// and NaN/-0/Undefined/Date/key order are all compared exactly.
func describe(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case undefinedT:
		return "undefined"
	case bool:
		return fmt.Sprint(x)
	case float64:
		if isNegativeZero(x) {
			return "num(-0)"
		}
		return "num(" + JSNumberString(x) + ")"
	case string:
		return fmt.Sprintf("%q", x)
	case time.Time:
		return "date(" + isoString(x) + ")"
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = describe(e)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case *Map:
		parts := []string{}
		for _, k := range x.Keys() {
			parts = append(parts, fmt.Sprintf("%q: %s", k, describe(x.Get(k))))
		}
		return "{" + strings.Join(parts, ", ") + "}"
	}
	return fmt.Sprintf("<%T %v>", v, v)
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func vectors(t *testing.T, suffix string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("testdata", "*"+suffix))
	if err != nil || len(files) == 0 {
		t.Fatalf("no %s vectors (run gen.js): %v", suffix, err)
	}
	names := make([]string, len(files))
	for i, f := range files {
		names[i] = strings.TrimSuffix(filepath.Base(f), suffix)
	}
	return names
}

func TestGoldenDumpJSONInput(t *testing.T) {
	for _, name := range vectors(t, ".input.json") {
		t.Run(name, func(t *testing.T) {
			v, err := ParseJSON([]byte(readFile(t, filepath.Join("testdata", name+".input.json"))))
			if err != nil {
				t.Fatal(err)
			}
			want := readFile(t, filepath.Join("testdata", name+".yaml"))
			if got := Dump(v, 120); got != want {
				t.Errorf("Dump mismatch\n%s", diff(want, got))
			}
		})
	}
}

func TestGoldenDumpTaggedValue(t *testing.T) {
	for _, name := range vectors(t, ".value.json") {
		t.Run(name, func(t *testing.T) {
			v := fromTagged(t, json.RawMessage(readFile(t, filepath.Join("testdata", name+".value.json"))))
			want := readFile(t, filepath.Join("testdata", name+".yaml"))
			if got := Dump(v, 120); got != want {
				t.Errorf("Dump mismatch\n%s", diff(want, got))
			}
		})
	}
}

func TestGoldenLoad(t *testing.T) {
	for _, name := range vectors(t, ".src.yaml") {
		t.Run(name, func(t *testing.T) {
			src := readFile(t, filepath.Join("testdata", name+".src.yaml"))
			wantRaw := readFile(t, filepath.Join("testdata", name+".json"))
			got, err := Load(src)

			var probe map[string]json.RawMessage
			if json.Unmarshal([]byte(wantRaw), &probe) == nil {
				if msg, ok := probe["$error"]; ok {
					if err == nil {
						t.Fatalf("Load succeeded, js-yaml fails with %s; got %s", msg, describe(got))
					}
					return
				}
			}
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			want := fromTagged(t, json.RawMessage(wantRaw))
			if describe(got) != describe(want) {
				t.Fatalf("Load mismatch\nwant %s\n got %s", describe(want), describe(got))
			}

			yamlPath := filepath.Join("testdata", name+".yaml")
			if _, statErr := os.Stat(yamlPath); statErr != nil {
				t.Logf("no dump vector (js-yaml emits &ref_ anchors for shared objects)")
				return
			}
			if out := Dump(got, 120); out != readFile(t, yamlPath) {
				t.Errorf("Dump(Load) mismatch\n%s", diff(readFile(t, yamlPath), out))
			}
		})
	}
}

// TestGoldenReload: Load(Node's dump) gives the dumped value back (js-yaml's
// round-trip guarantee), so yaml.v3 parses every js-yaml scalar style the
// way js-yaml does. Vectors holding undefined are skipped (dump drops it).
func TestGoldenReload(t *testing.T) {
	check := func(t *testing.T, name string, v any) {
		want := describe(v)
		if strings.Contains(want, "undefined") {
			t.Skip("undefined does not round-trip")
		}
		got, err := Load(readFile(t, filepath.Join("testdata", name+".yaml")))
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if g := describe(got); g != want {
			t.Fatalf("reload mismatch\n%s", diff(want, g))
		}
	}
	for _, name := range vectors(t, ".input.json") {
		t.Run(name, func(t *testing.T) {
			v, err := ParseJSON([]byte(readFile(t, filepath.Join("testdata", name+".input.json"))))
			if err != nil {
				t.Fatal(err)
			}
			check(t, name, v)
		})
	}
	for _, name := range vectors(t, ".value.json") {
		t.Run(name, func(t *testing.T) {
			check(t, name, fromTagged(t, json.RawMessage(readFile(t, filepath.Join("testdata", name+".value.json")))))
		})
	}
}

// diff shows the first differing line.
func diff(want, got string) string {
	wl, gl := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < len(wl) || i < len(gl); i++ {
		var w, g string
		if i < len(wl) {
			w = wl[i]
		}
		if i < len(gl) {
			g = gl[i]
		}
		if w != g {
			return fmt.Sprintf("line %d:\nwant %q\n got %q", i+1, w, g)
		}
	}
	return "(identical lines; length differs)"
}

func TestJSNumberString(t *testing.T) {
	cases := map[float64]string{
		0: "0", 1: "1", -5: "-5", 0.1: "0.1", 1e21: "1e+21", 1e20: "100000000000000000000",
		1.5e-7: "1.5e-7", 1e-7: "1e-7", 0.000001: "0.000001", 123456789012: "123456789012",
		1.7976931348623157e308: "1.7976931348623157e+308", 5e-324: "5e-324", -2.5e-10: "-2.5e-10",
		1.0 / 3: "0.3333333333333333", 123e-20: "1.23e-18", 9007199254740993: "9007199254740992",
	}
	for f, want := range cases {
		if got := JSNumberString(f); got != want {
			t.Errorf("JSNumberString(%v) = %q, want %q", f, got, want)
		}
	}
	if got := JSNumberString(math.Copysign(0, -1)); got != "0" {
		t.Errorf("-0 → %q", got)
	}
	if JSNumberString(math.NaN()) != "NaN" || JSNumberString(math.Inf(-1)) != "-Infinity" {
		t.Error("special values")
	}
}

func TestDumpUndefinedAndGoKinds(t *testing.T) {
	if got := Dump(Undefined, 120); got != "" {
		t.Errorf("Dump(Undefined) = %q", got)
	}
	if got, want := Dump([]any{1, Undefined, int64(3)}, 120), "- 1\n- null\n- 3\n"; got != want {
		t.Errorf("got %q want %q", got, want)
	}
	m := NewMap()
	m.Set("a", Undefined)
	if got := Dump(m, 120); got != "{}\n" {
		t.Errorf("all-undefined map = %q", got)
	}
	defer func() {
		if recover() == nil {
			t.Error("unsupported kind should panic")
		}
	}()
	Dump(struct{}{}, 120)
}

func TestLoadEdgeCases(t *testing.T) {
	// js-yaml: no document at all → undefined; a blank/comment-only stream is
	// one empty document → null (table verified against Node).
	for src, wantUndef := range map[string]bool{
		"": true, " ": true, "\n": true, "  \n": true, "\ufeff": true,
		"\n\n": false, "# c": false, "  # c\n": false, "\t": false, "...\n": false,
	} {
		v, err := Load(src)
		if err != nil || IsUndefined(v) != wantUndef || (!wantUndef && v != nil) {
			t.Errorf("Load(%q) = %v, %v; want undefined=%v", src, v, err, wantUndef)
		}
	}
	if _, err := Load("a: \x00\n"); err == nil {
		t.Error("null byte must fail")
	}
	// Aliases share the same object, like js-yaml.
	v, err := Load("a: &x {k: 1}\nb: *x\n")
	if err != nil {
		t.Fatal(err)
	}
	m := v.(*Map)
	if m.Get("a").(*Map) != m.Get("b").(*Map) {
		t.Error("alias should resolve to the same *Map")
	}
	if _, err := Load("a: &x [*x]\n"); err == nil {
		t.Error("recursive alias should fail")
	}
	if _, err := Load("1: a\n01: b\n"); err == nil {
		t.Error("keys 1 and 01 both stringify to \"1\" → duplicate")
	}
}
