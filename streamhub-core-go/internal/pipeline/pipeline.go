// Package pipeline is src/modules/pipeline: GET /apps/:app/pipeline, the
// app's resolved media-pipeline topology (ingest → processing → delivery →
// storage) from config.yaml plus cheap live hints (active streams, on-disk
// HLS). The shape is a stable frontend contract (animated flow diagram).
package pipeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/netmetrics"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/notifications"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/system"
)

// ---------------------------------------------------------------------------
// Collaborators (narrow views; the lazy ones may return nil)
// ---------------------------------------------------------------------------

// HwAccel is HwAccelService.resolve + getMode.
type HwAccel interface {
	Resolve(ctx context.Context, app string) system.HwaccelDecision
	GetMode(app string) system.HwaccelMode
}

// Notifier is NotifierService.channelsFor.
type Notifier interface {
	ChannelsFor(app string) notifications.ChannelsEnabled
}

// NetMetrics is NetMetricsService.history.
type NetMetrics interface {
	History(ctx context.Context, app string, hours float64, now time.Time) []netmetrics.HistoryBucket
}

// Passthrough is the remux plane (PassthroughService.enabled/list).
type Passthrough interface {
	Enabled() bool
	List(ctx context.Context, app string) ([]livekit.PassthroughInfo, error)
}

// PluginsRepo is AppPluginsRepository.list.
type PluginsRepo interface {
	List(ctx context.Context, app string) ([]*plugins.Installed, error)
}

// PluginsRegistry is PluginRegistryService.getMeta.
type PluginsRegistry interface {
	GetMeta(id string) *plugins.Meta
}

// VisionView is VisionPipelineView.
type VisionView struct {
	EnabledModels []string
	Running       int
	Pending       int
	EdgeTotal     int
	EdgeOnline    int
}

// Vision is VisionAppService.pipelineVision (an error degrades compute).
type Vision interface {
	PipelineVision(app string) (VisionView, error)
}

// Deps wires the service. The func getters are resolved at call time.
type Deps struct {
	Config      *config.Config
	Store       *db.Service
	Apps        contracts.AppsService
	HwAccel     HwAccel
	Notifier    Notifier
	NetMetrics  NetMetrics
	Passthrough func() Passthrough
	Plugins     func() PluginsRepo
	Registry    func() PluginsRegistry
	Vision      func() Vision
	Log         *slog.Logger
}

// Service is PipelineService.
type Service struct {
	d   Deps
	now func() time.Time
}

// New builds the service.
func New(d Deps) *Service {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	return &Service{d: d, now: time.Now}
}

func call[T any](f func() T) T {
	var zero T
	if f == nil {
		return zero
	}
	return f()
}

// ---------------------------------------------------------------------------
// Wire types (field order = Node object literal order)
// ---------------------------------------------------------------------------

// PipelineEndpoint is one ingest/delivery node.
type PipelineEndpoint struct {
	Type    string  `json:"type"`
	Enabled bool    `json:"enabled"`
	Active  bool    `json:"active"`
	Label   string  `json:"label"`
	Detail  *string `json:"detail,omitempty"`
}

// PipelineLayer is an adaptive rung.
type PipelineLayer struct {
	Name   string  `json:"name"`
	Height float64 `json:"height"`
}

// PipelineProcessing is the processing section.
type PipelineProcessing struct {
	Transcoding struct {
		Enabled bool               `json:"enabled"`
		Encoder string             `json:"encoder"`
		Hwaccel system.HwaccelMode `json:"hwaccel"`
	} `json:"transcoding"`
	Adaptive struct {
		Enabled bool            `json:"enabled"`
		Layers  []PipelineLayer `json:"layers"`
	} `json:"adaptive"`
	Passthrough PipelinePassthroughPlane `json:"passthrough"`
}

// PipelinePassthroughPlane is processing.passthrough.
type PipelinePassthroughPlane struct {
	Enabled    bool     `json:"enabled"`
	Transports []string `json:"transports"`
}

// PipelineCompute is the compute section.
type PipelineCompute struct {
	Edge struct {
		Total  int `json:"total"`
		Online int `json:"online"`
	} `json:"edge"`
	Vision struct {
		Enabled     bool     `json:"enabled"`
		Models      []string `json:"models"`
		Assignments struct {
			Running int `json:"running"`
			Pending int `json:"pending"`
		} `json:"assignments"`
	} `json:"vision"`
}

