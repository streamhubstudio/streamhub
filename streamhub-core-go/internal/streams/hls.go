package streams

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Port of hls.service.ts: the live HLS egress of a stream's room. LiveKit
// writes index.m3u8 + .ts segments to <app dir>/hls/<safe(room)>/, served by
// the core at /hls/<app>/<room>/.

const (
	// PlaylistName is the full timeline playlist.
	PlaylistName = "index.m3u8"
	// LivePlaylistName is the bounded rolling playlist of DVR channels.
	LivePlaylistName = "live.m3u8"
	segmentDurationS = 4
)

// HlsStartResult is the start payload.
type HlsStartResult struct {
	EgressID    string `json:"egressId"`
	PlaylistURL string `json:"playlistUrl"`
	Status      string `json:"status"`
}

// HlsStopResult is the stop payload.
type HlsStopResult struct {
	EgressID *string `json:"egressId"`
	Status   string  `json:"status"`
}

// HlsStatusResult is the status payload.
type HlsStatusResult struct {
	Active      bool   `json:"active"`
	PlaylistURL string `json:"playlistUrl"`
}

// Hls is HlsService.
type Hls struct {
	s *Service
}

// NewHls builds the HLS orchestration over the streams service.
func NewHls(s *Service) *Hls { return &Hls{s: s} }

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
	dvr := h.dvrEnabled(ctx, appName)
	manifest := PlaylistName
	if dvr {
		manifest = LivePlaylistName
	}
	playlistURL := playlistURL(baseURL, appName, slug, manifest)

	existing, err := h.activeForRoom(ctx, room)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return &HlsStartResult{existing.EgressID, playlistURL, existing.Status}, nil
	}

	outputDir := filepath.Join(h.s.apps.AppDir(appName), "hls", slug)
	if err := os.MkdirAll(outputDir, 0o777); err != nil {
		return nil, httpx.Internal("cannot create HLS output dir: " + nodeFsMessage(err))
	}
	in := StartHlsEgressInput{
		AppName: appName, RoomName: room, OutputDir: outputDir, PlaylistName: PlaylistName, SegmentDurationS: segmentDurationS,
	}
	if dvr {
		in.LivePlaylistName = LivePlaylistName
	}
	info, err := h.egressOrMissing().StartHlsEgress(ctx, in)
	if err != nil {
		msg := errText(err)
		h.logWrite("error", "startHlsEgress failed", hlsFailMeta{appName, room, msg})
		return nil, httpx.Internal("failed to start HLS egress: " + msg)
	}
	h.logWrite("info", "hls started", hlsStartedMeta{appName, streamID, room, info.EgressID, info.Status, playlistURL})
	h.s.dispatch(ctx, appName, "hls_started", hlsStartedEvent{appName, room, streamID, info.EgressID, info.Status, playlistURL})
	return &HlsStartResult{info.EgressID, playlistURL, info.Status}, nil
}

// Stop stops the active HLS egress(es) of the room (lenient when none).
func (h *Hls) Stop(ctx context.Context, appName, streamID string) (*HlsStopResult, error) {
	room, err := h.resolveRoom(ctx, appName, streamID)
	if err != nil {
		return nil, err
	}
	var active []HlsEgressInfo
	if list, err := h.egressOrMissing().ListHlsEgress(ctx, room); err != nil {
		h.s.log.Warn("listHlsEgress failed: " + errText(err))
	} else {
		for _, e := range list {
			if e.RoomName == room {
				active = append(active, e)
			}
		}
	}
	if len(active) == 0 {
		return &HlsStopResult{nil, "inactive"}, nil
	}
	var lastID *string
	lastStatus := "inactive"
	for _, e := range active {
		res, err := h.egressOrMissing().StopEgress(ctx, e.EgressID)
		if err != nil {
			h.logWrite("error", "stopEgress failed", hlsStopFailMeta{appName, room, e.EgressID, errText(err)})
			continue
		}
		id := res.EgressID
		lastID, lastStatus = &id, res.Status
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
	manifest := PlaylistName
	if h.dvrEnabled(ctx, appName) {
		manifest = LivePlaylistName
	}
	url := playlistURL(baseURL, appName, slug, manifest)
	active := false
	if e, err := h.activeForRoom(ctx, room); err != nil {
		h.s.log.Debug("hls status egress check failed: " + errText(err))
	} else {
		active = e != nil
	}
	if !active {
		_, err := os.Stat(filepath.Join(h.s.apps.AppDir(appName), "hls", slug, PlaylistName))
		active = err == nil
	}
	return &HlsStatusResult{active, url}, nil
}

// dvrEnabled is features.linear.dvr === true (false on any config error).
func (h *Hls) dvrEnabled(ctx context.Context, appName string) bool {
	cfg, err := h.s.apps.GetConfig(ctx, appName)
	if err != nil || cfg.Features.Linear == nil {
		return false
	}
	return cfg.Features.Linear.Dvr
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
	list, err := h.egressOrMissing().ListHlsEgress(ctx, room)
	if err != nil {
		return nil, err
	}
	for _, e := range list {
		if e.RoomName == room {
			e := e
			return &e, nil
		}
	}
	return nil, nil
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
