package passthrough

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/livekit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
)

const (
	// playlistFreshWindow: a playlist written within it counts as live.
	playlistFreshWindow = 30 * time.Second
	// streamSyncInterval drives the passthrough → streams-table mirror.
	streamSyncInterval = 15 * time.Second
	forwardIDPrefix    = "fwd_"
)

func forwardRemuxID(key string) string { return forwardIDPrefix + key }

// KeyStore is the IngressAuthService slice the gate uses.
type KeyStore interface {
	RegisterPassthrough(ctx context.Context, app, room, transport, sourceURL string) (ingressID, streamKey string, err error)
	FindByStreamKey(ctx context.Context, app, streamKey string) (*livekit.IngressAuthRow, error)
	ListPassthrough(ctx context.Context, app string) ([]livekit.IngressAuthRow, error)
	Remove(ctx context.Context, app, ingressID string) error
}

// Streams is the StreamsServiceContract slice of the streams-table sync.
type Streams interface {
	Upsert(ctx context.Context, app, streamID, streamType, room, participant string) error
	End(ctx context.Context, app, streamID string) error
}

// PublishResult is HandlePublishResult (Port 0 = none).
type PublishResult struct {
	Accepted  bool
	IngressID string
	Port      int
}

// Capabilities is the "what you lose vs the LiveKit path" block.
type Capabilities struct {
	Mode             string   `json:"mode"`
	Remux            bool     `json:"remux"`
	Webrtc           bool     `json:"webrtc"`
	SubSecondLatency bool     `json:"subSecondLatency"`
	AdaptiveBitrate  bool     `json:"adaptiveBitrate"`
	Transcode        bool     `json:"transcode"`
	RequiresH264Aac  bool     `json:"requiresH264Aac"`
	Recording        bool     `json:"recording"`
	RoomFeatures     bool     `json:"roomFeatures"`
	BackupKey        bool     `json:"backupKey"`
	Gpu              bool     `json:"gpu"`
	LatencyMs        int      `json:"latencyMs,omitempty"`
	Lost             []string `json:"lost"`
}

var lost = []string{
	"No WebRTC / sub-second playback — HLS only (~2 segments of latency).",
	"No adaptive bitrate (ABR) — a single passthrough rendition.",
	"No server-side transcode safety net — the source MUST be H.264/AAC.",
	"No egress recording / VOD for this ingress.",
	"No room features (viewer count, chat, reactions, moderation, snapshots, track plugins).",
	"No backup/failover key and no GPU acceleration.",
}

// CapabilitiesFor is PassthroughService.capabilities (SRT adds latencyMs).
func CapabilitiesFor(inputType string) Capabilities {
	c := Capabilities{Mode: "passthrough", Remux: true, RequiresH264Aac: true, Lost: append([]string(nil), lost...)}
	if inputType == TransportSRT {
		c.LatencyMs = SrtLatencyMs
	}
	return c
}

// Service is PassthroughService: the auth gate (the minted ptk_ key IS the
// capability) + orchestration of the remux plane. It never calls LiveKit.
type Service struct {
	cfg     *config.Config
	keys    KeyStore
	remux   *RemuxManager
	streams func() Streams
	log     *slog.Logger
	now     func() time.Time

	// Tracks reports a MediaMTX path's track codecs (E1 HEVC detection);
	// nil = the MediaMTX API. Tests inject a fake.
	Tracks TrackProber
	// HLSEdge picks the hlsUrl base (a cdn-edge when STREAMHUB_HLS_EDGE_SELECT
	// is on); nil = PUBLIC_BASE_URL.
	HLSEdge func() livekit.HLSEdge

	mu        sync.Mutex
	usedPorts map[int]bool
	portByID  map[string]int
	liveRooms map[string]bool
}

