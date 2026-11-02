package healthworker

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/streamhealth"
)

// 3.4 additions (no Node counterpart): remote probes through edge/CDN bases
// (an in-process httptest edge mirroring the origin's disk) and the core's
// "source has no audio" fact (stream_sources, written by the real store).

func TestParseEdgeBases(t *testing.T) {
	got := ParseEdgeBases(" edge1=https://cdn1.example.com/ , https://cdn2.example.com:8443/base/?x=1\n" +
		"ftp://nope, not a url, edge1=https://dup.example.com, we!rd=http://10.0.0.9")
	want := []EdgeBase{{"edge1", "https://cdn1.example.com"}, {"cdn2.example.com:8443", "https://cdn2.example.com:8443/base"},
		{"we_rd", "http://10.0.0.9"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v", got)
	}
	if l := ParseEdgeBases([]any{"a=http://a", 3, "http://b"}); len(l) != 2 || l[1].Name != "b" {
		t.Fatalf("list: %+v", l)
	}
	for _, v := range []any{"", nil, y.Undefined, 5.0} {
		if l := ParseEdgeBases(v); len(l) != 0 {
			t.Fatalf("%v → %+v", v, l)
		}
	}
	if u := (EdgeBase{"e", "https://cdn"}).PlaylistURL("my app", "r-1"); u != "https://cdn/hls/my%20app/r-1/index.m3u8" {
		t.Fatal(u)
	}
}

func TestRemoteSegmentURL(t *testing.T) {
	const pl = "https://cdn/hls/live/r/index.m3u8?st=tok"
	for uri, want := range map[string]string{
		"s1.ts":                     "https://cdn/hls/live/r/s1.ts",
		"s1.ts?st=x":                "https://cdn/hls/live/r/s1.ts?st=x",
		"/hls/live/r/s2.ts":         "https://cdn/hls/live/r/s2.ts",
		"https://cdn/x/s3.ts":       "https://cdn/x/s3.ts",
		"https://evil.example/a.ts": "",
		"http://cdn/a.ts":           "",
		"":                          "",
	} {
		if got := remoteSegmentURL(pl, uri); got != want {
			t.Errorf("%q → %q, want %q", uri, got, want)
		}
	}
}

// recMedia is fakeMedia that records the binaries run and the files probed.
type recMedia struct {
	mu     sync.Mutex
	volume string
	bins   []string
	files  []string
}

func (f *recMedia) run(_ context.Context, bin string, args []string) (string, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bins = append(f.bins, bin)
	file := args[len(args)-1]
	if bin == "ffmpeg" {
		file = args[3]
	}
	if _, err := os.Stat(file); err != nil {
		file = "MISSING:" + file
	}
	f.files = append(f.files, file)
	if bin == "ffprobe" {
		return avProbe, ""
	}
	return "", f.volume
}

func (f *recMedia) count(bin string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, b := range f.bins {
		if b == bin {
			n++
		}
	}
	return n
}

func lastOverview(t *testing.T, c *capture, n int) map[string]map[string]any {
	t.Helper()
	waitFor(t, func() bool { c.mu.Lock(); defer c.mu.Unlock(); return len(c.ingest) >= n })
	c.mu.Lock()
	defer c.mu.Unlock()
	var ov struct {
		Streams []map[string]any `json:"streams"`
	}
	if err := json.Unmarshal([]byte(c.ingest[len(c.ingest)-1]), &ov); err != nil {
		t.Fatal(err)
	}
	out := map[string]map[string]any{}
	for _, s := range ov.Streams {
		out[s["room"].(string)] = s
	}
	return out
}

func TestWorkerRemoteProbe(t *testing.T) {
	root := t.TempDir()
	hls := filepath.Join(root, "hls")
	var down atomic.Bool
	var segGets atomic.Int32
	files := http.StripPrefix("/hls/live/", http.FileServer(http.Dir(hls)))
	edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if down.Load() {
			http.Error(w, "bad gateway", http.StatusBadGateway)
			return
		}
		if strings.HasSuffix(r.URL.Path, ".ts") {
			segGets.Add(1)
		}
		files.ServeHTTP(w, r)
	}))
	t.Cleanup(edge.Close)
	var cap capture
	srv := cap.server(t)
	env := map[string]string{"HEALTH_APP": "live", "HEALTH_HLS_DIR": hls, "HEALTH_DATA_DIR": filepath.Join(root, "sh"),
		"HEALTH_CONFIG_JSON":   `{"sample_interval_sec":2,"stall_sec":4,"edge_hls_bases":"edge1=` + edge.URL + `/"}`,
		"STREAMHUB_EVENTS_URL": srv.URL + "/events", "STREAMHUB_INGEST_URL": srv.URL + "/live", "STREAMHUB_INGEST_TOKEN": "tok"}
	var out bytes.Buffer
	now := time.UnixMilli(1_000_000)
	media := &recMedia{volume: "mean_volume: -20.0 dB\n"}
	w := newTestWorker(t, env, &fakeMedia{}, &out, &now)
	w.o.Run = media.run
	room := filepath.Join(hls, "live-cam")
	writePlaylist(t, room, 0, []string{"s0.ts", "s1.ts"}, false)
	ctx := context.Background()

	w.tick(ctx)
	if !strings.Contains(out.String(), "room discovered: live-cam@edge1 via "+edge.URL+"/hls/live/live-cam/index.m3u8\n") {
		t.Fatalf("log: %s", out.String())
	}
	if n := segGets.Load(); n != 1 {
		t.Fatalf("only the newest new segment is fetched, got %d GETs", n)
	}
	ov := lastOverview(t, &cap, 1)
	o, r := ov["live-cam"], ov["live-cam@edge1"]
	if o == nil || r == nil || o["status"] != "healthy" || r["status"] != "healthy" {
		t.Fatalf("overview: %v", ov)
	}
	if _, ok := o["via"]; ok {
		t.Fatal("origin snapshot must not carry remote fields")
	}
	if r["origin"] != "live-cam" || r["via"] != "edge1" || r["url"] != edge.URL+"/hls/live/live-cam/index.m3u8" || r["error"] != nil {
		t.Fatalf("remote: %v", r)
	}
	// the remote deep probe ran on a downloaded copy, removed afterwards
	media.mu.Lock()
	var tmp []string
	for _, f := range media.files {
		if strings.HasPrefix(f, "MISSING:") {
			t.Fatalf("probe on a missing file: %v", media.files)
		}
		if !strings.HasPrefix(f, hls) {
			tmp = append(tmp, f)
		}
	}
	media.mu.Unlock()
	if len(tmp) != 2 || !strings.HasSuffix(tmp[0], ".ts") { // ffprobe + volumedetect
		t.Fatalf("remote files: %v", tmp)
	}
	if _, err := os.Stat(tmp[0]); err == nil {
		t.Fatal("the downloaded segment must be removed")
	}
	if m := r["metrics"].(map[string]any); m["measuredKbps"] != 1000.0 || m["meanDb"] != -20.0 {
		t.Fatalf("remote metrics: %v", m)
	}

	// edge down: the origin keeps advancing (healthy), the edge stalls
	down.Store(true)
	for i := 1; i <= 3; i++ {
		now = now.Add(2 * time.Second)
		writePlaylist(t, room, i, []string{"s" + itoa(i) + ".ts", "s" + itoa(i+1) + ".ts"}, false)
		w.tick(ctx)
	}
	ov = lastOverview(t, &cap, 4)
	if ov["live-cam"]["status"] != "healthy" || ov["live-cam@edge1"]["status"] != "critical" || ov["live-cam@edge1"]["error"] != "HTTP 502" {
		t.Fatalf("overview: %v", ov)
	}
	waitFor(t, func() bool { cap.mu.Lock(); defer cap.mu.Unlock(); return len(cap.events) >= 2 })
	cap.mu.Lock()
	evs := append([]string{}, cap.events...)
	cap.mu.Unlock()
	want := []string{
		`{"event":"health.stalled","room":"live-cam","data":{"stalledForSec":4,"via":"edge1"}}`,
		`{"event":"health.degraded","room":"live-cam","data":{"status":"critical","reasons":["stalled"],"via":"edge1"}}`,
	}
	if !reflect.DeepEqual(evs, want) {
		t.Fatalf("events:\n%s", strings.Join(evs, "\n"))
	}
	if !strings.Contains(out.String(), `event health.stalled room=live-cam@edge1 {"stalledForSec":4,"via":"edge1"}`) {
		t.Fatalf("log: %s", out.String())
	}
	// back up: the first good fetch is a plain advance (no false "dropped")
	down.Store(false)
	now = now.Add(2 * time.Second)
	w.tick(ctx)
	if m := lastOverview(t, &cap, 5)["live-cam@edge1"]["metrics"].(map[string]any); m["droppedSegments"] != 1.0 || m["secondsSinceAdvance"] != 0.0 {
		// s2 rotated out of the window while the edge was down: a real
		// segment the edge never served — reported, as on the origin
		t.Fatalf("recovery metrics: %v", m)
	}

	// room gone from the origin's disk → its remote probe goes too
	_ = os.RemoveAll(room)
	now = now.Add(2 * time.Second)
	w.tick(ctx)
	if len(w.rooms) != 0 || !strings.Contains(out.String(), "room gone: live-cam@edge1\n") {
		t.Fatalf("rooms %v log: %s", w.order, out.String())
	}
}

