package recording

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// vod-transcode.service.spec — the pipeline over a real per-app DB, a
// recording ffmpeg Runner that materializes realistic outputs, and fake
// apps / S3 / logs / callbacks.

const tcApp = "live"

type tcAppsFake struct {
	cfg  *contracts.AppConfig
	root string
}

func (a *tcAppsFake) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	return []contracts.AppRecord{{Name: tcApp}}, nil
}
func (a *tcAppsFake) Get(context.Context, string) (*contracts.AppRecord, error) { return nil, nil }
func (a *tcAppsFake) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (a *tcAppsFake) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (a *tcAppsFake) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	return a.cfg, nil
}
func (a *tcAppsFake) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (a *tcAppsFake) AppDir(name string) string { return filepath.Join(a.root, name) }

type tcUpload struct {
	Key, ContentType, Content string
}

type tcS3Fake struct {
	mu      sync.Mutex
	uploads []tcUpload
}

func (s *tcS3Fake) Upload(_ context.Context, _ contracts.S3Config, local, key, ct string) (*contracts.S3UploadResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := tcUpload{Key: key, ContentType: ct}
	if strings.HasSuffix(key, ".m3u8") {
		b, _ := os.ReadFile(local)
		u.Content = string(b)
	}
	s.uploads = append(s.uploads, u)
	return &contracts.S3UploadResult{Key: key, Bucket: "test-bucket", URL: "https://s3.test/test-bucket/" + key, SizeBytes: 10}, nil
}
func (s *tcS3Fake) PresignGet(context.Context, contracts.S3Config, string, float64, *contracts.S3PresignOptions) (string, error) {
	return "", nil
}
func (s *tcS3Fake) Delete(context.Context, contracts.S3Config, string) error { return nil }
func (s *tcS3Fake) Exists(context.Context, contracts.S3Config, string) (bool, error) {
	return true, nil
}

func (s *tcS3Fake) keys() []string {
	var k []string
	for _, u := range s.uploads {
		k = append(k, u.Key)
	}
	return k
}

func (s *tcS3Fake) find(key string) *tcUpload {
	for i := range s.uploads {
		if s.uploads[i].Key == key {
			return &s.uploads[i]
		}
	}
	return nil
}

type tcLogsFake struct {
	mu   sync.Mutex
	msgs []string
}

func (l *tcLogsFake) Write(level, _ string, msg string, meta any, _ *int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, _ := json.Marshal(meta)
	l.msgs = append(l.msgs, level+"|"+msg+"|"+string(b))
}

func (l *tcLogsFake) has(msg string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, m := range l.msgs {
		if strings.Contains(m, "|"+msg+"|") {
			return true
		}
	}
	return false
}

type tcCallback struct {
	App, Event string
	Body       string
}

type tcCallbacksFake struct {
	mu     sync.Mutex
	events []tcCallback
}

func (c *tcCallbacksFake) Dispatch(_ context.Context, app, event string, payload any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, _ := json.Marshal(payload)
	c.events = append(c.events, tcCallback{app, event, string(b)})
	return nil
}

// tcRunner records every call and materializes the expected outputs.
type tcRunner struct {
	mu    sync.Mutex
	calls [][]string
	// failHeight fails the ffmpeg HLS / mezzanine step of that height.
	failHeight string
	failAll    bool
	failWebm   bool
	// pkg materializes shaka output (nil = packager fails).
	pkg func(outDir string)
}

