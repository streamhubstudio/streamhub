package streams

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/fsperm"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/web"
)

// Port of hls.service.ts: the live HLS egress of a stream's room. LiveKit
// writes index.m3u8 + .ts segments to <app dir>/hls/<safe(room)>/, served by
// the core at /hls/<app>/<room>/.

const (
	// PlaylistName is the full timeline playlist.
	PlaylistName = "index.m3u8"
	// LivePlaylistName is the bounded rolling playlist of DVR channels.
	LivePlaylistName = "live.m3u8"
	// segmentDurationS is the historical egress segment length: the default
	// of STREAMHUB_HLS_SEGMENT_S (config.Config.HLSSegmentS).
	segmentDurationS = 4
	// hlsStartupGrace: an egress younger than this is never judged dead —
	// the composite needs a few seconds before its first segment lands.
	hlsStartupGrace = 20 * time.Second
	// hlsStaleSegments: an active egress whose playlist did not advance in
	// this many segment durations is dead (LT4 #3).
	hlsStaleSegments = 3
)

// HlsStartResult is the start payload.
type HlsStartResult struct {
	EgressID    string `json:"egressId"`
	PlaylistURL string `json:"playlistUrl"`
	Status      string `json:"status"`
	// Dvr is set only under features.dvr (G5): the playlist is rewindable.
	Dvr *HlsDvrInfo `json:"dvr,omitempty"`
}

// HlsStopResult is the stop payload.
type HlsStopResult struct {
	EgressID *string `json:"egressId"`
	Status   string  `json:"status"`
}

// HlsStatusResult is the status payload.
type HlsStatusResult struct {
	Active      bool        `json:"active"`
	PlaylistURL string      `json:"playlistUrl"`
	Dvr         *HlsDvrInfo `json:"dvr,omitempty"`
}

// Hls is HlsService.
type Hls struct {
	s *Service
	// Windows keeps the dvr.m3u8 of windowed apps in step (G5).
	Windows *WindowWriter

	mu sync.Mutex
	// abandoned are egresses the core gave up on (egress id → room): their
	// playlist froze and LiveKit could not stop them. LiveKit keeps listing
	// such a corpse as EGRESS_ACTIVE (its worker is gone, nobody answers the
	// stop), so every lookup skips it; an entry is dropped once LiveKit stops
	// listing the egress.
	abandoned map[string]string
	// launched is when this core started an egress: the startup grace while
	// LiveKit has no started_at for it yet. Entries expire with the grace.
	launched map[string]time.Time
}

// NewHls builds the HLS orchestration over the streams service.
func NewHls(s *Service) *Hls {
	return &Hls{s: s, Windows: NewWindowWriter(), abandoned: map[string]string{}, launched: map[string]time.Time{}}
}

func (h *Hls) egress() Egress { return get(h.s.opt.Egress) }

func (h *Hls) logWrite(level, message string, meta any) {
	if l := get(h.s.opt.Logs); l != nil {
		l.Write(level, "hls", message, meta, nil)
	}
}

type hlsFailMeta struct {
	AppName string `json:"appName"`
	Room    string `json:"room"`
	Error   string `json:"error"`
}

type hlsStartedMeta struct {
	AppName     string `json:"appName"`
	StreamID    string `json:"streamId"`
	Room        string `json:"room"`
	EgressID    string `json:"egressId"`
	Status      string `json:"status"`
	PlaylistURL string `json:"playlistUrl"`
}

type hlsStartedEvent struct {
	App         string `json:"app"`
	Room        string `json:"room"`
	StreamID    string `json:"streamId"`
	EgressID    string `json:"egressId"`
	Status      string `json:"status"`
	PlaylistURL string `json:"playlistUrl"`
}

type hlsStaleMeta struct {
	AppName  string  `json:"appName"`
	Room     string  `json:"room"`
	EgressID string  `json:"egressId"`
	IdleS    float64 `json:"idleSeconds"`
}

type hlsStopFailMeta struct {
	AppName  string `json:"appName"`
	Room     string `json:"room"`
	EgressID string `json:"egressId"`
	Error    string `json:"error"`
}

type hlsStopMeta struct {
	AppName  string  `json:"appName"`
	StreamID string  `json:"streamId"`
	Room     string  `json:"room"`
	EgressID *string `json:"egressId"`
	Status   string  `json:"status"`
}

type hlsStoppedEvent struct {
	App      string  `json:"app"`
	Room     string  `json:"room"`
	StreamID string  `json:"streamId"`
	EgressID *string `json:"egressId"`
	Status   string  `json:"status"`
}

