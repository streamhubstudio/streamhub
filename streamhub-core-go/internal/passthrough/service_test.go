package passthrough

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

const app = "live"

var bg = context.Background()

type fakeStreams struct {
	mu        sync.Mutex
	upserts   []string
	ends      []string
	upsertErr error
}

func (f *fakeStreams) Upsert(_ context.Context, app, id, typ, room, part string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upserts = append(f.upserts, strings.Join([]string{app, id, typ, room, part}, "|"))
	return f.upsertErr
}

func (f *fakeStreams) End(_ context.Context, app, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ends = append(f.ends, app+"|"+id)
	return nil
}

type svcFixture struct {
	cfg     *config.Config
	svc     *Service
	keys    *livekit.IngressAuth
	sp      *fakeSpawner
	streams *fakeStreams
}

func baseCfg(dir string) *config.Config {
	return &config.Config{
		DataDir: dir, RtmpPassthroughEnable: true, RtmpPublicHost: "media.test", RtmpPassthroughPort: 1937,
		MediamtxRtmpPort: 1935, LivekitIngressRtmpPort: 11935, MediamtxAPIURL: "http://127.0.0.1:9997",
	}
}

func newSvc(t *testing.T, mutate func(*config.Config)) *svcFixture {
	store, g, dir := testutil.Store(t)
	testutil.Exec(t, g, "INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)", app, app)
	cfg := baseCfg(dir)
	if mutate != nil {
		mutate(cfg)
	}
	f := &svcFixture{cfg: cfg, sp: &fakeSpawner{}, streams: &fakeStreams{}}
	f.keys = livekit.NewIngressAuth(func(ctx context.Context, a string) (*sql.DB, error) { return store.App(ctx, a) })
	remux := NewRemuxManager("", f.sp.spawn, nil, testutil.Log())
	remux.afterFunc = func(time.Duration, func()) *time.Timer { return time.NewTimer(time.Hour) }
	t.Cleanup(remux.Close)
	f.svc = NewService(cfg, f.keys, remux, func() Streams { return f.streams }, testutil.Log())
	return f
}

func (f *svcFixture) register(t *testing.T, room, transport, src string) (string, string) {
	t.Helper()
	id, key, err := f.keys.RegisterPassthrough(bg, app, room, transport, src)
	if err != nil {
		t.Fatal(err)
	}
	return id, key
}

