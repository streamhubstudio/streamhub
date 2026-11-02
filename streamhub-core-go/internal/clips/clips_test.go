package clips

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/recording"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/streams"
)

// G6 — clips: the pure planner (instants, range, window, segment selection,
// ffmpeg argv) and the job service over fakes (no ffmpeg, S3 or network:
// the runner writes the output file, the publisher records the upload).

var bg = context.Background()

const nowMs = 1_793_282_400_000.0 // 2026-10-29T14:00:00Z

func status(t *testing.T, err error, want int, sub string) {
	t.Helper()
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != want || !strings.Contains(err.Error(), sub) {
		t.Fatalf("got %v (%T), want %d containing %q", err, err, want, sub)
	}
}

func TestParseInstantAndResolve(t *testing.T) {
	for in, want := range map[any]float64{
		1793282400.0: nowMs, 1793282400.5: nowMs + 500, nowMs: nowMs, int64(1793282400): nowMs,
		"1793282400": nowMs, "2026-10-29T14:00:00Z": nowMs, "2026-10-29T11:00:00.250-03:00": nowMs + 250,
	} {
		if got, ok := ParseInstant(in); !ok || got != want {
			t.Errorf("%v → %v %v, want %v", in, got, ok, want)
		}
	}
	for _, in := range []any{nil, "", "yesterday", -5.0, 0.0, true, []any{1.0}} {
		if _, ok := ParseInstant(in); ok {
			t.Errorf("%v must not parse", in)
		}
	}

	r, err := Request{EventTs: 1793282400.0}.Resolve()
	if err != nil || r != (Range{nowMs - 10_000, nowMs + 10_000}) || r.DurationS() != 20 {
		t.Fatalf("default event clip = %+v %v", r, err)
	}
	b, a := 3.0, 0.0
	if r, _ = (Request{EventTs: "2026-10-29T14:00:00Z", Before: &b, After: &a}).Resolve(); r != (Range{nowMs - 3000, nowMs}) {
		t.Fatalf("%+v", r)
	}
	if r, _ = (Request{From: nowMs - 5000, To: "2026-10-29T14:00:00Z"}).Resolve(); r != (Range{nowMs - 5000, nowMs}) {
		t.Fatalf("%+v", r)
	}
	neg := -1.0
	for _, q := range []Request{
		{}, {From: 1.0, EventTs: 2.0}, {From: "x", To: nowMs}, {From: nowMs}, {EventTs: "nope"}, {EventTs: nowMs, Before: &neg},
	} {
		if _, err := q.Resolve(); err == nil {
			t.Errorf("%+v must be refused", q)
		}
	}
}

func TestValidate(t *testing.T) {
	win := Window{nowMs - 3600_000, nowMs - 2000}
	ok := Range{nowMs - 60_000, nowMs - 40_000}
	if err := Validate(ok, 120, win, nowMs); err != nil {
		t.Fatal(err)
	}
	// Reaching past the live edge is fine (the job waits), up to MaxFutureSeconds.
	if err := Validate(Range{nowMs - 10_000, nowMs + 10_000}, 120, win, nowMs); err != nil {
		t.Fatal(err)
	}
	status(t, Validate(Range{nowMs, nowMs}, 120, win, nowMs), 400, "at least 1s")
	status(t, Validate(Range{nowMs, nowMs - 1}, 120, win, nowMs), 400, "to must be after from")
	status(t, Validate(Range{nowMs - 200_000, nowMs - 50_000}, 120, win, nowMs), 400, "at most 120s (features.clips.max_seconds)")
	status(t, Validate(Range{nowMs - 3700_000, nowMs - 3690_000}, 120, win, nowMs), 400, "before the oldest available segment (2026-10-29T13:00:00.000Z)")
	status(t, Validate(Range{nowMs + 110_000, nowMs + 130_000}, 120, win, nowMs), 400, "more than 120s in the future")
}

