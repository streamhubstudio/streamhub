package streamflow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// js parses a JSON literal into the value model (JS key order).
func js(t testing.TB, s string) any {
	t.Helper()
	v, err := y.ParseJSON([]byte(s))
	if err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	return v
}

func jm(t testing.TB, s string) *y.Map { return js(t, s).(*y.Map) }

func str(v any) string { return jsonString(v) }

// ---------------------------------------------------------------------------
// boxes/path.spec.ts
// ---------------------------------------------------------------------------

func TestPath(t *testing.T) {
	bag := js(t, `{"trigger":{"room":"gate","box":[{"n":1},{"n":2}]},"vars":{}}`)
	if getPath(bag, "trigger.room") != "gate" || getPath(bag, "trigger.box.1.n") != 2.0 {
		t.Fatal("nested/array read")
	}
	for _, p := range []string{"trigger.nope", "trigger.__proto__.polluted", "constructor.prototype", "trigger.box.5", "trigger.box.-1", "trigger.room.x"} {
		if !y.IsUndefined(getPath(bag, p)) {
			t.Errorf("%s not undefined", p)
		}
	}
	root := y.NewMap()
	setPath(root, "vars.a.b", 7.0)
	if str(root) != `{"vars":{"a":{"b":7}}}` {
		t.Fatalf("setPath %s", str(root))
	}
	setPath(root, "__proto__.polluted", true)
	if root.Has("__proto__") {
		t.Fatal("prototype pollution")
	}

	b2 := js(t, `{"trigger":{"plate":"ABC","conf":0.9},"snap":{"url":"http://x/y.jpg"}}`)
	if resolveValue("{{trigger.conf}}", b2) != 0.9 || resolveValue("{{ snap.url }}", b2) != "http://x/y.jpg" {
		t.Fatal("full template")
	}
	if resolveValue("plate {{trigger.plate}} seen", b2) != "plate ABC seen" || resolveString("{{trigger.missing}}", b2) != "" {
		t.Fatal("inline template")
	}
	if got := str(resolveValue(js(t, `{"p":"{{trigger.plate}}","arr":["{{trigger.conf}}"],"__proto__":1}`), b2)); got != `{"p":"ABC","arr":[0.9]}` {
		t.Fatalf("deep resolve %s", got)
	}
	if resolveValue(42.0, b2) != 42.0 || resolveString("x {{trigger}} y", b2) != `x {"plate":"ABC","conf":0.9} y` {
		t.Fatal("untouched / object interpolation")
	}
}

// ---------------------------------------------------------------------------
// boxes/expr.spec.ts
// ---------------------------------------------------------------------------

func TestExpr(t *testing.T) {
	bag := js(t, `{"trigger":{"conf":"0.92","plate":"ABC123","tags":["vip","staff"],"flag":true,"n":0},"vars":{}}`)
	rule := func(s string) bool { return evalRule(jm(t, s), bag) }
	cases := map[string]bool{
		`{"field":"trigger.conf","op":"gt","value":0.9}`:               true,
		`{"field":"trigger.conf","op":"lte","value":"0.5"}`:            false,
		`{"field":"trigger.conf","op":"eq","value":0.92}`:              true,
		`{"field":"trigger.flag","op":"eq","value":"true"}`:            true,
		`{"field":"trigger.plate","op":"ne","value":"X"}`:              true,
		`{"field":"trigger.plate","op":"contains","value":"C12"}`:      true,
		`{"field":"trigger.tags","op":"contains","value":"vip"}`:       true,
		`{"field":"trigger.tags","op":"not_contains","value":"x"}`:     true,
		`{"field":"trigger","op":"contains","value":"plate"}`:          true,
		`{"field":"trigger.plate","op":"matches","value":"^ABC\\d+$"}`: true,
		`{"field":"trigger.plate","op":"matches","value":"(?<=A)BC"}`:  true,
		`{"field":"trigger.plate","op":"matches","value":"(["}`:        false,
		`{"field":"trigger.plate","op":"exists"}`:                      true,
		`{"field":"trigger.none","op":"not_exists"}`:                   true,
		`{"field":"trigger.n","op":"truthy"}`:                          false,
		`{"field":"trigger.n","op":"falsy"}`:                           true,
		`{"field":"trigger.plate","op":"bogus"}`:                       false,
		`{"field":"trigger.none","op":"eq","value":null}`:              false,
	}
	for r, want := range cases {
		if got := rule(r); got != want {
			t.Errorf("%s → %v", r, got)
		}
	}
	if !evalCondition(js(t, `{"rules":[]}`), bag) || evalCondition(js(t, `{"rules":[{"field":"trigger.n","op":"truthy"},{"field":"trigger.flag","op":"truthy"}]}`), bag) ||
		!evalCondition(js(t, `{"match":"any","rules":[{"field":"trigger.n","op":"truthy"},{"field":"trigger.flag","op":"truthy"}]}`), bag) {
		t.Fatal("evalCondition")
	}
	sw := func(s string) string { return evalSwitch(jm(t, s), bag) }
	if sw(`{"field":"trigger.plate","cases":[{"value":"X"},{"value":"ABC123","port":"hit"}]}`) != "hit" ||
		sw(`{"field":"trigger.plate","cases":[{"value":"ABC123"}]}`) != "ABC123" ||
		sw(`{"field":"trigger.plate","cases":[{"value":"no"}],"default":"other"}`) != "other" ||
		sw(`{"field":"trigger.plate"}`) != "default" {
		t.Fatal("evalSwitch")
	}
}

