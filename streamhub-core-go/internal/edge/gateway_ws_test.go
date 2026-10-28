package edge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/cluster"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Replays testdata/ws_vectors.json — recorded from the Node gateway by
// testdata/record-node-ws.js — against the Go gateway: every master→edge
// frame must be byte-identical (after the same placeholder substitution) and
// every HTTP reply JSON-identical (key order included).

type vector struct {
	Token string `json:"token"`
	Steps []struct {
		Step     string `json:"step"`
		Response string `json:"response"`
		Frame    string `json:"frame"`
		Close    *struct {
			Code   int    `json:"code"`
			Reason string `json:"reason"`
		} `json:"close"`
	} `json:"steps"`
}

type stack struct {
	store  *db.Service
	srv    *httptest.Server
	gw     *Gateway
	nodeID string
	ph     map[string]string
}

func newStack(t *testing.T, token string) *stack {
	t.Helper()
	store, g, dir := testutil.Store(t)
	t.Setenv("STREAMHUB_CLUSTER_REQUIRE_TLS", "")
	cfg := &config.Config{DataDir: dir, ClusterToken: token}
	role := cluster.NewNodeRole(g, func(string) string { return "" }, testutil.Log())
	csvc := cluster.New(cfg, g, role, nil, testutil.Log())
	repo := NewRepo(g)
	framer := &Framer{}
	gw := NewGateway(g, func() string { return cfg.ClusterToken }, csvc, repo, framer, testutil.Log())
	gw.PingEvery = 300 * time.Millisecond
	sched := NewScheduler(cfg, g, gw, repo, framer, NewAlerter(nil, nil, testutil.Log()), nil, testutil.Log())
	mod := NewModule(g, gw, sched, repo, func() Catalog { return nil }, nil, func() Logs { return nil })
	mod.CommandTimeout, mod.LogTimeout = 400*time.Millisecond, 400*time.Millisecond
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	mod.Register(a)
	cluster.NewRoutes(csvc, nil).Register(a)
	srv := httptest.NewServer(httpx.Chain(mux, gw.Middleware, httpx.WithRequest))
	t.Cleanup(func() { gw.Shutdown(); srv.Close() })

	payload, _, err := csvc.Join(context.Background(), cluster.JoinInput{Name: "ws-edge", IP: "192.0.2.10", Type: "edge"}, true)
	if err != nil {
		t.Fatal(err)
	}
	return &stack{store: store, srv: srv, gw: gw, nodeID: payload.NodeID, ph: map[string]string{payload.NodeID: "{{nodeId}}"}}
}