// timeline: n segments of 4 s ending at endMs.
func timeline(n int, endMs float64) []streams.TimedSegment {
	out := make([]streams.TimedSegment, n)
	for i := range out {
		start := endMs - float64(n-i)*4000
		out[i] = streams.TimedSegment{
			MediaSegment: streams.MediaSegment{URI: fmt.Sprintf("segment_%05d.ts", i), Duration: 4, PDT: start},
			Start:        start, End: start + 4000,
		}
	}
	return out
}

func TestSelectAndFfmpegArgs(t *testing.T) {
	tl := timeline(10, nowMs) // [now-40s, now)
	sel, ok := Select(tl, Range{nowMs - 30_000, nowMs - 9_000})
	if !ok || len(sel.Segments) != 6 || sel.Segments[0].URI != "segment_00002.ts" || sel.Segments[5].URI != "segment_00007.ts" {
		t.Fatalf("%+v", sel)
	}
	if sel.OffsetS != 2 || sel.DurationS != 21 {
		t.Fatalf("offset %v duration %v", sel.OffsetS, sel.DurationS)
	}
	// A range hanging off the window is cut to what exists.
	if sel, ok = Select(tl, Range{nowMs - 8_000, nowMs + 30_000}); !ok || sel.DurationS != 8 || len(sel.Segments) != 2 {
		t.Fatalf("%+v", sel)
	}
	if _, ok = Select(tl, Range{nowMs + 1000, nowMs + 2000}); ok {
		t.Fatal("nothing on disk → no selection")
	}
	if w, ok := WindowOf(tl); !ok || w != (Window{nowMs - 40_000, nowMs}) {
		t.Fatalf("%+v", w)
	}

	want := []string{"-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-ss", "2", "-i", "/w/l.ffconcat",
		"-t", "21", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", "/w/out.mp4"}
	if got := FfmpegArgs("/w/l.ffconcat", "/w/out.mp4", Selection{OffsetS: 2, DurationS: 21}); !reflect.DeepEqual(got, want) {
		t.Fatalf("%q", got)
	}
	if got := ConcatList([]string{"/a/seg_1.ts", "/it's/seg_2.ts"}); got != "ffconcat version 1.0\nfile '/a/seg_1.ts'\nfile '/it'\\''s/seg_2.ts'\n" {
		t.Fatalf("%q", got)
	}
	if n := ClipName("cam/1 gate", nowMs, "clp_x"); n != "clip-cam_1_gate-20261029-140000-clp_x.mp4" {
		t.Fatal(n)
	}
}

// --- fakes -----------------------------------------------------------------

type fakeApps struct {
	dataDir string
	clips   *contracts.ClipsFeatures
	hls     *contracts.HlsFeatures
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	return []contracts.AppRecord{{Name: "live"}}, nil
}
func (f *fakeApps) Get(_ context.Context, name string) (*contracts.AppRecord, error) {
	if name != "live" {
		return nil, nil
	}
	return &contracts.AppRecord{ID: 1, Name: name}, nil
}
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, errors.New("unused")
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(_ context.Context, name string) (*contracts.AppConfig, error) {
	if name != "live" {
		return nil, errors.New("config.yaml missing")
	}
	return &contracts.AppConfig{Name: name, Features: contracts.AppFeatures{Clips: f.clips, Hls: f.hls}}, nil
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, errors.New("unused")
}
func (f *fakeApps) AppDir(name string) string { return filepath.Join(f.dataDir, "apps", name) }

type fakeStreams map[string]string

func (f fakeStreams) StreamRoom(_ context.Context, _, id string) (string, bool, error) {
	room, ok := f[id]
	return room, ok, nil
}

type fakePublisher struct {
	mu         sync.Mutex
	storageErr error
	failWith   error
	got        []recording.PublishInput
}

func (f *fakePublisher) CheckStorage(context.Context, string) error { return f.storageErr }
func (f *fakePublisher) PublishFile(_ context.Context, in recording.PublishInput) (*recording.VodRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, in)
	if f.failWith != nil {
		return nil, f.failWith
	}
	key, url, size := "clips/"+in.Name, "https://s3.example/clips/"+in.Name+"?sig", 1234.0
	return &recording.VodRecord{ID: 7, Name: in.Name, FileKey: &key, PublicURL: &url, SizeBytes: &size, Source: in.Source}, nil
}

