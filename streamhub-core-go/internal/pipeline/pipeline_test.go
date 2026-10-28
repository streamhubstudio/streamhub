package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/netmetrics"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/notifications"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/system"
)

// ---- fakes ---------------------------------------------------------------

type fakeApps struct {
	contracts.AppsService
	dir string
	cfg map[string]*contracts.AppConfig
}

func (f *fakeApps) GetConfig(_ context.Context, name string) (*contracts.AppConfig, error) {
	c, ok := f.cfg[name]
	if !ok {
		return nil, httpx.NotFound("app '" + name + "' not found")
	}
	return c, nil
}
func (f *fakeApps) AppDir(name string) string { return filepath.Join(f.dir, "apps", name) }

type fakeHw struct {
	mode     string
	decision system.HwaccelDecision
}

func (f *fakeHw) Resolve(context.Context, string) system.HwaccelDecision { return f.decision }
func (f *fakeHw) GetMode(string) system.HwaccelMode                      { return f.mode }

type fakeNotifier struct {
	ch   notifications.ChannelsEnabled
	apps []string
}

func (f *fakeNotifier) ChannelsFor(app string) notifications.ChannelsEnabled {
	f.apps = append(f.apps, app)
	return f.ch
}

type fakeNet struct {
	buckets []netmetrics.HistoryBucket
	hours   float64
}

func (f *fakeNet) History(_ context.Context, _ string, hours float64, _ time.Time) []netmetrics.HistoryBucket {
	f.hours = hours
	return f.buckets
}

type fakePT struct {
	on   bool
	list []livekit.PassthroughInfo
	err  error
}

func (f *fakePT) Enabled() bool { return f.on }
func (f *fakePT) List(context.Context, string) ([]livekit.PassthroughInfo, error) {
	return f.list, f.err
}

type fakeRepo struct{ list []*plugins.Installed }

func (f *fakeRepo) List(context.Context, string) ([]*plugins.Installed, error) { return f.list, nil }

type fakeRegistry struct{}

func (fakeRegistry) GetMeta(id string) *plugins.Meta {
	k := "plugin"
	return &plugins.Meta{ID: id, Kind: &k, Category: "processor"}
}

type fakeVision struct {
	v   VisionView
	err error
}

func (f *fakeVision) PipelineVision(string) (VisionView, error) { return f.v, f.err }

// ---- harness -------------------------------------------------------------

type harness struct {
	t      *testing.T
	svc    *Service
	cfg    *config.Config
	apps   *fakeApps
	hw     *fakeHw
	notif  *fakeNotifier
	net    *fakeNet
	pt     *fakePT
	repo   *fakeRepo
	vision *fakeVision
	ctx    context.Context
}

// scaffold is the default config of a freshly created app.
func scaffold(name string) *contracts.AppConfig {
	return &contracts.AppConfig{
		Name: name, RoomPrefix: name,
		Rtmp:        contracts.RtmpConfig{Enabled: true},
		Webrtc:      contracts.WebrtcConfig{Adaptive: true, Layers: []contracts.WebrtcLayer{{Name: "high", Height: 720}, {Name: "med", Height: 480}, {Name: "low", Height: 240}}},
		Transcoding: contracts.TranscodingConfig{Enabled: true},
		Recording:   contracts.RecordingConfig{Enabled: true},
	}
}

func build(t *testing.T, mut func(*config.Config)) *harness {
	store, _, dir := testutil.Store(t)
	cfg := &config.Config{DataDir: dir, MediamtxRtmpPort: 1935, RtmpsPort: 1936}
	if mut != nil {
		mut(cfg)
	}
	h := &harness{
		t: t, cfg: cfg, ctx: context.Background(),
		apps:   &fakeApps{dir: dir, cfg: map[string]*contracts.AppConfig{}},
		hw:     &fakeHw{mode: "auto", decision: system.HwaccelDecision{Requested: "auto", Effective: "cpu", Type: "none"}},
		notif:  &fakeNotifier{},
		net:    &fakeNet{},
		pt:     &fakePT{},
		repo:   &fakeRepo{},
		vision: &fakeVision{v: VisionView{EnabledModels: []string{}}},
	}
	h.svc = New(Deps{
		Config: cfg, Store: store, Apps: h.apps, HwAccel: h.hw, Notifier: h.notif, NetMetrics: h.net,
		Passthrough: func() Passthrough { return h.pt },
		Plugins:     func() PluginsRepo { return h.repo },
		Registry:    func() PluginsRegistry { return fakeRegistry{} },
		Vision:      func() Vision { return h.vision },
		Log:         testutil.Log(),
	})
	return h
}