func TestReadRoomSources(t *testing.T) {
	appDir := t.TempDir()
	st := streamhealth.NewStore(nil)
	defer st.CloseAll()
	ctx := context.Background()
	for _, c := range []struct {
		room         string
		audio, video bool
	}{{"cam-1", false, true}, {"cam-2", true, true}, {"gone", true, true}, {"gone", false, false}} {
		if err := st.PutSource(ctx, "live", appDir, c.room, c.audio, c.video); err != nil {
			t.Fatal(err)
		}
	}
	m := ReadRoomSources(ctx, streamhealth.FileFor(appDir))
	if !reflect.DeepEqual(m, map[string]bool{"cam-1": false, "cam-2": true}) {
		t.Fatalf("%v", m)
	}
	// a pre-3.4 db (no stream_sources table) and no db at all = unknown
	old := filepath.Join(t.TempDir(), "stream-health.db")
	_ = os.WriteFile(old, nil, 0o644)
	if len(ReadRoomSources(ctx, old)) != 0 || len(ReadRoomSources(ctx, filepath.Join(t.TempDir(), "nope.db"))) != 0 {
		t.Fatal("unknown")
	}
}

func TestStateNoAudioSource(t *testing.T) {
	s := NewRoomState()
	silent := func(x *Sample) { x.MeanDb = ptr(-91.0) }
	Evaluate(s, good(silent), T, 0)
	if r := Evaluate(s, good(silent), T, 20_000); r.Status != "degraded" || !has(names(r), "health.audio_lost") {
		t.Fatalf("%+v", r)
	}
	// the core now says the source carries no audio: detector off, the open
	// audio_lost closes, then the rollup recovers through the hysteresis
	none := func(x *Sample) { x.MeanDb, x.HasAudioTrack, x.NoAudioSource = ptr(-91.0), ptr(true), true }
	r := Evaluate(s, good(none), T, 30_000)
	if !reflect.DeepEqual(names(r), []string{"health.audio_recovered"}) || r.Events[0].Data.Get("reason") != "no_audio_source" || len(r.Reasons) != 0 {
		t.Fatalf("%+v", r)
	}
	if r = Evaluate(s, good(none), T, 40_000); !reflect.DeepEqual(names(r), []string{"health.recovered"}) || r.Status != "healthy" {
		t.Fatalf("%+v", r)
	}
	// no track at all (passthrough-style) is not audio_missing either
	s = NewRoomState()
	for i := 0; i < 5; i++ {
		if r := Evaluate(s, good(func(x *Sample) { x.HasAudioTrack, x.MeanDb, x.NoAudioSource = ptr(false), nil, true }), T, float64(i)*10_000); len(r.Events) != 0 || r.Status != "healthy" {
			t.Fatalf("%+v", r)
		}
	}
}