func (f *fakePublisher) FindByID(_ context.Context, _ string, id int64) (*recording.VodRecord, error) {
	url := "https://s3.example/vod/7?sig"
	return &recording.VodRecord{ID: id, PublicURL: &url}, nil
}

// fakeRunner "runs" ffmpeg: writes the output (last arg) unless told to fail;
// gate (when set) blocks every run until closed.
type fakeRunner struct {
	mu   sync.Mutex
	args [][]string
	list []string
	fail error
	gate chan struct{}
}

func (f *fakeRunner) Run(_ context.Context, bin string, args []string, _ time.Duration) ([]byte, error) {
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.args = append(f.args, args)
	for i, a := range args {
		if a == "-i" {
			b, _ := os.ReadFile(args[i+1])
			f.list = append(f.list, string(b))
		}
	}
	if bin != "ffmpeg" {
		return nil, errors.New("unexpected " + bin)
	}
	if f.fail != nil {
		return nil, f.fail
	}
	return nil, os.WriteFile(args[len(args)-1], []byte("mp4"), 0o644)
}

func (f *fakeRunner) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.args)
}

type event struct {
	name    string
	payload map[string]any
}

type fakeCallbacks struct {
	mu     sync.Mutex
	events []event
}

func (f *fakeCallbacks) Dispatch(_ context.Context, _, ev string, payload any) error {
	b, _ := json.Marshal(payload)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	f.mu.Lock()
	f.events = append(f.events, event{ev, m})
	f.mu.Unlock()
	return nil
}

type harness struct {
	svc   *Service
	apps  *fakeApps
	pub   *fakePublisher
	run   *fakeRunner
	cb    *fakeCallbacks
	dir   string // the room's HLS dir
	mu    sync.Mutex
	now   float64
	seq   atomic.Int64
	sleep func() // hook run on every fake sleep (after the clock moved)
}

func (h *harness) clock() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	return time.UnixMilli(int64(h.now))
}