// ---------------------------------------------------------------------------
// streamflow.graph.spec.ts
// ---------------------------------------------------------------------------

func graphOf(t *testing.T, s string) Graph { return normalizeGraph(js(t, s)) }

func TestGraph(t *testing.T) {
	for s, msg := range map[string]string{
		`{"boxes":[{"id":"a"},{"id":"a"}]}`:                                                           "duplicate box id 'a'",
		`{"boxes":[{"id":"a"}],"edges":[{"from":"a","to":"b"}]}`:                                      "edge to unknown box 'b'",
		`{"boxes":[{"id":"a"}],"edges":[{"from":"z","to":"a"}]}`:                                      "edge from unknown box 'z'",
		`{"boxes":[{"id":5}]}`:                                                                        "every box needs a non-empty string id",
		`{"boxes":[{"id":"a"},{"id":"b"}],"edges":[{"from":"a","to":"b"},{"from":"b:out","to":"a"}]}`: "cycle through box 'a'",
	} {
		if err := validateGraph(graphOf(t, s)); err == nil || err.Error() != msg {
			t.Errorf("%s → %v", s, err)
		}
	}

	run := func(g Graph, start string, ports map[string]string, max int) ([]string, error) {
		var order []string
		err := runGraph(context.Background(), g, start, func(_ context.Context, b any) (any, string, error) {
			id := boxID(b)
			order = append(order, id)
			if id == "boom" {
				return nil, "", errors.New("box blew up")
			}
			if p, ok := ports[id]; ok {
				return nil, p, nil
			}
			return nil, "out", nil
		}, max)
		return order, err
	}
	linear := graphOf(t, `{"boxes":[{"id":"a"},{"id":"b"},{"id":"c"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]}`)
	if o, _ := run(linear, "a", nil, 100); strings.Join(o, "") != "abc" {
		t.Fatalf("linear %v", o)
	}
	branch := graphOf(t, `{"boxes":[{"id":"t"},{"id":"c"},{"id":"yes"},{"id":"no"}],"edges":[{"from":"t","to":"c"},{"from":"c","fromPort":"true","to":"yes"},{"from":"c:false","to":"no"}]}`)
	if o, _ := run(branch, "t", map[string]string{"c": "true"}, 100); strings.Join(o, ",") != "t,c,yes" {
		t.Fatalf("true branch %v", o)
	}
	if o, _ := run(branch, "t", map[string]string{"c": "false"}, 100); strings.Join(o, ",") != "t,c,no" {
		t.Fatalf("false branch %v", o)
	}
	diamond := graphOf(t, `{"boxes":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}],"edges":[{"from":"a","to":"b"},{"from":"a","to":"c"},{"from":"b","to":"d"},{"from":"c","to":"d"}]}`)
	if o, _ := run(diamond, "a", nil, 100); strings.Join(o, "") != "abcd" {
		t.Fatalf("diamond %v", o)
	}
	if _, err := run(linear, "a", nil, 2); err == nil || err.Error() != "exceeded max steps (2)" {
		t.Fatalf("max steps %v", err)
	}
	thrower := graphOf(t, `{"boxes":[{"id":"a"},{"id":"boom"}],"edges":[{"from":"a","to":"boom"}]}`)
	if _, err := run(thrower, "a", nil, 100); err == nil || err.Error() != "box blew up" {
		t.Fatalf("throw %v", err)
	}
	if _, err := run(linear, "zz", nil, 100); err == nil || err.Error() != "start box 'zz' not in graph" {
		t.Fatalf("start %v", err)
	}

	tg := graphOf(t, `{"boxes":[{"id":"x","type":"logic.delay"},{"id":"t","type":"trigger.event"}],"edges":[{"from":"t","to":"x"}]}`)
	if boxID(findTriggerBox(tg, func(s string) bool { return strings.HasPrefix(s, "trigger.") })) != "t" || boxID(findTriggerBox(tg, nil)) != "t" {
		t.Fatal("findTriggerBox")
	}
}

