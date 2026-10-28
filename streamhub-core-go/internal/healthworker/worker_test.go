package healthworker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// The orchestration loop (main.js) over a temp HLS tree, a fake
// ffprobe/ffmpeg and a capturing ingest/events server.

type capture struct {
	mu     sync.Mutex
	events []string
	ingest []string
	tokens []string
}

func (c *capture) server(t *testing.T) *httptest.Server {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		c.mu.Lock()
		defer c.mu.Unlock()
		c.tokens = append(c.tokens, r.Header.Get("x-plugin-ingest-token")+"|"+r.Header.Get("content-type"))
		if strings.HasSuffix(r.URL.Path, "/events") {
			c.events = append(c.events, string(b))
		} else {
			c.ingest = append(c.ingest, string(b))
		}
	}))
	t.Cleanup(s.Close)
	return s
}

const avProbe = `{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720,"avg_frame_rate":"25/1","start_time":"1.400"},
{"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,"start_time":"1.412"}],"format":{"bit_rate":"1500000"}}`

type fakeMedia struct{ volume string }

func (f *fakeMedia) run(_ context.Context, bin string, _ []string) (string, string) {
	if bin == "ffprobe" {
		return avProbe, ""
	}
	return "", f.volume
}

func writePlaylist(t *testing.T, dir string, seq int, segs []string, endlist bool) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:" + itoa(seq) + "\n")
	for _, s := range segs {
		b.WriteString("#EXTINF:2.000,\n" + s + "\n")
		_ = os.WriteFile(filepath.Join(dir, s), bytes.Repeat([]byte{0}, 250_000), 0o644)
	}
	if endlist {
		b.WriteString("#EXT-X-ENDLIST\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "index.m3u8"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newTestWorker(t *testing.T, env map[string]string, media *fakeMedia, out io.Writer, now *time.Time) *worker {
	t.Helper()
	o := Options{Getenv: func(k string) (string, bool) { v, ok := env[k]; return v, ok }, Stdout: out, Stderr: out,
		Client: http.DefaultClient, Now: func() time.Time { return *now }, Run: media.run}
	w := &worker{o: o, app: env["HEALTH_APP"], hlsDir: env["HEALTH_HLS_DIR"], dbFile: filepath.Join(env["HEALTH_DATA_DIR"], "stream-health.db"),
		ffprobe: "ffprobe", ffmpeg: "ffmpeg", eventsURL: env["STREAMHUB_EVENTS_URL"], ingestURL: env["STREAMHUB_INGEST_URL"],
		token: env["STREAMHUB_INGEST_TOKEN"], appConfig: ParseAppConfig(env["HEALTH_CONFIG_JSON"], true), rooms: map[string]*roomRT{},
		events: make(chan []byte, 256)}
	go func() {
		for body := range w.events {
			w.post(context.Background(), w.eventsURL, body)
		}
	}()
	return w
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200 && !cond(); i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if !cond() {
		t.Fatal("timed out")
	}
}

func TestWorkerLoop(t *testing.T) {
	root := t.TempDir()
	hls := filepath.Join(root, "hls")
	var cap capture
	srv := cap.server(t)
	env := map[string]string{"HEALTH_APP": "live", "HEALTH_HLS_DIR": hls, "HEALTH_DATA_DIR": filepath.Join(root, "sh"),
		"HEALTH_CONFIG_JSON":   `{"sample_interval_sec":2,"stall_sec":4,"silence_duration_sec":1}`,
		"STREAMHUB_EVENTS_URL": srv.URL + "/events", "STREAMHUB_INGEST_URL": srv.URL + "/live", "STREAMHUB_INGEST_TOKEN": "tok"}
	var out bytes.Buffer
	now := time.UnixMilli(1_000_000)
	media := &fakeMedia{volume: "mean_volume: -20.0 dB\nmax_volume: -3.0 dB\n"}
	w := newTestWorker(t, env, media, &out, &now)
	room := filepath.Join(hls, "live-cam")
	writePlaylist(t, room, 0, []string{"s0.ts", "s1.ts"}, false)
	_ = os.MkdirAll(filepath.Join(hls, "no-playlist"), 0o755)

	ctx := context.Background()
	w.tick(ctx)
	if !strings.Contains(out.String(), "[health-worker] room discovered: live-cam\n") || strings.Contains(out.String(), "no-playlist") {
		t.Fatalf("log: %s", out.String())
	}
	waitFor(t, func() bool { cap.mu.Lock(); defer cap.mu.Unlock(); return len(cap.ingest) == 1 })
	var ov struct {
		Room    string           `json:"room"`
		Streams []map[string]any `json:"streams"`
	}
	_ = json.Unmarshal([]byte(cap.ingest[0]), &ov)
	if ov.Room != "overview" || len(ov.Streams) != 1 || ov.Streams[0]["status"] != "healthy" {
		t.Fatalf("overview: %s", cap.ingest[0])
	}
	snap, _ := y.ParseJSON([]byte(cap.ingest[0]))
	s0 := snap.(*y.Map).Get("streams").([]any)[0].(*y.Map)
	if strings.Join(s0.Keys(), ",") != "room,status,reasons,facts,metrics,ts" {
		t.Fatalf("snapshot keys: %v", s0.Keys())
	}
	if js, _ := y.Stringify(s0.Get("facts")); js != `{"videoCodec":"h264","width":1280,"height":720,"fps":25,"audioCodec":"aac","sampleRate":48000,"channels":2,"bitrateKbps":1500}` {
		t.Fatalf("facts: %s", js)
	}
	if js, _ := y.Stringify(s0.Get("metrics")); js != `{"measuredKbps":1000,"secondsSinceAdvance":0,"meanDb":-20,"desyncMs":12,"ccErrors":0,"droppedSegments":0,"discontinuityTags":0,"baselineKbps":1000}` {
		t.Fatalf("metrics: %s", js)
	}

	// silence → audio_lost (+ degraded); a stall → stalled + critical
	media.volume = "mean_volume: -91.0 dB\n"
	for i := 1; i <= 3; i++ {
		now = now.Add(2 * time.Second)
		writePlaylist(t, room, i, []string{"s" + itoa(i) + ".ts", "s" + itoa(i+1) + ".ts"}, false)
		w.tick(ctx)
	}
	for i := 0; i < 3; i++ {
		now = now.Add(2 * time.Second)
		w.tick(ctx)
	}
	waitFor(t, func() bool { cap.mu.Lock(); defer cap.mu.Unlock(); return len(cap.events) >= 3 })
	cap.mu.Lock()
	evs := append([]string{}, cap.events...)
	cap.mu.Unlock()
	want := []string{
		`{"event":"health.audio_lost","room":"live-cam","data":{"reason":"silence","silenceDb":-91,"silentForSec":2}}`,
		`{"event":"health.degraded","room":"live-cam","data":{"status":"degraded","reasons":["audio_silent"]}}`,
		`{"event":"health.stalled","room":"live-cam","data":{"stalledForSec":4}}`,
	}
	for i, e := range want {
		if i >= len(evs) || evs[i] != e {
			t.Fatalf("events:\n%s", strings.Join(evs, "\n"))
		}
	}
	if !strings.Contains(out.String(), `[health-worker] event health.stalled room=live-cam {"stalledForSec":4}`) {
		t.Fatalf("log: %s", out.String())
	}
	for _, tok := range cap.tokens {
		if tok != "tok|application/json" {
			t.Fatalf("headers: %s", tok)
		}
	}

	// ENDLIST → forgotten (and, as in Node, rediscovered on every tick)
	writePlaylist(t, room, 9, []string{"s9.ts"}, true)
	now = now.Add(2 * time.Second)
	w.tick(ctx)
	if len(w.rooms) != 0 {
		t.Fatal("endlist must forget the room")
	}
	// playlist gone → "room gone" only for a room still tracked
	writePlaylist(t, room, 10, []string{"s10.ts"}, false)
	now = now.Add(2 * time.Second)
	w.tick(ctx)
	_ = os.RemoveAll(room)
	now = now.Add(2 * time.Second)
	w.tick(ctx)
	if !strings.Contains(out.String(), "[health-worker] room gone: live-cam\n") {
		t.Fatalf("log: %s", out.String())
	}
}

func TestWorkerNoTokenNoPost(t *testing.T) {
	root := t.TempDir()
	var cap capture
	srv := cap.server(t)
	env := map[string]string{"HEALTH_APP": "live", "HEALTH_HLS_DIR": root, "HEALTH_DATA_DIR": root,
		"STREAMHUB_INGEST_URL": srv.URL + "/live"}
	now := time.UnixMilli(0)
	w := newTestWorker(t, env, &fakeMedia{}, io.Discard, &now)
	writePlaylist(t, filepath.Join(root, "r"), 0, []string{"a.ts"}, false)
	w.tick(context.Background())
	time.Sleep(20 * time.Millisecond)
	if len(cap.ingest) != 0 {
		t.Fatal("no token → no post")
	}
}

func TestRunMissingEnv(t *testing.T) {
	var errb bytes.Buffer
	code := Run(context.Background(), Options{Getenv: func(string) (string, bool) { return "", false }, Stdout: io.Discard, Stderr: &errb})
	if code != 2 || errb.String() != "[health-worker] HEALTH_APP / HEALTH_HLS_DIR missing — exiting\n" {
		t.Fatalf("%d %q", code, errb.String())
	}
}

func TestRunStartsAndStops(t *testing.T) {
	root := t.TempDir()
	env := map[string]string{"HEALTH_APP": "live", "HEALTH_HLS_DIR": root, "HEALTH_DATA_DIR": root, "HEALTH_CONFIG_JSON": `{"stall_sec":30,"x":[1]}`}
	var out bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	code := Run(ctx, Options{Getenv: func(k string) (string, bool) { v, ok := env[k]; return v, ok }, Stdout: &out, Stderr: &out})
	want := "[health-worker] starting app=live hls=" + root + " db=" + filepath.Join(root, "stream-health.db") +
		` config={"stall_sec":30,"x":[1]}` + "\n[health-worker] stopped\n"
	if code != 0 || out.String() != want {
		t.Fatalf("%d\n%s\nwant\n%s", code, out.String(), want)
	}
}

func TestSegmentPath(t *testing.T) {
	dir := t.TempDir()
	for uri, ok := range map[string]bool{"a.ts": true, "sub/a.ts?x=1": true, "../a.ts": false, "/etc/passwd": false,
		"https://cdn/a.ts": false, "HTTP://x/y": false, "": false, filepath.Join(dir, "abs.ts"): true, ".": false} {
		if got := segmentPath(dir, uri) != ""; got != ok {
			t.Errorf("segmentPath(%q) = %v", uri, got)
		}
	}
}
