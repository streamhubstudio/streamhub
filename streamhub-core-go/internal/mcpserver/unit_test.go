package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Ports of config.spec.ts, client.spec.ts and tools.spec.ts (the full
// tool → endpoint mapping is covered by the parity vectors).

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestConfig(t *testing.T) {
	for in, want := range map[string]string{
		"https://media.example.com":          "https://media.example.com/api/v1",
		"http://127.0.0.1:3020":              "http://127.0.0.1:3020/api/v1",
		"https://media.example.com/":         "https://media.example.com/api/v1",
		"https://media.example.com/api/v1":   "https://media.example.com/api/v1",
		"https://media.example.com/api/v1/":  "https://media.example.com/api/v1",
		"  https://media.example.com//  ":    "https://media.example.com/api/v1",
		"https://media.example.com/api/v1//": "https://media.example.com/api/v1",
	} {
		if got := NormalizeBaseURL(in); got != want {
			t.Errorf("NormalizeBaseURL(%q) = %q", in, got)
		}
	}
	base := map[string]string{"STREAMHUB_API_URL": "https://media.example.com", "STREAMHUB_API_TOKEN": "sk_test_123"}
	cfg, err := LoadConfig(env(base), nil)
	if err != nil || cfg.BaseURL != "https://media.example.com/api/v1" || cfg.Token != "sk_test_123" || cfg.AllowDestructive {
		t.Fatalf("%+v %v", cfg, err)
	}
	if _, err := LoadConfig(env(map[string]string{"STREAMHUB_API_TOKEN": "x"}), nil); err == nil || !strings.Contains(err.Error(), "STREAMHUB_API_URL") {
		t.Fatal(err)
	}
	if _, err := LoadConfig(env(map[string]string{"STREAMHUB_API_URL": "http://x"}), nil); err == nil || !strings.Contains(err.Error(), "STREAMHUB_API_TOKEN") {
		t.Fatal(err)
	}
	if cfg, _ := LoadConfig(env(base), []string{"--allow-destructive"}); !cfg.AllowDestructive {
		t.Fatal("flag must enable destructive tools")
	}
	for v, want := range map[string]bool{"true": true, "1": true, "yes": true, "on": true, "TRUE": true, "false": false, "0": false, "off": false, "": false, "nope": false} {
		m := map[string]string{"STREAMHUB_ALLOW_DESTRUCTIVE": v}
		for k, x := range base {
			m[k] = x
		}
		if cfg, _ := LoadConfig(env(m), nil); cfg.AllowDestructive != want {
			t.Errorf("STREAMHUB_ALLOW_DESTRUCTIVE=%q → %v", v, cfg.AllowDestructive)
		}
	}
}

// recorder is an httptest API that records the last request.
type recorder struct {
	method, uri, auth, accept, ctype, body string
	status                                 int
	respBody                               string
}

func (r *recorder) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		b, _ := io.ReadAll(req.Body)
		r.method, r.uri, r.body = req.Method, req.URL.RequestURI(), string(b)
		r.auth, r.accept, r.ctype = req.Header.Get("authorization"), req.Header.Get("accept"), req.Header.Get("content-type")
		w.WriteHeader(r.status)
		_, _ = io.WriteString(w, r.respBody)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func js(v any) string { s, _ := y.Stringify(v); return s }

func TestClient(t *testing.T) {
	ctx := context.Background()
	rec := &recorder{status: 200, respBody: `{"data":{"b":1,"a":2},"error":null}`}
	srv := rec.server(t)
	c := NewClient(srv.URL+"/api/v1", "sk_test", nil)

	// Bearer auth + accept, URL from the base; no body → no content-type.
	v, err := c.Do(ctx, "GET", "/apps", nil, y.Undefined)
	if err != nil || js(v) != `{"b":1,"a":2}` || rec.method != "GET" || rec.uri != "/api/v1/apps" ||
		rec.auth != "Bearer sk_test" || rec.accept != "application/json" || rec.ctype != "" || rec.body != "" {
		t.Fatalf("%v %v %+v", js(v), err, rec)
	}
	// JSON body: content-type + serialized once, key order kept.
	body := y.NewMap()
	body.Set("z", 1.0)
	body.Set("a", "x")
	_, _ = c.Do(ctx, "POST", "/apps", nil, body)
	if rec.ctype != "application/json" || rec.body != `{"z":1,"a":"x"}` {
		t.Fatalf("%+v", rec)
	}
	// Query: undefined/null skipped, insertion order, URLSearchParams encoding.
	_, _ = c.Do(ctx, "GET", "/logs", []QueryParam{{"level", "error"}, {"q", "a b&c*~é"}, {"skip", nil}, {"u", y.Undefined}, {"limit", 50.0}, {"flag", false}}, y.Undefined)
	if rec.uri != "/api/v1/logs?level=error&q=a+b%26c*%7E%C3%A9&limit=50&flag=false" {
		t.Fatal(rec.uri)
	}

	cases := []struct {
		status        int
		body, result  string
		errStatus     int
		errMsgPattern string
	}{
		{200, `{"data":[1],"total":9,"limit":1,"offset":0}`, `{"items":[1],"total":9,"limit":1,"offset":0}`, 0, ""},
		{200, `{"data":[1],"total":9}`, `{"items":[1],"total":9}`, 0, ""},
		{200, `[1,2]`, `[1,2]`, 0, ""},
		{200, `"ok"`, `"ok"`, 0, ""},
		{200, `{"ok":true}`, `{"ok":true}`, 0, ""},
		{204, ``, `{"ok":true}`, 0, ""},
		{404, `{"statusCode":404,"message":"app 'x' not found","error":"Not Found"}`, "", 404, `^app 'x' not found$`},
		{400, `{"statusCode":400,"message":["a","b"],"error":"Bad Request"}`, "", 400, `^a; b$`},
		{403, `{"error":"Forbidden"}`, "", 403, `^Forbidden$`},
		{500, `plain text body  `, "", 500, `^plain text body$`},
		{502, ``, "", 502, `^HTTP 502$`},
		{200, `{"data":null,"error":"quota exceeded"}`, "", 200, `^quota exceeded$`},
		{200, `{"data":null,"error":{"code":"q"}}`, "", 200, `^StreamHub returned an error: \{"code":"q"\}$`},
	}
	for _, tc := range cases {
		rec.status, rec.respBody = tc.status, tc.body
		v, err := c.Do(ctx, "GET", "/x", nil, y.Undefined)
		if tc.errMsgPattern == "" {
			if err != nil || js(v) != tc.result {
				t.Errorf("%d %s → %s %v", tc.status, tc.body, js(v), err)
			}
			continue
		}
		var ae *APIError
		if !errors.As(err, &ae) || ae.Status != tc.errStatus || !regexp.MustCompile(tc.errMsgPattern).MatchString(ae.Message) {
			t.Errorf("%d %s → %v", tc.status, tc.body, err)
		}
	}

	// Network failure → status 0, "Cannot reach StreamHub at <url>: fetch failed".
	dead := NewClient("http://127.0.0.1:1/api/v1", "x", nil)
	_, err = dead.Do(ctx, "GET", "/health", nil, y.Undefined)
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != 0 || ae.Message != "Cannot reach StreamHub at http://127.0.0.1:1/api/v1/health: fetch failed" {
		t.Fatal(err)
	}
	if errorText(err) != "StreamHub API error (network error): "+ae.Message || errorText(errors.New("x")) != "Error: x" {
		t.Fatal(errorText(err))
	}
	if c.Origin() != srv.URL || NewClient("https://m.example/api/v1", "", nil).Origin() != "https://m.example" {
		t.Fatal(c.Origin())
	}
	if ExtractErrorMessage(nil, 502) != "HTTP 502" {
		t.Fatal("fallback")
	}
}

func TestPick(t *testing.T) {
	a := y.NewMap()
	a.Set("b", false)
	a.Set("c", 0.0)
	a.Set("d", nil)
	a.Set("e", "")
	a.Set("a", y.Undefined)
	if got := js(pick(a, []string{"a", "b", "c", "d", "e"})); got != `{"b":false,"c":0,"d":null,"e":""}` {
		t.Fatal(got)
	}
}

func catalogTools(t *testing.T) []*y.Map {
	var cat catalog
	if err := json.Unmarshal(catalogJSON, &cat); err != nil {
		t.Fatal(err)
	}
	var out []*y.Map
	for _, r := range cat.Tools {
		v, _ := y.ParseJSON(r)
		out = append(out, v.(*y.Map))
	}
	return out
}

func TestRegistry(t *testing.T) {
	tools := catalogTools(t)
	if len(tools) != len(toolSpecs) {
		t.Fatalf("catalog %d tools, table %d", len(tools), len(toolSpecs))
	}
	seen := map[string]bool{}
	snake := regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	var gated []string
	for i, tm := range tools {
		name := tm.Get("name").(string)
		if seen[name] || !snake.MatchString(name) || toolSpecs[i].Name != name {
			t.Errorf("bad/duplicate/misordered tool %q", name)
		}
		seen[name] = true
		title, _ := tm.Get("title").(string)
		desc, _ := tm.Get("description").(string)
		if title == "" || len(desc) <= 20 || !strings.Contains(desc, "/api/v1/") {
			t.Errorf("%s: title/description must be present and cite the endpoint", name)
		}
		if _, ok := tm.Get("inputSchema").(*y.Map); !ok {
			t.Errorf("%s: missing inputSchema", name)
		}
		ann, _ := tm.Get("annotations").(*y.Map)
		if toolSpecs[i].Destructive {
			gated = append(gated, name)
			props := tm.Get("inputSchema").(*y.Map).Get("properties").(*y.Map)
			if ann == nil || ann.Get("destructiveHint") != true || !props.Has("confirm") {
				t.Errorf("%s: destructive tool needs destructiveHint + confirm", name)
			}
		}
		if ann != nil && ann.Get("readOnlyHint") == true && ann.Has("destructiveHint") {
			t.Errorf("%s: contradictory hints", name)
		}
	}
	sort.Strings(gated)
	if !slices.Equal(gated, []string{"delete_app", "delete_vod", "purge_app_db"}) {
		t.Fatal(gated)
	}

	// The gate: destructive tools are absent unless allowed.
	safe, _ := New(&Config{BaseURL: tsBase, Token: "x"}, nil)
	all, _ := New(&Config{BaseURL: tsBase, Token: "x", AllowDestructive: true}, nil)
	if len(safe.tools) != len(toolSpecs)-3 || safe.tools["delete_app"] != nil || len(all.tools) != len(toolSpecs) || all.tools["delete_app"] == nil {
		t.Fatalf("gate: %d / %d", len(safe.tools), len(all.tools))
	}
}

func TestDestructiveHandlersRequireConfirm(t *testing.T) {
	c := NewClient("http://127.0.0.1:1/api/v1", "x", nil) // never reached
	for _, name := range []string{"delete_app", "delete_vod", "purge_app_db"} {
		var spec *toolSpec
		for i := range toolSpecs {
			if toolSpecs[i].Name == name {
				spec = &toolSpecs[i]
			}
		}
		a := y.NewMap()
		a.Set("app", "live")
		a.Set("name", "old")
		if _, err := spec.run(context.Background(), c, a); !errors.Is(err, errNotConfirmed) {
			t.Errorf("%s ran without confirm: %v", name, err)
		}
	}
}

func TestPretty(t *testing.T) {
	v, _ := y.ParseJSON([]byte(`{"b":[],"a":{},"2":[1,{"x":null}],"s":"é \"","n":1e21}`))
	want := "{\n  \"2\": [\n    1,\n    {\n      \"x\": null\n    }\n  ],\n  \"b\": [],\n  \"a\": {},\n  \"s\": \"é \\\"\",\n  \"n\": 1e+21\n}"
	if got := Pretty(v); got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	if toText(y.Undefined) != "null" || toText("raw") != "raw" || toText(nil) != "null" {
		t.Fatal("toText")
	}
}