func (h *harness) app(name string, mut func(*contracts.AppConfig)) {
	c := scaffold(name)
	if mut != nil {
		mut(c)
	}
	h.apps.cfg[name] = c
}

func (h *harness) get(name string) *AppPipeline {
	h.t.Helper()
	p, err := h.svc.Get(h.ctx, name)
	if err != nil {
		h.t.Fatal(err)
	}
	return p
}

var seq int

func (h *harness) stream(app, typ, room, status string) {
	h.t.Helper()
	adb, err := h.svc.d.Store.App(h.ctx, app)
	if err != nil {
		h.t.Fatal(err)
	}
	seq++
	testutil.Exec(h.t, adb, `INSERT INTO streams (app_id, stream_id, type, room, participant, status) VALUES (1, ?, ?, ?, 'pub', ?)`,
		room+"/"+typ+"-"+string(rune('a'+seq%26))+time.Now().Format("150405.000000000"), typ, room, status)
}

func (h *harness) playlist(app, room string) {
	dir := filepath.Join(h.apps.AppDir(app), "hls", room)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.m3u8"), []byte("#EXTM3U"), 0o644); err != nil {
		h.t.Fatal(err)
	}
}

func node(list []PipelineEndpoint, typ string) PipelineEndpoint {
	for _, e := range list {
		if e.Type == typ {
			return e
		}
	}
	return PipelineEndpoint{}
}

func types(list []PipelineEndpoint) []string {
	out := []string{}
	for _, e := range list {
		out = append(out, e.Type)
	}
	return out
}