// writeIndex writes n 4-s segments ending at endMs (index.m3u8 with PDT).
func (h *harness) writeIndex(t *testing.T, n int, endMs float64) {
	t.Helper()
	_ = os.MkdirAll(h.dir, 0o755)
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n")
	for _, s := range timeline(n, endMs) {
		fmt.Fprintf(&b, "#EXT-X-PROGRAM-DATE-TIME:%s\n#EXTINF:4.000,\n%s\n", streams.FormatPDT(s.Start), s.URI)
		if err := os.WriteFile(filepath.Join(h.dir, s.URI), []byte("ts"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(h.dir, streams.PlaylistName), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	store, _, dataDir := testutil.Store(t)
	h := &harness{
		apps: &fakeApps{dataDir: dataDir, clips: &contracts.ClipsFeatures{Enabled: true, MaxSeconds: 120, MaxConcurrent: 2, MaxQueued: 20}},
		pub:  &fakePublisher{}, run: &fakeRunner{}, cb: &fakeCallbacks{}, now: nowMs,
	}
	h.dir = filepath.Join(dataDir, "apps", "live", "hls", "cam1")
	h.svc = New(Deps{
		Apps: h.apps, Streams: fakeStreams{"cam1/enc": "cam1", "roomless": ""}, Publisher: h.pub, Vods: h.pub,
		Store: NewStore(store.App), Runner: h.run, Callbacks: func() Dispatcher { return h.cb }, Log: testutil.Log(), Now: h.clock,
		Sleep: func(_ context.Context, d time.Duration) error {
			h.mu.Lock()
			h.now += float64(d.Milliseconds())
			h.mu.Unlock()
			if h.sleep != nil {
				h.sleep()
			}
			return nil
		},
		NewID: func() string { return fmt.Sprintf("clp_%d", h.seq.Add(1)) },
	})
	return h
}

func (h *harness) get(t *testing.T, id string) *Clip {
	t.Helper()
	c, err := h.svc.Get(bg, "live", id)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// --- service ----------------------------------------------------------------

// Hecho = an event → a 20 s clip in S3 and in the VOD list, linked from the
// event: the job cuts the right segments, publishes source=clip under
// clips/, and clip.ready carries the VOD + the originating event.
func TestEventClipEndToEnd(t *testing.T) {
	h := newHarness(t)
	h.writeIndex(t, 30, nowMs) // the last 120 s
	ts := (nowMs - 40_000) / 1000
	origin := &Origin{Kind: "streamflow", Event: "plate.detected", EventTs: ptr(nowMs - 40_000), WorkflowID: "wf1", RunID: "run1",
		Data: json.RawMessage(`{"plate":"AB123CD","room":"cam1"}`)}
	c, err := h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: Request{EventTs: ts}, Origin: origin})
	if err != nil {
		t.Fatal(err)
	}
	if c.Status != StatusQueued || c.Room != "cam1" || *c.StreamID != "cam1/enc" || c.DurationS != 20 ||
		c.From != "2026-10-29T13:59:10.000Z" || c.To != "2026-10-29T13:59:30.000Z" {
		t.Fatalf("%+v", c)
	}
	h.svc.Wait()

	got := h.get(t, c.ID)
	if got.Status != StatusReady || got.VodID == nil || *got.VodID != 7 || got.URL == nil || got.Error != nil {
		t.Fatalf("%+v", got)
	}
	if len(h.run.args) != 1 {
		t.Fatal(h.run.args)
	}
	// [now-50s, now-30s) over 4 s segments from now-120s: segments 17..22,
	// 2 s into the first one.
	args := strings.Join(h.run.args[0], " ")
	if !strings.Contains(args, "-ss 2 -i ") || !strings.Contains(args, "-t 20 -c copy") || strings.Count(h.run.list[0], "file '") != 6 ||
		!strings.Contains(h.run.list[0], filepath.Join(h.dir, "segment_00017.ts")) || !strings.Contains(h.run.list[0], filepath.Join(h.dir, "segment_00022.ts")) {
		t.Fatalf("args %s\nlist %s", args, h.run.list[0])
	}
	in := h.pub.got[0]
	if in.Source != recording.VodSourceClip || in.KeyPrefix != "clips/" || in.Room != "cam1" || in.StreamID != "cam1/enc" ||
		!strings.HasPrefix(in.Name, "clip-cam1-20261029-135910-") || in.StartedAt.UnixMilli() != int64(nowMs-50_000) {
		t.Fatalf("%+v", in)
	}
	if in.Meta.Get("clipId") != c.ID || in.Meta.Get("source") != "clip" {
		t.Fatalf("meta %v", in.Meta)
	}
	if _, err := os.Stat(filepath.Join(h.apps.AppDir("live"), "clips", "."+c.ID+".ffconcat")); err == nil {
		t.Fatal("concat list left behind")
	}

	if len(h.cb.events) != 1 || h.cb.events[0].name != EventReady {
		t.Fatalf("%+v", h.cb.events)
	}
	p := h.cb.events[0].payload
	o, _ := p["origin"].(map[string]any)
	if p["clipId"] != c.ID || p["vodId"] != 7.0 || p["source"] != "clip" || p["room"] != "cam1" || p["durationS"] != 20.0 ||
		!strings.HasPrefix(p["url"].(string), "https://s3.example/clips/") || o["event"] != "plate.detected" || o["runId"] != "run1" {
		t.Fatalf("clip.ready payload %v", p)
	}

	for _, sid := range []*string{nil, ptr2("cam1/enc")} {
		list, err := h.svc.List(bg, "live", sid, 0)
		if err != nil || len(list) != 1 || list[0].ID != c.ID {
			t.Fatalf("list %v %v", list, err)
		}
	}
	if list, _ := h.svc.List(bg, "live", ptr2("other"), 0); len(list) != 0 {
		t.Fatal(list)
	}
	_, err = h.svc.Get(bg, "live", "clp_nope")
	status(t, err, 404, "clip 'clp_nope' not found")
	_, err = h.svc.List(bg, "ghost", nil, 0)
	status(t, err, 404, "app 'ghost' not found")
}

func ptr(f float64) *float64 { return &f }
func ptr2(s string) *string  { return &s }

// A clip reaching past the live edge waits for the egress to write it.
func TestClipWaitsForFutureSegments(t *testing.T) {
	h := newHarness(t)
	h.writeIndex(t, 10, nowMs)
	h.sleep = func() {
		h.mu.Lock()
		now := h.now
		h.mu.Unlock()
		h.writeIndex(t, 10+int((now-nowMs)/4000), nowMs+float64(int((now-nowMs)/4000))*4000)
	}
	c, err := h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: Request{EventTs: nowMs}})
	if err != nil {
		t.Fatal(err)
	}
	h.svc.Wait()
	if got := h.get(t, c.ID); got.Status != StatusReady {
		t.Fatalf("%+v", got)
	}
	if args := strings.Join(h.run.args[0], " "); !strings.Contains(args, "-t 20 ") {
		t.Fatalf("the full 20 s once written: %s", args)
	}
}