// Start launches (or reuses, idempotently) the HLS egress of the stream's room.
func (h *Hls) Start(ctx context.Context, appName, streamID, baseURL string) (*HlsStartResult, error) {
	room, err := h.resolveRoom(ctx, appName, streamID)
	if err != nil {
		return nil, err
	}
	slug := Safe(room)
	plan := h.plan(ctx, appName)
	playlistURL := h.signedURL(ctx, appName, slug, playlistURL(h.hlsBase(ctx, appName, baseURL), appName, slug, plan.Manifest))
	outputDir := h.roomDir(appName, room)

	live, err := h.liveForRoom(ctx, room)
	if err != nil {
		return nil, err
	}
	if existing := newestEgress(live); existing != nil {
		idle, stale := h.stale(*existing, outputDir, plan.SegmentSeconds)
		if !stale {
			h.track(outputDir, plan)
			return &HlsStartResult{existing.EgressID, playlistURL, existing.Status, plan.dvrInfo()}, nil
		}
		// A corpse (e.g. its egress worker restarted): every egress of the
		// room writes this same frozen playlist, so all of them go — stopped
		// best-effort, then forgotten — and a fresh one is launched below.
		for _, e := range live {
			if _, err := h.egressOrMissing().StopEgress(ctx, e.EgressID); err != nil {
				h.s.log.Debug("stale hls egress stop failed: " + errText(err))
			}
			h.abandon(e)
			h.logWrite("warn", "stale hls egress replaced", hlsStaleMeta{appName, room, e.EgressID, idle.Seconds()})
		}
	}

	if err := os.MkdirAll(outputDir, fsperm.PublicHLS); err != nil {
		return nil, httpx.Internal("cannot create HLS output dir: " + nodeFsMessage(err))
	}
	in := StartHlsEgressInput{
		AppName: appName, RoomName: room, OutputDir: outputDir, PlaylistName: PlaylistName, SegmentDurationS: plan.SegmentSeconds,
	}
	if plan.LivePlaylist {
		in.LivePlaylistName = LivePlaylistName
	}
	info, err := h.egressOrMissing().StartHlsEgress(ctx, in)
	if err != nil {
		msg := errText(err)
		h.logWrite("error", "startHlsEgress failed", hlsFailMeta{appName, room, msg})
		return nil, httpx.Internal("failed to start HLS egress: " + msg)
	}
	h.mu.Lock()
	h.launched[info.EgressID] = h.s.now()
	h.mu.Unlock()
	h.track(outputDir, plan)
	h.logWrite("info", "hls started", hlsStartedMeta{appName, streamID, room, info.EgressID, info.Status, playlistURL})
	h.s.dispatch(ctx, appName, "hls_started", hlsStartedEvent{appName, room, streamID, info.EgressID, info.Status, playlistURL})
	return &HlsStartResult{info.EgressID, playlistURL, info.Status, plan.dvrInfo()}, nil
}

// track hands a windowed room to the dvr.m3u8 writer (no-op otherwise).
func (h *Hls) track(dir string, plan HlsPlan) {
	if plan.WindowSegments > 0 && h.Windows != nil {
		h.Windows.Track(dir, plan.WindowSegments)
	}
}

// roomDir is <app dir>/hls/<safe(room)>.
func (h *Hls) roomDir(appName, room string) string {
	return filepath.Join(h.s.apps.AppDir(appName), "hls", Safe(room))
}

// plan is PlanFor(the app config) over the STREAMHUB_HLS_SEGMENT_S default;
// the historical plan on any config error.
func (h *Hls) plan(ctx context.Context, appName string) HlsPlan {
	cfg, err := h.s.apps.GetConfig(ctx, appName)
	if err != nil {
		cfg = nil
	}
	return PlanForSegments(cfg, h.s.cfg.HLSSegmentS)
}

