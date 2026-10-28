package edge

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/cluster"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Heartbeater is the cluster heartbeat path (ClusterService.heartbeat).
type Heartbeater interface {
	Heartbeat(ctx context.Context, nodeID string, stats *y.Map) error
}

// conn is one live edge connection.
type conn struct {
	nodeID       string
	ws           *websocket.Conn
	role         string
	agentVersion string
	capabilities []string
	connectedAt  time.Time

	mu          sync.Mutex
	missedPongs int
	closed      bool
	pending     map[string]chan any
	stop        chan struct{}
}

// Gateway is EdgeGateway: upgrade auth, one connection per node (newer
// wins), JSON frame routing, JSON keepalive pings and request→reply.
type Gateway struct {
	db      *sql.DB
	token   func() string
	cluster Heartbeater
	repo    *Repo
	framer  *Framer
	log     *slog.Logger
	now     func() time.Time
	// PingEvery is the keepalive cadence (PingInterval; tests shorten it).
	PingEvery time.Duration

	mu             sync.Mutex
	conns          map[string]*conn
	lastDisconnect map[string]time.Time
}

// NewGateway builds the gateway. token returns STREAMHUB_CLUSTER_TOKEN.
func NewGateway(global *sql.DB, token func() string, hb Heartbeater, repo *Repo, framer *Framer, log *slog.Logger) *Gateway {
	return &Gateway{
		db: global, token: token, cluster: hb, repo: repo, framer: framer, log: log, now: time.Now,
		PingEvery: PingInterval, conns: map[string]*conn{}, lastDisconnect: map[string]time.Time{},
	}
}

// Middleware claims WebSocket upgrades on WSPath before the API mux (Node
// hangs the gateway off the HTTP server's 'upgrade' event, outside express).
// Non-upgrade requests on the path fall through.
func (g *Gateway) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != WSPath || !isUpgrade(r) {
			next.ServeHTTP(w, r)
			return
		}
		g.ServeWS(w, r)
	})
}

func isUpgrade(r *http.Request) bool {
	return headerHasToken(r.Header.Get("Connection"), "upgrade") && r.Header.Get("Upgrade") != ""
}

func headerHasToken(v, token string) bool {
	for _, t := range strings.Split(v, ",") {
		if strings.EqualFold(strings.TrimSpace(t), token) {
			return true
		}
	}
	return false
}

// Decision is an upgrade authorization result.
type Decision struct {
	OK      bool
	NodeID  string
	Code    int
	Message string
}

// Authorize is authorizeUpgrade: disabled → 503, bad token → 401 (header or
// ?token=), missing nodeId → 400, unknown node → 404.
func (g *Gateway) Authorize(r *http.Request) Decision {
	q := r.URL.Query()
	token := r.Header.Get("X-Cluster-Token")
	if _, ok := r.Header["X-Cluster-Token"]; !ok {
		token = q.Get("token")
	}
	expected := g.token()
	if expected == "" {
		return Decision{Code: 503, Message: "cluster disabled"}
	}
	if !cluster.TokenMatches(token, expected) {
		return Decision{Code: 401, Message: "invalid cluster token"}
	}
	nodeID := q.Get("nodeId")
	if nodeID == "" {
		return Decision{Code: 400, Message: "nodeId required"}
	}
	var one int
	if err := g.db.QueryRow(`SELECT 1 FROM nodes WHERE id = ?`, nodeID).Scan(&one); err != nil {
		return Decision{NodeID: nodeID, Code: 404, Message: "unknown node"}
	}
	return Decision{OK: true, NodeID: nodeID, Code: 101, Message: "ok"}
}

// ServeWS authorizes and accepts (or rejects with Node's raw response).
func (g *Gateway) ServeWS(w http.ResponseWriter, r *http.Request) {
	d := g.Authorize(r)
	if !d.OK {
		reject(w, d.Code, d.Message)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // ws has no origin check
		CompressionMode:    websocket.CompressionDisabled,
		OnPongReceived: func(context.Context, []byte) {
			g.resetPongs(d.NodeID)
		},
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(100 << 20) // ws' default maxPayload
	g.Accept(d.NodeID, ws)
}

// reject writes exactly what Node writes on the raw socket:
// "HTTP/1.1 <code> <message>\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".
func reject(w http.ResponseWriter, code int, message string) {
	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		w.Header().Set("Connection", "close")
		w.WriteHeader(code)
		return
	}
	defer conn.Close()
	_, _ = fmt.Fprintf(brw, "HTTP/1.1 %d %s\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", code, message)
	_ = brw.Flush()
}

// Accept registers a validated socket; an existing connection of the node
// is replaced (closed 4409).
func (g *Gateway) Accept(nodeID string, ws *websocket.Conn) {
	c := &conn{nodeID: nodeID, ws: ws, capabilities: []string{}, connectedAt: g.now(), pending: map[string]chan any{}, stop: make(chan struct{})}
	g.mu.Lock()
	prev := g.conns[nodeID]
	g.conns[nodeID] = c
	g.mu.Unlock()
	if prev != nil {
		g.clear(prev, true)
		go func() { _ = prev.ws.Close(4409, "replaced by newer connection") }()
	}
	go g.readLoop(c)
	go g.pingLoop(c)
	g.log.Info("edge node connected: " + nodeID)
}