func (r *tcRunner) Run(_ context.Context, bin string, args []string, _ time.Duration) ([]byte, error) {
	r.mu.Lock()
	r.calls = append(r.calls, append([]string{bin}, args...))
	r.mu.Unlock()
	joined := strings.Join(args, " ")
	last := args[len(args)-1]
	switch {
	case bin == "ffprobe":
		return []byte(`{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"duration":"60.0"}],"format":{"duration":"60.0"}}`), nil
	case bin == "ffmpeg" && strings.Contains(joined, "-hls_segment_filename"):
		if r.failAll || (r.failHeight != "" && strings.Contains(joined, "scale=-2:"+r.failHeight+" ")) {
			return nil, os.ErrInvalid
		}
		dir := filepath.Dir(last)
		_ = os.WriteFile(last, []byte("#EXTM3U\n#EXTINF:4,\nseg_0000.ts\n#EXTINF:4,\nseg_0001.ts\n#EXT-X-ENDLIST\n"), 0o644)
		_ = os.WriteFile(filepath.Join(dir, "seg_0000.ts"), []byte("ts-0"), 0o644)
		_ = os.WriteFile(filepath.Join(dir, "seg_0001.ts"), []byte("ts-1"), 0o644)
	case bin == "ffmpeg" && strings.Contains(joined, "libvpx"):
		if r.failAll || r.failWebm {
			return nil, os.ErrInvalid
		}
		_ = os.WriteFile(last, []byte("webm-bytes"), 0o644)
	case bin == "ffmpeg" && strings.Contains(joined, "+faststart"):
		_ = os.WriteFile(last, []byte("mezz-mp4"), 0o644)
	case strings.Contains(joined, "--hls_master_playlist_output"):
		if r.pkg == nil {
			return nil, os.ErrInvalid
		}
		for i, a := range args {
			if a == "--hls_master_playlist_output" {
				r.pkg(filepath.Dir(args[i+1]))
			}
		}
	}
	return nil, nil
}

func (r *tcRunner) count(substr string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, c := range r.calls {
		if strings.Contains(strings.Join(c, " "), substr) {
			n++
		}
	}
	return n
}

type tcHarness struct {
	t    *testing.T
	svc  *VodTranscode
	apps *tcAppsFake
	s3   *tcS3Fake
	logs *tcLogsFake
	cb   *tcCallbacksFake
	run  *tcRunner
	vods *Vods
	vars *Variants
}

func tcConfig(mod func(*contracts.AppConfig)) *contracts.AppConfig {
	c := &contracts.AppConfig{Name: tcApp, RoomPrefix: tcApp}
	c.S3.Bucket = "test-bucket"
	c.Transcoding.Encoding = "h264"
	c.Features.PublicPlayback = true
	if mod != nil {
		mod(c)
	}
	return c
}

func newTcHarness(t *testing.T) *tcHarness {
	store, _, dir := testutil.Store(t)
	h := &tcHarness{t: t, apps: &tcAppsFake{cfg: tcConfig(nil), root: filepath.Join(dir, "apps-work")},
		s3: &tcS3Fake{}, logs: &tcLogsFake{}, cb: &tcCallbacksFake{}, run: &tcRunner{},
		vods: NewVods(store.App), vars: NewVariants(store.App)}
	h.svc = NewVodTranscode(TranscodeDeps{Apps: h.apps, S3: h.s3, Vods: h.vods, Variants: h.vars, Logs: h.logs,
		Callbacks: h.cb, Runner: h.run, Log: testutil.Log()})
	return h
}

func (h *tcHarness) seed(name string) (int64, string) {
	h.t.Helper()
	dir := filepath.Join(h.apps.root, tcApp, "recordings")
	_ = os.MkdirAll(dir, 0o755)
	src := filepath.Join(dir, name+".mp4")
	_ = os.WriteFile(src, []byte("mp4-data"), 0o644)
	sid, room, nm, meta, now := "stream-1", "room-1", name+".mp4", `{"egressId":"EG_test"}`, time.Now().UTC().Format(time.RFC3339)
	id, err := h.vods.Insert(context.Background(), tcApp, VodInsert{AppID: 1, StreamID: &sid, Room: &room, Name: nm,
		Status: "ready", LocalPath: &src, StartedAt: &now, MetatagsJSON: &meta})
	if err != nil {
		h.t.Fatal(err)
	}
	return id, src
}

func (h *tcHarness) process(id int64, src string, del bool) {
	h.svc.Enqueue(context.Background(), TranscodeJob{AppName: tcApp, VodID: id, SourcePath: src, DeleteSourceAfter: del})
}

func (h *tcHarness) variants(id int64) []VariantRecord {
	l, err := h.vars.ListByVod(context.Background(), tcApp, id)
	if err != nil {
		h.t.Fatal(err)
	}
	return l
}