// NewService builds the service.
func NewService(cfg *config.Config, keys KeyStore, remux *RemuxManager, streams func() Streams, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		cfg: cfg, keys: keys, remux: remux, streams: streams, log: log, now: time.Now,
		usedPorts: map[int]bool{}, portByID: map[string]int{}, liveRooms: map[string]bool{},
	}
}

// Remux exposes the manager (logs/status, boot front).
func (s *Service) Remux() *RemuxManager { return s.remux }

// Enabled is the master switch (STREAMHUB_RTMP_PASSTHROUGH_ENABLE).
func (s *Service) Enabled() bool { return s.cfg.RtmpPassthroughEnable }

// Start runs the streams-table sync every 15 s while the plane is enabled.
func (s *Service) Start(ctx context.Context) {
	if !s.Enabled() {
		return
	}
	go func() {
		t := time.NewTicker(streamSyncInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.SyncStreamRows(ctx)
			}
		}
	}()
}

func (s *Service) streamsSvc() Streams {
	if s.streams == nil {
		return nil
	}
	return s.streams()
}

// SyncStreamRows mirrors live passthrough remuxes into the per-app streams
// table (passthrough bypasses LiveKit ⇒ no webhook creates the row): fresh
// playlist ⇒ upsert ACTIVE `<room>/passthrough` every tick; stale/stopped ⇒
// end it once. Best-effort.
func (s *Service) SyncStreamRows(ctx context.Context) {
	st := s.streamsSvc()
	if st == nil {
		return
	}
	for _, e := range s.remux.List() {
		key := e.App + "::" + e.Room
		streamID := e.Room + "/passthrough"
		live := e.Desired == "live" && s.playlistFresh(e.App, e.Room)
		var err error
		s.mu.Lock()
		wasLive := s.liveRooms[key]
		s.mu.Unlock()
		switch {
		case live:
			if err = st.Upsert(ctx, e.App, streamID, "rtmp", e.Room, "passthrough"); err == nil {
				s.mu.Lock()
				s.liveRooms[key] = true
				s.mu.Unlock()
			}
		case wasLive:
			if err = st.End(ctx, e.App, streamID); err == nil {
				s.mu.Lock()
				delete(s.liveRooms, key)
				s.mu.Unlock()
			}
		}
		if err != nil {
			s.log.Warn("streams-table sync failed for " + key + ": " + err.Error())
		}
	}
}

// IsPassthroughID: the id belongs to the passthrough plane.
func IsPassthroughID(id string) bool { return livekit.IsPassthroughID(id) }

// ParseMpegtsSource implements livekit.Passthrough (the create DTO fields).
func (s *Service) ParseMpegtsSource(in livekit.MpegtsSource) (string, error) {
	o := MpegtsOptions{URL: in.URL, SourcesRaw: in.Sources, Localaddr: in.Localaddr, OverrunNonfatal: in.OverrunNonfatal}
	if in.FifoSize != nil {
		f := float64(*in.FifoSize)
		o.FifoSize = &f
	}
	p, err := ParseMpegtsSource(o)
	if err != nil {
		return "", err
	}
	return p.SourceURL, nil
}

// Create mints a ptk_ key for an already-namespaced room, arms the remux
// (except RTMP under the MediaMTX switch: its ready hook arms it) and returns
// the push/playback surface. 503 when the plane is disabled.
func (s *Service) Create(ctx context.Context, app, room, transport, sourceURL string) (*livekit.PassthroughInfo, error) {
	if !s.Enabled() {
		return nil, httpx.Unavailable("RTMP/SRT/MPEG-TS passthrough is disabled — set STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on to use it")
	}
	if transport == "" {
		transport = TransportRTMP
	}
	ingressID, streamKey, err := s.keys.RegisterPassthrough(ctx, app, room, transport, sourceURL)
	if err != nil {
		return nil, err
	}
	port := 0
	if !s.pullDriven(transport) {
		port = s.HandlePublish(ctx, app, streamKey, nil).Port
	}
	info := s.buildInfo(app, ingressID, room, streamKey, sourceURL, port)
	return &info, nil
}

