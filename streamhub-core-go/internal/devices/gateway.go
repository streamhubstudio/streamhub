package devices

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// UpgradeGuard rejects an upgrade from a banned/blocked IP ("" = allow).
type UpgradeGuard interface {
	RejectUpgradeReason(ip string) string
}

type dconn struct {
	id, app     string
	ws          *websocket.Conn
	connectedAt time.Time

	mu      sync.Mutex
	closed  bool
	pending map[string]chan DeviceCommandResult
	stop    chan struct{}
}

// Gateway is the device WS control channel: `Authorization: Device <dk_…>`
// upgrade auth, one connection per device (newer wins), JSON frames,
// protocol-level keepalive pings, command → command_result.
type Gateway struct {
	svc   *Service
	guard UpgradeGuard
	log   *slog.Logger
	// PingEvery is the keepalive cadence (tests shorten it).
	PingEvery time.Duration

	mu    sync.Mutex
	conns map[string]*dconn
}

// NewGateway builds the gateway and attaches it to svc.
func NewGateway(svc *Service, guard UpgradeGuard, log *slog.Logger) *Gateway {
	if log == nil {
		log = slog.Default()
	}
	g := &Gateway{svc: svc, guard: guard, log: log, PingEvery: PingInterval, conns: map[string]*dconn{}}
	svc.gw = g
	return g
}

// Middleware claims upgrades on WSPath before the API mux.
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
	for _, t := range strings.Split(r.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(t), "upgrade") {
			return r.Header.Get("Upgrade") != ""
		}
	}
	return false
}

// credentialOf reads `Authorization: Device <credential>` (only the header:
// a query-string credential would land in access logs).
func credentialOf(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	scheme, cred, ok := strings.Cut(h, " ")
	if !ok || !strings.EqualFold(scheme, AuthScheme) {
		return ""
	}
	return strings.TrimSpace(cred)
}

// Decision is an upgrade authorization result.
type Decision struct {
	OK      bool
	ID, App string
	Code    int
	Message string
}

// Authorize: disabled → 503, blocked IP → 403, bad/revoked credential → 401.
func (g *Gateway) Authorize(r *http.Request) Decision {
	if !g.svc.Enabled() {
		return Decision{Code: http.StatusServiceUnavailable, Message: "device plane disabled"}
	}
	ip := httpx.ClientIP(r)
	if g.guard != nil {
		if reason := g.guard.RejectUpgradeReason(ip); reason != "" {
			return Decision{Code: http.StatusForbidden, Message: "forbidden"}
		}
	}
	row, ok := g.svc.Authenticate(r.Context(), credentialOf(r))
	if !ok {
		g.svc.recordOffense(ip)
		return Decision{Code: http.StatusUnauthorized, Message: "invalid device credential"}
	}
	return Decision{OK: true, ID: row.ID, App: row.App, Code: http.StatusSwitchingProtocols, Message: "ok"}
}

// ServeWS authorizes and accepts.
func (g *Gateway) ServeWS(w http.ResponseWriter, r *http.Request) {
	d := g.Authorize(r)
	if !d.OK {
		w.Header().Set("Connection", "close")
		httpx.WriteJSON(w, d.Code, map[string]any{"statusCode": d.Code, "message": d.Message})
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // devices are not browsers: no Origin to check
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimit)
	g.accept(d.ID, d.App, httpx.ClientIP(r), ws)
}

func (g *Gateway) accept(id, app, ip string, ws *websocket.Conn) {
	c := &dconn{id: id, app: app, ws: ws, connectedAt: time.Now(), pending: map[string]chan DeviceCommandResult{}, stop: make(chan struct{})}
	g.mu.Lock()
	prev := g.conns[id]
	g.conns[id] = c
	g.mu.Unlock()
	if prev != nil {
		g.drop(prev)
		go func() { _ = prev.ws.Close(CloseReplaced, "replaced by newer connection") }()
	}
	g.svc.recordHello(context.Background(), id, ip, &inFrame{}) // last seen / ip
	go g.readLoop(c, ip)
	go g.pingLoop(c)
	g.log.Info("device connected", "deviceId", id, "app", app)
}

func (g *Gateway) readLoop(c *dconn, ip string) {
	ctx := context.Background()
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			g.onClose(c)
			return
		}
		g.onFrame(ctx, c, ip, data)
	}
}