func jsonOf(t *testing.T, v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// ---- passthrough app (minimal pipeline) ------------------------------------

func TestMinimalStableShape(t *testing.T) {
	h := build(t, nil)
	h.app("pass", func(c *contracts.AppConfig) {
		c.Transcoding.Enabled = false
		c.Recording.Enabled = false
	})
	p := h.get("pass")

	if got := types(p.Ingest); !reflect.DeepEqual(got, []string{"rtmp", "rtmps", "whip", "webrtc", "rtsp", "ws-mjpeg", "srt", "mpegts"}) {
		t.Fatalf("ingest order %v", got)
	}
	if got := types(p.Delivery); !reflect.DeepEqual(got, []string{"webrtc", "hls", "cdn", "restream"}) {
		t.Fatalf("delivery order %v", got)
	}
	for _, i := range p.Ingest {
		if i.Active || i.Label == "" {
			t.Fatalf("idle ingest %+v", i)
		}
	}
	if !node(p.Ingest, "rtmp").Enabled || node(p.Ingest, "rtmps").Enabled || !node(p.Ingest, "ws-mjpeg").Enabled {
		t.Fatal("enabled flags")
	}
	want := map[string]string{
		"processing.transcoding": `{"enabled":false,"encoder":"cpu","hwaccel":"auto"}`,
		"processing.adaptive":    `{"enabled":true,"layers":[{"name":"high","height":720},{"name":"med","height":480},{"name":"low","height":240}]}`,
		"processing.passthrough": `{"enabled":false,"transports":[]}`,
		"storage":                `{"recording":{"enabled":false},"s3":{"configured":false}}`,
		"plugins":                `[]`,
		"live":                   `{"activeStreams":0,"tags":[]}`,
		"ingestFront":            `{"mediamtx":false,"port":1935}`,
		"compute":                `{"edge":{"total":0,"online":0},"vision":{"enabled":false,"models":[],"assignments":{"running":0,"pending":0}}}`,
		"events":                 `{"callbacks":{"configured":false},"mqtt":{"enabled":false},"log":{"enabled":true}}`,
		"notifications":          `{"email":false,"discord":false,"telegram":false}`,
		"net":                    `{"inBytes":0,"outBytes":0,"windowSec":3600}`,
		"delivery.cdn":           `{"type":"cdn","enabled":false,"active":false,"label":"CDN / public URL"}`,
		"delivery.restream":      `{"type":"restream","enabled":false,"active":false,"label":"Restream"}`,
	}
	got := map[string]any{
		"processing.transcoding": p.Processing.Transcoding, "processing.adaptive": p.Processing.Adaptive,
		"processing.passthrough": p.Processing.Passthrough, "storage": p.Storage, "plugins": p.Plugins,
		"live": p.Live, "ingestFront": p.IngestFront, "compute": p.Compute, "events": p.Events,
		"notifications": p.Notifications, "net": p.Net,
		"delivery.cdn": node(p.Delivery, "cdn"), "delivery.restream": node(p.Delivery, "restream"),
	}
	for k, w := range want {
		if g := jsonOf(t, got[k]); g != w {
			t.Errorf("%s:\n got %s\nwant %s", k, g, w)
		}
	}
	if !node(p.Delivery, "webrtc").Enabled || node(p.Delivery, "webrtc").Active || node(p.Delivery, "hls").Active {
		t.Error("delivery idle flags")
	}
	// Top-level key order is the Node object literal order.
	full := jsonOf(t, p)
	order := []string{`"ingest"`, `"ingestFront"`, `"processing"`, `"compute"`, `"delivery"`, `"storage"`, `"plugins"`, `"live"`, `"events"`, `"notifications"`, `"net"`}
	last := -1
	for _, k := range order {
		i := strings.Index(full, k+":")
		if i <= last {
			t.Fatalf("key order broken at %s", k)
		}
		last = i
	}
	if strings.Contains(full, "viewers") {
		t.Fatal("live.viewers must be omitted")
	}
}

func TestNeverLeaksCredentials(t *testing.T) {
	h := build(t, nil)
	h.app("pass", func(c *contracts.AppConfig) {
		c.S3 = contracts.S3Config{Bucket: "vods-pass", AccessKey: "AKIA-SUPER-SECRET-KEY", SecretKey: "wJal-SUPER-SECRET-VALUE"}
		c.Callbacks = contracts.CallbacksConfig{URL: "https://example.com/hook", Secret: "s3cr3t"}
	})
	flat := jsonOf(t, h.get("pass"))
	if strings.Contains(flat, "SUPER-SECRET") || strings.Contains(flat, "s3cr3t") || strings.Contains(flat, "example.com/hook") {
		t.Fatalf("leak: %s", flat)
	}
	if !strings.Contains(flat, "vods-pass") {
		t.Fatal("bucket name expected")
	}
}

// ---- fully-configured app ----------------------------------------------------

func fullHarness(t *testing.T) *harness {
	h := build(t, func(c *config.Config) { c.RtmpsEnable = true; c.RtmpPublicHost = "stream.example.com" })
	h.app("full", func(c *contracts.AppConfig) {
		c.Transcoding.Enabled = true
		c.Webrtc = contracts.WebrtcConfig{Adaptive: true, Layers: []contracts.WebrtcLayer{{Name: "high", Height: 1080}, {Name: "low", Height: 360}}}
		c.Recording = contracts.RecordingConfig{Enabled: true, SplitMinutes: 30, SnapshotSeconds: 60}
		c.S3 = contracts.S3Config{Bucket: "full-vods", AccessKey: "AK123456", SecretKey: "SK123456", PublicURL: "https://cdn.example.com"}
	})
	h.repo.list = []*plugins.Installed{{PluginID: "yolo", Enabled: true}, {PluginID: "deface", Enabled: false}}
	h.hw.mode = "gpu"
	h.hw.decision = system.HwaccelDecision{Requested: "gpu", Effective: "gpu", Type: "nvidia"}
	return h
}

func TestFullyConfigured(t *testing.T) {
	h := fullHarness(t)
	p := h.get("full")
	checks := map[string][2]string{
		"transcoding": {jsonOf(t, p.Processing.Transcoding), `{"enabled":true,"encoder":"gpu","hwaccel":"gpu"}`},
		"adaptive":    {jsonOf(t, p.Processing.Adaptive), `{"enabled":true,"layers":[{"name":"high","height":1080},{"name":"low","height":360}]}`},
		"recording":   {jsonOf(t, p.Storage.Recording), `{"enabled":true,"splitMinutes":30,"snapshotSeconds":60}`},
		"s3":          {jsonOf(t, p.Storage.S3), `{"configured":true,"bucket":"full-vods"}`},
		"cdn":         {jsonOf(t, node(p.Delivery, "cdn")), `{"type":"cdn","enabled":true,"active":false,"label":"CDN / public URL","detail":"https://cdn.example.com"}`},
		"plugins":     {jsonOf(t, p.Plugins), `[{"id":"yolo","enabled":true,"kind":"plugin","category":"processor"},{"id":"deface","enabled":false,"kind":"plugin","category":"processor"}]`},
	}
	for k, c := range checks {
		if c[0] != c[1] {
			t.Errorf("%s:\n got %s\nwant %s", k, c[0], c[1])
		}
	}
	rtmps := node(p.Ingest, "rtmps")
	if !rtmps.Enabled || rtmps.Active || !strings.Contains(*rtmps.Detail, "rtmps://stream.example.com:1936") {
		t.Errorf("rtmps %+v", rtmps)
	}
	if *node(p.Ingest, "rtmp").Detail != "rtmp://stream.example.com:1935" {
		t.Error("rtmp detail")
	}

	// hwaccel=gpu but no GPU detected ⇒ cpu.
	h.hw.decision = system.HwaccelDecision{Requested: "gpu", Effective: "cpu", Type: "none"}
	if g := jsonOf(t, h.get("full").Processing.Transcoding); g != `{"enabled":true,"encoder":"cpu","hwaccel":"gpu"}` {
		t.Errorf("cpu fallback %s", g)
	}
}

// ---- live hints ----------------------------------------------------------------

func TestLiveHints(t *testing.T) {
	h := build(t, nil)
	h.app("live1", nil)
	h.stream("live1", "webrtc", "roomA", "active")
	h.stream("live1", "rtmp", "roomB", "active")
	h.stream("live1", "rtsp", "roomC", "active")
	h.stream("live1", "ws-mjpeg", "roomD", "active")
	h.stream("live1", "rtmp", "roomE", "ended")
	p := h.get("live1")
	active := map[string]bool{}
	for _, i := range p.Ingest {
		active[i.Type] = i.Active
	}
	want := map[string]bool{"rtmp": true, "rtmps": false, "whip": false, "webrtc": true, "rtsp": true, "ws-mjpeg": true, "srt": false, "mpegts": false}
	if !reflect.DeepEqual(active, want) {
		t.Fatalf("active %v", active)
	}
	if p.Live.ActiveStreams != 4 || !node(p.Delivery, "webrtc").Active {
		t.Fatalf("live %+v", p.Live)
	}
}

func TestTagsHint(t *testing.T) {
	h := build(t, nil)
	h.app("live1", nil)
	adb, _ := h.svc.d.Store.App(h.ctx, "live1")
	for i, tags := range []any{`["b","a"]`, `["a","c",1,""]`, `not json`, `[]`} {
		testutil.Exec(t, adb, `INSERT INTO streams (app_id, stream_id, type, room, participant, status, tags) VALUES (1, ?, 'rtmp', 'r', 'p', 'active', ?)`, "s"+string(rune('0'+i)), tags)
	}
	if g := jsonOf(t, h.get("live1").Live); g != `{"activeStreams":4,"tags":["b","a","c"]}` {
		t.Fatalf("tags %s", g)
	}
}

func TestRtmpsMirrorsRtmp(t *testing.T) {
	h := build(t, func(c *config.Config) { c.RtmpsEnable = true })
	h.app("live1", nil)
	h.stream("live1", "rtmp", "roomA", "active")
	r := node(h.get("live1").Ingest, "rtmps")
	if !r.Enabled || !r.Active || *r.Detail != "rtmps://<host>:1936 (TLS front → RTMP :1935)" {
		t.Fatalf("rtmps %+v", r)
	}
}

func TestHlsActiveOnlyForLiveRoomPlaylist(t *testing.T) {
	h := build(t, nil)
	h.app("live1", nil)
	h.stream("live1", "webrtc", "live-room", "active")
	h.playlist("live1", "dead-room")
	if node(h.get("live1").Delivery, "hls").Active {
		t.Fatal("stale playlist must not count")
	}
	h.playlist("live1", "live-room")
	if !node(h.get("live1").Delivery, "hls").Active {
		t.Fatal("live playlist must count")
	}
}

func TestHlsCdn(t *testing.T) {
	for _, v := range []string{"true", "1", "ON", " yes "} {
		t.Setenv("STREAMHUB_HLS_CDN", v)
		h := build(t, nil)
		h.app("live1", nil)
		c := node(h.get("live1").Delivery, "cdn")
		if !c.Enabled || c.Active || *c.Detail != "CDN-cacheable live HLS (STREAMHUB_HLS_CDN on)" {
			t.Fatalf("%q: %+v", v, c)
		}
		h.stream("live1", "rtmp", "show", "active")
		h.playlist("live1", "show")
		if c := node(h.get("live1").Delivery, "cdn"); !c.Enabled || !c.Active {
			t.Fatalf("%q live: %+v", v, c)
		}
	}
	t.Setenv("STREAMHUB_HLS_CDN", "false")
	h := build(t, nil)
	h.app("x", func(c *contracts.AppConfig) { c.S3.PublicURL = " https://cdn " })
	t.Setenv("STREAMHUB_HLS_CDN", "on")
	if d := *node(h.get("x").Delivery, "cdn").Detail; d != "https://cdn + CDN-cacheable live HLS (STREAMHUB_HLS_CDN on)" {
		t.Fatalf("both knobs: %s", d)
	}
}

func TestWsIngestDisabled(t *testing.T) {
	h := build(t, nil)
	h.app("live1", func(c *contracts.AppConfig) {
		c.Features.WsIngest = &contracts.WsIngestFeatures{Enabled: false, MaxFps: 15}
	})
	if node(h.get("live1").Ingest, "ws-mjpeg").Enabled {
		t.Fatal("ws-mjpeg must be disabled")
	}
}

// ---- new sections ------------------------------------------------------------------

func TestNewSections(t *testing.T) {
	t.Run("mediamtx front", func(t *testing.T) {
		h := build(t, func(c *config.Config) { c.MediamtxEnable = true })
		h.app("xapp", nil)
		if g := jsonOf(t, h.get("xapp").IngestFront); g != `{"mediamtx":true,"port":1935}` {
			t.Fatal(g)
		}
	})

	pt := []struct {
		name string
		list []livekit.PassthroughInfo
		err  error
		want string
	}{
		{"srt + rtmp, sorted", []livekit.PassthroughInfo{{InputType: "srt"}, {InputType: "rtmp"}, {InputType: "srt"}}, nil, `{"enabled":true,"transports":["rtmp","srt"]}`},
		{"mpegts surfaced", []livekit.PassthroughInfo{{InputType: "mpegts"}, {InputType: "rtmp"}}, nil, `{"enabled":true,"transports":["mpegts","rtmp"]}`},
		{"none ⇒ full capability set", nil, nil, `{"enabled":true,"transports":["mpegts","rtmp","srt"]}`},
		{"list error ⇒ capability set", nil, errors.New("boom"), `{"enabled":true,"transports":["mpegts","rtmp","srt"]}`},
	}
	for _, c := range pt {
		t.Run(c.name, func(t *testing.T) {
			h := build(t, nil)
			h.app("xapp", nil)
			h.pt.on, h.pt.list, h.pt.err = true, c.list, c.err
			p := h.get("xapp")
			if g := jsonOf(t, p.Processing.Passthrough); g != c.want {
				t.Fatal(g)
			}
			for _, typ := range []string{"srt", "mpegts"} {
				if n := node(p.Ingest, typ); !n.Enabled {
					t.Fatalf("%s node off", typ)
				}
			}
			if *node(p.Ingest, "srt").Detail != "SRT passthrough (remux, -c copy)" {
				t.Fatal("srt detail")
			}
		})
	}

	t.Run("vision aggregate", func(t *testing.T) {
		h := build(t, nil)
		h.app("xapp", nil)
		h.vision.v = VisionView{EnabledModels: []string{"occupancy", "counting"}, Running: 2, Pending: 1, EdgeTotal: 4, EdgeOnline: 3}
		if g := jsonOf(t, h.get("xapp").Compute); g != `{"edge":{"total":4,"online":3},"vision":{"enabled":true,"models":["occupancy","counting"],"assignments":{"running":2,"pending":1}}}` {
			t.Fatal(g)
		}
	})

	t.Run("vision throws ⇒ idle compute", func(t *testing.T) {
		h := build(t, nil)
		h.app("xapp", nil)
		h.vision.err = errors.New("vision not installed")
		if g := jsonOf(t, h.get("xapp").Compute); g != `{"edge":{"total":0,"online":0},"vision":{"enabled":false,"models":[],"assignments":{"running":0,"pending":0}}}` {
			t.Fatal(g)
		}
	})

	t.Run("events from config", func(t *testing.T) {
		h := build(t, nil)
		h.app("xapp", func(c *contracts.AppConfig) {
			c.Callbacks = contracts.CallbacksConfig{URL: "https://example.com/hook", Secret: "s3cr3t"}
			c.Mqtt.Enabled = true
		})
		p := h.get("xapp")
		if g := jsonOf(t, p.Events); g != `{"callbacks":{"configured":true},"mqtt":{"enabled":true},"log":{"enabled":true}}` {
			t.Fatal(g)
		}
		if strings.Contains(jsonOf(t, p), "s3cr3t") {
			t.Fatal("secret leaked")
		}
	})

	t.Run("notification channels", func(t *testing.T) {
		h := build(t, nil)
		h.app("xapp", nil)
		h.notif.ch = notifications.ChannelsEnabled{Email: true, Telegram: true}
		if g := jsonOf(t, h.get("xapp").Notifications); g != `{"email":true,"discord":false,"telegram":true}` || h.notif.apps[0] != "xapp" {
			t.Fatal(g)
		}
	})

	t.Run("net sums last hour", func(t *testing.T) {
		h := build(t, nil)
		h.app("xapp", nil)
		h.net.buckets = []netmetrics.HistoryBucket{{Bucket: "a", In: 100, Out: 40}, {Bucket: "b", In: 5, Out: 3}}
		if g := jsonOf(t, h.get("xapp").Net); g != `{"inBytes":105,"outBytes":43,"windowSec":3600}` || h.net.hours != 1 {
			t.Fatal(g)
		}
	})

	t.Run("restream targets", func(t *testing.T) {
		h := build(t, nil)
		h.app("xapp", nil)
		adb, _ := h.svc.d.Store.App(h.ctx, "xapp")
		for _, s := range [][2]string{{"active", "r1"}, {"starting", "r2"}, {"stopped", "r3"}} {
			testutil.Exec(t, adb, `INSERT INTO restream_targets (app, room, stream_id, name, platform, url, url_masked, egress_id, status)
               VALUES ('xapp', ?, NULL, NULL, 'youtube', 'rtmp://x/key', 'rtmp://x/***', ?, ?)`, s[1], "eg-"+s[1], s[0])
		}
		if g := jsonOf(t, node(h.get("xapp").Delivery, "restream")); g != `{"type":"restream","enabled":true,"active":true,"label":"Restream","detail":"2 targets"}` {
			t.Fatal(g)
		}
		testutil.Exec(t, adb, `UPDATE restream_targets SET status = 'failed' WHERE room = 'r2'`)
		testutil.Exec(t, adb, `UPDATE restream_targets SET status = 'stopped' WHERE room = 'r1'`)
		if g := jsonOf(t, node(h.get("xapp").Delivery, "restream")); g != `{"type":"restream","enabled":true,"active":false,"label":"Restream","detail":"1 target"}` {
			t.Fatal(g)
		}
	})
}

func TestVisionFallback(t *testing.T) {
	h := build(t, nil)
	h.app("xapp", nil)
	h.svc.d.Vision = nil
	h.repo.list = []*plugins.Installed{{PluginID: "crowd", Enabled: true}, {PluginID: "occupancy", Enabled: true}, {PluginID: "counting", Enabled: false}, {PluginID: "yolo", Enabled: true}}
	g, _ := h.svc.d.Store.Global(h.ctx)
	testutil.Exec(t, g, `INSERT INTO nodes (id, name) VALUES ('n1', 'n1')`)
	if got := jsonOf(t, h.get("xapp").Compute); got != `{"edge":{"total":1,"online":0},"vision":{"enabled":true,"models":["occupancy","crowd"],"assignments":{"running":0,"pending":0}}}` {
		t.Fatal(got)
	}
}

func TestUnknownApp404(t *testing.T) {
	h := build(t, nil)
	_, err := h.svc.Get(h.ctx, "nope")
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != 404 {
		t.Fatalf("want 404, got %v", err)
	}
}

func TestSlug(t *testing.T) {
	for in, want := range map[string]string{"live-room": "live-room", "a b/c.d": "a_b_c_d", "é": "_", "x😀": "x__"} {
		if got := Slug(in); got != want {
			t.Errorf("%q → %q", in, got)
		}
	}
}