func (h *tcHarness) meta(id int64) map[string]any {
	v, _ := h.vods.FindByID(context.Background(), tcApp, id)
	var m map[string]any
	_ = json.Unmarshal([]byte(*v.MetatagsJSON), &m)
	return m
}

func (h *tcHarness) dispatched(event string) []tcCallback {
	h.cb.mu.Lock()
	defer h.cb.mu.Unlock()
	var out []tcCallback
	for _, e := range h.cb.events {
		if e.Event == event {
			out = append(out, e)
		}
	}
	return out
}

func shape(vs []VariantRecord) string {
	var parts []string
	for _, v := range vs {
		h := "null"
		if v.Height != nil {
			h = xcNum(*v.Height)
		}
		parts = append(parts, v.Kind+"/"+v.Format+"/"+h)
	}
	return strings.Join(parts, ",")
}

func TestTranscodePlan(t *testing.T) {
	h := newTcHarness(t)
	if p := h.svc.PlanFor(tcConfig(nil)); len(p.Renditions) != 0 || p.Webm || h.svc.Needed(tcConfig(nil)) {
		t.Fatal("default config must need nothing")
	}
	off := tcConfig(func(c *contracts.AppConfig) {
		c.Transcoding = contracts.TranscodingConfig{Enabled: false, Encoding: "h264+vp8", VodAdaptive: true,
			VodRenditions: []contracts.VodRendition{{Height: 720, BitrateKbps: 2800}}}
	})
	if h.svc.Needed(off) {
		t.Fatal("master switch off must gate everything")
	}
	webm := tcConfig(func(c *contracts.AppConfig) { c.Transcoding.Enabled, c.Transcoding.Encoding = true, "h264+vp8" })
	if p := h.svc.PlanFor(webm); len(p.Renditions) != 0 || !p.Webm || !h.svc.Needed(webm) {
		t.Fatal("h264+vp8 → webm only")
	}
	explicit := tcConfig(func(c *contracts.AppConfig) {
		c.Transcoding.Enabled, c.Transcoding.VodAdaptive = true, true
		c.Transcoding.VodRenditions = []contracts.VodRendition{{Height: 1080, BitrateKbps: 5000}, {Height: 480, BitrateKbps: 1400}}
	})
	if p := h.svc.PlanFor(explicit); len(p.Renditions) != 2 || p.Renditions[0].Height != 1080 || p.Renditions[1].BitrateKbps != 1400 {
		t.Fatal(p)
	}
	derived := tcConfig(func(c *contracts.AppConfig) {
		c.Transcoding.Enabled, c.Transcoding.VodAdaptive = true, true
		c.Webrtc.Layers = []contracts.WebrtcLayer{{Name: "high", Height: 720}, {Name: "med", Height: 480}, {Name: "low", Height: 240}}
	})
	want := []contracts.VodRendition{{Height: 720, BitrateKbps: 2800}, {Height: 480, BitrateKbps: 1400}, {Height: 240, BitrateKbps: 500}}
	if p := h.svc.PlanFor(derived); len(p.Renditions) != 3 || p.Renditions[0] != want[0] || p.Renditions[2] != want[2] {
		t.Fatal(p)
	}
}

func adaptiveCfg(c *contracts.AppConfig) {
	c.Transcoding.Enabled, c.Transcoding.VodAdaptive = true, true
	c.Transcoding.VodRenditions = []contracts.VodRendition{{Height: 720, BitrateKbps: 2800}, {Height: 480, BitrateKbps: 1400}}
}