// ---------------------------------------------------------------------------
// boxes/portable.spec.ts + catalogue / event catalogue
// ---------------------------------------------------------------------------

func TestPortable(t *testing.T) {
	g := js(t, `{"boxes":[{"id":"t","type":"trigger.manual","x":1},{"id":"h","type":"action.http","config":{"url":"https://x","apiKey":"literal","token":"{{secret.T}}","raw":"sk-abcdef","long":"`+strings.Repeat("A", 40)+`","n":5}}],"edges":[{"from":"t","to":"h"}],"zoom":2}`)
	exp := exportWorkflow("Flow", g)
	if got := str(exp); got != `{"streamflow":1,"name":"Flow","graph":{"boxes":[{"id":"t","type":"trigger.manual","x":1,"config":{}},{"id":"h","type":"action.http","config":{"url":"https://x","apiKey":"","token":"{{secret.T}}","raw":"","long":"","n":5}}],"edges":[{"from":"t","to":"h"}]},"redactions":["h.apiKey","h.raw","h.long"]}` {
		t.Fatalf("export %s", got)
	}
	name, graph, err := importWorkflow(exp, "Imported workflow")
	if err != nil || name != "Flow" || str(graph) != str(exp.Get("graph")) {
		t.Fatalf("round trip %v %s", err, str(graph))
	}
	for raw, msg := range map[string]string{
		`{"graph":{"boxes":[{"id":"a","type":"x.y"},{"id":"b","type":"x.y"},{"id":"c"},{"id":"d","type":null}]}}`: "unknown box types: x.y, , ",
		`{"graph":{"boxes":[{"id":"a","type":"x.y"}]}}`:                                                           "unknown box type: x.y",
		`{"graph":{}}`: "workflow has no boxes to import",
		`{}`:           "workflow has no boxes to import",
		`{"graph":{"boxes":[{"id":"a","type":"logic.delay"},{"id":"b","type":"logic.delay"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"a"}]}}`: "cycle through box 'a'",
	} {
		if _, _, err := importWorkflow(js(t, raw), "x"); err == nil || err.Error() != msg {
			t.Errorf("%s → %v", raw, err)
		}
	}
	if n, _, _ := importWorkflow(js(t, `{"name":"  ","graph":{"boxes":[{"id":"a","type":"action.db"}]}}`), "Imported workflow"); n != "Imported workflow" {
		t.Fatalf("fallback name %q", n)
	}
}

func TestCatalogue(t *testing.T) {
	plain, full := boxCatalogue(false), boxCatalogue(true)
	if len(full) != len(plain)+4 {
		t.Fatalf("catalogue sizes %d %d", len(plain), len(full))
	}
	for _, s := range plain {
		if strings.Contains(string(s), `"dangerous":true`) {
			t.Fatal("dangerous box in the default palette")
		}
	}
	for _, typ := range []string{"action.code", "action.shell", "action.ssh", "action.db", "trigger.event", "logic.switch"} {
		if !knownTypes[typ] {
			t.Errorf("%s missing", typ)
		}
	}
	for typ := range executors {
		if !knownTypes[typ] {
			t.Errorf("executor %s has no catalogue entry", typ)
		}
	}
	var fams []struct {
		Family string `json:"family"`
		Scope  string `json:"scope"`
		Events []struct {
			Event    string `json:"event"`
			Wildcard bool   `json:"wildcard"`
		} `json:"events"`
	}
	if err := json.Unmarshal(eventCatalogue(), &fams); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, f := range fams {
		if f.Scope != "app" && f.Scope != "cluster" {
			t.Errorf("family %s scope %q", f.Family, f.Scope)
		}
		for _, e := range f.Events {
			if !e.Wildcard && seen[e.Event] {
				t.Errorf("duplicate %s", e.Event)
			}
			seen[e.Event] = true
		}
	}
	// core-emitted alert families the trigger picker must offer
	for _, ev := range []string{"network.threshold_exceeded", "iot.data", "fleet.battery_low", "fleet.battery_recovered"} {
		if !seen[ev] {
			t.Errorf("event catalogue misses %s", ev)
		}
	}
}

// ---------------------------------------------------------------------------
// secret-crypt.util.spec.ts (+ Node vectors)
// ---------------------------------------------------------------------------

func TestCryptNodeVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/crypt.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Cases []struct{ Master, App, Plaintext, Stored string }
		Masks []struct{ V, Mask string }
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cases {
		if pt, ok := decryptSecret(c.Stored, c.Master, c.App); !ok || pt != c.Plaintext {
			t.Errorf("Node ciphertext for %q did not open: %q %v", c.App, pt, ok)
		}
		if _, ok := decryptSecret(c.Stored, c.Master, c.App+"x"); ok {
			t.Error("per-app isolation broken")
		}
	}
	for _, m := range v.Masks {
		if got := maskSecret(m.V); got != m.Mask {
			t.Errorf("mask(%q) = %q, want %q", m.V, got, m.Mask)
		}
	}
}

func TestCrypt(t *testing.T) {
	a, _ := encryptSecret("value-1", "m", "app")
	b, _ := encryptSecret("value-1", "m", "app")
	if a == b {
		t.Fatal("IV reused")
	}
	if pt, ok := decryptSecret(a, "m", "app"); !ok || pt != "value-1" {
		t.Fatal("round trip")
	}
	parts := strings.Split(a, "$")
	tampered := strings.Join([]string{parts[0], parts[1], parts[2], "AAAA" + parts[3]}, "$")
	for _, bad := range []struct{ s, m, app string }{{a, "wrong", "app"}, {tampered, "m", "app"}, {"nope", "m", "app"}, {"x$y$z$w", "m", "app"}, {a, "", "app"}} {
		if _, ok := decryptSecret(bad.s, bad.m, bad.app); ok {
			t.Errorf("%+v opened", bad)
		}
	}
	if _, err := encryptSecret("x", "", "app"); err == nil {
		t.Fatal("empty master accepted")
	}
	if _, err := encryptSecret("x", "m", ""); err == nil {
		t.Fatal("empty app accepted")
	}
	if !looksMasked("sk-…abcd") || looksMasked("plain") {
		t.Fatal("looksMasked")
	}
	out := redactSecretValues(js(t, `{"a":"token shh-secret-value here","b":["shh-secret-value"],"c":3}`), []string{"shh-secret-value", "abc", ""})
	if str(out) != `{"a":"token [redacted] here","b":["[redacted]"],"c":3}` {
		t.Fatalf("redact %s", str(out))
	}
	clean := js(t, `{"a":"x"}`)
	if redactSecretValues(clean, []string{"ab"}) != clean {
		t.Fatal("short needles must be ignored")
	}
}

// ---------------------------------------------------------------------------
// ai.request.spec.ts
// ---------------------------------------------------------------------------

func TestAIRequest(t *testing.T) {
	if providerBaseURL("") != "https://api.openai.com/v1" || providerBaseURL("deepseek") != "https://api.deepseek.com/v1" {
		t.Fatal("base urls")
	}
	url, body := buildChatRequest(AIChatOptions{Model: "gpt-4o-mini", Prompt: "hi"})
	if url != "https://api.openai.com/v1/chat/completions" || str(body) != `{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}` {
		t.Fatalf("text-only %s %s", url, str(body))
	}
	mt, temp := 99.9, 0.2
	url, body = buildChatRequest(AIChatOptions{Provider: "deepseek", Model: "deepseek-chat", Prompt: "p", System: "sys",
		ImageBase64: "QUJD", MaxTokens: &mt, Temperature: &temp, JSONMode: true, BaseURL: "https://proxy.example/v1//"})
	want := `{"model":"deepseek-chat","messages":[{"role":"system","content":"sys"},{"role":"user","content":[{"type":"text","text":"p"},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,QUJD"}}]}],"max_tokens":99,"temperature":0.2,"response_format":{"type":"json_object"}}`
	if url != "https://proxy.example/v1/chat/completions" || str(body) != want {
		t.Fatalf("full %s\n%s", url, str(body))
	}
	if resolveImageSource(AIChatOptions{ImageBase64: "data:image/png;base64,x"}) != "data:image/png;base64,x" ||
		resolveImageSource(AIChatOptions{ImageURL: " http://i ", ImageBase64: "x"}) != "http://i" {
		t.Fatal("image source")
	}
	text, tokens := parseChatResponse(js(t, `{"choices":[{"message":{"content":"ok"}}],"usage":{"total_tokens":42}}`))
	if text != "ok" || tokens != 42 {
		t.Fatal("parse")
	}
	if text, tokens := parseChatResponse(js(t, `{}`)); text != "" || tokens != 0 {
		t.Fatal("parse empty")
	}
	if estimateUSD("gpt-4o-mini", 1000) != 0.0006 || estimateUSD("unknown", 1000) != 0.002 || estimateUSD("x", -5) != 0 {
		t.Fatal("estimate")
	}
}