func (g *Gateway) onFrame(ctx context.Context, c *dconn, ip string, data []byte) {
	var f inFrame
	if err := json.Unmarshal(data, &f); err != nil || f.Type == "" {
		g.sendConn(c, errorFrame{Type: FrameError, Message: "invalid frame"})
		return
	}
	// a frame read after a revoke (row gone) must not resurrect anything
	if !g.current(c) {
		return
	}
	switch f.Type {
	case FrameHello:
		g.svc.recordHello(ctx, c.id, ip, &f)
		if cfg, err := g.svc.BuildConfig(ctx, c.id); err == nil {
			g.sendConn(c, cfg)
		}
	case FrameStatus:
		g.svc.recordStatus(ctx, c.id, data)
	case FrameCommandResult:
		if f.ID == "" {
			return
		}
		c.mu.Lock()
		ch, ok := c.pending[f.ID]
		delete(c.pending, f.ID)
		c.mu.Unlock()
		if ok {
			ch <- DeviceCommandResult{ID: f.ID, OK: f.OK, Message: f.Message}
		}
	case FramePing:
		g.svc.touch(ctx, c.id)
		g.sendConn(c, pongFrame{FramePong})
	case FramePong:
		g.svc.touch(ctx, c.id)
	default:
		g.sendConn(c, errorFrame{Type: FrameError, Message: fmt.Sprintf("unknown frame type %q", f.Type)})
	}
}

func (g *Gateway) pingLoop(c *dconn) {
	t := time.NewTicker(g.PingEvery)
	defer t.Stop()
	missed := 0
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(context.Background(), g.PingEvery)
			err := c.ws.Ping(ctx)
			cancel()
			if err == nil {
				missed = 0
				continue
			}
			missed++
			if missed >= MaxMissedPings {
				g.log.Warn("device missed pings — closing", "deviceId", c.id)
				_ = c.ws.CloseNow()
				g.onClose(c)
				return
			}
		}
	}
}

func (g *Gateway) current(c *dconn) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.conns[c.id] == c
}

func (g *Gateway) onClose(c *dconn) {
	g.mu.Lock()
	cur := g.conns[c.id] == c
	if cur {
		delete(g.conns, c.id)
	}
	g.mu.Unlock()
	g.drop(c)
	if cur {
		g.log.Info("device disconnected", "deviceId", c.id)
	}
}

// drop stops the ping loop and fails pending commands.
func (g *Gateway) drop(c *dconn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.stop)
	}
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
}

func (g *Gateway) get(id string) *dconn {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.conns[id]
}

// IsConnected reports a live socket for the device.
func (g *Gateway) IsConnected(id string) bool {
	c := g.get(id)
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed
}

// Send writes a JSON frame to the device; false when not connected.
func (g *Gateway) Send(id string, frame any) bool {
	c := g.get(id)
	if c == nil {
		return false
	}
	return g.sendConn(c, frame)
}

func (g *Gateway) sendConn(c *dconn, frame any) bool {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return false
	}
	js, err := json.Marshal(frame)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, js) == nil
}

// Command sends a command frame and awaits the matching command_result.
func (g *Gateway) Command(id string, f CommandFrame, timeout time.Duration) (*DeviceCommandResult, error) {
	c := g.get(id)
	if c == nil {
		return nil, httpx.Unavailable(msgNotConnected)
	}
	f.ID = uuid.NewString()
	ch := make(chan DeviceCommandResult, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, httpx.Unavailable(msgNotConnected)
	}
	c.pending[f.ID] = ch
	c.mu.Unlock()
	if !g.sendConn(c, f) {
		c.mu.Lock()
		delete(c.pending, f.ID)
		c.mu.Unlock()
		return nil, httpx.Unavailable(msgNotConnected)
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case res, ok := <-ch:
		if !ok {
			return nil, httpx.Unavailable(msgNotConnected)
		}
		return &res, nil
	case <-t.C:
		c.mu.Lock()
		delete(c.pending, f.ID)
		c.mu.Unlock()
		return nil, httpx.Nest(http.StatusGatewayTimeout, msgNoResponse)
	}
}

// Kick closes a device's socket with code/reason (revocation).
func (g *Gateway) Kick(id string, code websocket.StatusCode, reason string) {
	c := g.get(id)
	if c == nil {
		return
	}
	g.onClose(c)
	go func() {
		if err := c.ws.Close(code, reason); err != nil {
			_ = c.ws.CloseNow()
		}
	}()
}

// Shutdown closes every connection.
func (g *Gateway) Shutdown() {
	g.mu.Lock()
	conns := g.conns
	g.conns = map[string]*dconn{}
	g.mu.Unlock()
	for _, c := range conns {
		g.drop(c)
		_ = c.ws.CloseNow()
	}
}