// pullDriven: MediaMTX owns :1935 and arms RTMP via its ready hook — and,
// with STREAMHUB_MEDIAMTX_SRT_ENABLE, SRT too (its :8890 listener, key-checked
// by the auth hook) instead of a per-ingress ffmpeg listener that checks
// nothing.
func (s *Service) pullDriven(transport string) bool {
	if !s.cfg.MediamtxEnable {
		return false
	}
	return transport == TransportRTMP || (transport == TransportSRT && s.cfg.MediamtxSrtEnable)
}

// mediamtxPort is the MediaMTX listener a pull-driven transport uses.
func (s *Service) mediamtxPort(transport string) int {
	if transport == TransportSRT {
		return s.cfg.MediamtxSrtPort
	}
	return s.cfg.MediamtxRtmpPort
}

func (s *Service) findPassthrough(ctx context.Context, app, streamKey string) *livekit.IngressAuthRow {
	row, err := s.keys.FindByStreamKey(ctx, app, streamKey)
	if err != nil {
		s.log.Warn("passthrough key lookup failed for app \"" + app + "\": " + err.Error())
		return nil
	}
	if row == nil || !IsPassthroughID(row.IngressID) {
		return nil
	}
	return row
}

// HandlePublish is the prePublish gate: an unknown / non-passthrough key is
// rejected with NO ffmpeg spawned; a valid ptk_ key arms the remux.
func (s *Service) HandlePublish(ctx context.Context, app, streamKey string, appID *int64) PublishResult {
	row := s.findPassthrough(ctx, app, streamKey)
	if row == nil {
		s.log.Warn("passthrough publish REJECTED for app \"" + app + "\" (unknown/invalid key)")
		return PublishResult{}
	}
	room := app
	if row.Room != nil {
		room = *row.Room
	}
	transport := livekit.PassthroughTransportOf(row.IngressID)
	hls := HlsDir(s.cfg.DataDir, app, room)

	if transport == TransportMPEGTS {
		// PULL source: no client push, no listener port; the canonical udp://
		// input is persisted so boot re-arm rebuilds it byte-for-byte.
		if row.SourceURL == nil || *row.SourceURL == "" {
			s.log.Warn("mpegts publish REJECTED for app \"" + app + "\" (ingress " + row.IngressID + " has no source_url)")
			return PublishResult{}
		}
		s.remux.Start(row.IngressID, RemuxSpec{
			App: app, Room: room, StreamKey: streamKey, HlsDir: hls,
			Transport: TransportMPEGTS, Mode: "pull", SourceURL: *row.SourceURL, AppID: appID,
		})
		return PublishResult{Accepted: true, IngressID: row.IngressID}
	}

	if s.pullDriven(transport) {
		// MediaMTX already accepted the push: ffmpeg PULLS from it.
		port := s.mediamtxPort(transport)
		s.remux.Start(row.IngressID, RemuxSpec{
			App: app, Room: room, StreamKey: streamKey, Port: port, HlsDir: hls,
			Transport: transport, Mode: "pull", AppID: appID, HlsVariant: s.hlsVariant(ctx, app, streamKey),
		})
		return PublishResult{Accepted: true, IngressID: row.IngressID, Port: port}
	}

	port := s.acquirePort(row.IngressID)
	s.remux.Start(row.IngressID, RemuxSpec{
		App: app, Room: room, StreamKey: streamKey, Port: port, HlsDir: hls, Transport: transport, AppID: appID,
	})
	return PublishResult{Accepted: true, IngressID: row.IngressID, Port: port}
}