func (g *Gateway) readLoop(c *conn) {
	ctx := context.Background()
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			g.onClose(c)
			return
		}
		if f := ParseFrame(data); f != nil {
			g.onFrame(c, f)
		}
	}
}

func (g *Gateway) pingLoop(c *conn) {
	t := time.NewTicker(g.PingEvery)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
			c.mu.Lock()
			if c.closed {
				c.mu.Unlock()
				return
			}
			dead := c.missedPongs >= MaxMissedPongs
			if !dead {
				c.missedPongs++
			}
			c.mu.Unlock()
			if dead {
				g.log.Warn(fmt.Sprintf("edge node %s missed pongs — terminating", c.nodeID))
				_ = c.ws.CloseNow()
				g.onClose(c)
				return
			}
			g.Send(c.nodeID, pingFrame{"ping"})
		}
	}
}

type pingFrame struct {
	Type string `json:"type"`
}

func (g *Gateway) resetPongs(nodeID string) {
	g.mu.Lock()
	c := g.conns[nodeID]
	g.mu.Unlock()
	if c != nil {
		c.mu.Lock()
		c.missedPongs = 0
		c.mu.Unlock()
	}
}

// onClose drops the connection unless it was already replaced (a stale
// close of an old socket never drops the newer one). Idempotent.
func (g *Gateway) onClose(c *conn) {
	g.mu.Lock()
	current := g.conns[c.nodeID] == c
	if current {
		delete(g.conns, c.nodeID)
		g.lastDisconnect[c.nodeID] = g.now()
	}
	g.mu.Unlock()
	g.clear(c, true)
	if current {
		g.log.Info("edge node disconnected: " + c.nodeID)
	}
}

// clear stops the ping loop and abandons pending requests.
func (g *Gateway) clear(c *conn, closed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if closed && !c.closed {
		c.closed = true
		close(c.stop)
	}
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
}

// ---------------------------------------------------------------------------
// inbound frames
// ---------------------------------------------------------------------------

func (g *Gateway) onFrame(c *conn, f *Frame) {
	ctx := context.Background()
	switch f.Type {
	case "register":
		c.mu.Lock()
		c.role, _ = f.Str("role")
		c.agentVersion, _ = f.Str("agentVersion")
		c.capabilities = []string{}
		if arr, ok := f.Get("capabilities").([]any); ok {
			for _, v := range arr {
				if s, ok := v.(string); ok {
					c.capabilities = append(c.capabilities, s)
				}
			}
		}
		c.mu.Unlock()
		_ = g.cluster.Heartbeat(ctx, c.nodeID, nil) // vanished node: the watchdog reconciles
		g.reoffer(ctx, c.nodeID)
	case "telemetry":
		if stats, ok := f.Get("stats").(*y.Map); ok {
			if err := g.cluster.Heartbeat(ctx, c.nodeID, stats); err != nil {
				g.log.Debug(fmt.Sprintf("telemetry persist for %s failed: %s", c.nodeID, err))
			}
		}
	case "assignment_status":
		id, ok1 := f.Str("id")
		status, ok2 := f.Str("status")
		if !ok1 || !ok2 || id == "" || status == "" {
			return
		}
		if status != StatusRunning && status != StatusStopped && status != StatusFailed {
			return
		}
		var detail *string
		if d, ok := f.Str("detail"); ok {
			detail = &d
		}
		_ = g.repo.UpdateStatus(ctx, id, status, detail)
	case "cmd_result":
		id, ok := f.Str("cmdId")
		if !ok || id == "" {
			return
		}
		res := CommandResult{OK: f.Get("ok") == true}
		if out, ok := f.Str("output"); ok {
			res.Output = &out
		}
		g.resolve(c, id, res)
	case "log_tail_result":
		id, ok := f.Str("reqId")
		if !ok || id == "" {
			return
		}
		lines := []string{}
		if arr, ok := f.Get("lines").([]any); ok {
			for _, v := range arr {
				if s, ok := v.(string); ok {
					lines = append(lines, s)
				}
			}
		}
		g.resolve(c, id, lines)
	case "pong":
		c.mu.Lock()
		c.missedPongs = 0
		c.mu.Unlock()
	default:
		g.log.Debug(fmt.Sprintf("edge %s: ignoring frame '%s'", c.nodeID, f.Type))
	}
}

// reoffer pushes every pending/offered assignment of a (re)connected node.
func (g *Gateway) reoffer(ctx context.Context, nodeID string) {
	parked, err := g.repo.PendingOrOfferedByNode(ctx, nodeID)
	if err != nil {
		return
	}
	for _, a := range parked {
		if g.Send(nodeID, g.framer.AssignFrame(a)) {
			_ = g.repo.UpdateStatus(ctx, a.ID, StatusOffered, nil)
		}
	}
	if len(parked) > 0 {
		g.log.Info(fmt.Sprintf("re-offered %d assignment(s) to %s", len(parked), nodeID))
	}
}