// Stop stops the active HLS egress(es) of the room (lenient when none): the
// same set Start would reuse (liveForRoom), so a stop never misses what a
// start returned.
func (h *Hls) Stop(ctx context.Context, appName, streamID string) (*HlsStopResult, error) {
	room, err := h.resolveRoom(ctx, appName, streamID)
	if err != nil {
		return nil, err
	}
	active, err := h.liveForRoom(ctx, room)
	if err != nil {
		h.s.log.Warn("listHlsEgress failed: " + errText(err))
	}
	if len(active) == 0 {
		return &HlsStopResult{nil, "inactive"}, nil
	}
	dir := h.roomDir(appName, room)
	segS := h.plan(ctx, appName).SegmentSeconds
	var lastID *string
	lastStatus := "inactive"
	for _, e := range active {
		res, err := h.egressOrMissing().StopEgress(ctx, e.EgressID)
		if err != nil {
			h.logWrite("error", "stopEgress failed", hlsStopFailMeta{appName, room, e.EgressID, errText(err)})
			// LiveKit cannot stop an egress whose worker is gone and keeps it
			// EGRESS_ACTIVE: when its playlist is frozen too, forget it so the
			// next start launches a fresh one instead of reusing the corpse. A
			// live egress whose stop merely failed is kept (never two egresses
			// writing one room).
			if _, stale := h.stale(e, dir, segS); stale {
				h.abandon(e)
			}
			continue
		}
		id := res.EgressID
		lastID, lastStatus = &id, res.Status
	}
	if h.Windows != nil {
		h.Windows.Untrack(h.roomDir(appName, room))
	}
	h.logWrite("info", "hls stop requested", hlsStopMeta{appName, streamID, room, lastID, lastStatus})
	h.s.dispatch(ctx, appName, "hls_stopped", hlsStoppedEvent{appName, room, streamID, lastID, lastStatus})
	return &HlsStopResult{lastID, lastStatus}, nil
}

// Status reports whether a live playlist is available (active egress, or the
// on-disk index.m3u8 as fallback).
func (h *Hls) Status(ctx context.Context, appName, streamID, baseURL string) (*HlsStatusResult, error) {
	room, err := h.resolveRoom(ctx, appName, streamID)
	if err != nil {
		return nil, err
	}
	slug := Safe(room)
	plan := h.plan(ctx, appName)
	url := h.signedURL(ctx, appName, slug, playlistURL(h.hlsBase(ctx, appName, baseURL), appName, slug, plan.Manifest))
	active := false
	if e, err := h.activeForRoom(ctx, room); err != nil {
		h.s.log.Debug("hls status egress check failed: " + errText(err))
	} else {
		active = e != nil
	}
	if active {
		// A core restart forgets its windows: a status poll re-arms them.
		h.track(h.roomDir(appName, room), plan)
	} else {
		_, err := os.Stat(filepath.Join(h.s.apps.AppDir(appName), "hls", slug, PlaylistName))
		active = err == nil
	}
	return &HlsStatusResult{active, url, plan.dvrInfo()}, nil
}

func (h *Hls) resolveRoom(ctx context.Context, appName, streamID string) (string, error) {
	stream, err := h.s.Get(ctx, appName, streamID)
	if err != nil {
		return "", err
	}
	if stream == nil {
		return "", httpx.NotFound(fmt.Sprintf("stream '%s' not found", streamID))
	}
	room := jsTrim(stream.Room)
	if room == "" {
		return "", httpx.BadRequest(fmt.Sprintf("stream '%s' has no room for HLS", streamID))
	}
	return room, nil
}

func (h *Hls) activeForRoom(ctx context.Context, room string) (*HlsEgressInfo, error) {
	live, err := h.liveForRoom(ctx, room)
	if err != nil {
		return nil, err
	}
	return newestEgress(live), nil
}

// liveForRoom is every listed HLS egress of exactly this room (the listing
// is by prefix) the core has not abandoned — the one set Start, Stop, Status
// and the watchdog all act on.
func (h *Hls) liveForRoom(ctx context.Context, room string) ([]HlsEgressInfo, error) {
	list, err := h.egressOrMissing().ListHlsEgress(ctx, room)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	listed := map[string]bool{}
	var out []HlsEgressInfo
	for _, e := range list {
		if e.RoomName != room {
			continue
		}
		listed[e.EgressID] = true
		if _, gone := h.abandoned[e.EgressID]; !gone {
			out = append(out, e)
		}
	}
	for id, r := range h.abandoned {
		if r == room && !listed[id] {
			delete(h.abandoned, id)
		}
	}
	return out, nil
}

// newestEgress is the most recently started egress (list order on ties /
// unknown start): after a recovery the fresh egress wins over a corpse
// LiveKit still lists. nil when none.
func newestEgress(list []HlsEgressInfo) *HlsEgressInfo {
	var best *HlsEgressInfo
	for i := range list {
		if best == nil || list[i].StartedAt.After(best.StartedAt) {
			best = &list[i]
		}
	}
	return best
}

func (h *Hls) abandon(e HlsEgressInfo) {
	h.mu.Lock()
	h.abandoned[e.EgressID] = e.RoomName
	delete(h.launched, e.EgressID)
	h.mu.Unlock()
}

