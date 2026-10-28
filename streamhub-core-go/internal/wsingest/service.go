package wsingest

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Close codes of the ingest protocol (ESP32-WS-INGEST.md §3.5).
const (
	CloseUnauthorized  = 4401
	CloseForbidden     = 4403
	CloseIdle          = 4408
	CloseReplaced      = 4409
	CloseFrameTooLarge = 4413
	CloseRateLimited   = 4429
	closeUnsupported   = 1003
)

// Protocol constants.
const (
	PingInterval          = 15 * time.Second
	IdleCheckInterval     = 5 * time.Second
	DefaultIdleTimeoutSec = 30
	DefaultMaxDataBytes   = 16 * 1024
	DefaultMaxDataPerSec  = 5
	maxBadFrames          = 5
	handshakesPerMinute   = 60
	maxDataDepth          = 8
	viewerWriteTimeout    = 10 * time.Second
	controlWriteTimeout   = 10 * time.Second
)

var (
	slugRE      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	dataTopicRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$`)
	bearerRE    = regexp.MustCompile(`(?i)^Bearer\s+(.+)$`)
)

// Conn is the transport seam (the subset of a ws socket the service uses);
// tests drive the whole lifecycle with fakes.
type Conn interface {
	// Read blocks for the next message; any error ends the connection.
	Read(ctx context.Context) (binary bool, data []byte, err error)
	WriteText(ctx context.Context, b []byte) error
	WriteBinary(ctx context.Context, b []byte) error
	// Close starts the close handshake (code + reason); never blocks long.
	Close(code int, reason string)
	// Terminate drops the connection without a handshake.
	Terminate()
	// Ping sends a ping and waits for its pong (or ctx).
	Ping(ctx context.Context) error
}

// UpgradeInfo is what the gateway extracts from the upgrade request.
type UpgradeInfo struct {
	URL           string // path + query
	Authorization string
	IP            string
}

// IngressAuth is the ingress_auth key store slice (livekit.IngressAuth).
type IngressAuth interface {
	RegisterWsIngest(ctx context.Context, app, room string) (ingressID, streamKey string, err error)
	FindByStreamKey(ctx context.Context, app, streamKey string) (*livekit.IngressAuthRow, error)
	ListWsIngest(ctx context.Context, app string) ([]livekit.IngressAuthRow, error)
	Remove(ctx context.Context, app, ingressID string) error
}

// Quotas is the concurrent-streams quota gate.
type Quotas interface {
	EnforceConcurrentStreams(ctx context.Context, p *auth.Principal) error
}

// Streams is the StreamsServiceContract slice used for registration.
type Streams interface {
	Upsert(ctx context.Context, app, streamID, streamType, room, participant string) error
	End(ctx context.Context, app, streamID string) error
}

// Callbacks is the signed event funnel.
type Callbacks interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// Deps wires the Service. Getters are resolved at call time (nil = absent).
type Deps struct {
	Global        *sql.DB
	AppDB         func(ctx context.Context, app string) (*sql.DB, error)
	DataDir       string
	PublicBaseURL string
	LivekitKey    string
	LivekitSecret string
	IngressAuth   IngressAuth
	Hub           *FrameHub
	Metrics       *Metrics
	Apps          contracts.AppsService
	Quotas        func() Quotas
	Streams       func() Streams
	Callbacks     func() Callbacks
	Log           *slog.Logger
	Now           func() time.Time
}

// Service is WsIngestService.
type Service struct {
	d   Deps
	log *slog.Logger
	now func() time.Time

	mu         sync.Mutex
	active     map[string]*camera // "<app> <wsk_key>"
	handshakes map[string]*bucket

	// Timer intervals (tests shorten them).
	pingInterval, idleCheck time.Duration
}

type bucket struct {
	count   int
	resetAt time.Time
}

// New builds the service.
func New(d Deps) *Service {
	s := &Service{d: d, log: d.Log, now: d.Now, active: map[string]*camera{}, handshakes: map[string]*bucket{},
		pingInterval: PingInterval, idleCheck: IdleCheckInterval}
	if s.log == nil {
		s.log = slog.Default()
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.d.Metrics == nil {
		s.d.Metrics = NewMetrics(nil)
	}
	if s.d.Hub == nil {
		s.d.Hub = NewFrameHub()
	}
	return s
}

// Hub is the frame hub (shared with the /live HTTP endpoints).
func (s *Service) Hub() *FrameHub { return s.d.Hub }

func getter[T any](f func() T) T {
	var zero T
	if f == nil {
		return zero
	}
	return f()
}

type camera struct {
	mu            sync.Mutex
	app, room     string
	identity      string
	streamID      string
	key           string
	conn          Conn
	maxFrameBytes int
	idleTimeout   time.Duration
	lastFrameAt   time.Time
	tokens        float64
	maxFps        float64
	lastRefill    time.Time
	badFrames     int
	missedPongs   int
	fpsDropped    int64
	frames        int64
	maxDataBytes  int
	dataTokens    float64
	maxDataPerSec float64
	lastDataRefil time.Time
	dataDropped   int64
	closed        bool
	replaced      bool
	stop          chan struct{}
	stopOnce      sync.Once
}

func (c *camera) stopTimers() { c.stopOnce.Do(func() { close(c.stop) }) }

// ---------------------------------------------------------------------------
// Boot cleanup (onModuleInit)
// ---------------------------------------------------------------------------

// Start is the boot cleanup: any ws-mjpeg row still active cannot have a live
// socket after a restart — mark it ended (only for app DBs already on disk).
func (s *Service) Start(ctx context.Context) {
	rows, err := s.d.Global.QueryContext(ctx, "SELECT name FROM apps")
	if err != nil {
		s.log.Debug(fmt.Sprintf("ws-mjpeg boot cleanup skipped: %s", err))
		return
	}
	var names []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			names = append(names, n)
		}
	}
	rows.Close()
	for _, n := range names {
		if _, err := os.Stat(filepath.Join(s.d.DataDir, "apps", n, "app.db")); err != nil {
			continue
		}
		adb, err := s.d.AppDB(ctx, n)
		if err != nil {
			continue
		}
		_, _ = adb.ExecContext(ctx, "UPDATE streams SET status = 'ended', ended_at = datetime('now') "+
			"WHERE type = 'ws-mjpeg' AND status = 'active'")
	}
}

// ---------------------------------------------------------------------------
// Ingest connections
// ---------------------------------------------------------------------------

type readyMsg struct {
	Type           string  `json:"type"`
	Room           string  `json:"room"`
	StreamID       string  `json:"streamId"`
	MaxFps         float64 `json:"maxFps"`
	MaxFrameBytes  int     `json:"maxFrameBytes"`
	MaxDataBytes   int     `json:"maxDataBytes"`
	MaxDataPerSec  float64 `json:"maxDataPerSec"`
	IdleTimeoutSec int     `json:"idleTimeoutSec"`
}

type errorMsg struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type streamEvent struct {
	StreamID    string `json:"streamId"`
	Room        string `json:"room"`
	Type        string `json:"type"`
	Participant string `json:"participant"`
}

type dataEvent struct {
	Topic    string `json:"topic"`
	DeviceID string `json:"deviceId"`
	Data     *y.Map `json:"data"`
	Source   string `json:"source"`
}

// HandleIngest runs one camera connection end-to-end (blocks until it ends).
func (s *Service) HandleIngest(ctx context.Context, conn Conn, info UpgradeInfo) {
	cam, activeKey := s.handshakeIngest(ctx, conn, info)
	if cam == nil {
		return
	}
	go s.pingLoop(cam)
	go s.idleLoop(cam)
	for {
		binary, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		s.onMessage(ctx, cam, binary, data)
	}
	s.finalizeCamera(context.WithoutCancel(ctx), activeKey, cam)
}

func (s *Service) handshakeIngest(ctx context.Context, conn Conn, info UpgradeInfo) (*camera, string) {
	if !s.allowHandshake(info.IP) {
		s.reject(conn, CloseRateLimited, "rate_limited")
		return nil, ""
	}
	q := query(info.URL)
	app, roomRaw := q.Get("app"), q.Get("room")
	key := bearer(info.Authorization)
	if key == "" {
		key = q.Get("key")
	}
	if !slugRE.MatchString(app) {
		s.reject(conn, CloseUnauthorized, "invalid_app")
		return nil, ""
	}
	if roomRaw == "" || !slugRE.MatchString(roomRaw) {
		s.reject(conn, CloseUnauthorized, "invalid_room")
		return nil, ""
	}
	if !strings.HasPrefix(key, livekit.WsStreamKeyPrefix) {
		s.reject(conn, CloseUnauthorized, "invalid_key")
		return nil, ""
	}
	appRow := s.appRow(ctx, app)
	if appRow == nil {
		s.reject(conn, CloseUnauthorized, "unknown_app")
		return nil, ""
	}
	authRow, err := s.d.IngressAuth.FindByStreamKey(ctx, app, key)
	if err != nil || authRow == nil || !strings.HasPrefix(authRow.IngressID, livekit.WsIngressIDPrefix) {
		s.reject(conn, CloseUnauthorized, "invalid_key")
		return nil, ""
	}
	cfg := s.appConfig(ctx, app)
	feats := wsFeatures(cfg)
	if !feats.Enabled {
		s.reject(conn, CloseForbidden, "ws_ingest_disabled")
		return nil, ""
	}
	room := NamespaceRoom(prefixFor(cfg, appRow, app), roomRaw)
	if authRow.Room != nil && *authRow.Room != "" && *authRow.Room != room && *authRow.Room != roomRaw {
		s.reject(conn, CloseUnauthorized, "room_mismatch")
		return nil, ""
	}
	if q := getter(s.d.Quotas); q != nil {
		if err := q.EnforceConcurrentStreams(ctx, s.deviceCtx(ctx, app)); err != nil {
			s.reject(conn, CloseForbidden, "quota_exceeded")
			return nil, ""
		}
	}

	activeKey := app + " " + key
	s.mu.Lock()
	_, had := s.active[activeKey]
	if feats.MaxCameras > 0 && !had && float64(s.countCamerasLocked(app)) >= feats.MaxCameras {
		s.mu.Unlock()
		s.reject(conn, CloseForbidden, "max_cameras")
		return nil, ""
	}
	prev := s.active[activeKey]
	identity := identityFor(q.Get("identity"), key)
	now := s.now()
	maxDataBytes, maxDataPerSec := int(feats.MaxDataBytes), feats.MaxDataPerSec
	cam := &camera{
		app: app, room: room, identity: identity, streamID: room + "/" + identity, key: key, conn: conn,
		maxFrameBytes: int(feats.MaxFrameKb * 1024), idleTimeout: DefaultIdleTimeoutSec * time.Second,
		lastFrameAt: now, tokens: feats.MaxFps, maxFps: feats.MaxFps, lastRefill: now,
		maxDataBytes: maxDataBytes, dataTokens: maxDataPerSec, maxDataPerSec: maxDataPerSec, lastDataRefil: now,
		stop: make(chan struct{}),
	}
	s.active[activeKey] = cam
	n := s.countCamerasLocked(app)
	s.mu.Unlock()
	if prev != nil {
		// Duplicate key → the NEW connection wins; the zombie gets 4409.
		prev.mu.Lock()
		prev.replaced = true
		prev.mu.Unlock()
		s.closeCamera(prev, CloseReplaced, "replaced by new connection")
	}
	s.d.Hub.SetPublisher(app, room, true)
	s.d.Metrics.SetCameras(app, n)

	if st := getter(s.d.Streams); st != nil {
		if err := st.Upsert(ctx, app, cam.streamID, "ws-mjpeg", room, identity); err != nil {
			s.log.Warn(fmt.Sprintf("streams.upsert failed for %s: %s", cam.streamID, err))
		}
	}
	s.dispatch(ctx, app, "stream_started", streamEvent{cam.streamID, room, "ws-mjpeg", identity})
	s.sendJSON(conn, readyMsg{"ready", room, cam.streamID, feats.MaxFps, cam.maxFrameBytes, maxDataBytes, maxDataPerSec, DefaultIdleTimeoutSec})
	return cam, activeKey
}

// pingLoop: keepalive every interval; two unanswered pings → terminate.
func (s *Service) pingLoop(cam *camera) {
	t := time.NewTicker(s.pingInterval)
	defer t.Stop()
	for {
		select {
		case <-cam.stop:
			return
		case <-t.C:
		}
		cam.mu.Lock()
		if cam.missedPongs >= 2 {
			cam.closed = true
			cam.mu.Unlock()
			cam.stopTimers()
			cam.conn.Terminate()
			return
		}
		cam.missedPongs++
		cam.mu.Unlock()
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*s.pingInterval)
			defer cancel()
			if cam.conn.Ping(ctx) == nil {
				cam.mu.Lock()
				cam.missedPongs = 0
				cam.mu.Unlock()
			}
		}()
	}
}

// idleLoop closes 4408 when no frame arrived for the idle timeout.
func (s *Service) idleLoop(cam *camera) {
	t := time.NewTicker(s.idleCheck)
	defer t.Stop()
	for {
		select {
		case <-cam.stop:
			return
		case <-t.C:
		}
		cam.mu.Lock()
		idle := s.now().Sub(cam.lastFrameAt) > cam.idleTimeout
		cam.mu.Unlock()
		if idle {
			s.sendError(cam.conn, "idle_timeout", "no frames received")
			s.closeCamera(cam, CloseIdle, "idle timeout")
			return
		}
	}
}

func (s *Service) onMessage(ctx context.Context, cam *camera, binary bool, data []byte) {
	cam.mu.Lock()
	closed := cam.closed
	cam.mu.Unlock()
	if closed {
		return
	}
	if binary {
		s.onFrame(cam, data)
		return
	}
	v, err := y.ParseJSON(data)
	if err != nil {
		return
	}
	m, ok := v.(*y.Map)
	if !ok {
		return
	}
	switch m.Get("type") {
	case "stats":
		s.saveStats(ctx, cam, m)
	case "data":
		s.onDataFrame(ctx, cam, m, len(data))
	}
}

func (s *Service) onFrame(cam *camera, frame []byte) {
	cam.mu.Lock()
	if len(frame) > cam.maxFrameBytes {
		max := cam.maxFrameBytes
		cam.mu.Unlock()
		s.sendError(cam.conn, "frame_too_large", fmt.Sprintf("max %d bytes", max))
		s.d.Metrics.DroppedFrame("too_large")
		s.closeCamera(cam, CloseFrameTooLarge, "frame too large")
		return
	}
	if len(frame) < 4 || frame[0] != 0xff || frame[1] != 0xd8 {
		cam.badFrames++
		bad := cam.badFrames
		cam.mu.Unlock()
		s.d.Metrics.DroppedFrame("not_jpeg")
		if bad >= maxBadFrames {
			s.sendError(cam.conn, "invalid_frames", "not JPEG data")
			s.closeCamera(cam, closeUnsupported, "unsupported data")
		}
		return
	}
	cam.badFrames = 0
	now := s.now()
	if !takeToken(&cam.tokens, &cam.lastRefill, cam.maxFps, now) {
		cam.fpsDropped++
		cam.mu.Unlock()
		s.d.Metrics.DroppedFrame("fps")
		return
	}
	cam.lastFrameAt = now
	cam.frames++
	app, room := cam.app, cam.room
	cam.mu.Unlock()
	s.d.Hub.Publish(app, room, frame, now.UnixMilli())
	s.d.Metrics.Frame(len(frame))
}

// takeToken is refill-and-take on a token bucket (rate per second).
func takeToken(tokens *float64, last *time.Time, rate float64, now time.Time) bool {
	elapsed := float64(now.Sub(*last).Milliseconds()) / 1000
	if elapsed > 0 {
		*tokens = min(rate, *tokens+elapsed*rate)
		*last = now
	}
	if *tokens >= 1 {
		*tokens--
		return true
	}
	return false
}

func (s *Service) onDataFrame(ctx context.Context, cam *camera, parsed *y.Map, rawLen int) {
	cam.mu.Lock()
	defer cam.mu.Unlock()
	if cam.maxDataBytes > 0 && rawLen > cam.maxDataBytes {
		cam.dataDropped++
		s.d.Metrics.DroppedFrame("data_too_large")
		return
	}
	topic, _ := parsed.Get("topic").(string)
	if !dataTopicRE.MatchString(topic) {
		cam.dataDropped++
		return
	}
	payload, ok := parsed.Get("data").(*y.Map)
	if !ok || payload == nil || !withinDepth(payload, maxDataDepth, 1) {
		cam.dataDropped++
		return
	}
	now := s.now()
	if !takeToken(&cam.dataTokens, &cam.lastDataRefil, cam.maxDataPerSec, now) {
		cam.dataDropped++
		s.d.Metrics.DroppedFrame("data_rate")
		return
	}
	cam.lastFrameAt = now
	ev := dataEvent{topic, cam.identity, payload, "ws"}
	app := cam.app
	go s.dispatch(context.WithoutCancel(ctx), app, "iot.data", ev)
}

// withinDepth bounds the nesting depth (depth 1 = flat; arrays count too).
func withinDepth(v any, max, depth int) bool {
	if depth > max {
		return false
	}
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			if !withinDepth(e, max, depth+1) {
				return false
			}
		}
	case *y.Map:
		for _, k := range x.Keys() {
			if !withinDepth(x.Get(k), max, depth+1) {
				return false
			}
		}
	}
	return true
}

// saveStats persists a device stats message onto the stream row:
// {...stats, live, framesReceived, framesDroppedFps, viewers, ts} minus type.
func (s *Service) saveStats(ctx context.Context, cam *camera, stats *y.Map) {
	cam.mu.Lock()
	frames, dropped := cam.frames, cam.fpsDropped
	cam.mu.Unlock()
	p := stats.Clone()
	p.Set("live", true)
	p.Set("framesReceived", float64(frames))
	p.Set("framesDroppedFps", float64(dropped))
	p.Set("viewers", float64(s.d.Hub.ViewerCount(cam.app, cam.room)))
	p.Set("ts", jsx.ISO(s.now()))
	p.Delete("type")
	enc, err := y.Stringify(p)
	if err != nil {
		return
	}
	adb, err := s.d.AppDB(ctx, cam.app)
	if err != nil {
		return
	}
	if _, err := adb.ExecContext(ctx, "UPDATE streams SET last_stats_json = ? WHERE stream_id = ?", enc, cam.streamID); err != nil {
		s.log.Debug(fmt.Sprintf("stats save failed: %s", err))
	}
}

// closeCamera is a server-initiated graceful close (idempotent).
func (s *Service) closeCamera(cam *camera, code int, reason string) {
	cam.mu.Lock()
	if cam.closed {
		cam.mu.Unlock()
		return
	}
	cam.closed = true
	cam.mu.Unlock()
	cam.stopTimers()
	cam.conn.Close(code, reason)
}

// finalizeCamera runs on every close path: unregister unless a newer
// connection with the same key took over (it owns the row and the slot).
func (s *Service) finalizeCamera(ctx context.Context, activeKey string, cam *camera) {
	cam.mu.Lock()
	cam.closed = true
	replaced := cam.replaced
	cam.mu.Unlock()
	cam.stopTimers()
	s.mu.Lock()
	mine := s.active[activeKey] == cam
	if mine {
		delete(s.active, activeKey)
	}
	n := s.countCamerasLocked(cam.app)
	s.mu.Unlock()
	if replaced {
		return
	}
	if mine {
		s.d.Hub.SetPublisher(cam.app, cam.room, false)
	}
	s.d.Metrics.SetCameras(cam.app, n)
	if st := getter(s.d.Streams); st != nil {
		if err := st.End(ctx, cam.app, cam.streamID); err != nil {
			s.log.Warn(fmt.Sprintf("streams.end failed for %s: %s", cam.streamID, err))
		}
	}
	s.dispatch(ctx, cam.app, "stream_ended", streamEvent{cam.streamID, cam.room, "ws-mjpeg", cam.identity})
}

// ---------------------------------------------------------------------------
// Viewer WS
// ---------------------------------------------------------------------------

// HandleViewer runs one /live/ws viewer (blocks until it disconnects).
func (s *Service) HandleViewer(ctx context.Context, conn Conn, info UpgradeInfo) {
	q := query(info.URL)
	app, roomRaw := q.Get("app"), q.Get("room")
	if !slugRE.MatchString(app) || roomRaw == "" {
		s.reject(conn, CloseUnauthorized, "invalid_params")
		return
	}
	appRow := s.appRow(ctx, app)
	if appRow == nil {
		s.reject(conn, CloseUnauthorized, "unknown_app")
		return
	}
	cfg := s.appConfig(ctx, app)
	room := NamespaceRoom(prefixFor(cfg, appRow, app), roomRaw)
	if !s.PlaybackAllowed(cfg, room, q.Get("token")) {
		s.reject(conn, CloseUnauthorized, "playback_unauthorized")
		return
	}
	v := NewViewer("ws")
	s.d.Hub.Subscribe(app, room, v)
	s.d.Metrics.SetViewers(app, "ws", s.d.Hub.ViewerCount(app, room))
	go func() {
		for f := range v.C {
			wctx, cancel := context.WithTimeout(context.Background(), viewerWriteTimeout)
			err := conn.WriteBinary(wctx, f)
			cancel()
			if err != nil {
				conn.Terminate()
				for range v.C { //nolint:revive // drain until unsubscribed
				}
				return
			}
		}
	}()
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			break
		}
	}
	s.d.Hub.Unsubscribe(app, room, v)
	s.d.Metrics.SetViewers(app, "ws", s.d.Hub.ViewerCount(app, room))
}

// PlaybackAllowed is the gate shared by the viewer WS and /live HTTP:
// public unless features.publicPlayback is false, then a LiveKit subscribe
// token for the room is required.
func (s *Service) PlaybackAllowed(cfg *contracts.AppConfig, room, token string) bool {
	if cfg == nil || cfg.Features.PublicPlayback {
		return true
	}
	if token == "" || s.d.LivekitKey == "" || s.d.LivekitSecret == "" {
		return false
	}
	claims, ok := verifyLiveKitToken(token, s.d.LivekitKey, s.d.LivekitSecret, s.now())
	return ok && subscribeGrantFor(claims, room)
}

// ---------------------------------------------------------------------------
// Provisioning / status
// ---------------------------------------------------------------------------

// WsIngestProvisioned is the mint result (plaintext key once + connection URLs).
type WsIngestProvisioned struct {
	ID          string `json:"id"`
	StreamKey   string `json:"streamKey"`
	Room        string `json:"room"`
	Identity    string `json:"identity"`
	WsURL       string `json:"wsUrl"`
	ViewerWsURL string `json:"viewerWsUrl"`
	MjpegURL    string `json:"mjpegUrl"`
	FrameURL    string `json:"frameUrl"`
	PlayerURL   string `json:"playerUrl"`
	EmbedURL    string `json:"embedUrl"`
}

// Provision mints a wsk_ key for a room.
func (s *Service) Provision(ctx context.Context, app, roomRaw, identity string) (*WsIngestProvisioned, error) {
	appRow := s.appRow(ctx, app)
	if appRow == nil {
		return nil, httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	cfg := s.appConfig(ctx, app)
	room := NamespaceRoom(prefixFor(cfg, appRow, app), roomRaw)
	id, key, err := s.d.IngressAuth.RegisterWsIngest(ctx, app, room)
	if err != nil {
		return nil, httpx.Internal("Internal server error")
	}
	if identity == "" {
		identity = "wscam-" + lastN(key, 6)
	}
	u := s.urls(app, room, roomRaw)
	return &WsIngestProvisioned{id, key, room, identity, u.ws, u.viewerWs, u.mjpeg, u.frame, u.player, u.embed}, nil
}

// WsIngestKeyStatus is one row of the list endpoint.
type WsIngestKeyStatus struct {
	ID        string  `json:"id"`
	Room      *string `json:"room"`
	StreamKey *string `json:"streamKey"`
	Active    bool    `json:"active"`
	Identity  string  `json:"identity,omitempty"`
	CreatedAt *string `json:"createdAt"`
}

// ListKeys lists an app's WS keys with live state.
func (s *Service) ListKeys(ctx context.Context, app string) ([]WsIngestKeyStatus, error) {
	if s.appRow(ctx, app) == nil {
		return nil, httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	rows, err := s.d.IngressAuth.ListWsIngest(ctx, app)
	if err != nil {
		return nil, httpx.Internal("Internal server error")
	}
	out := make([]WsIngestKeyStatus, 0, len(rows))
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range rows {
		st := WsIngestKeyStatus{ID: r.IngressID, Room: r.Room, StreamKey: r.StreamKey, CreatedAt: r.CreatedAt}
		if r.StreamKey != nil {
			if cam := s.active[app+" "+*r.StreamKey]; cam != nil {
				st.Active, st.Identity = true, cam.identity
			}
		}
		out = append(out, st)
	}
	return out, nil
}

// Revoke deletes a WS key and closes its live camera (4401).
func (s *Service) Revoke(ctx context.Context, app, id string) error {
	if s.appRow(ctx, app) == nil {
		return httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	rows, err := s.d.IngressAuth.ListWsIngest(ctx, app)
	if err != nil {
		return httpx.Internal("Internal server error")
	}
	var row *livekit.IngressAuthRow
	for i := range rows {
		if rows[i].IngressID == id {
			row = &rows[i]
		}
	}
	if row == nil {
		return httpx.NotFound(fmt.Sprintf("ws-ingest key '%s' not found", id))
	}
	if row.StreamKey != nil {
		s.mu.Lock()
		cam := s.active[app+" "+*row.StreamKey]
		s.mu.Unlock()
		if cam != nil {
			s.closeCamera(cam, CloseUnauthorized, "key revoked")
		}
	}
	if err := s.d.IngressAuth.Remove(ctx, app, id); err != nil {
		return httpx.Internal("Internal server error")
	}
	return nil
}

// WsIngestLiveInfo is the public live state of a room.
type WsIngestLiveInfo struct {
	Active   bool    `json:"active"`
	Type     *string `json:"type"`
	Room     string  `json:"room"`
	MjpegURL string  `json:"mjpegUrl,omitempty"`
	FrameURL string  `json:"frameUrl,omitempty"`
	WsURL    string  `json:"wsUrl,omitempty"`
}

// WsIngestLiveInfo reports whether a ws-mjpeg camera publishes in a room (404 when
// the app disables public playback).
func (s *Service) LiveInfo(ctx context.Context, app, roomRaw string) (*WsIngestLiveInfo, error) {
	appRow := s.appRow(ctx, app)
	if appRow == nil {
		return nil, httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	cfg := s.appConfig(ctx, app)
	if cfg != nil && !cfg.Features.PublicPlayback {
		return nil, httpx.NotFound("public playback is disabled for this app")
	}
	room := NamespaceRoom(prefixFor(cfg, appRow, app), roomRaw)
	if !s.d.Hub.HasPublisher(app, room) {
		return &WsIngestLiveInfo{Room: room}, nil
	}
	u := s.urls(app, room, roomRaw)
	t := "ws-mjpeg"
	return &WsIngestLiveInfo{true, &t, room, u.mjpeg, u.frame, u.viewerWs}, nil
}

// CountCameras is the number of live cameras of an app.
func (s *Service) CountCameras(app string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.countCamerasLocked(app)
}

func (s *Service) countCamerasLocked(app string) int {
	n := 0
	for _, c := range s.active {
		if c.app == app {
			n++
		}
	}
	return n
}

// ResolveRoom resolves app + short room into the namespaced room and config
// (ok=false when the app does not exist).
func (s *Service) ResolveRoom(ctx context.Context, app, roomRaw string) (string, *contracts.AppConfig, bool) {
	appRow := s.appRow(ctx, app)
	if appRow == nil {
		return "", nil, false
	}
	cfg := s.appConfig(ctx, app)
	return NamespaceRoom(prefixFor(cfg, appRow, app), roomRaw), cfg, true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type urlSet struct{ ws, viewerWs, mjpeg, frame, player, embed string }

var httpPrefixRE = regexp.MustCompile(`(?i)^http`)

func (s *Service) urls(app, room, roomRaw string) urlSet {
	base := strings.TrimRight(s.d.PublicBaseURL, "/")
	wsBase := httpPrefixRE.ReplaceAllLiteralString(base, "ws")
	e := jsx.EncodeURIComponent
	live := "/live/" + e(app) + "/" + e(room)
	return urlSet{
		ws:       wsBase + "/ingest/ws?app=" + e(app) + "&room=" + e(roomRaw),
		viewerWs: wsBase + "/live/ws?app=" + e(app) + "&room=" + e(roomRaw),
		mjpeg:    base + live + "/mjpeg",
		frame:    base + live + "/frame.jpg",
		player:   base + "/play/" + e(app) + "/" + e(room),
		embed:    base + "/embed/" + e(app) + "/" + e(room),
	}
}

// NamespaceRoom namespaces a room under the app prefix.
func NamespaceRoom(prefix, room string) string {
	if room == "" {
		return prefix
	}
	if room == prefix || strings.HasPrefix(room, prefix+"-") {
		return room
	}
	return prefix + "-" + room
}

func identityFor(raw, key string) string {
	if raw != "" && slugRE.MatchString(raw) {
		return raw
	}
	return "wscam-" + lastN(key, 6)
}

func lastN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func query(u string) url.Values {
	i := strings.IndexByte(u, '?')
	if i < 0 {
		return url.Values{}
	}
	v, _ := url.ParseQuery(u[i+1:])
	return v
}

func bearer(h string) string {
	m := bearerRE.FindStringSubmatch(strings.TrimSpace(h))
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func (s *Service) allowHandshake(ip string) bool {
	if ip == "" {
		return true
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.handshakes[ip]
	if b == nil || !now.Before(b.resetAt) {
		s.handshakes[ip] = &bucket{1, now.Add(time.Minute)}
		if len(s.handshakes) > 10_000 {
			for k, v := range s.handshakes {
				if !now.Before(v.resetAt) {
					delete(s.handshakes, k)
				}
			}
		}
		return true
	}
	b.count++
	return b.count <= handshakesPerMinute
}

type appRow struct {
	id     int64
	name   string
	prefix sql.NullString
}

func (s *Service) appRow(ctx context.Context, app string) *appRow {
	var r appRow
	err := s.d.Global.QueryRowContext(ctx, "SELECT id, name, livekit_room_prefix FROM apps WHERE name = ?", app).
		Scan(&r.id, &r.name, &r.prefix)
	if err != nil {
		return nil
	}
	return &r
}

func (s *Service) appConfig(ctx context.Context, app string) *contracts.AppConfig {
	if s.d.Apps == nil {
		return nil
	}
	cfg, err := s.d.Apps.GetConfig(ctx, app)
	if err != nil {
		return nil
	}
	return cfg
}

// prefixFor is cfg?.roomPrefix || app.livekit_room_prefix || app.
func prefixFor(cfg *contracts.AppConfig, r *appRow, app string) string {
	if cfg != nil && cfg.RoomPrefix != "" {
		return cfg.RoomPrefix
	}
	if r.prefix.String != "" {
		return r.prefix.String
	}
	return app
}

func wsFeatures(cfg *contracts.AppConfig) contracts.WsIngestFeatures {
	if cfg != nil && cfg.Features.WsIngest != nil {
		return *cfg.Features.WsIngest
	}
	return contracts.WsIngestFeatures{Enabled: true, MaxFps: 15, MaxFrameKb: 256, MaxDataBytes: DefaultMaxDataBytes, MaxDataPerSec: DefaultMaxDataPerSec}
}

// deviceCtx is the minimal principal for quota enforcement on a device
// connection (the app's tenant); nil without a tenant (quotas skipped).
func (s *Service) deviceCtx(ctx context.Context, app string) *auth.Principal {
	var tenant sql.NullString
	if err := s.d.Global.QueryRowContext(ctx, "SELECT tenant_id FROM apps WHERE name = ?", app).Scan(&tenant); err != nil || tenant.String == "" {
		return nil
	}
	return &auth.Principal{UserID: "ws-ingest:" + app, TenantID: tenant.String, Role: auth.RoleService, Scope: auth.ScopeApp, Via: auth.ViaUserJWT}
}

func (s *Service) sendJSON(conn Conn, v any) {
	b, err := jsx.Stringify(v)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), controlWriteTimeout)
	defer cancel()
	_ = conn.WriteText(ctx, []byte(b))
}

func (s *Service) sendError(conn Conn, code, message string) {
	s.sendJSON(conn, errorMsg{"error", code, message})
}

// reject sends a protocol error and closes (before acceptance).
func (s *Service) reject(conn Conn, code int, reason string) {
	s.sendError(conn, strconv.Itoa(code), reason)
	conn.Close(code, reason)
}

func (s *Service) dispatch(ctx context.Context, app, event string, payload any) {
	cb := getter(s.d.Callbacks)
	if cb == nil {
		return
	}
	if err := cb.Dispatch(ctx, app, event, payload); err != nil {
		s.log.Warn(fmt.Sprintf("callbacks.dispatch(%s) failed: %s", event, err))
	}
}