func (g *Gateway) resolve(c *conn, id string, v any) {
	c.mu.Lock()
	ch, ok := c.pending[id]
	if ok {
		delete(c.pending, id)
	}
	c.mu.Unlock()
	if ok {
		ch <- v
	}
}

// ---------------------------------------------------------------------------
// outbound / liveness accessors
// ---------------------------------------------------------------------------

func (g *Gateway) get(nodeID string) *conn {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.conns[nodeID]
}

// IsConnected: a live WS right now.
func (g *Gateway) IsConnected(nodeID string) bool {
	c := g.get(nodeID)
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed
}

// ConnectedNodeIDs lists every connected node.
func (g *Gateway) ConnectedNodeIDs() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]string, 0, len(g.conns))
	for id := range g.conns {
		out = append(out, id)
	}
	return out
}

// ConnectedSince is when the current connection was accepted.
func (g *Gateway) ConnectedSince(nodeID string) (time.Time, bool) {
	c := g.get(nodeID)
	if c == nil {
		return time.Time{}, false
	}
	return c.connectedAt, true
}

// LastDisconnectAt is the node's last WS drop.
func (g *Gateway) LastDisconnectAt(nodeID string) (time.Time, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	t, ok := g.lastDisconnect[nodeID]
	return t, ok
}

// DisconnectedSince is the last drop while currently disconnected.
func (g *Gateway) DisconnectedSince(nodeID string) (time.Time, bool) {
	if g.IsConnected(nodeID) {
		return time.Time{}, false
	}
	return g.LastDisconnectAt(nodeID)
}

// Send writes a JSON frame (JSON.stringify semantics); false when the node
// is not connected or the write fails.
func (g *Gateway) Send(nodeID string, frame any) bool {
	c := g.get(nodeID)
	if c == nil {
		return false
	}
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return false
	}
	js, err := jsx.Stringify(frame)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, []byte(js)) == nil
}

type revokeFrame struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// Revoke pushes a revoke frame.
func (g *Gateway) Revoke(nodeID, id string) bool { return g.Send(nodeID, revokeFrame{"revoke", id}) }

// CommandResult is a cmd_result.
type CommandResult struct {
	OK     bool    `json:"ok"`
	Output *string `json:"output,omitempty"`
}

// ErrNotConnected / ErrTimeout map to Nest's 503 / 504 {error} bodies.
var (
	ErrNotConnected = cluster.ObjErr(http.StatusServiceUnavailable, "node not connected")
	ErrTimeout      = cluster.ObjErr(http.StatusGatewayTimeout, "edge did not respond in time")
)

// Command runs restart|reboot|ping on a node and awaits cmd_result.
func (g *Gateway) Command(nodeID, command string, args *y.Map, timeout time.Duration) (CommandResult, error) {
	id := uuid.NewString()
	frame := y.NewMap()
	frame.Set("type", "cmd")
	frame.Set("cmdId", id)
	frame.Set("command", command)
	if args != nil {
		frame.Set("args", args)
	}
	v, err := g.request(nodeID, frame, id, timeout)
	if err != nil {
		return CommandResult{}, err
	}
	return v.(CommandResult), nil
}

// LogTail requests the tail of the node's runtime log.
func (g *Gateway) LogTail(nodeID string, lines int, timeout time.Duration) ([]string, error) {
	id := uuid.NewString()
	frame := y.NewMap()
	frame.Set("type", "log_tail")
	frame.Set("reqId", id)
	frame.Set("lines", float64(lines))
	v, err := g.request(nodeID, frame, id, timeout)
	if err != nil {
		return nil, err
	}
	return v.([]string), nil
}

// Disconnect force-closes a node (1000).
func (g *Gateway) Disconnect(nodeID string) {
	c := g.get(nodeID)
	if c == nil {
		return
	}
	go func() {
		if err := c.ws.Close(websocket.StatusNormalClosure, "disconnected by master"); err != nil {
			_ = c.ws.CloseNow()
		}
	}()
	g.onClose(c)
}

func (g *Gateway) request(nodeID string, frame *y.Map, id string, timeout time.Duration) (any, error) {
	c := g.get(nodeID)
	if c == nil {
		return nil, ErrNotConnected
	}
	ch := make(chan any, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, ErrNotConnected
	}
	c.pending[id] = ch
	c.mu.Unlock()
	if !g.Send(nodeID, frame) {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ErrNotConnected
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case v, ok := <-ch:
		if !ok { // connection dropped: Node's pending promise never settles; the timer would fire
			<-t.C
			return nil, ErrTimeout
		}
		return v, nil
	case <-t.C:
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ErrTimeout
	}
}

// Shutdown terminates every connection.
func (g *Gateway) Shutdown() {
	g.mu.Lock()
	conns := g.conns
	g.conns = map[string]*conn{}
	g.mu.Unlock()
	for _, c := range conns {
		g.clear(c, true)
		_ = c.ws.CloseNow()
	}
}