// PipelineStorage is the storage section.
type PipelineStorage struct {
	Recording struct {
		Enabled         bool     `json:"enabled"`
		SplitMinutes    *float64 `json:"splitMinutes,omitempty"`
		SnapshotSeconds *float64 `json:"snapshotSeconds,omitempty"`
	} `json:"recording"`
	S3 struct {
		Configured bool    `json:"configured"`
		Bucket     *string `json:"bucket,omitempty"`
	} `json:"s3"`
}

// PipelinePlugin is an installed plugin with its registry meta.
type PipelinePlugin struct {
	ID       string `json:"id"`
	Enabled  bool   `json:"enabled"`
	Kind     string `json:"kind"`
	Category string `json:"category"`
}

type pipelineFlag struct {
	Enabled bool `json:"enabled"`
}

// PipelineEvents is the event fan-out taps section.
type PipelineEvents struct {
	Callbacks struct {
		Configured bool `json:"configured"`
	} `json:"callbacks"`
	Mqtt pipelineFlag `json:"mqtt"`
	Log  pipelineFlag `json:"log"`
}

// PipelineNet is the rolling network I/O.
type PipelineNet struct {
	InBytes   int64 `json:"inBytes"`
	OutBytes  int64 `json:"outBytes"`
	WindowSec int   `json:"windowSec"`
}

// AppPipeline is the GET /apps/:app/pipeline data.
type AppPipeline struct {
	Ingest      []PipelineEndpoint `json:"ingest"`
	IngestFront struct {
		Mediamtx bool `json:"mediamtx"`
		Port     int  `json:"port"`
	} `json:"ingestFront"`
	Processing    PipelineProcessing            `json:"processing"`
	Compute       PipelineCompute               `json:"compute"`
	Delivery      []PipelineEndpoint            `json:"delivery"`
	Storage       PipelineStorage               `json:"storage"`
	Plugins       []PipelinePlugin              `json:"plugins"`
	Live          PipelineLive                  `json:"live"`
	Events        PipelineEvents                `json:"events"`
	Notifications notifications.ChannelsEnabled `json:"notifications"`
	Net           PipelineNet                   `json:"net"`
}

// PipelineLive is the live section (viewers is never emitted).
type PipelineLive struct {
	ActiveStreams int      `json:"activeStreams"`
	Tags          []string `json:"tags"`
}

type liveHints struct {
	total  int
	byType map[string]int
	rooms  []string
	tags   []string
}

func strp(s string) *string { return &s }

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// Get resolves the topology (404 from the apps module on an unknown app).
func (s *Service) Get(ctx context.Context, app string) (*AppPipeline, error) {
	cfg, err := s.d.Apps.GetConfig(ctx, app)
	if err != nil {
		return nil, err
	}
	hints := s.liveHints(ctx, app)
	p := &AppPipeline{}
	p.Ingest = s.ingest(cfg, hints)
	p.IngestFront.Mediamtx = s.d.Config.MediamtxEnable
	p.IngestFront.Port = s.d.Config.MediamtxRtmpPort
	p.Processing = s.processing(ctx, app, cfg)
	p.Compute = s.compute(ctx, app)
	p.Delivery = s.delivery(ctx, app, cfg, hints)
	p.Storage = storage(cfg)
	p.Plugins = s.installedPlugins(ctx, app)
	p.Live = PipelineLive{ActiveStreams: hints.total, Tags: hints.tags}
	p.Events = events(cfg)
	if s.d.Notifier != nil {
		p.Notifications = s.d.Notifier.ChannelsFor(app)
	}
	p.Net = s.net(ctx, app)
	return p, nil
}

func (s *Service) passthroughEnabled() (Passthrough, bool) {
	pt := call(s.d.Passthrough)
	return pt, pt != nil && pt.Enabled()
}