func TestTranscodeAdaptiveLadder(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(adaptiveCfg)
	id, src := h.seed("rec-1")
	h.process(id, src, false)

	rows := h.variants(id)
	if shape(rows) != "master/hls/null,rendition/hls-h264/720,rendition/hls-h264/480" {
		t.Fatal(shape(rows))
	}
	keys := strings.Join(h.s3.keys(), " ")
	for _, k := range []string{"hls/rec-1/720p/index.m3u8", "hls/rec-1/720p/seg_0000.ts", "hls/rec-1/720p/seg_0001.ts",
		"hls/rec-1/480p/index.m3u8", "hls/rec-1/480p/seg_0000.ts", "hls/rec-1/master.m3u8"} {
		if !strings.Contains(keys, k) {
			t.Errorf("missing upload %s", k)
		}
	}
	m := h.s3.find("hls/rec-1/master.m3u8")
	// 1920x1080 source → 16:9 widths (1280 / 854)
	if m.ContentType != "application/vnd.apple.mpegurl" || !strings.Contains(m.Content, "#EXTM3U") ||
		!strings.Contains(m.Content, "BANDWIDTH=2928000,RESOLUTION=1280x720") ||
		!strings.Contains(m.Content, "BANDWIDTH=1528000,RESOLUTION=854x480") ||
		!strings.Contains(m.Content, "720p/index.m3u8") || !strings.Contains(m.Content, "480p/index.m3u8") {
		t.Fatal(m.Content)
	}
	if ct := h.s3.find("hls/rec-1/720p/seg_0000.ts").ContentType; ct != "video/mp2t" {
		t.Fatal(ct)
	}
	for _, r := range rows {
		if r.Height != nil && *r.Height == 720 {
			if *r.FileKey != "hls/rec-1/720p/index.m3u8" || *r.ExtraJSON != `{"segmentKeys":["hls/rec-1/720p/seg_0000.ts","hls/rec-1/720p/seg_0001.ts"]}` {
				t.Fatal(*r.FileKey, *r.ExtraJSON)
			}
		}
	}
	if mt := h.meta(id); mt["hlsMasterKey"] != "hls/rec-1/master.m3u8" || mt["variantCount"] != float64(3) || mt["egressId"] != "EG_test" {
		t.Fatal(mt)
	}
	ev := h.dispatched("vod_variants_ready")
	if len(ev) != 1 || !strings.HasPrefix(ev[0].Body, `{"vodId":`+xcNum(float64(id))+`,"app":"live","room":"room-1","streamId":"stream-1","masterKey":"hls/rec-1/master.m3u8","webmKey":null,"variants":[{"kind":"master","format":"hls","height":null,"bitrateKbps":null,"key":"hls/rec-1/master.m3u8","sizeBytes":10}`) {
		t.Fatal(ev)
	}
	if _, err := os.Stat(filepath.Join(h.apps.root, tcApp, "transcode", "rec-1")); !os.IsNotExist(err) {
		t.Fatal("workdir not cleaned")
	}
	// the master playlist width follows the probed source aspect
	if got := h.run.count("scale=-2:720 "); got != 1 {
		t.Fatal(got)
	}
}

func TestTranscodeSkipsFailedRendition(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(adaptiveCfg)
	h.run.failHeight = "480"
	id, src := h.seed("rec-1")
	h.process(id, src, false)
	if shape(h.variants(id)) != "master/hls/null,rendition/hls-h264/720" {
		t.Fatal(shape(h.variants(id)))
	}
	m := h.s3.find("hls/rec-1/master.m3u8").Content
	if !strings.Contains(m, "720p/index.m3u8") || strings.Contains(m, "480p/index.m3u8") || !h.logs.has("hls rendition failed") {
		t.Fatal(m)
	}
}

