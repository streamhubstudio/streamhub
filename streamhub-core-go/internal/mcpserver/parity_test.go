package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// The parity suite replays testdata/ts_calls.json + ts_catalog.json
// (generated from the TypeScript server by testdata/gen.mjs) against the Go
// server over a real MCP JSON-RPC session (in-memory transport), with an
// httptest fake API scripted exactly like gen.mjs's fakeFetch.

const tsBase = "https://media.example.com/api/v1"

// fakeAPI is gen.mjs's fakeFetch: /api/v1/apps/<seg> selects a canned
// response; anything else echoes the request.
func fakeAPI(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(r.URL.EscapedPath(), "/")
		seg := ""
		if len(parts) > 4 {
			seg = parts[4]
		}
		jsonResp := func(status int, body string) {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, body)
		}
		switch seg {
		case "e404":
			jsonResp(404, `{"statusCode":404,"message":"app 'e404' not found","error":"Not Found"}`)
		case "e400":
			jsonResp(400, `{"statusCode":400,"message":["name must be a string","room too long"],"error":"Bad Request"}`)
		case "e403err":
			jsonResp(403, `{"statusCode":403,"error":"Forbidden"}`)
		case "e500text":
			w.WriteHeader(500)
			_, _ = io.WriteString(w, "upstream exploded")
		case "e502empty":
			w.WriteHeader(502)
		case "e204":
			w.WriteHeader(204)
		case "eenv":
			jsonResp(200, `{"data":null,"error":{"code":"quota","message":"quota exceeded"}}`)
		case "eenvstr":
			jsonResp(200, `{"data":null,"error":"bad thing"}`)
		case "paged":
			jsonResp(200, `{"data":[{"id":1},{"id":2}],"total":9,"limit":2,"offset":0}`)
		case "bare":
			jsonResp(200, `[1,"x",{"2":3,"b":2,"a":1}]`)
		case "text":
			w.WriteHeader(200)
			_, _ = io.WriteString(w, "plain text body")
		case "undef":
			jsonResp(200, `{"data":null,"error":null}`)
		case "net":
			hj, _ := w.(http.Hijacker)
			c, _, _ := hj.Hijack()
			_ = c.Close()
		default:
			b, _ := io.ReadAll(r.Body)
			echo := y.NewMap()
			echo.Set("method", r.Method)
			echo.Set("url", "https://media.example.com"+r.URL.RequestURI())
			echo.Set("authorization", r.Header.Get("authorization"))
			echo.Set("accept", r.Header.Get("accept"))
			if ct := r.Header.Get("content-type"); ct != "" {
				echo.Set("contentType", ct)
			} else {
				echo.Set("contentType", nil)
			}
			if len(b) > 0 {
				echo.Set("body", string(b))
			} else {
				echo.Set("body", nil)
			}
			env := y.NewMap()
			env.Set("data", echo)
			env.Set("error", nil)
			s, _ := y.Stringify(env)
			jsonResp(200, s)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// session is a raw JSON-RPC client over the in-memory MCP transport.
type session struct {
	t    *testing.T
	conn mcp.Connection
	next int64
}

func connect(t *testing.T, allowDestructive bool, base string) *session {
	t.Helper()
	srv, err := New(&Config{BaseURL: base, Token: "sk_test", AllowDestructive: allowDestructive}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ct, st := mcp.NewInMemoryTransports()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if _, err := srv.SDK().Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	conn, err := ct.Connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	s := &session{t: t, conn: conn}
	s.call("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "t", "version": "0"}})
	_ = conn.Write(ctx, &jsonrpc.Request{Method: "notifications/initialized", Params: json.RawMessage(`{}`)})
	return s
}

type rpcErr struct {
	Code    int64
	Message string
}

// call sends one request and returns its raw result (or the error).
func (s *session) call(method string, params any) (json.RawMessage, *rpcErr) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.next++
	id, _ := jsonrpc.MakeID(float64(s.next))
	var p json.RawMessage
	switch x := params.(type) {
	case json.RawMessage:
		p = x
	case string:
		p = json.RawMessage(x)
	default:
		p, _ = json.Marshal(params)
	}
	if err := s.conn.Write(ctx, &jsonrpc.Request{ID: id, Method: method, Params: p}); err != nil {
		s.t.Fatal(err)
	}
	for {
		msg, err := s.conn.Read(ctx)
		if err != nil {
			s.t.Fatal(err)
		}
		res, ok := msg.(*jsonrpc.Response)
		if !ok || res.ID != id {
			continue
		}
		if res.Error != nil {
			var we *jsonrpc.Error
			if errors.As(res.Error, &we) {
				return nil, &rpcErr{we.Code, we.Message}
			}
			return nil, &rpcErr{0, res.Error.Error()}
		}
		return res.Result, nil
	}
}

// load parses a testdata vector file in JS key order.
func load(t *testing.T, name string) *y.Map {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	v, err := y.ParseJSON(b)
	if err != nil {
		t.Fatal(err)
	}
	return v.(*y.Map)
}

// generic decodes JSON into plain Go values (key order irrelevant).
func generic(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("%v: %s", err, b)
	}
	return v
}

func stringify(v any) string { s, _ := y.Stringify(v); return s }

func TestParityCatalogue(t *testing.T) {
	cat := load(t, "ts_catalog.json")
	for _, mode := range []string{"safe", "destructive"} {
		t.Run(mode, func(t *testing.T) {
			want := cat.Get(mode).(*y.Map)
			s := connect(t, mode == "destructive", tsBase)
			for method, key := range map[string]string{
				"tools/list": "tools", "resources/list": "resources",
				"resources/templates/list": "resourceTemplates", "prompts/list": "prompts",
			} {
				got, rerr := s.call(method, "{}")
				if rerr != nil {
					t.Fatalf("%s: %+v", method, rerr)
				}
				exp := `{"` + key + `":` + stringify(want.Get(key)) + `}`
				if !reflect.DeepEqual(generic(t, got), generic(t, []byte(exp))) {
					t.Errorf("%s differs from the TypeScript server", method)
				}
			}
		})
	}
}

func TestParityInitialize(t *testing.T) {
	want := load(t, "ts_catalog.json").Get("safe").(*y.Map)
	srv, _ := New(&Config{BaseURL: tsBase, Token: "x"}, nil)
	ct, st := mcp.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := srv.SDK().Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "0"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	init := cs.InitializeResult()
	info, _ := json.Marshal(init.ServerInfo)
	caps, _ := json.Marshal(init.Capabilities)
	if !reflect.DeepEqual(generic(t, info), generic(t, []byte(stringify(want.Get("serverInfo"))))) {
		t.Errorf("serverInfo = %s", info)
	}
	if !reflect.DeepEqual(generic(t, caps), generic(t, []byte(stringify(want.Get("capabilities"))))) {
		t.Errorf("capabilities = %s", caps)
	}
	if init.Instructions != "" {
		t.Errorf("unexpected instructions %q", init.Instructions)
	}
}

// stripClientPrefix removes the "MCP error <code>: " the TypeScript client
// prepends to a JSON-RPC error message (the server sent the rest).
func stripClientPrefix(code float64, msg string) string {
	return strings.TrimPrefix(msg, "MCP error "+y.JSNumberString(code)+": ")
}

func TestParityCalls(t *testing.T) {
	vec := load(t, "ts_calls.json")
	api := fakeAPI(t)
	for _, mode := range []string{"safe", "destructive"} {
		t.Run(mode, func(t *testing.T) {
			m := vec.Get(mode).(*y.Map)
			s := connect(t, mode == "destructive", api.URL+"/api/v1")
			fix := func(b []byte) any {
				return generic(t, []byte(strings.ReplaceAll(string(b), api.URL, "https://media.example.com")))
			}
			for i, c := range m.Get("calls").([]any) {
				cm := c.(*y.Map)
				params := `{"name":` + stringify(cm.Get("tool")) + `,"arguments":` + stringify(cm.Get("args")) + `}`
				got, rerr := s.call("tools/call", params)
				if rerr != nil {
					t.Errorf("call %d %v: rpc error %+v", i, cm.Get("tool"), rerr)
					continue
				}
				if want := cm.Get("result"); !reflect.DeepEqual(fix(got), generic(t, []byte(stringify(want)))) {
					t.Errorf("call %d %s %s:\n got  %s\n want %s", i, cm.Get("tool"), stringify(cm.Get("args")), got, stringify(want))
				}
			}
			for _, r := range m.Get("reads").([]any) {
				rm := r.(*y.Map)
				got, rerr := s.call("resources/read", `{"uri":`+stringify(rm.Get("uri"))+`}`)
				checkRPC(t, "read "+rm.Get("uri").(string), rm, got, rerr, fix)
			}
			for _, p := range m.Get("prompts").([]any) {
				pm := p.(*y.Map)
				got, rerr := s.call("prompts/get", `{"name":`+stringify(pm.Get("name"))+`,"arguments":`+stringify(pm.Get("arguments"))+`}`)
				checkRPC(t, "prompt "+stringify(pm), pm, got, rerr, fix)
			}
		})
	}
}

func checkRPC(t *testing.T, label string, want *y.Map, got json.RawMessage, rerr *rpcErr, fix func([]byte) any) {
	t.Helper()
	if e, ok := want.Get("error").(*y.Map); ok {
		code := e.Get("code").(float64)
		msg := stripClientPrefix(code, e.Get("message").(string))
		if rerr == nil || rerr.Code != int64(code) || rerr.Message != msg {
			t.Errorf("%s: got %+v / %s, want error %v %q", label, rerr, got, code, msg)
		}
		return
	}
	if rerr != nil {
		t.Errorf("%s: unexpected error %+v", label, rerr)
		return
	}
	if !reflect.DeepEqual(fix(got), generic(t, []byte(stringify(want.Get("result"))))) {
		t.Errorf("%s:\n got  %s\n want %s", label, got, stringify(want.Get("result")))
	}
}