func (s *Service) ingest(cfg *contracts.AppConfig, h liveHints) []PipelineEndpoint {
	live := func(t string) bool { return h.byType[t] > 0 }
	c := s.d.Config
	rtmpEnabled := cfg.Rtmp.Enabled
	rtmpsEnabled := rtmpEnabled && c.RtmpsEnable
	rtmpHost := c.RtmpPublicHost
	rtmpsHost := c.RtmpsPublicHost
	if rtmpsHost == "" {
		rtmpsHost = rtmpHost
	}
	wsEnabled := cfg.Features.WsIngest == nil || cfg.Features.WsIngest.Enabled
	_, pt := s.passthroughEnabled()

	rtmpDetail := "RTMP ingest on port 1935"
	if rtmpHost != "" {
		rtmpDetail = "rtmp://" + rtmpHost + ":1935"
	}
	rtmpsDetail := "STREAMHUB_RTMPS_ENABLE off"
	if rtmpsEnabled {
		host := rtmpsHost
		if host == "" {
			host = "<host>"
		}
		rtmpsDetail = fmt.Sprintf("rtmps://%s:%d (TLS front → RTMP :1935)", host, c.RtmpsPort)
	}
	srtDetail, tsDetail := "STREAMHUB_RTMP_PASSTHROUGH_ENABLE off", "STREAMHUB_RTMP_PASSTHROUGH_ENABLE off"
	if pt {
		srtDetail, tsDetail = "SRT passthrough (remux, -c copy)", "MPEG-TS multicast PULL (remux, -c copy)"
	}
	return []PipelineEndpoint{
		{"rtmp", rtmpEnabled, live("rtmp"), "RTMP", strp(rtmpDetail)},
		{"rtmps", rtmpsEnabled, rtmpsEnabled && live("rtmp"), "RTMPS", strp(rtmpsDetail)},
		{"whip", true, live("whip"), "WHIP", strp("WebRTC-HTTP ingest (port 8080)")},
		{"webrtc", true, live("webrtc"), "WebRTC publish", strp("LiveKit SFU (/rtc)")},
		{"rtsp", true, live("rtsp"), "RTSP / URL pull", strp("URL ingress — pulls a remote rtsp/http/hls/srt source")},
		{"ws-mjpeg", wsEnabled, live("ws-mjpeg"), "WS MJPEG (ESP32)", strp("/ingest/ws gateway")},
		{"srt", pt, pt && live("srt"), "SRT", strp(srtDetail)},
		{"mpegts", pt, pt && live("mpegts"), "MPEG-TS / UDP", strp(tsDetail)},
	}
}

func (s *Service) processing(ctx context.Context, app string, cfg *contracts.AppConfig) PipelineProcessing {
	var p PipelineProcessing
	p.Transcoding.Enabled = cfg.Transcoding.Enabled
	p.Transcoding.Encoder = "cpu"
	p.Transcoding.Hwaccel = "auto"
	if s.d.HwAccel != nil {
		p.Transcoding.Encoder = s.d.HwAccel.Resolve(ctx, app).Effective
		p.Transcoding.Hwaccel = s.d.HwAccel.GetMode(app)
	}
	p.Adaptive.Enabled = cfg.Webrtc.Adaptive
	p.Adaptive.Layers = []PipelineLayer{}
	for _, l := range cfg.Webrtc.Layers {
		p.Adaptive.Layers = append(p.Adaptive.Layers, PipelineLayer{l.Name, l.Height})
	}
	p.Passthrough = s.passthroughPlane(ctx, app)
	return p
}