func TestTranscodeWebm(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(func(c *contracts.AppConfig) { c.Transcoding.Enabled, c.Transcoding.Encoding = true, "h264+vp8" })
	id, src := h.seed("rec-vp8")
	h.process(id, src, false)
	rows := h.variants(id)
	if shape(rows) != "alternate/webm-vp8/1080" || *rows[0].FileKey != "rec-vp8.webm" || *rows[0].BitrateKbps != 5000 {
		t.Fatal(shape(rows))
	}
	if u := h.s3.find("rec-vp8.webm"); u == nil || u.ContentType != "video/webm" {
		t.Fatal(h.s3.uploads)
	}
	for _, k := range h.s3.keys() {
		if strings.HasSuffix(k, ".m3u8") {
			t.Fatal("hls without vodAdaptive")
		}
	}
	if len(h.dispatched("vod_variants_ready")) != 1 || h.run.count("rec-vp8.webm") != 1 {
		t.Fatal(h.cb.events)
	}
	if mt := h.meta(id); mt["hlsMasterKey"] != nil {
		t.Fatal("hlsMasterKey must be absent without a ladder", mt)
	}

	// h264+vp8 AND vodAdaptive: ladder + master + webm (webm at the top rung)
	h2 := newTcHarness(t)
	h2.apps.cfg = tcConfig(func(c *contracts.AppConfig) {
		c.Transcoding = contracts.TranscodingConfig{Enabled: true, Encoding: "h264+vp8", VodAdaptive: true,
			VodRenditions: []contracts.VodRendition{{Height: 720, BitrateKbps: 2800}}}
	})
	id, src = h2.seed("rec-1")
	h2.process(id, src, false)
	if shape(h2.variants(id)) != "master/hls/null,rendition/hls-h264/720,alternate/webm-vp8/1080" || h2.run.count("-b:v 2800k -deadline") != 1 {
		t.Fatal(shape(h2.variants(id)))
	}
}

func TestTranscodeSourceLifecycle(t *testing.T) {
	for _, del := range []bool{true, false} {
		h := newTcHarness(t)
		h.apps.cfg = tcConfig(func(c *contracts.AppConfig) { c.Transcoding.Enabled, c.Transcoding.Encoding = true, "h264+vp8" })
		id, src := h.seed("rec-1")
		h.process(id, src, del)
		v, _ := h.vods.FindByID(context.Background(), tcApp, id)
		_, statErr := os.Stat(src)
		if del && (statErr == nil || v.LocalPath != nil) {
			t.Fatal("deleteSourceAfter=true must remove the source + null local_path")
		}
		if !del && (statErr != nil || v.LocalPath == nil || *v.LocalPath != src) {
			t.Fatal("deleteSourceAfter=false must keep the source")
		}
	}
}

func TestTranscodeDegradation(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(func(c *contracts.AppConfig) {
		c.Transcoding = contracts.TranscodingConfig{Enabled: true, Encoding: "h264+vp8", VodAdaptive: true,
			VodRenditions: []contracts.VodRendition{{Height: 720, BitrateKbps: 2800}}}
	})
	h.run.failAll = true
	id, src := h.seed("rec-1")
	h.process(id, src, false)
	v, _ := h.vods.FindByID(context.Background(), tcApp, id)
	if len(h.variants(id)) != 0 || len(h.dispatched("vod_variants_ready")) != 0 || v.Status != "ready" ||
		!h.logs.has("vod transcode produced no variants") {
		t.Fatal(h.logs.msgs)
	}

	// missing source → logged, nothing generated
	h = newTcHarness(t)
	h.apps.cfg = tcConfig(func(c *contracts.AppConfig) { c.Transcoding.Enabled, c.Transcoding.Encoding = true, "h264+vp8" })
	id, _ = h.seed("rec-1")
	h.process(id, filepath.Join(h.apps.root, tcApp, "recordings", "ghost.mp4"), false)
	if len(h.variants(id)) != 0 || !h.logs.has("transcode source missing") || len(h.run.calls) != 0 {
		t.Fatal(h.logs.msgs)
	}
}

func TestTranscodeQueueDedupesAndRunsOnWorker(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(func(c *contracts.AppConfig) { c.Transcoding.Enabled, c.Transcoding.Encoding = true, "h264+vp8" })
	id, src := h.seed("rec-1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// queued before the worker drains: the duplicate is dropped
	h.svc.mu.Lock()
	h.svc.started = true
	h.svc.mu.Unlock()
	h.process(id, src, false)
	h.process(id, src, false)
	if len(h.svc.queue) != 1 || !h.logs.has("vod transcode job enqueued") {
		t.Fatal(len(h.svc.queue))
	}
	h.svc.mu.Lock()
	h.svc.started = false
	h.svc.mu.Unlock()
	h.svc.Start(ctx)
	select {
	case h.svc.wake <- struct{}{}:
	default:
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(h.dispatched("vod_variants_ready")) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(h.dispatched("vod_variants_ready")) != 1 {
		t.Fatal("worker did not run the job")
	}
}