// hlsVariant picks the HLS segmenting of a pull-driven publish: with
// STREAMHUB_PASSTHROUGH_HEVC on and MediaMTX reporting an H.265 video
// track, fMP4/hvc1 (E1); anything else (switch off, H.264, probe failure)
// keeps MPEG-TS, the Node behaviour.
func (s *Service) hlsVariant(ctx context.Context, app, streamKey string) string {
	if !s.cfg.PassthroughHEVC {
		return ""
	}
	probe := s.Tracks
	if probe == nil {
		probe = mediamtxTracks(s.cfg.MediamtxAPIURL)
	}
	tracks, err := probe(ctx, app+"/"+streamKey)
	if err != nil {
		s.log.Warn("passthrough HEVC probe failed — segmenting as MPEG-TS", "app", app, "err", err)
		return ""
	}
	for _, t := range tracks {
		if IsHEVCTrack(t) {
			return HlsFMP4HEVC
		}
	}
	return ""
}

// AuthorizeKey is the MediaMTX auth hook gate: a known passthrough key?
// Arms nothing (the ready hook does).
func (s *Service) AuthorizeKey(ctx context.Context, app, streamKey string) bool {
	return s.findPassthrough(ctx, app, streamKey) != nil
}

// HandleDone stops the remux of an ended publish but KEEPS the key.
func (s *Service) HandleDone(ctx context.Context, app, streamKey string) {
	row := s.findPassthrough(ctx, app, streamKey)
	if row == nil {
		return
	}
	s.remux.Stop(row.IngressID)
	s.releasePort(row.IngressID)
}

// HandleForwardPublish arms the hidden FORWARD child relaying a `live/<key>`
// publish off MediaMTX to the moved LiveKit ingress (switch on only).
func (s *Service) HandleForwardPublish(key string) {
	if !s.cfg.MediamtxEnable || key == "" {
		return
	}
	s.remux.Start(forwardRemuxID(key), RemuxSpec{
		Kind: "forward", App: livekit.RtmpApp, Room: key, StreamKey: key, ForwardKey: key,
		Port: s.cfg.MediamtxRtmpPort, DestPort: s.cfg.LivekitIngressRtmpPort,
	})
}

// HandleForwardDone stops the forward child.
func (s *Service) HandleForwardDone(key string) {
	if key == "" {
		return
	}
	s.remux.Stop(forwardRemuxID(key))
}

// Remove tears a passthrough ingress down (remux + HLS dir, port, key, the
// mirrored streams row). False when id is not a passthrough id.
func (s *Service) Remove(ctx context.Context, app, id string) bool {
	if !IsPassthroughID(id) {
		return false
	}
	var room *string
	if rows, err := s.keys.ListPassthrough(ctx, app); err == nil {
		for _, r := range rows {
			if r.IngressID == id {
				room = r.Room
				break
			}
		}
	}
	s.remux.Stop(id)
	s.releasePort(id)
	if err := s.keys.Remove(ctx, app, id); err != nil {
		s.log.Warn("passthrough key removal failed for " + id + ": " + err.Error())
	}
	if room != nil && *room != "" {
		s.mu.Lock()
		delete(s.liveRooms, app+"::"+*room)
		s.mu.Unlock()
		if st := s.streamsSvc(); st != nil {
			_ = st.End(context.WithoutCancel(ctx), app, *room+"/passthrough") // best-effort
		}
	}
	return true
}

// Get returns one passthrough ingress (merged with live status) or nil.
func (s *Service) Get(ctx context.Context, app, id string) (*livekit.PassthroughInfo, error) {
	if !IsPassthroughID(id) {
		return nil, nil
	}
	rows, err := s.keys.ListPassthrough(ctx, app)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		if r.IngressID == id && r.StreamKey != nil && *r.StreamKey != "" {
			info := s.rowInfo(app, r)
			return &info, nil
		}
	}
	return nil, nil
}

// List returns every passthrough ingress of app, merged with remux status.
func (s *Service) List(ctx context.Context, app string) ([]livekit.PassthroughInfo, error) {
	rows, err := s.keys.ListPassthrough(ctx, app)
	if err != nil {
		return nil, err
	}
	out := []livekit.PassthroughInfo{}
	for _, r := range rows {
		if r.StreamKey == nil || *r.StreamKey == "" {
			continue
		}
		out = append(out, s.rowInfo(app, r))
	}
	return out, nil
}