func (s *Service) passthroughPlane(ctx context.Context, app string) PipelinePassthroughPlane {
	pt, enabled := s.passthroughEnabled()
	if !enabled {
		return PipelinePassthroughPlane{Enabled: false, Transports: []string{}}
	}
	set := map[string]bool{}
	if list, err := pt.List(ctx, app); err != nil {
		s.d.Log.Debug(fmt.Sprintf("passthrough list unavailable for %q: %s", app, err))
	} else {
		for _, ig := range list {
			switch ig.InputType {
			case "rtmp", "srt", "mpegts":
				set[ig.InputType] = true
			}
		}
	}
	if len(set) == 0 {
		return PipelinePassthroughPlane{Enabled: true, Transports: []string{"mpegts", "rtmp", "srt"}}
	}
	out := make([]string, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	sort.Strings(out)
	return PipelinePassthroughPlane{Enabled: true, Transports: out}
}

// visionModels is VISION_MODELS (order kept).
var visionModels = []string{"occupancy", "counting", "crowd", "demography"}

func (s *Service) compute(ctx context.Context, app string) PipelineCompute {
	var c PipelineCompute
	c.Vision.Models = []string{}
	v, err := s.visionView(ctx, app)
	if err != nil {
		s.d.Log.Debug(fmt.Sprintf("compute overview unavailable for %q: %s", app, err))
		return c
	}
	c.Edge.Total, c.Edge.Online = v.EdgeTotal, v.EdgeOnline
	if v.EnabledModels != nil {
		c.Vision.Models = v.EnabledModels
	}
	c.Vision.Enabled = len(c.Vision.Models) > 0
	c.Vision.Assignments.Running, c.Vision.Assignments.Pending = v.Running, v.Pending
	return c
}

// visionView asks the vision module, or (until vision-apps is ported) runs
// the same aggregate over the shared tables: enabled vision installs from
// app_plugins, the edge_assignments backlog and the nodes registry. Online
// needs the edge WS gateway, so it stays 0 in the fallback.
func (s *Service) visionView(ctx context.Context, app string) (VisionView, error) {
	if v := call(s.d.Vision); v != nil {
		return v.PipelineVision(app)
	}
	out := VisionView{EnabledModels: []string{}}
	if repo := call(s.d.Plugins); repo != nil {
		if list, err := repo.List(ctx, app); err == nil {
			on := map[string]bool{}
			for _, p := range list {
				on[p.PluginID] = p.Enabled
			}
			for _, m := range visionModels {
				if on[m] {
					out.EnabledModels = append(out.EnabledModels, m)
				}
			}
		}
	}
	g, err := s.d.Store.Global(ctx)
	if err != nil {
		return out, nil
	}
	if rows, err := g.QueryContext(ctx, `SELECT plugin_id, status FROM edge_assignments WHERE app = ?`, app); err == nil {
		for rows.Next() {
			var pid, st string
			if rows.Scan(&pid, &st) != nil {
				continue
			}
			isVision := false
			for _, m := range visionModels {
				isVision = isVision || m == pid
			}
			if !isVision {
				continue
			}
			if st == "running" {
				out.Running++
			} else if st == "pending" {
				out.Pending++
			}
		}
		rows.Close()
	}
	var n int
	if err := g.QueryRowContext(ctx, `SELECT COUNT(*) FROM nodes`).Scan(&n); err == nil {
		out.EdgeTotal = n
	}
	return out, nil
}

func events(cfg *contracts.AppConfig) PipelineEvents {
	var e PipelineEvents
	e.Callbacks.Configured = strings.TrimSpace(cfg.Callbacks.URL) != ""
	e.Mqtt.Enabled = cfg.Mqtt.Enabled
	e.Log.Enabled = true
	return e
}

func (s *Service) net(ctx context.Context, app string) PipelineNet {
	n := PipelineNet{WindowSec: 3600}
	if s.d.NetMetrics == nil {
		return n
	}
	for _, b := range s.d.NetMetrics.History(ctx, app, 1, s.now()) {
		n.InBytes += b.In
		n.OutBytes += b.Out
	}
	return n
}

func (s *Service) restreamTargets(ctx context.Context, app string) (configured, live int) {
	adb, err := s.d.Store.App(ctx, app)
	if err != nil {
		return 0, 0
	}
	if err := adb.QueryRowContext(ctx, "SELECT COUNT(*) AS n FROM restream_targets WHERE status != 'stopped'").Scan(&configured); err != nil {
		return 0, 0
	}
	if err := adb.QueryRowContext(ctx, "SELECT COUNT(*) AS n FROM restream_targets WHERE status IN ('starting','active')").Scan(&live); err != nil {
		return 0, 0
	}
	return configured, live
}

var hlsCdnOn = regexp.MustCompile(`(?i)^(1|true|on|yes)$`)

func (s *Service) delivery(ctx context.Context, app string, cfg *contracts.AppConfig, h liveHints) []PipelineEndpoint {
	cdnBase := strings.TrimSpace(cfg.S3.PublicURL)
	hlsCdn := hlsCdnOn.MatchString(strings.TrimSpace(s.d.Config.Env("STREAMHUB_HLS_CDN")))
	hlsLive := s.hlsActive(app, h.rooms)
	var parts []string
	if cdnBase != "" {
		parts = append(parts, cdnBase)
	}
	if hlsCdn {
		parts = append(parts, "CDN-cacheable live HLS (STREAMHUB_HLS_CDN on)")
	}
	cdn := PipelineEndpoint{"cdn", hlsCdn || cdnBase != "", hlsCdn && hlsLive, "CDN / public URL", nil}
	if len(parts) > 0 {
		cdn.Detail = strp(strings.Join(parts, " + "))
	}
	configured, live := s.restreamTargets(ctx, app)
	restream := PipelineEndpoint{"restream", configured > 0, live > 0, "Restream", nil}
	if configured > 0 {
		word := "targets"
		if configured == 1 {
			word = "target"
		}
		restream.Detail = strp(fmt.Sprintf("%d %s", configured, word))
	}
	return []PipelineEndpoint{
		{"webrtc", true, h.total > 0, "WebRTC playback", strp("LiveKit SFU (/rtc)")},
		{"hls", true, hlsLive, "HLS", strp("/hls/<app>/<room>/index.m3u8 (on-demand live egress)")},
		cdn,
		restream,
	}
}

func storage(cfg *contracts.AppConfig) PipelineStorage {
	var st PipelineStorage
	st.Recording.Enabled = cfg.Recording.Enabled
	if v := cfg.Recording.SplitMinutes; v > 0 {
		st.Recording.SplitMinutes = &v
	}
	if v := cfg.Recording.SnapshotSeconds; v > 0 {
		st.Recording.SnapshotSeconds = &v
	}
	st.S3.Configured = cfg.S3.AccessKey != "" && cfg.S3.SecretKey != ""
	if b := strings.TrimSpace(cfg.S3.Bucket); b != "" {
		st.S3.Bucket = &b
	}
	return st
}

func (s *Service) liveHints(ctx context.Context, app string) liveHints {
	h := liveHints{byType: map[string]int{}, rooms: []string{}, tags: []string{}}
	adb, err := s.d.Store.App(ctx, app)
	if err != nil {
		return h
	}
	rows, err := adb.QueryContext(ctx, "SELECT type, room, tags FROM streams WHERE status = 'active'")
	if err != nil {
		s.d.Log.Debug(fmt.Sprintf("live hints unavailable for %q: %s", app, err))
		return h
	}
	defer rows.Close()
	seenRoom, seenTag := map[string]bool{}, map[string]bool{}
	for rows.Next() {
		var typ string
		var room, tags sql.NullString
		if err := rows.Scan(&typ, &room, &tags); err != nil {
			return liveHints{byType: map[string]int{}, rooms: []string{}, tags: []string{}}
		}
		h.total++
		h.byType[typ]++
		if room.String != "" && !seenRoom[room.String] {
			seenRoom[room.String] = true
			h.rooms = append(h.rooms, room.String)
		}
		if tags.String != "" {
			var arr []any
			if json.Unmarshal([]byte(tags.String), &arr) == nil {
				for _, e := range arr {
					if t, ok := e.(string); ok && t != "" && !seenTag[t] {
						seenTag[t] = true
						h.tags = append(h.tags, t)
					}
				}
			}
		}
	}
	return h
}

func (s *Service) hlsActive(app string, rooms []string) bool {
	base := filepath.Join(s.d.Apps.AppDir(app), "hls")
	for _, r := range rooms {
		if _, err := os.Stat(filepath.Join(base, Slug(r), "index.m3u8")); err == nil {
			return true
		}
	}
	return false
}

// Slug is HlsService.safe: every UTF-16 unit outside [a-zA-Z0-9_-] → "_".
func Slug(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		case r > 0xFFFF:
			b.WriteString("__")
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

func (s *Service) installedPlugins(ctx context.Context, app string) []PipelinePlugin {
	out := []PipelinePlugin{}
	repo := call(s.d.Plugins)
	if repo == nil {
		return out
	}
	list, err := repo.List(ctx, app)
	if err != nil {
		s.d.Log.Debug(fmt.Sprintf("plugin list unavailable for %q: %s", app, err))
		return out
	}
	reg := call(s.d.Registry)
	for _, p := range list {
		kind, cat := "plugin", "tool"
		if reg != nil {
			if m := reg.GetMeta(p.PluginID); m != nil {
				if m.Kind != nil {
					kind = *m.Kind
				}
				if m.Category != "" {
					cat = m.Category
				}
			}
		}
		out = append(out, PipelinePlugin{p.PluginID, p.Enabled, kind, cat})
	}
	return out
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

// Module is PipelineController.
type Module struct{ Svc *Service }

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	type appIn struct {
		App string `path:"app"`
	}
	huma.Register(a, *authz.Require(api.Bearer(&huma.Operation{
		OperationID: "PipelineController_get", Method: http.MethodGet, Path: api.Prefix + "/apps/{app}/pipeline",
		Summary: "Resolved media-pipeline topology: ingest → processing → delivery → storage, derived from the app's config.yaml plus live hints (active streams / on-disk HLS).",
		Tags:    []string{"apps"},
	}), "app", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[*AppPipeline]], error) {
			p, err := m.Svc.Get(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(p), nil
		})
}
