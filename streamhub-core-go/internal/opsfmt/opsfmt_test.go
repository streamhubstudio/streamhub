package opsfmt

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// testdata/python-vectors.json is FROZEN: every case was run (on Python
// 3.14) through the `python3 -c` snippets that deploy/streamhub used before
// 3.3.2 — extracted verbatim from the script — and the output recorded. The
// generator and the snippets live only in git history (pre-3.3.2
// deploy/streamhub); the api-error expectation reflects the script's
// `2>/dev/null || true` (a Python crash = empty message). opsfmt must match
// byte for byte, so the operator sees exactly what the Python CLI printed.
func TestPythonParityVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/python-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vecs []struct {
		View   string   `json:"view"`
		Args   []string `json:"args"`
		Input  string   `json:"input"`
		Stdout string   `json:"stdout"`
		Code   int      `json:"code"`
	}
	if err := json.Unmarshal(raw, &vecs); err != nil {
		t.Fatal(err)
	}
	if len(vecs) < 50 {
		t.Fatalf("only %d vectors", len(vecs))
	}
	seen := map[string]bool{}
	for i, v := range vecs {
		seen[v.View] = true
		var out, errb bytes.Buffer
		code := Run(append([]string{v.View}, v.Args...), strings.NewReader(v.Input), &out, &errb)
		got, want := out.String(), v.Stdout
		if v.View == "api-error" { // consumed via $(...), which strips trailing newlines
			got, want = strings.TrimRight(got, "\n"), strings.TrimRight(want, "\n")
		}
		if code != v.Code || got != want {
			t.Errorf("#%d %s %v (input %.120s)\n code %d want %d\n got:\n%s\nwant:\n%s\nstderr: %s",
				i, v.View, v.Args, v.Input, code, v.Code, got, want, errb.String())
		}
	}
	for view := range views {
		if !seen[view] {
			t.Errorf("view %q has no parity vector", view)
		}
	}
}

func TestRunUsageAndErrors(t *testing.T) {
	run := func(args []string, in string) (int, string, string) {
		var out, errb bytes.Buffer
		code := Run(args, strings.NewReader(in), &out, &errb)
		return code, out.String(), errb.String()
	}
	if code, _, e := run(nil, ""); code != 2 || !strings.Contains(e, "usage:") {
		t.Fatal(code, e)
	}
	if code, _, e := run([]string{"--help"}, ""); code != 0 || !strings.Contains(e, "node-id <ref>") {
		t.Fatal(code, e)
	}
	if code, _, e := run([]string{"bogus"}, "{}"); code != 2 || !strings.Contains(e, `unknown view "bogus"`) {
		t.Fatal(code, e)
	}
	if code, _, _ := run([]string{"node-id"}, "{}"); code != 2 {
		t.Fatal(code)
	}
	// A broken body fails the pipeline (the Python traceback did too) …
	if code, out, e := run([]string{"nodes"}, "<html>"); code != 1 || out != "" || !strings.Contains(e, "invalid JSON") {
		t.Fatal(code, out, e)
	}
	if code, _, e := run([]string{"nodes"}, "[]"); code != 1 || !strings.Contains(e, "expected a JSON object") {
		t.Fatal(code, e)
	}
	if code, _, _ := run([]string{"nodes"}, `{"data":[]} {}`); code != 1 {
		t.Fatal(code)
	}
	// … except api-error, which degrades to "no message".
	if code, out, _ := run([]string{"api-error"}, "502 Bad Gateway"); code != 0 || out != "\n" {
		t.Fatal(code, out)
	}
}

func TestPyFloat(t *testing.T) {
	for in, want := range map[float64]string{
		1: "1.0", 0.1: "0.1", 1e16: "1e+16", 1e15: "1000000000000000.0", 0.0001: "0.0001",
		0.00001: "1e-05", 1.5e300: "1.5e+300", -2.5: "-2.5", 123.456e5: "12345600.0", 9999999999999998: "9999999999999998.0",
	} {
		if got := pyFloat(in); got != want {
			t.Errorf("pyFloat(%v) = %s, want %s", in, got, want)
		}
	}
}

func TestPyReprStr(t *testing.T) {
	for in, want := range map[string]string{
		"live": "'live'", "it's": `"it's"`, `a'b"c`: `'a\'b"c'`, "tab\there": `'tab\there'`,
		"ñ": "'ñ'", "\x01": `'\x01'`, `back\slash`: `'back\\slash'`, "\u0085": `'\x85'`,
	} {
		if got := pyReprStr(in); got != want {
			t.Errorf("pyReprStr(%q) = %s, want %s", in, got, want)
		}
	}
}
