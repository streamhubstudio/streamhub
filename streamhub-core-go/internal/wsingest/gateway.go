package wsingest

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Port of ws-ingest.gateway.ts + mountLiveHttp: the WebSocket upgrades on
// /ingest/ws (cameras) and /live/ws (viewers) and the terminal /live HTTP
// mount, installed as an HTTP middleware ahead of the API mux and the SPA
// fallback. permessage-deflate is off (JPEG does not compress).

const (
	IngestPath = "/ingest/ws"
	ViewerPath = "/live/ws"
	// ingestMaxPayload is the transport cap (the protocol cap is per app).
	ingestMaxPayload = 8 << 20
	// viewerMaxPayload is ws's default maxPayload (100 MiB).
	viewerMaxPayload = 100 << 20
	// closeSettle bounds the wait for a started close handshake.
	closeSettle = 5 * time.Second
)

// UpgradeGuard is the network-security IP gate (NetworkGuard): a non-empty
// reason rejects the upgrade with a bare 403.
type UpgradeGuard interface {
	RejectUpgradeReason(ip string) string
}

// Gateway routes our upgrades and the /live HTTP mount.
type Gateway struct {
	svc   *Service
	live  *LiveHTTP
	guard UpgradeGuard // optional
	log   *slog.Logger
	// ctx is cancelled at shutdown (terminates every socket).
	ctx context.Context
}

// NewGateway builds the gateway. guard may be nil.
func NewGateway(ctx context.Context, svc *Service, live *LiveHTTP, guard UpgradeGuard, log *slog.Logger) *Gateway {
	if log == nil {
		log = slog.Default()
	}
	return &Gateway{svc: svc, live: live, guard: guard, log: log, ctx: ctx}
}

// Middleware intercepts /ingest/ws and /live/ws upgrades and every /live
// request; everything else goes to next.
func (g *Gateway) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		upgrade := isWebSocketUpgrade(r)
		switch {
		case upgrade && (p == IngestPath || p == ViewerPath):
			g.serveUpgrade(w, r, p == IngestPath)
		case p == "/live" || strings.HasPrefix(p, "/live/"):
			g.live.ServeHTTP(w, r)
		default:
			next.ServeHTTP(w, r)
		}
	})
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func (g *Gateway) serveUpgrade(w http.ResponseWriter, r *http.Request, ingest bool) {
	ip := upgradeIP(r)
	if g.guard != nil {
		if reason := g.guard.RejectUpgradeReason(ip); reason != "" {
			w.Header().Set("Connection", "close")
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(http.StatusForbidden)
			g.log.Warn(fmt.Sprintf("ws upgrade rejected by network-security (%s)", reason))
			return
		}
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // ws.Server({noServer}) checks no Origin
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	limit := int64(viewerMaxPayload)
	if ingest {
		limit = ingestMaxPayload
	}
	c.SetReadLimit(limit)
	conn := &wsConn{c: c, closing: make(chan struct{})}
	info := UpgradeInfo{URL: r.URL.RequestURI(), Authorization: r.Header.Get("Authorization"), IP: ip}
	// The request context dies with the hijacked handler; the connection's
	// lifetime is bounded by the gateway's (shutdown) context instead.
	ctx, cancel := context.WithCancel(g.ctx)
	defer cancel()
	go func() {
		<-ctx.Done()
		if g.ctx.Err() != nil {
			c.CloseNow()
		}
	}()
	if ingest {
		g.svc.HandleIngest(ctx, conn, info)
	} else {
		g.svc.HandleViewer(ctx, conn, info)
	}
	conn.settle(closeSettle)
	c.CloseNow()
}

// upgradeIP is X-Forwarded-For (first hop) or the socket peer.
func upgradeIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if ip := strings.TrimSpace(strings.Split(xff, ",")[0]); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// wsConn adapts coder/websocket to Conn.
type wsConn struct {
	c       *websocket.Conn
	once    sync.Once
	started atomic.Bool
	closing chan struct{} // closed when a started close handshake ends
}

func (w *wsConn) Read(ctx context.Context) (bool, []byte, error) {
	t, b, err := w.c.Read(ctx)
	return t == websocket.MessageBinary, b, err
}

func (w *wsConn) WriteText(ctx context.Context, b []byte) error {
	return w.c.Write(ctx, websocket.MessageText, b)
}

func (w *wsConn) WriteBinary(ctx context.Context, b []byte) error {
	return w.c.Write(ctx, websocket.MessageBinary, b)
}

// Close runs the close handshake in the background (it waits for the peer).
func (w *wsConn) Close(code int, reason string) {
	w.once.Do(func() {
		w.started.Store(true)
		go func() {
			defer close(w.closing)
			_ = w.c.Close(websocket.StatusCode(code), reason)
		}()
	})
}

// settle waits (bounded) for a started close handshake, so the close frame
// reaches the peer before the connection is dropped.
func (w *wsConn) settle(d time.Duration) {
	if !w.started.Load() {
		return
	}
	select {
	case <-w.closing:
	case <-time.After(d):
	}
}

func (w *wsConn) Terminate() { _ = w.c.CloseNow() }

func (w *wsConn) Ping(ctx context.Context) error { return w.c.Ping(ctx) }