func TestWorkerNoAudioSource(t *testing.T) {
	root := t.TempDir()
	hls := filepath.Join(root, "hls")
	appDir := filepath.Join(root, "app")
	st := streamhealth.NewStore(nil)
	defer st.CloseAll()
	ctx := context.Background()
	if err := st.PutSource(ctx, "live", appDir, "live-cam", false, true); err != nil {
		t.Fatal(err)
	}
	var cap capture
	srv := cap.server(t)
	env := map[string]string{"HEALTH_APP": "live", "HEALTH_HLS_DIR": hls, "HEALTH_DATA_DIR": filepath.Dir(streamhealth.FileFor(appDir)),
		"HEALTH_CONFIG_JSON":   `{"sample_interval_sec":2,"silence_duration_sec":1}`,
		"STREAMHUB_EVENTS_URL": srv.URL + "/events", "STREAMHUB_INGEST_URL": srv.URL + "/live", "STREAMHUB_INGEST_TOKEN": "tok"}
	now := time.UnixMilli(1_000_000)
	media := &recMedia{volume: "mean_volume: -91.0 dB\n"} // the egress's silent AAC
	w := newTestWorker(t, env, &fakeMedia{}, &bytes.Buffer{}, &now)
	w.o.Run = media.run
	room := filepath.Join(hls, "live-cam")
	for i := 0; i < 4; i++ {
		writePlaylist(t, room, i, []string{"s" + itoa(i) + ".ts", "s" + itoa(i+1) + ".ts"}, false)
		w.tick(ctx)
		now = now.Add(2 * time.Second)
	}
	s := lastOverview(t, &cap, 4)["live-cam"]
	facts := s["facts"].(map[string]any)
	if s["status"] != "healthy" || facts["audioSource"] != "none" || facts["audioCodec"] != "aac" {
		t.Fatalf("snapshot: %v", s)
	}
	if media.count("ffmpeg") != 0 {
		t.Fatal("no audio source → no volumedetect decode")
	}
	cap.mu.Lock()
	n := len(cap.events)
	cap.mu.Unlock()
	if n != 0 {
		t.Fatalf("events: %v", cap.events)
	}

	// the source starts publishing audio: the silence detector is back on
	if err := st.PutSource(ctx, "live", appDir, "live-cam", true, true); err != nil {
		t.Fatal(err)
	}
	for i := 4; i < 7; i++ {
		writePlaylist(t, room, i, []string{"s" + itoa(i) + ".ts", "s" + itoa(i+1) + ".ts"}, false)
		w.tick(ctx)
		now = now.Add(2 * time.Second)
	}
	waitFor(t, func() bool { cap.mu.Lock(); defer cap.mu.Unlock(); return len(cap.events) >= 2 })
	cap.mu.Lock()
	first := cap.events[0]
	cap.mu.Unlock()
	if !strings.HasPrefix(first, `{"event":"health.audio_lost","room":"live-cam","data":{"reason":"silence"`) {
		t.Fatalf("events: %v", cap.events)
	}
	if s := lastOverview(t, &cap, 7)["live-cam"]; s["facts"].(map[string]any)["audioSource"] != "track" {
		t.Fatalf("snapshot: %v", s)
	}
}