func (f *svcFixture) create(t *testing.T, room, transport, src string) *livekit.PassthroughInfo {
	t.Helper()
	info, err := f.svc.Create(bg, app, room, transport, src)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func argOf(p *fakeProc) string { return strings.Join(p.args, " ") }

func TestHandlePublishGate(t *testing.T) {
	f := newSvc(t, nil)
	id, key := f.register(t, "live-ch1", "rtmp", "")
	res := f.svc.HandlePublish(bg, app, key, nil)
	if res != (PublishResult{true, id, 1937}) || f.sp.count() != 1 {
		t.Fatalf("res = %+v spawns=%d", res, f.sp.count())
	}
	if a := argOf(f.sp.last()); !strings.Contains(a, "rtmp://0.0.0.0:1937/live/"+key) ||
		!strings.Contains(a, filepath.Join("apps", "live", "hls", "live-ch1", "index.m3u8")) {
		t.Fatalf("args = %s", a)
	}
	// Unknown and non-passthrough (wsk_) keys are rejected with NO spawn.
	if f.svc.HandlePublish(bg, app, "ptk_never-minted", nil).Accepted {
		t.Fatal("unknown key accepted")
	}
	_, wsk, _ := f.keys.RegisterWsIngest(bg, app, "live-cam1")
	if f.svc.HandlePublish(bg, app, wsk, nil).Accepted || f.sp.count() != 1 {
		t.Fatal("ws-ingest key accepted")
	}
}

func TestCreateRTMP(t *testing.T) {
	f := newSvc(t, nil)
	info := f.create(t, "live-ch1", "rtmp", "")
	if info.Mode != "passthrough" || !strings.HasPrefix(info.IngressID, "pti_") || !strings.HasPrefix(info.StreamKey, "ptk_") ||
		strings.HasPrefix(info.IngressID, "pti_srt_") {
		t.Fatalf("info = %+v", info)
	}
	if info.RtmpURL != "rtmp://media.test:1937/live/"+info.StreamKey || info.HlsURL != "/hls/live/live-ch1/index.m3u8" ||
		info.PlayerURL != "/play/live/live-ch1" || info.InputType != "rtmp" || info.SrtURL != "" || info.Status != "live" {
		t.Fatalf("info = %+v", info)
	}
	c := info.Capabilities.(Capabilities)
	if c.Mode != "passthrough" || !c.Remux || c.Webrtc || c.AdaptiveBitrate || c.Transcode || c.Recording || len(c.Lost) != 6 || c.LatencyMs != 0 {
		t.Fatalf("caps = %+v", c)
	}
	b, _ := json.Marshal(c)
	if strings.Contains(string(b), "latencyMs") {
		t.Fatal("rtmp capabilities carry latencyMs")
	}
	row, _ := f.keys.FindByStreamKey(bg, app, info.StreamKey)
	if row == nil || row.IngressID != info.IngressID {
		t.Fatal("key not persisted")
	}
}

func TestCreateDisabled503(t *testing.T) {
	f := newSvc(t, func(c *config.Config) { c.RtmpPassthroughEnable = false })
	_, err := f.svc.Create(bg, app, "live-ch1", "rtmp", "")
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != 503 ||
		err.Error() != "RTMP/SRT/MPEG-TS passthrough is disabled — set STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on to use it" || f.sp.count() != 0 {
		t.Fatalf("err = %v", err)
	}
}

func TestDistinctPortsAndRelease(t *testing.T) {
	f := newSvc(t, nil)
	a := f.create(t, "live-a", "rtmp", "")
	b := f.create(t, "live-b", "srt", "")
	if !strings.Contains(argOf(f.sp.procs[0]), ":1937/") || !strings.Contains(argOf(f.sp.procs[1]), "srt://0.0.0.0:1938?mode=listener") {
		t.Fatalf("args %s / %s", argOf(f.sp.procs[0]), argOf(f.sp.procs[1]))
	}
	if b.SrtURL != "srt://media.test:1938?streamid="+b.StreamKey || b.RtmpURL != "" || b.InputType != "srt" {
		t.Fatalf("srt info = %+v", b)
	}
	if c := b.Capabilities.(Capabilities); c.LatencyMs != 120 {
		t.Fatalf("srt caps = %+v", c)
	}
	if !f.svc.Remove(bg, app, a.IngressID) {
		t.Fatal("remove")
	}
	// The freed :1937 is reused.
	f.create(t, "live-c", "rtmp", "")
	if !strings.Contains(argOf(f.sp.last()), ":1937/") {
		t.Fatalf("args = %s", argOf(f.sp.last()))
	}
}

func TestSrtRearmFromPersistedID(t *testing.T) {
	f := newSvc(t, nil)
	id, key := f.register(t, "live-srt", "srt", "")
	if !strings.HasPrefix(id, "pti_srt_") {
		t.Fatal(id)
	}
	if res := f.svc.HandlePublish(bg, app, key, nil); !res.Accepted || !strings.Contains(argOf(f.sp.last()), "srt://0.0.0.0:1937?mode=listener") {
		t.Fatalf("res=%+v args=%s", res, argOf(f.sp.last()))
	}
}

func TestMpegtsCreate(t *testing.T) {
	f := newSvc(t, nil)
	src := "udp://@239.1.1.1:5000?overrun_nonfatal=1"
	info := f.create(t, "live-mt", "mpegts", src)
	if !strings.HasPrefix(info.IngressID, "pti_mpegts_") || info.SourceURL != src || info.RtmpURL != "" || info.SrtURL != "" || info.InputType != "mpegts" {
		t.Fatalf("info = %+v", info)
	}
	a := argOf(f.sp.last())
	if !strings.Contains(a, "-f mpegts -i "+src) || strings.Contains(a, "-listen") {
		t.Fatalf("args = %s", a)
	}
	// No listener port consumed: the next RTMP ingress still gets :1937.
	f.create(t, "live-r", "rtmp", "")
	if !strings.Contains(argOf(f.sp.last()), ":1937/") {
		t.Fatal("mpegts consumed a port")
	}
	list, _ := f.svc.List(bg, app)
	found := false
	for _, r := range list {
		if r.IngressID == info.IngressID {
			found = r.SourceURL == src
		}
	}
	if !found {
		t.Fatalf("list = %+v", list)
	}
	// Re-arm rebuilds the exact persisted input.
	f.svc.Remux().Stop(info.IngressID)
	f.svc.HandlePublish(bg, app, info.StreamKey, nil)
	if !strings.Contains(argOf(f.sp.last()), "-i "+src) {
		t.Fatal("re-arm lost the source")
	}
	if !f.svc.Remove(bg, app, info.IngressID) {
		t.Fatal("remove")
	}
}

func TestMpegtsWithoutSourceRejected(t *testing.T) {
	f := newSvc(t, nil)
	_, key := f.register(t, "live-mt", "mpegts", "")
	if f.svc.HandlePublish(bg, app, key, nil).Accepted || f.sp.count() != 0 {
		t.Fatal("mpegts without source armed")
	}
}

func TestRemove(t *testing.T) {
	f := newSvc(t, nil)
	info := f.create(t, "live-ch1", "rtmp", "")
	if l, _ := f.svc.List(bg, app); len(l) != 1 {
		t.Fatal("list")
	}
	p := f.sp.last()
	if !f.svc.Remove(bg, app, info.IngressID) || !p.terminated {
		t.Fatal("remove did not stop")
	}
	if l, _ := f.svc.List(bg, app); len(l) != 0 {
		t.Fatal("still listed")
	}
	if row, _ := f.keys.FindByStreamKey(bg, app, info.StreamKey); row != nil {
		t.Fatal("key kept")
	}
	if f.svc.Remove(bg, app, "IN_livekit") {
		t.Fatal("non-passthrough id removed")
	}
	if len(f.streams.ends) != 1 || f.streams.ends[0] != "live|live-ch1/passthrough" {
		t.Fatalf("ends = %v", f.streams.ends)
	}
	// Node answers deleted:true for any pti_ id, even unknown.
	if !f.svc.Remove(bg, app, "pti_abc") {
		t.Fatal("unknown pti_ id")
	}
}

func TestGetAndListStatus(t *testing.T) {
	f := newSvc(t, nil)
	info := f.create(t, "live-ch1", "rtmp", "")
	got, err := f.svc.Get(bg, app, info.IngressID)
	if err != nil || got == nil || got.Status != "live" || *got.PlaylistFresh || got.RtmpURL != info.RtmpURL {
		t.Fatalf("get = %+v %v", got, err)
	}
	if g, _ := f.svc.Get(bg, app, "IN_x"); g != nil {
		t.Fatal("non-passthrough get")
	}
	f.svc.Remux().Stop(info.IngressID)
	got, _ = f.svc.Get(bg, app, info.IngressID)
	if got.Status != "off" {
		t.Fatalf("status = %s", got.Status)
	}
}

func TestPublicBaseURL(t *testing.T) {
	f := newSvc(t, func(c *config.Config) { c.PublicBaseURL = "https://tv.example.com//"; c.RtmpPublicHost = "" })
	info := f.create(t, "room a", "rtmp", "")
	if info.HlsURL != "https://tv.example.com/hls/live/room%20a/index.m3u8" || info.PlayerURL != "https://tv.example.com/play/live/room%20a" ||
		!strings.HasPrefix(info.RtmpURL, "rtmp://"+livekit.DefaultRtmpHost+":1937/live/") {
		t.Fatalf("info = %+v", info)
	}
}

func TestMediamtxSwitch(t *testing.T) {
	f := newSvc(t, func(c *config.Config) { c.MediamtxEnable = true; c.MediamtxHookSecret = "s3cret" })
	info := f.create(t, "live-ch1", "rtmp", "")
	if info.RtmpURL != "rtmp://media.test:1935/live/"+info.StreamKey || f.sp.count() != 0 || info.Status != "off" {
		t.Fatalf("info=%+v spawns=%d", info, f.sp.count())
	}
	idA, keyA := f.register(t, "ch-a", "rtmp", "")
	idB, keyB := f.register(t, "ch-b", "rtmp", "")
	if r := f.svc.HandlePublish(bg, app, keyA, nil); r != (PublishResult{true, idA, 1935}) {
		t.Fatal(r)
	}
	if r := f.svc.HandlePublish(bg, app, keyB, nil); r != (PublishResult{true, idB, 1935}) {
		t.Fatal(r)
	}
	if a := argOf(f.sp.procs[0]); a != "-hide_banner -loglevel warning -i rtmp://127.0.0.1:1935/live/"+keyA+" -c copy -f hls -hls_time 4 -hls_list_size 6 -hls_flags delete_segments+append_list -hls_segment_filename "+
		filepath.Join(f.cfg.DataDir, "apps/live/hls/ch-a/seg_%05d.ts")+" "+filepath.Join(f.cfg.DataDir, "apps/live/hls/ch-a/index.m3u8") {
		t.Fatalf("pull args = %s", a)
	}
	// Auth gate unchanged; AuthorizeKey arms nothing.
	_, wsk, _ := f.keys.RegisterWsIngest(bg, app, "x")
	if f.svc.HandlePublish(bg, app, "ptk_never", nil).Accepted || f.svc.HandlePublish(bg, app, wsk, nil).Accepted {
		t.Fatal("gate")
	}
	n := f.sp.count()
	if !f.svc.AuthorizeKey(bg, app, keyA) || f.svc.AuthorizeKey(bg, app, "ptk_bogus") || f.svc.AuthorizeKey(bg, app, wsk) || f.sp.count() != n {
		t.Fatal("authorizeKey")
	}
	// SRT keeps its own listener + port.
	srt := f.create(t, "live-srt", "srt", "")
	if srt.SrtURL != "srt://media.test:1937?streamid="+srt.StreamKey || !strings.Contains(argOf(f.sp.last()), "srt://0.0.0.0:1937?mode=listener") {
		t.Fatalf("srt = %+v", srt)
	}
	// Forward: hidden fwd_ child pull:1935 → push:11935.
	before := f.sp.count()
	f.svc.HandleForwardPublish("sk_livekit")
	if f.sp.count() != before+1 || !strings.Contains(argOf(f.sp.last()), "rtmp://127.0.0.1:11935/live/sk_livekit") {
		t.Fatal("forward not armed")
	}
	if st, ok := f.svc.Remux().Status("fwd_sk_livekit"); !ok || st.Status != "live" {
		t.Fatal("fwd_ id")
	}
	for _, e := range f.svc.Remux().List() {
		if strings.HasPrefix(e.IngressID, "fwd_") {
			t.Fatal("forward listed")
		}
	}
	if l, _ := f.svc.List(bg, app); len(l) != 4 {
		t.Fatalf("list = %d", len(l))
	}
	fwd := f.sp.last()
	f.svc.HandleForwardDone("sk_livekit")
	if !fwd.terminated {
		t.Fatal("forward not stopped")
	}
	// HandleDone keeps the key.
	f.svc.HandleDone(bg, app, keyA)
	if !f.sp.procs[0].terminated || !f.svc.AuthorizeKey(bg, app, keyA) {
		t.Fatal("handleDone")
	}
}

func TestForwardNoopWithoutSwitch(t *testing.T) {
	f := newSvc(t, nil)
	f.svc.HandleForwardPublish("sk_livekit")
	f.svc.HandleForwardDone("")
	if f.sp.count() != 0 {
		t.Fatal("forward armed without the switch")
	}
}

func TestIsPassthroughID(t *testing.T) {
	for id, want := range map[string]bool{"pti_abc": true, "pti_srt_abc": true, "pti_mpegts_x": true, "IN_livekit": false, "wsi_x": false} {
		if IsPassthroughID(id) != want {
			t.Errorf("%s", id)
		}
	}
}

func writePlaylist(t *testing.T, dir string, age time.Duration) {
	t.Helper()
	d := HlsDir(dir, app, "live-ch1")
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	pl := filepath.Join(d, HlsPlaylist)
	if err := os.WriteFile(pl, []byte("#EXTM3U\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ts := time.Now().Add(-age)
	_ = os.Chtimes(pl, ts, ts)
}

func TestSyncStreamRows(t *testing.T) {
	f := newSvc(t, nil)
	_, key := f.register(t, "live-ch1", "rtmp", "")
	f.svc.HandlePublish(bg, app, key, nil)
	writePlaylist(t, f.cfg.DataDir, 0)
	f.svc.SyncStreamRows(bg)
	f.svc.SyncStreamRows(bg) // self-healing: every live tick re-upserts
	if len(f.streams.upserts) != 2 || f.streams.upserts[0] != "live|live-ch1/passthrough|rtmp|live-ch1|passthrough" {
		t.Fatalf("upserts = %v", f.streams.upserts)
	}
	writePlaylist(t, f.cfg.DataDir, 2*time.Minute)
	f.svc.SyncStreamRows(bg)
	f.svc.SyncStreamRows(bg) // ended once
	if len(f.streams.ends) != 1 || f.streams.ends[0] != "live|live-ch1/passthrough" {
		t.Fatalf("ends = %v", f.streams.ends)
	}
}

func TestSyncSkipsStoppedAndSwallowsErrors(t *testing.T) {
	f := newSvc(t, nil)
	id, key := f.register(t, "live-ch1", "rtmp", "")
	f.svc.HandlePublish(bg, app, key, nil)
	f.svc.Remux().Stop(id)
	writePlaylist(t, f.cfg.DataDir, 0)
	f.svc.SyncStreamRows(bg)
	if len(f.streams.upserts) != 0 {
		t.Fatal("upsert for a stopped acceptor")
	}
	f.svc.HandlePublish(bg, app, key, nil)
	writePlaylist(t, f.cfg.DataDir, 0)
	f.streams.upsertErr = errors.New("db locked")
	f.svc.SyncStreamRows(bg) // must not panic
}

func TestParseMpegtsSourceAdapter(t *testing.T) {
	f := newSvc(t, nil)
	src, sources, fifo, off := "udp://@232.1.1.1:5000", "10.0.0.1", int64(5000), false
	got, err := f.svc.ParseMpegtsSource(livekit.MpegtsSource{URL: src, Sources: &sources, FifoSize: &fifo, OverrunNonfatal: &off})
	if err != nil || got != "udp://@232.1.1.1:5000?sources=10.0.0.1&fifo_size=5000&overrun_nonfatal=0" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := f.svc.ParseMpegtsSource(livekit.MpegtsSource{URL: "udp://@1.2.3.4:5000", Sources: &sources}); err == nil {
		t.Fatal("ssm on unicast accepted")
	}
}

// ---------------------------------------------------------------------------
// Front: boot re-arm (passthrough.rtmp-server.spec.ts)
// ---------------------------------------------------------------------------

func mediamtxAPI(t *testing.T, pages []string, status int) (*httptest.Server, *[]string) {
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.String())
		if status != 200 {
			w.WriteHeader(status)
			return
		}
		page := 0
		_, _ = fmt.Sscanf(r.URL.Query().Get("page"), "%d", &page)
		_, _ = w.Write([]byte(pages[page]))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestRearmFromMediamtx(t *testing.T) {
	f := newSvc(t, func(c *config.Config) { c.MediamtxEnable = true })
	_, k1 := f.register(t, "ch1", "rtmp", "")
	_, k2 := f.register(t, "ch2", "rtmp", "")
	page0 := fmt.Sprintf(`{"pageCount":2,"items":[{"name":"live/%s","ready":true},{"name":"live/sk_lk","ready":true},{"name":"live/%s","ready":false}]}`, k1, k2)
	page1 := `{"pageCount":2,"items":[{"name":"garbage","ready":true},{"ready":true},{"name":"live/ptk_unknown","ready":true}]}`
	srv, hits := mediamtxAPI(t, []string{page0, page1}, 200)
	f.cfg.MediamtxAPIURL = srv.URL + "/"
	front := NewFront(f.svc, f.keys, nil, testutil.Log())
	pull, fwd := front.RearmFromMediamtx(bg)
	if pull != 1 || fwd != 1 || len(*hits) != 2 || (*hits)[0] != "/v3/paths/list?page=0&itemsPerPage=100" {
		t.Fatalf("pull=%d fwd=%d hits=%v", pull, fwd, *hits)
	}
	if !strings.Contains(argOf(f.sp.procs[0]), "-i rtmp://127.0.0.1:1935/live/"+k1) {
		t.Fatalf("args = %s", argOf(f.sp.procs[0]))
	}
	if _, ok := f.svc.Remux().Status("fwd_sk_lk"); !ok {
		t.Fatal("forward not re-armed")
	}
}

func TestRearmFromMediamtxDownAPI(t *testing.T) {
	f := newSvc(t, func(c *config.Config) { c.MediamtxEnable = true })
	srv, _ := mediamtxAPI(t, nil, 500)
	f.cfg.MediamtxAPIURL = srv.URL
	front := NewFront(f.svc, f.keys, nil, testutil.Log())
	if p, w := front.RearmFromMediamtx(bg); p != 0 || w != 0 {
		t.Fatal("armed from a failing API")
	}
	f.cfg.MediamtxAPIURL = "http://127.0.0.1:1" // unreachable
	if p, w := front.RearmFromMediamtx(bg); p != 0 || w != 0 || f.sp.count() != 0 {
		t.Fatal("armed from an unreachable API")
	}
}

func TestRearmAll(t *testing.T) {
	f := newSvc(t, nil)
	f.register(t, "ch1", "rtmp", "")
	f.register(t, "ch2", "srt", "")
	f.register(t, "ch3", "mpegts", "udp://@239.1.1.1:5000?overrun_nonfatal=1")
	apps := func(context.Context) ([]string, error) { return []string{app, "empty"}, nil }
	front := NewFront(f.svc, f.keys, apps, testutil.Log())
	if n := front.RearmAll(bg); n != 3 || f.sp.count() != 3 {
		t.Fatalf("armed = %d", n)
	}
	// Under the MediaMTX switch RTMP rows are skipped (the ready hook arms them).
	g := newSvc(t, func(c *config.Config) { c.MediamtxEnable = true })
	g.register(t, "ch1", "rtmp", "")
	g.register(t, "ch2", "srt", "")
	if n := NewFront(g.svc, g.keys, apps, testutil.Log()).RearmAll(bg); n != 1 || !strings.Contains(argOf(g.sp.last()), "srt://") {
		t.Fatalf("armed = %d", n)
	}
	failing := func(context.Context) ([]string, error) { return nil, errors.New("db down") }
	if n := NewFront(f.svc, f.keys, failing, testutil.Log()).RearmAll(bg); n != 0 {
		t.Fatal("re-armed despite apps failure")
	}
}

func TestFrontStartGated(t *testing.T) {
	f := newSvc(t, func(c *config.Config) { c.RtmpPassthroughEnable = false; c.MediamtxEnable = true })
	srv, hits := mediamtxAPI(t, []string{`{"items":[]}`}, 200)
	f.cfg.MediamtxAPIURL = srv.URL
	ctx, cancel := context.WithCancel(bg)
	defer cancel()
	NewFront(f.svc, f.keys, func(context.Context) ([]string, error) { return []string{app}, nil }, testutil.Log()).Start(ctx)
	time.Sleep(50 * time.Millisecond)
	if len(*hits) != 0 || f.sp.count() != 0 {
		t.Fatal("disabled front probed MediaMTX / armed")
	}
}