var (
	sqlTS = regexp.MustCompile(`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`)
	isoTS = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`)
)

func (s *stack) norm(text string) string {
	for v, k := range s.ph {
		text = strings.ReplaceAll(text, v, k)
	}
	return isoTS.ReplaceAllString(sqlTS.ReplaceAllString(text, "<sql-ts>"), "<iso-ts>")
}

// api calls the REST surface and renders {"status":N,"body":<JSON as sent>}.
func (s *stack) api(t *testing.T, method, path string, body any) string {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	}
	req, _ := http.NewRequest(method, s.srv.URL+"/api/v1"+path, rd)
	req.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	v, err := y.ParseJSON(raw)
	if err != nil {
		t.Fatalf("%s %s: %s", method, path, raw)
	}
	js, _ := y.Stringify(v)
	return fmt.Sprintf(`{"status":%d,"body":%s}`, res.StatusCode, js)
}

// rawUpgrade sends an upgrade request and returns the raw answer bytes.
func rawUpgrade(t *testing.T, base, pathq string, headers map[string]string) string {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(base, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var h strings.Builder
	for k, v := range headers {
		h.WriteString(k + ": " + v + "\r\n")
	}
	fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"+
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n%s\r\n", pathq, h.String())
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	out, _ := io.ReadAll(bufio.NewReader(conn))
	return string(out)
}

type client struct {
	ws     *websocket.Conn
	frames chan string
	closed chan websocket.CloseError
}

func dialEdge(t *testing.T, s *stack, query string, headers http.Header) *client {
	t.Helper()
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(s.srv.URL, "http")+WSPath+query, &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		t.Fatal(err)
	}
	c := &client{ws: ws, frames: make(chan string, 64), closed: make(chan websocket.CloseError, 1)}
	go func() {
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				var ce websocket.CloseError
				if errors.As(err, &ce) {
					c.closed <- ce
				}
				close(c.frames)
				return
			}
			c.frames <- string(data)
		}
	}()
	return c
}

func (c *client) send(t *testing.T, v any) {
	t.Helper()
	var data []byte
	if s, ok := v.(string); ok {
		data = []byte(s)
	} else {
		data, _ = json.Marshal(v)
	}
	if err := c.ws.Write(context.Background(), websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}

// next returns the next non-ping frame (pings are checked separately).
func (c *client) next(t *testing.T, skipPings bool) string {
	t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case f, ok := <-c.frames:
			if !ok {
				t.Fatal("socket closed")
			}
			if skipPings && f == `{"type":"ping"}` {
				continue
			}
			return f
		case <-timeout:
			t.Fatal("no frame")
		}
	}
}

func TestWSProtocolMatchesNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/ws_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vec vector
	if err := json.Unmarshal(raw, &vec); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{}
	var closeWant *struct {
		Code   int    `json:"code"`
		Reason string `json:"reason"`
	}
	for _, st := range vec.Steps {
		want[st.Step] = st.Response + st.Frame
		if st.Close != nil {
			closeWant = st.Close
		}
	}
	s := newStack(t, vec.Token)
	check := func(step, got string) {
		t.Helper()
		if got != want[step] {
			t.Errorf("%s:\n got  %s\n want %s", step, got, want[step])
		}
	}
	q := func(x string) string { return WSPath + x }

	// 1) upgrade rejections: Node's exact raw responses
	check("reject-no-token", rawUpgrade(t, s.srv.URL, q("?nodeId="+s.nodeID), nil))
	check("reject-bad-token", rawUpgrade(t, s.srv.URL, q("?nodeId="+s.nodeID), map[string]string{"X-Cluster-Token": "nope"}))
	check("reject-no-node", rawUpgrade(t, s.srv.URL, q(""), map[string]string{"X-Cluster-Token": vec.Token}))
	check("reject-unknown-node", rawUpgrade(t, s.srv.URL, q("?nodeId=ghost&token="+vec.Token), nil))

	// 2) connect + register
	c := dialEdge(t, s, "?nodeId="+s.nodeID, http.Header{"X-Cluster-Token": {vec.Token}})
	c.send(t, map[string]any{"type": "register", "role": "edge", "agentVersion": "1.2.3", "capabilities": []any{"cuda", 7}})
	time.Sleep(100 * time.Millisecond)

	// 3) schedule onto the connected node
	created := s.api(t, "POST", "/edge/assignments", json.RawMessage(`{"app":"live","pluginId":"wsplug","streamId":"cam1","config":{"room":"cam1","z":1,"a":{"b":[1,2.5,"x"]}}}`))
	var cr struct {
		Body struct{ Data struct{ ID string } }
	}
	_ = json.Unmarshal([]byte(created), &cr)
	asg1 := cr.Body.Data.ID
	s.ph[asg1] = "{{asg1}}"
	check("schedule-http", s.norm(created))
	check("schedule-frame", s.norm(c.next(t, true)))

	// 4) status + telemetry + junk frames
	c.send(t, map[string]any{"type": "assignment_status", "id": asg1, "status": "running", "detail": "pid 42"})
	c.send(t, json.RawMessage(`{"type":"telemetry","stats":{"cpu":0.5,"grid":{"gpu":true,"vramFreeMb":3000},"z":[1]}}`))
	c.send(t, "not json")
	c.send(t, map[string]any{"type": "mystery"})
	time.Sleep(200 * time.Millisecond)
	check("after-status", s.norm(s.api(t, "GET", "/edge/assignments?app=live", nil)))
	check("after-telemetry", s.norm(nodeOf(t, s.api(t, "GET", "/edge/nodes", nil), s.nodeID)))

	// 5) command round-trip
	cmdDone := make(chan string, 1)
	go func() {
		cmdDone <- s.api(t, "POST", "/edge/nodes/"+s.nodeID+"/command", json.RawMessage(`{"command":"restart","args":{"soft":true,"n":1}}`))
	}()
	cmdFrame := c.next(t, true)
	cmdID := field(cmdFrame, "cmdId")
	s.ph[cmdID] = "{{cmdId}}"
	check("cmd-frame", s.norm(cmdFrame))
	c.send(t, map[string]any{"type": "cmd_result", "cmdId": cmdID, "ok": true, "output": "restarted"})
	check("cmd-http", s.norm(<-cmdDone))

	// 6) log tail round-trip
	logDone := make(chan string, 1)
	go func() { logDone <- s.api(t, "GET", "/edge/nodes/"+s.nodeID+"/logs?lines=5", nil) }()
	logFrame := c.next(t, true)
	reqID := field(logFrame, "reqId")
	s.ph[reqID] = "{{reqId}}"
	check("logtail-frame", s.norm(logFrame))
	c.send(t, map[string]any{"type": "log_tail_result", "reqId": reqID, "lines": []any{"a", 2, "b"}})
	check("logtail-http", s.norm(<-logDone))

	// 7) command timeout → 504
	toDone := make(chan string, 1)
	go func() {
		toDone <- s.api(t, "POST", "/edge/nodes/"+s.nodeID+"/command", json.RawMessage(`{"command":"ping"}`))
	}()
	toFrame := c.next(t, true)
	s.ph[field(toFrame, "cmdId")] = "{{cmdId2}}"
	check("cmd2-frame", s.norm(toFrame))
	check("cmd-timeout-http", s.norm(<-toDone))

	// 8) keepalive ping frame, answered with a JSON pong
	ping := ""
	for ping == "" {
		if f := c.next(t, false); f == `{"type":"ping"}` {
			ping = f
		}
	}
	check("ping-frame", ping)
	c.send(t, map[string]any{"type": "pong"})

	// 9) revoke
	check("revoke-http", s.norm(s.api(t, "DELETE", "/edge/assignments/"+asg1, nil)))
	check("revoke-frame", s.norm(c.next(t, true)))

	// 10) second assignment, then a newer connection replaces the old (4409)
	c2resp := s.api(t, "POST", "/edge/assignments", json.RawMessage(`{"app":"live","pluginId":"wsplug2"}`))
	var cr2 struct {
		Body struct{ Data struct{ ID string } }
	}
	_ = json.Unmarshal([]byte(c2resp), &cr2)
	s.ph[cr2.Body.Data.ID] = "{{asg2}}"
	check("schedule2-frame", s.norm(c.next(t, true)))
	c2 := dialEdge(t, s, "?nodeId="+s.nodeID+"&token="+vec.Token, nil)
	select {
	case ce := <-c.closed:
		if int(ce.Code) != closeWant.Code || ce.Reason != closeWant.Reason {
			t.Errorf("replaced-close: %d %q want %d %q", ce.Code, ce.Reason, closeWant.Code, closeWant.Reason)
		}
	case <-time.After(3 * time.Second):
		t.Error("old socket was not closed")
	}
	c2.send(t, map[string]any{"type": "register", "role": "edge"})
	check("reoffer-frame", s.norm(c2.next(t, true)))
	checkUnordered(t, "after-reoffer", s.norm(s.api(t, "GET", "/edge/assignments?app=live", nil)), want["after-reoffer"])
	_ = c2.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(200 * time.Millisecond)
	check("after-close", s.norm(nodeOf(t, s.api(t, "GET", "/edge/nodes", nil), s.nodeID)))
	if s.gw.IsConnected(s.nodeID) {
		t.Fatal("still connected after close")
	}
	if _, ok := s.gw.LastDisconnectAt(s.nodeID); !ok {
		t.Fatal("disconnect not recorded")
	}
}

func field(frame, key string) string {
	var m map[string]any
	_ = json.Unmarshal([]byte(frame), &m)
	s, _ := m[key].(string)
	return s
}

// nodeOf picks one node of a GET /edge/nodes reply, rendered as Node does.
func nodeOf(t *testing.T, resp, id string) string {
	t.Helper()
	v, _ := y.ParseJSON([]byte(resp))
	for _, n := range v.(*y.Map).Get("body").(*y.Map).Get("data").([]any) {
		if n.(*y.Map).Get("id") == id {
			js, _ := y.Stringify(n)
			return js
		}
	}
	t.Fatalf("node %s not listed", id)
	return ""
}

// checkUnordered compares {"status","body":{"data":[...]}} with data as a
// multiset (rows created within one second sort by random uuid).
func checkUnordered(t *testing.T, step, got, want string) {
	t.Helper()
	split := func(s string) []string {
		v, err := y.ParseJSON([]byte(s))
		if err != nil {
			return []string{s}
		}
		var out []string
		for _, e := range v.(*y.Map).Get("body").(*y.Map).Get("data").([]any) {
			js, _ := y.Stringify(e)
			out = append(out, js)
		}
		sort.Strings(out)
		return out
	}
	g, w := split(got), split(want)
	if strings.Join(g, "\n") != strings.Join(w, "\n") {
		t.Errorf("%s:\n got  %v\n want %v", step, g, w)
	}
}

func TestWSRejectDisabled(t *testing.T) {
	s := newStack(t, "tok")
	s.gw.token = func() string { return "" }
	// edge.gateway.ts rejectUpgrade with (503, 'cluster disabled')
	if got := rawUpgrade(t, s.srv.URL, WSPath+"?nodeId=x", nil); got != "HTTP/1.1 503 cluster disabled\r\nConnection: close\r\nContent-Length: 0\r\n\r\n" {
		t.Fatalf("%q", got)
	}
	// a non-upgrade GET on the path falls through to the mux
	res, err := http.Get(s.srv.URL + WSPath)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == http.StatusSwitchingProtocols {
		t.Fatal("plain GET upgraded")
	}
}

func TestWSMissedPongsTerminate(t *testing.T) {
	s := newStack(t, "tok")
	s.gw.PingEvery = 50 * time.Millisecond
	c := dialEdge(t, s, "?nodeId="+s.nodeID+"&token=tok", nil)
	_ = c
	deadline := time.Now().Add(3 * time.Second)
	for s.gw.IsConnected(s.nodeID) {
		if time.Now().After(deadline) {
			t.Fatal("silent node never terminated after 3 missed pongs")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestWSPongKeepsAlive(t *testing.T) {
	s := newStack(t, "tok")
	s.gw.PingEvery = 50 * time.Millisecond
	c := dialEdge(t, s, "?nodeId="+s.nodeID+"&token=tok", nil)
	go func() {
		for f := range c.frames {
			if f == `{"type":"ping"}` {
				_ = c.ws.Write(context.Background(), websocket.MessageText, []byte(`{"type":"pong"}`))
			}
		}
	}()
	time.Sleep(600 * time.Millisecond) // > 10 ping periods
	if !s.gw.IsConnected(s.nodeID) {
		t.Fatal("a ponging node was terminated")
	}
}

func TestCommandNotConnected(t *testing.T) {
	s := newStack(t, "tok")
	if _, err := s.gw.Command(s.nodeID, "ping", nil, time.Second); err != ErrNotConnected {
		t.Fatal(err)
	}
	if s.gw.Send(s.nodeID, map[string]string{"type": "x"}) {
		t.Fatal("send to a disconnected node")
	}
}
