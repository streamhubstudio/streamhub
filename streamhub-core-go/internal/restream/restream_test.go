package restream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
)

const (
	key  = "abcd-efgh-ijkl-mnop"
	room = "live-room1"
	sid  = room + "/pub1"
)

var bg = context.Background()

// ---------------------------------------------------------------------------
// presets (restream.presets.spec.ts)
// ---------------------------------------------------------------------------

func TestBuildTargetURL(t *testing.T) {
	cases := []struct {
		platform, url, key, want, err string
	}{
		{"youtube", "", "abcd-efgh-ijkl", "rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl", ""},
		{"twitch", "", "live_123_abc", "rtmp://live.twitch.tv/app/live_123_abc", ""},
		{"facebook", "", "FB-123-XYZ", "rtmps://live-api-s.facebook.com:443/rtmp/FB-123-XYZ", ""},
		{"custom", "rtmp://ingest.example.com/live/my-key", "", "rtmp://ingest.example.com/live/my-key", ""},
		{"custom", "rtmp://ingest.example.com/live/", "k1", "rtmp://ingest.example.com/live/k1", ""},
		{"custom", "  rtmps://x.example.com/app  ", "  k2 ", "rtmps://x.example.com/app/k2", ""},
		{"youtube", "", "", "", "stream key is required for YouTube Live"},
		{"twitch", "", "a/b", "", "stream key must not contain spaces or slashes"},
		{"twitch", "", "a b", "", "stream key must not contain spaces or slashes"},
		{"custom", "", "", "", "url is required for a custom destination"},
		{"custom", "http://example.com/live", "", "", "url must start with rtmp:// or rtmps://"},
		{"myspace", "", "k", "", "unknown platform 'myspace'"},
	}
	for _, c := range cases {
		got, err := BuildTargetURL(c.platform, c.url, c.key)
		if c.err != "" {
			if err == nil || err.Error() != c.err {
				t.Errorf("%s/%q/%q: err = %v, want %q", c.platform, c.url, c.key, err, c.err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s/%q/%q = %q, %v; want %q", c.platform, c.url, c.key, got, err, c.want)
		}
	}
	for p, pr := range presets {
		if !IsRtmpURL(pr.base) {
			t.Errorf("preset %s base %q is not an rtmp URL", p, pr.base)
		}
	}
}

func TestMaskRtmpURL(t *testing.T) {
	cases := map[string]string{
		"rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl": "rtmp://a.rtmp.youtube.com/live2/abcd…",
		"rtmp://host/app/key1":                           "rtmp://host/app/…",
		"rtmp://host":                                    "rtmp://host",
		"rtmp://host/":                                   "rtmp://host/",
		"rtmp://host/app/":                               "rtmp://host/app/",
		"not a url":                                      "not a url",
		"RTMPS://Host:443/rtmp/FB-123":                   "RTMPS://Host:443/rtmp/FB-1…",
	}
	for in, want := range cases {
		if got := MaskRtmpURL(in); got != want {
			t.Errorf("MaskRtmpURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// service (restream.service.spec.ts)
// ---------------------------------------------------------------------------

type fakeLK struct {
	mu       sync.Mutex
	seq      int
	starts   []livekit.StartStreamEgressInput
	stops    []string
	startErr error
	stopErr  error
	active   []livekit.StreamEgressInfo
}

func (f *fakeLK) StartStreamEgress(_ context.Context, in livekit.StartStreamEgressInput) (livekit.StreamEgressInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, in)
	if f.startErr != nil {
		return livekit.StreamEgressInfo{}, f.startErr
	}
	f.seq++
	return livekit.StreamEgressInfo{EgressID: fmt.Sprintf("EG_%d", f.seq), Status: "EGRESS_STARTING", RoomName: in.RoomName, URLs: []string{in.RtmpURL}}, nil
}

func (f *fakeLK) ListStreamEgress(context.Context, string) ([]livekit.StreamEgressInfo, error) {
	return f.active, nil
}

func (f *fakeLK) StopEgress(_ context.Context, id string) (livekit.EgressInfo, error) {
	f.stops = append(f.stops, id)
	return livekit.EgressInfo{EgressID: id, Status: "EGRESS_ENDING"}, f.stopErr
}

type fakeStreams struct{ rec *streams.StreamRecord }

func (f fakeStreams) Get(context.Context, string, string) (*streams.StreamRecord, error) {
	return f.rec, nil
}

type event struct {
	app, name string
	payload   map[string]any
}

type fakeCallbacks struct {
	mu     sync.Mutex
	events []event
}

func (f *fakeCallbacks) Dispatch(_ context.Context, app, ev string, payload any) error {
	b, _ := json.Marshal(payload)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	f.mu.Lock()
	f.events = append(f.events, event{app, ev, m})
	f.mu.Unlock()
	return nil
}

func (f *fakeCallbacks) named(name string) []event {
	var out []event
	for _, e := range f.events {
		if e.name == name {
			out = append(out, e)
		}
	}
	return out
}

type fixture struct {
	repo   *Repository
	svc    *Service
	lk     *fakeLK
	cb     *fakeCallbacks
	timers []func()
	delays []time.Duration
}

func newFixture(t *testing.T) *fixture {
	store, _, _ := testutil.Store(t)
	f := &fixture{repo: NewRepository(store), lk: &fakeLK{}, cb: &fakeCallbacks{}}
	st := &streams.StreamRecord{ID: 1, AppID: 1, StreamID: sid, Type: "webrtc", Room: room, Status: "active"}
	f.svc = NewService(Deps{
		Repo: f.repo, LiveKit: func() LiveKit { return f.lk }, Streams: fakeStreams{st},
		Callbacks: func() Callbacks { return f.cb }, Log: testutil.Log(),
	})
	f.svc.afterFunc = func(d time.Duration, fn func()) *time.Timer {
		f.delays = append(f.delays, d)
		f.timers = append(f.timers, fn)
		return time.NewTimer(time.Hour)
	}
	t.Cleanup(f.svc.Close)
	return f
}

// fire runs the pending retries (fake clock advance).
func (f *fixture) fire() {
	pending := f.timers
	f.timers = nil
	for _, fn := range pending {
		fn()
	}
}

func sp(s string) *string { return &s }

func (f *fixture) add(t *testing.T, in AddInput) *RestreamTargetView {
	t.Helper()
	v, err := f.svc.Add(bg, "live", sid, in)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func status(err error) int {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

func TestAddStartsPresetEgress(t *testing.T) {
	f := newFixture(t)
	v := f.add(t, AddInput{Platform: sp("youtube"), Key: key, Name: sp("Mi canal")})
	want := livekit.StartStreamEgressInput{AppName: "live", RoomName: room, RtmpURL: "rtmp://a.rtmp.youtube.com/live2/" + key}
	if len(f.lk.starts) != 1 || f.lk.starts[0] != want {
		t.Fatalf("starts = %+v", f.lk.starts)
	}
	if *v.EgressID != "EG_1" || v.Status != "starting" || v.Platform != "youtube" || *v.Name != "Mi canal" {
		t.Fatalf("view = %+v", v)
	}
	if *v.StreamID != sid || v.Room != room || v.Retries != 0 || v.EndedAt != nil || v.Error != nil {
		t.Fatalf("view = %+v", v)
	}
}

func TestNSimultaneousDestinations(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	f.add(t, AddInput{Platform: sp("twitch"), Key: "live_1"})
	f.add(t, AddInput{URL: "rtmp://custom.example.com/app/k"})
	list, err := f.svc.List(bg, "live", sid)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || len(f.lk.starts) != 3 {
		t.Fatalf("list=%d starts=%d", len(list), len(f.lk.starts))
	}
	ids := map[string]bool{}
	for _, v := range list {
		ids[*v.EgressID] = true
	}
	if len(ids) != 3 || list[0].Platform != "custom" { // newest first
		t.Fatalf("list = %+v", list)
	}
}

func TestStartedCallbackMasked(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	ev := f.cb.named("restream_started")
	if len(ev) != 1 {
		t.Fatalf("events = %+v", f.cb.events)
	}
	p := ev[0].payload
	if p["url"] != "rtmp://a.rtmp.youtube.com/live2/abcd…" || p["egressId"] != "EG_1" || p["status"] != "starting" || p["name"] != nil {
		t.Fatalf("payload = %+v", p)
	}
	b, _ := json.Marshal(f.cb.events)
	if strings.Contains(string(b), key) {
		t.Fatal("callback leaked the stream key")
	}
}

func TestDuplicateIs409AndCap(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	_, err := f.svc.Add(bg, "live", sid, AddInput{Platform: sp("youtube"), Key: key})
	if status(err) != 409 || !strings.Contains(err.Error(), "destination already active for room 'live-room1' (rtmp://a.rtmp.youtube.com/live2/abcd…)") {
		t.Fatalf("err = %v", err)
	}
	for i := 1; i < maxTargetsPerRoom; i++ {
		f.add(t, AddInput{Platform: sp("twitch"), Key: fmt.Sprintf("k%d", i)})
	}
	_, err = f.svc.Add(bg, "live", sid, AddInput{Platform: sp("twitch"), Key: "k-over"})
	if status(err) != 400 || err.Error() != "room 'live-room1' already has 10 live destinations" {
		t.Fatalf("err = %v", err)
	}
}

func TestStreamResolution(t *testing.T) {
	f := newFixture(t)
	f.svc.streams = fakeStreams{nil}
	_, err := f.svc.Add(bg, "live", "nope", AddInput{Platform: sp("youtube"), Key: key})
	if status(err) != 404 || err.Error() != "stream 'nope' not found" {
		t.Fatalf("err = %v", err)
	}
	f.svc.streams = fakeStreams{&streams.StreamRecord{Room: "  "}}
	_, err = f.svc.List(bg, "live", "x")
	if status(err) != 400 || err.Error() != "stream 'x' has no room to restream" {
		t.Fatalf("err = %v", err)
	}
}

func TestAddErrors(t *testing.T) {
	f := newFixture(t)
	_, err := f.svc.Add(bg, "live", sid, AddInput{Platform: sp("myspace")})
	if status(err) != 400 || err.Error() != "platform must be one of: youtube, twitch, facebook, custom" {
		t.Fatalf("err = %v", err)
	}
	_, err = f.svc.Add(bg, "live", sid, AddInput{Platform: sp("youtube")})
	if status(err) != 400 || err.Error() != "stream key is required for YouTube Live" {
		t.Fatalf("err = %v", err)
	}
	f.lk.startErr = errors.New("boom")
	_, err = f.svc.Add(bg, "live", sid, AddInput{Platform: sp("youtube"), Key: key})
	if status(err) != 500 || err.Error() != "failed to start restream: boom" {
		t.Fatalf("err = %v", err)
	}
}

func TestViewsNeverCarryTheKey(t *testing.T) {
	f := newFixture(t)
	v := f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	list, _ := f.svc.List(bg, "live", sid)
	for _, x := range []any{v, list} {
		b, _ := json.Marshal(x)
		if strings.Contains(string(b), key) || strings.Contains(string(b), `"url"`) {
			t.Fatalf("view leaked: %s", b)
		}
	}
	if v.URLMasked != "rtmp://a.rtmp.youtube.com/live2/abcd…" {
		t.Fatal(v.URLMasked)
	}
}

func TestListUpgradesStartingToActive(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	f.lk.active = []livekit.StreamEgressInfo{{EgressID: "EG_1", Status: "EGRESS_ACTIVE"}}
	list, _ := f.svc.List(bg, "live", sid)
	if list[0].Status != "active" {
		t.Fatalf("status = %s", list[0].Status)
	}
}

func TestRemoveStopsOne(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	f.add(t, AddInput{Platform: sp("twitch"), Key: "live_1"})
	v, err := f.svc.Remove(bg, "live", sid, " EG_1 ")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.lk.stops) != 1 || f.lk.stops[0] != "EG_1" || v.Status != "stopped" || v.EndedAt == nil {
		t.Fatalf("stops=%v view=%+v", f.lk.stops, v)
	}
	ev := f.cb.named("restream_stopped")
	if len(ev) != 1 || ev[0].payload["reason"] != "stopped_by_user" || ev[0].payload["egressId"] != "EG_1" {
		t.Fatalf("events = %+v", ev)
	}
	list, _ := f.svc.List(bg, "live", sid)
	if len(list) != 1 || *list[0].EgressID != "EG_2" {
		t.Fatalf("remaining = %+v", list)
	}
	// stopEgress failing is tolerated (the row is stopped anyway).
	f.lk.stopErr = errors.New("gone")
	if _, err := f.svc.Remove(bg, "live", sid, "EG_2"); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveUnknown(t *testing.T) {
	f := newFixture(t)
	_, err := f.svc.Remove(bg, "live", sid, "EG_404")
	if status(err) != 404 || err.Error() != "restream destination 'EG_404' not found for stream 'live-room1/pub1'" {
		t.Fatalf("err = %v", err)
	}
	_, err = f.svc.Remove(bg, "live", sid, "  ")
	if status(err) != 400 || err.Error() != "egress id is required" {
		t.Fatalf("err = %v", err)
	}
}

func TestNoDoubleStoppedAfterManualStop(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	if _, err := f.svc.Remove(bg, "live", sid, "EG_1"); err != nil {
		t.Fatal(err)
	}
	_ = f.svc.OnEgressEvent(bg, "live", "EG_1", "EGRESS_COMPLETE")
	if n := len(f.cb.named("restream_stopped")); n != 1 {
		t.Fatalf("restream_stopped fired %d times", n)
	}
}

func TestWebhookTransitions(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	f.add(t, AddInput{Platform: sp("twitch"), Key: "live_1"})
	f.add(t, AddInput{URL: "rtmp://c.example.com/app/k"})

	_ = f.svc.OnEgressEvent(bg, "live", "EG_1", "EGRESS_ACTIVE")
	_ = f.svc.OnEgressEvent(bg, "live", "EG_2", "EGRESS_ACTIVE")
	// One endpoint failing never takes down the others.
	_ = f.svc.OnEgressEvent(bg, "live", "EG_2", "EGRESS_FAILED")
	_ = f.svc.OnEgressEvent(bg, "live", "EG_3", "EGRESS_COMPLETE")

	byID := map[string]RestreamTargetView{}
	list, _ := f.svc.List(bg, "live", sid)
	for _, v := range list {
		byID[*v.EgressID] = v
	}
	if byID["EG_1"].Status != "active" || byID["EG_2"].Status != "failed" || *byID["EG_2"].Error != "egress egress_failed" {
		t.Fatalf("list = %+v", list)
	}
	if _, ok := byID["EG_3"]; ok {
		t.Fatal("completed endpoint should be stopped (omitted)")
	}
	failed := f.cb.named("restream_failed")
	if len(failed) != 1 || failed[0].payload["willRetry"] != true || failed[0].payload["retries"] != 0.0 || failed[0].payload["error"] != "egress egress_failed" {
		t.Fatalf("failed = %+v", failed)
	}
	stopped := f.cb.named("restream_stopped")
	if len(stopped) != 1 || stopped[0].payload["reason"] != "completed" {
		t.Fatalf("stopped = %+v", stopped)
	}
	if f.lk.stops != nil {
		t.Fatal("webhook path must not call stopEgress")
	}
	// LIMIT_REACHED is surfaced but not retried.
	_ = f.svc.OnEgressEvent(bg, "live", "EG_1", "EGRESS_LIMIT_REACHED")
	if last := f.cb.named("restream_failed"); last[len(last)-1].payload["willRetry"] != false || len(f.timers) != 1 {
		t.Fatalf("limit reached: %+v timers=%d", last, len(f.timers))
	}
	// ABORTED on a failed row is ignored.
	_ = f.svc.OnEgressEvent(bg, "live", "EG_2", "EGRESS_ABORTED")
	if len(f.cb.named("restream_stopped")) != 1 {
		t.Fatal("aborted after failed must not fire restream_stopped")
	}
}

func TestIgnoresForeignEgressAndResolvesAppFromMap(t *testing.T) {
	f := newFixture(t)
	if err := f.svc.OnEgressEvent(bg, "live", "EG_recording", "EGRESS_COMPLETE"); err != nil || len(f.cb.events) != 0 {
		t.Fatal("foreign egress must be a no-op")
	}
	if err := f.svc.OnEgressEvent(bg, "", "EG_unknown", "EGRESS_ACTIVE"); err != nil {
		t.Fatal(err)
	}
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	_ = f.svc.OnEgressEvent(bg, "", "EG_1", "EGRESS_ACTIVE")
	list, _ := f.svc.List(bg, "live", sid)
	if list[0].Status != "active" {
		t.Fatalf("status = %s", list[0].Status)
	}
}

func TestRetryRelaunchesWithBackoff(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	_ = f.svc.OnEgressEvent(bg, "live", "EG_1", "EGRESS_FAILED")
	if len(f.lk.starts) != 1 || len(f.delays) != 1 || f.delays[0] != 5*time.Second {
		t.Fatalf("starts=%d delays=%v", len(f.lk.starts), f.delays)
	}
	f.fire()
	want := livekit.StartStreamEgressInput{AppName: "live", RoomName: room, RtmpURL: "rtmp://a.rtmp.youtube.com/live2/" + key}
	if len(f.lk.starts) != 2 || f.lk.starts[1] != want {
		t.Fatalf("starts = %+v", f.lk.starts)
	}
	list, _ := f.svc.List(bg, "live", sid)
	if *list[0].EgressID != "EG_2" || list[0].Status != "starting" || list[0].Retries != 1 || list[0].Error != nil {
		t.Fatalf("after retry = %+v", list[0])
	}
	// The next failure backs off exponentially (5s · 2^retries).
	_ = f.svc.OnEgressEvent(bg, "live", "EG_2", "EGRESS_FAILED")
	if f.delays[1] != 10*time.Second {
		t.Fatalf("delays = %v", f.delays)
	}
}

func TestRetryFailureBumpsAndStopsAtLimit(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	_ = f.svc.OnEgressEvent(bg, "live", "EG_1", "EGRESS_FAILED")
	f.lk.startErr = errors.New("still down")
	for i := 0; i < 5; i++ {
		f.fire()
	}
	if got := len(f.lk.starts); got != 1+retryLimit {
		t.Fatalf("relaunch attempts = %d", got-1)
	}
	row, _ := f.repo.ByEgressID(bg, "live", "EG_1")
	if row.Retries != retryLimit || row.Status != "failed" {
		t.Fatalf("row = %+v", row)
	}
}

func TestNoRetryWhenStoppedMeanwhile(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	_ = f.svc.OnEgressEvent(bg, "live", "EG_1", "EGRESS_FAILED")
	row, _ := f.repo.ByEgressID(bg, "live", "EG_1")
	_ = f.repo.SetStatus(bg, "live", row.ID, "stopped", nil)
	f.fire()
	if len(f.lk.starts) != 1 {
		t.Fatal("stopped endpoint must not be relaunched")
	}
}

func TestPerAppIsolation(t *testing.T) {
	f := newFixture(t)
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	rows, err := f.repo.ListByRoom(bg, "other", room)
	if err != nil || len(rows) != 0 {
		t.Fatalf("other app rows = %v %v", rows, err)
	}
	list, _ := f.svc.List(bg, "other", sid)
	if len(list) != 0 {
		t.Fatal("other app sees destinations")
	}
	if _, err := f.svc.Remove(bg, "other", sid, "EG_1"); status(err) != 404 {
		t.Fatalf("err = %v", err)
	}
}

func TestCloseCancelsRetries(t *testing.T) {
	f := newFixture(t)
	f.svc.Close()
	f.add(t, AddInput{Platform: sp("youtube"), Key: key})
	_ = f.svc.OnEgressEvent(bg, "live", "EG_1", "EGRESS_FAILED")
	if len(f.timers) != 0 {
		t.Fatal("closed service scheduled a retry")
	}
}

// ---------------------------------------------------------------------------
// controller (AddRestreamDto)
// ---------------------------------------------------------------------------

func TestAddDtoMessages(t *testing.T) {
	b := validate.MustParse(`{"platform":"myspace","url":"http://x","key":5,"name":7,"layout":false}`)
	addRules(b)
	want := []string{
		"platform must be one of the following values: youtube, twitch, facebook, custom",
		"url must start with rtmp:// or rtmps://",
		"key must be shorter than or equal to 500 characters", "key must be a string",
		"name must be shorter than or equal to 120 characters", "name must be a string",
		"layout must be shorter than or equal to 100 characters", "layout must be a string",
	}
	if got := b.Messages(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("messages = %q", got)
	}
	b = validate.MustParse(`{"platform":null,"url":null}`)
	if addRules(b); b.Err() != nil {
		t.Fatal("null optional fields must validate")
	}
}