func TestCreateRefusals(t *testing.T) {
	h := newHarness(t)
	ts := (nowMs - 30_000) / 1000

	_, err := h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: Request{EventTs: ts}})
	status(t, err, 409, "no HLS segments on disk for room 'cam1'")
	h.writeIndex(t, 30, nowMs)

	_, err = h.svc.Create(bg, CreateInput{App: "ghost", StreamID: "x", Request: Request{EventTs: ts}})
	status(t, err, 404, "app 'ghost' config unavailable")
	_, err = h.svc.Create(bg, CreateInput{App: "live", StreamID: "nope", Request: Request{EventTs: ts}})
	status(t, err, 404, "stream 'nope' not found")
	_, err = h.svc.Create(bg, CreateInput{App: "live", StreamID: "roomless", Request: Request{EventTs: ts}})
	status(t, err, 400, "has no room to clip")
	_, err = h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: Request{From: nowMs - 500_000, To: nowMs - 490_000}})
	status(t, err, 400, "before the oldest available segment")

	h.pub.storageErr = &httpx.Error{Status: http.StatusConflict, Body: httpx.NestBody{StatusCode: 409, Message: "storage_not_configured"}}
	_, err = h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: Request{EventTs: ts}})
	status(t, err, 409, "storage_not_configured")
	h.pub.storageErr = nil

	h.apps.clips = &contracts.ClipsFeatures{Enabled: false, MaxSeconds: 120, MaxConcurrent: 1, MaxQueued: 1}
	_, err = h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: Request{EventTs: ts}})
	status(t, err, 400, "clips are disabled for app 'live' (features.clips.enabled)")
	h.apps.clips = nil
	_, err = h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: Request{EventTs: ts}})
	status(t, err, 400, "clips are disabled")

	h.apps.clips = &contracts.ClipsFeatures{Enabled: true, MaxSeconds: 15, MaxConcurrent: 1, MaxQueued: 2}
	_, err = h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: Request{EventTs: ts}})
	status(t, err, 400, "at most 15s")
}

// max_concurrent caps the running jobs per app (the rest wait in FIFO);
// max_queued refuses new work with 429 while the backlog is full.
func TestConcurrencyAndQueueLimits(t *testing.T) {
	h := newHarness(t)
	h.writeIndex(t, 30, nowMs)
	h.apps.clips = &contracts.ClipsFeatures{Enabled: true, MaxSeconds: 120, MaxConcurrent: 1, MaxQueued: 2}
	h.run.gate = make(chan struct{})
	req := Request{From: nowMs - 60_000, To: nowMs - 50_000}
	a, err := h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: req})
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: req})
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: req})
	status(t, err, 429, "already has 2 clips queued or running (features.clips.max_queued)")

	deadline := time.Now().Add(5 * time.Second)
	for h.get(t, a.ID).Status != StatusRunning && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := h.get(t, b.ID).Status; got != StatusQueued {
		t.Fatalf("second clip must wait behind max_concurrent=1, is %s", got)
	}
	close(h.run.gate)
	h.svc.Wait()
	if h.get(t, a.ID).Status != StatusReady || h.get(t, b.ID).Status != StatusReady || h.run.calls() != 2 {
		t.Fatal("both clips must complete in turn")
	}
}