// stale judges an EGRESS_ACTIVE egress by its own output, on this disk (no
// network): dead when the room's index.m3u8 — rewritten on every segment —
// has not changed in hlsStaleSegments × segS, past the startup grace. No
// playlist, or one older than the egress itself (left by a previous egress,
// or this egress writes elsewhere), is no evidence: alive. Returns the idle
// time it measured.
func (h *Hls) stale(e HlsEgressInfo, dir string, segS int) (time.Duration, bool) {
	if e.Status != "EGRESS_ACTIVE" {
		return 0, false
	}
	now := h.s.now()
	started := e.StartedAt
	h.mu.Lock()
	for id, at := range h.launched {
		if now.Sub(at) >= hlsStartupGrace {
			delete(h.launched, id)
		}
	}
	if at, ok := h.launched[e.EgressID]; ok && at.After(started) {
		started = at
	}
	h.mu.Unlock()
	if !started.IsZero() && now.Sub(started) < hlsStartupGrace {
		return 0, false
	}
	st, err := os.Stat(filepath.Join(dir, PlaylistName))
	if err != nil {
		return 0, false
	}
	mt := st.ModTime()
	if !started.IsZero() && mt.Before(started) {
		return 0, false
	}
	idle := now.Sub(mt)
	return idle, idle > time.Duration(hlsStaleSegments*max(1, segS))*time.Second
}

// egressOrMissing falls back to an egress whose every call fails like the
// guarded LiveKitService does when the SDK cannot reach LiveKit.
func (h *Hls) egressOrMissing() Egress {
	if e := h.egress(); e != nil {
		return e
	}
	return missingEgress{h.s.cfg.LivekitAPIKey != "" && h.s.cfg.LivekitAPISecret != ""}
}

type missingEgress struct{ creds bool }

func (m missingEgress) fail(op string) error {
	msg := "api-key and api-secret must be set"
	if m.creds {
		msg = "fetch failed"
	}
	return httpx.Unavailable(fmt.Sprintf("LiveKit %s failed: %s", op, msg))
}

func (m missingEgress) StartHlsEgress(context.Context, StartHlsEgressInput) (*HlsEgressInfo, error) {
	return nil, m.fail("startHlsEgress")
}

func (m missingEgress) ListHlsEgress(context.Context, string) ([]HlsEgressInfo, error) {
	return nil, m.fail("listHlsEgress")
}

func (m missingEgress) StopEgress(context.Context, string) (*EgressInfo, error) {
	return nil, m.fail("stopEgress")
}

// signedURL appends the HLS token when the app is private (G2): the
// playlistUrl handed out then plays as is. Public apps keep the bare URL.
func (h *Hls) signedURL(ctx context.Context, app, slug, url string) string {
	t := get(h.s.opt.HLSTokens)
	if t == nil {
		return url
	}
	return web.WithHLSToken(url, t.HLSTokenFor(ctx, app, slug))
}

// hlsBase is the playlistUrl base: a cdn-edge when edge selection is on and
// one is healthy, else the origin base as given.
func (h *Hls) hlsBase(ctx context.Context, app, origin string) string {
	e := get(h.s.opt.HLSEdge)
	if e == nil {
		return origin
	}
	return e.HLSBase(ctx, app, origin)
}

func playlistURL(base, app, slug, manifest string) string {
	return base + "/hls/" + jsx.EncodeURIComponent(app) + "/" + jsx.EncodeURIComponent(slug) + "/" + manifest
}

// BaseURL is the public origin for absolute playlist URLs: PUBLIC_BASE_URL
// when set, otherwise derived from the request (X-Forwarded-Proto/Host).
func BaseURL(publicBaseURL string, r *http.Request, host string, port int) string {
	if publicBaseURL != "" {
		return strings.TrimRight(publicBaseURL, "/")
	}
	proto := ""
	if fwd := r.Header.Get("X-Forwarded-Proto"); fwd != "" {
		proto = jsTrim(strings.SplitN(fwd, ",", 2)[0])
	}
	if proto == "" {
		proto = "http"
		if r.TLS != nil {
			proto = "https"
		}
	}
	h := r.Header.Get("X-Forwarded-Host")
	if h == "" {
		h = r.Host
	}
	if h == "" {
		h = fmt.Sprintf("%s:%d", host, port)
	}
	return proto + "://" + h
}

// errText is (e as Error).message: the Nest exception message for HTTP errors.
func errText(err error) string { return err.Error() }

// nodeFsMessage approximates a Node fs error message for a Go path error.
func nodeFsMessage(err error) string {
	if pe, ok := err.(*os.PathError); ok {
		return fmt.Sprintf("%s, %s '%s'", pe.Err, pe.Op, pe.Path)
	}
	return err.Error()
}