func (s *Service) rowInfo(app string, r livekit.IngressAuthRow) livekit.PassthroughInfo {
	room := app
	if r.Room != nil {
		room = *r.Room
	}
	src := ""
	if r.SourceURL != nil {
		src = *r.SourceURL
	}
	return s.buildInfo(app, r.IngressID, room, *r.StreamKey, src, 0)
}

// buildInfo is the push/playback surface of one ingress (armedPort 0 =
// none: the live listener's port, else the MediaMTX :1935 for a pull-driven
// RTMP ingress, else the passthrough base port).
func (s *Service) buildInfo(app, ingressID, room, streamKey, sourceURL string, armedPort int) livekit.PassthroughInfo {
	host := s.cfg.RtmpPublicHost
	if host == "" {
		host = livekit.DefaultRtmpHost
	}
	inputType := livekit.PassthroughTransportOf(ingressID)
	port := armedPort
	if port == 0 {
		s.mu.Lock()
		p, ok := s.portByID[ingressID]
		s.mu.Unlock()
		switch {
		case ok:
			port = p
		case s.pullDriven(inputType):
			port = s.mediamtxPort(inputType)
		default:
			port = s.cfg.RtmpPassthroughPort
		}
	}
	info := livekit.PassthroughInfo{
		Mode: "passthrough", IngressID: ingressID, App: app, Room: room, StreamKey: streamKey, InputType: inputType,
		Capabilities: CapabilitiesFor(inputType),
	}
	if inputType == TransportRTMP {
		info.RtmpURL = livekit.BuildPassthroughRtmpURL(streamKey, host, port, app)
	}
	if inputType == TransportSRT {
		if s.pullDriven(inputType) {
			info.SrtURL = MediamtxSrtPublishURL(host, port, app, streamKey)
		} else {
			info.SrtURL = livekit.BuildPassthroughSrtURL(streamKey, host, port)
		}
	}
	if inputType == TransportMPEGTS && sourceURL != "" {
		info.SourceURL = sourceURL
	}
	base := strings.TrimRight(s.cfg.PublicBaseURL, "/")
	ea, er := jsx.EncodeURIComponent(app), jsx.EncodeURIComponent(room)
	hlsBase := base
	if s.HLSEdge != nil {
		if e := s.HLSEdge(); e != nil {
			hlsBase = e.HLSBase(context.Background(), app, base)
		}
	}
	info.HlsURL = hlsBase + "/hls/" + ea + "/" + er + "/" + HlsPlaylist
	info.PlayerURL = base + "/play/" + ea + "/" + er
	info.Status = StatusOff
	if st, ok := s.remux.Status(ingressID); ok && st.Status != "" {
		info.Status = st.Status
	}
	fresh := s.playlistFresh(app, room)
	info.PlaylistFresh = &fresh
	return info
}

// playlistFresh: the room's HLS playlist was written within 30 s.
func (s *Service) playlistFresh(app, room string) bool {
	st, err := os.Stat(filepath.Join(HlsDir(s.cfg.DataDir, app, room), HlsPlaylist))
	if err != nil {
		return false
	}
	return s.now().Sub(st.ModTime()) < playlistFreshWindow
}

func (s *Service) acquirePort(id string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.portByID[id]; ok {
		return p
	}
	p := s.cfg.RtmpPassthroughPort
	for s.usedPorts[p] {
		p++
	}
	s.usedPorts[p] = true
	s.portByID[id] = p
	return p
}

func (s *Service) releasePort(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.portByID[id]; ok {
		delete(s.usedPorts, p)
		delete(s.portByID, id)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// The livekit plane's narrow view must keep matching.
var _ livekit.Passthrough = (*Service)(nil)