func TestFailuresAndBootRecovery(t *testing.T) {
	h := newHarness(t)
	h.writeIndex(t, 30, nowMs)
	req := Request{From: nowMs - 60_000, To: nowMs - 50_000}

	h.run.fail = errors.New("exit status 1")
	c, _ := h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: req})
	h.svc.Wait()
	got := h.get(t, c.ID)
	if got.Status != StatusFailed || got.Error == nil || *got.Error != "ffmpeg failed: exit status 1" || len(h.pub.got) != 0 {
		t.Fatalf("%+v", got)
	}
	if ev := h.cb.events[len(h.cb.events)-1]; ev.name != EventFailed || ev.payload["error"] != "ffmpeg failed: exit status 1" {
		t.Fatalf("%+v", ev)
	}
	if entries, _ := os.ReadDir(filepath.Join(h.apps.AppDir("live"), "clips")); len(entries) != 0 {
		t.Fatalf("failed clip left files: %v", entries)
	}

	h.run.fail = nil
	h.pub.failWith = errors.New("s3 down")
	c, _ = h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: req})
	h.svc.Wait()
	if got := h.get(t, c.ID); got.Status != StatusFailed || *got.Error != "upload failed: s3 down" {
		t.Fatalf("%+v", got)
	}

	// Back to a healthy S3: the same request goes through.
	h.pub.failWith = nil
	c, _ = h.svc.Create(bg, CreateInput{App: "live", StreamID: "cam1/enc", Request: req})
	h.svc.Wait()
	if got := h.get(t, c.ID); got.Status != StatusReady {
		t.Fatalf("%+v", got)
	}

	// Boot: a clip the previous core left queued is failed, never resumed.
	st := h.svc.d.Store
	orphan := &Clip{ID: "clp_orphan", Room: "cam1", fromMs: nowMs - 60_000, toMs: nowMs - 50_000}
	if err := st.Insert(bg, "live", orphan, nil); err != nil {
		t.Fatal(err)
	}
	h.svc.Start(bg)
	if got := h.get(t, "clp_orphan"); got.Status != StatusFailed || *got.Error != "interrupted by a core restart" {
		t.Fatalf("%+v", got)
	}
}

// Validated against the window, then pruned before the cut: the job fails
// with a clear reason instead of cutting the wrong span.
func TestPrunedRangeFails(t *testing.T) {
	h := newHarness(t)
	h.writeIndex(t, 30, nowMs)
	for i := 0; i < 5; i++ {
		_ = os.Remove(filepath.Join(h.dir, fmt.Sprintf("segment_%05d.ts", i)))
	}
	j := job{"live", &Clip{ID: "clp_pruned", Room: "cam1", fromMs: nowMs - 119_000, toMs: nowMs - 110_000}, streams.PlanFor(nil), 1}
	if err := h.svc.d.Store.Insert(bg, "live", j.clip, nil); err != nil {
		t.Fatal(err)
	}
	h.svc.process(bg, j)
	if got := h.get(t, "clp_pruned"); got.Status != StatusFailed || !strings.Contains(*got.Error, "pruned from the DVR window") {
		t.Fatalf("%+v", got)
	}
	if h.run.calls() != 0 {
		t.Fatal("ffmpeg must not run on an empty selection")
	}
}

func TestParseCreateBody(t *testing.T) {
	q, err := ParseCreateBody([]byte(`{"eventTs":1793282400,"before":5,"after":15}`))
	if err != nil || q.EventTs != 1793282400.0 || *q.Before != 5 || *q.After != 15 {
		t.Fatalf("%+v %v", q, err)
	}
	if _, err := ParseCreateBody([]byte(`{"eventTs":1,"before":-1}`)); err == nil || !strings.Contains(err.Error(), "before must not be less than 0") {
		t.Fatal(err)
	}
	if _, err := ParseCreateBody([]byte(`{"after":"x"}`)); err == nil || !strings.Contains(err.Error(), "after must be a number") {
		t.Fatal(err)
	}
}
