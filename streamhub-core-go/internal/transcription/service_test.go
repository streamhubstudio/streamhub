package transcription

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/recording"
)

// Port of transcription.service.spec.ts. NO network, NO real ffmpeg/whisper:
// the runner and the OpenAI transport are fakes, the local-provider worker
// is the test writing the result file.

const app = "live"

type fakeApps struct {
	dir     string
	missing bool
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Get(_ context.Context, name string) (*contracts.AppRecord, error) {
	if f.missing {
		return nil, nil
	}
	return &contracts.AppRecord{ID: 1, Name: name}, nil
}
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(_ context.Context, name string) (*contracts.AppConfig, error) {
	return &contracts.AppConfig{Name: name, S3: contracts.S3Config{Provider: "minio", Bucket: "b", AccessKey: "k", SecretKey: "s"}}, nil
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (f *fakeApps) AppDir(string) string { return f.dir }

type upload struct {
	bucket, local, key, contentType string
}

type fakeS3 struct {
	mu      sync.Mutex
	uploads []upload
	fail    error
}

func (f *fakeS3) Upload(_ context.Context, cfg contracts.S3Config, local, key, ct string) (*contracts.S3UploadResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	f.uploads = append(f.uploads, upload{cfg.Bucket, local, key, ct})
	return &contracts.S3UploadResult{Key: key, Bucket: cfg.Bucket}, nil
}
func (f *fakeS3) PresignGet(_ context.Context, _ contracts.S3Config, key string, _ float64, _ *contracts.S3PresignOptions) (string, error) {
	return "https://s3.test/" + key + "?sig=test", nil
}
func (f *fakeS3) Delete(context.Context, contracts.S3Config, string) error         { return nil }
func (f *fakeS3) Exists(context.Context, contracts.S3Config, string) (bool, error) { return false, nil }

func (f *fakeS3) list() []upload {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]upload(nil), f.uploads...)
}

// recRunner: ffprobe → n audio streams; ffmpeg → writes the out file.
type recRunner struct {
	mu      sync.Mutex
	streams int
	ffmpeg  [][]string
	fail    bool
}

func (r *recRunner) run(_ context.Context, bin string, args []string, _ time.Duration) (string, error) {
	if bin == "ffprobe" {
		parts := make([]string, r.streams)
		for i := range parts {
			parts[i] = fmt.Sprintf(`{"index":%d}`, i)
		}
		return `{"streams":[` + strings.Join(parts, ",") + `]}`, nil
	}
	r.mu.Lock()
	r.ffmpeg = append(r.ffmpeg, args)
	r.mu.Unlock()
	if r.fail {
		return "", errors.New("ffmpeg exploded")
	}
	return "", os.WriteFile(args[len(args)-1], []byte("mp3-bytes"), 0o644)
}

func (r *recRunner) calls() [][]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]string(nil), r.ffmpeg...)
}

type rt func(*http.Request) (*http.Response, error)

func (f rt) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// openAI answers every transcription call with body(n) (n = 1-based call).
func openAI(status int, body func(n int) string) *http.Client {
	var mu sync.Mutex
	n := 0
	return &http.Client{Transport: rt(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		n++
		b := body(n)
		mu.Unlock()
		if r.URL.String() != "https://api.openai.com/v1/audio/transcriptions" || r.Header.Get("authorization") != "Bearer sk-test" {
			return nil, fmt.Errorf("unexpected request %s", r.URL)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(b)), Header: http.Header{}}, nil
	})}
}

func fixed(s string) func(int) string { return func(int) string { return s } }

type env struct {
	svc    *Service
	repo   *Repo
	vods   *recording.Vods
	plugs  *plugins.Repo
	reg    *plugins.Registry
	s3     *fakeS3
	runner *recRunner
	apps   *fakeApps
	appDir string
	seq    int
}

func newEnv(t *testing.T) *env {
	t.Helper()
	store, _, dir := testutil.Store(t)
	vendor, _ := filepath.Abs("../plugins/testdata/vendor")
	reg := plugins.NewRegistry(plugins.Paths{VendorRoot: vendor}, func(string) string { return "" }, testutil.Log())
	reg.Discover()
	if reg.GetMeta(PluginID) == nil {
		t.Fatal("transcription fixture meta not discovered")
	}
	e := &env{repo: NewRepo(store), vods: recording.NewVods(store.App), plugs: plugins.NewRepo(store), reg: reg,
		s3: &fakeS3{}, runner: &recRunner{streams: 1}, appDir: filepath.Join(dir, "apps", app)}
	e.apps = &fakeApps{dir: e.appDir}
	e.svc = New(Deps{Repo: e.repo, Vods: e.vods, Installs: e.plugs, Registry: reg, Apps: e.apps, S3: e.s3, Log: testutil.Log()})
	e.svc.Runner = e.runner.run
	e.svc.PollInterval = 10 * time.Millisecond
	e.svc.PollTimeout = 2 * time.Second
	return e
}

type seed struct {
	metatags string
	fileKey  *string
	streamID *string
}

// seedVod inserts a ready VOD whose localPath is a real dummy file.
func (e *env) seedVod(t *testing.T, o seed) int64 {
	t.Helper()
	ctx := context.Background()
	e.seq++
	local := filepath.Join(e.appDir, "recordings", fmt.Sprintf("rec-%d.mp4", e.seq))
	_ = os.MkdirAll(filepath.Dir(local), 0o755)
	if err := os.WriteFile(local, []byte("mp4"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := o.metatags
	if meta == "" {
		meta = `{"egressId":"EG_1","mode":"room-composite"}`
	}
	streamID := o.streamID
	if streamID == nil {
		streamID = sp("stream-a")
	}
	name, now := filepath.Base(local), jsx.ISO(time.Now())
	id, err := e.vods.Insert(ctx, app, recording.VodInsert{AppID: 1, StreamID: streamID, Room: sp("main"), Name: name,
		Status: "recording", LocalPath: &local, StartedAt: &now, MetatagsJSON: &meta})
	if err != nil {
		t.Fatal(err)
	}
	fk := any("rec-1.mp4")
	if o.fileKey != nil {
		fk = *o.fileKey
	}
	if err := e.vods.Update(ctx, app, id, (&recording.VodPatch{}).Set("status", "ready").Set("file_key", fk).Set("duration_s", 12.5)); err != nil {
		t.Fatal(err)
	}
	return id
}

// install installs (and enables) the plugin with config over defaults.
func (e *env) install(t *testing.T, enabled bool, kv ...any) {
	t.Helper()
	cfg := plugins.DefaultConfig(e.reg.GetMeta(PluginID)).Clone()
	for i := 0; i < len(kv); i += 2 {
		cfg.Set(kv[i].(string), kv[i+1])
	}
	if err := e.plugs.Install(context.Background(), app, PluginID, cfg, enabled); err != nil {
		t.Fatal(err)
	}
}

// waitForDone polls until the row is ready/failed.
func (e *env) waitForDone(t *testing.T, vodID int64) *Record {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		row, _ := e.repo.GetByVod(context.Background(), app, vodID)
		if row != nil && (row.Status == "ready" || row.Status == "failed") || time.Now().After(deadline) {
			// let the job's deferred cleanup + release finish
			for i := 0; i < 200 && e.svc.isRunning(key(app, vodID)); i++ {
				time.Sleep(5 * time.Millisecond)
			}
			return row
		}
		time.Sleep(15 * time.Millisecond)
	}
}

func wantHTTP(t *testing.T, err error, status int) {
	t.Helper()
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != status {
		t.Fatalf("want HTTP %d, got %v", status, err)
	}
}

var bg = context.Background()

func TestTriggerGuardsInstallEnable(t *testing.T) {
	e := newEnv(t)
	id := e.seedVod(t, seed{})
	_, err := e.svc.Trigger(bg, app, id)
	wantHTTP(t, err, 400)
	e.install(t, false)
	_, err = e.svc.Trigger(bg, app, id)
	wantHTTP(t, err, 400)
}

func TestTriggerGuardsVod(t *testing.T) {
	e := newEnv(t)
	e.install(t, true)
	_, err := e.svc.Trigger(bg, app, 999)
	wantHTTP(t, err, 404)
	local := filepath.Join(e.appDir, "recordings", "inflight.mp4")
	_ = os.MkdirAll(filepath.Dir(local), 0o755)
	_ = os.WriteFile(local, []byte("x"), 0o644)
	now := jsx.ISO(time.Now())
	id, err := e.vods.Insert(bg, app, recording.VodInsert{AppID: 1, StreamID: sp("s"), Room: sp("main"), Name: "inflight.mp4",
		Status: "recording", LocalPath: &local, StartedAt: &now})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.Trigger(bg, app, id)
	wantHTTP(t, err, 409)
}

func TestTriggerAlreadyRunning(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "local")
	id := e.seedVod(t, seed{})
	e.svc.PollTimeout = 300 * time.Millisecond
	if _, err := e.svc.Trigger(bg, app, id); err != nil {
		t.Fatal(err)
	}
	_, err := e.svc.Trigger(bg, app, id)
	wantHTTP(t, err, 409)
	row := e.waitForDone(t, id)
	if row.Status != "failed" || !strings.Contains(*row.Error, "worker") {
		t.Fatalf("%+v", row)
	}
}

func TestTriggerUnknownApp(t *testing.T) {
	e := newEnv(t)
	e.apps.missing = true
	_, err := e.svc.Trigger(bg, "ghost", 1)
	wantHTTP(t, err, 404)
}

func TestOpenAIFlow(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "sk-test")
	id := e.seedVod(t, seed{fileKey: sp("streamhub/live/rec-1.mp4")})
	e.svc.HTTP = openAI(200, fixed(`{"text":"hola mundo","language":"es","segments":[{"start":0,"end":1.5,"text":"hola"},{"start":1.5,"end":3,"text":"mundo"}]}`))
	q, err := e.svc.Trigger(bg, app, id)
	if err != nil || q.Status != "queued" {
		t.Fatalf("%+v %v", q, err)
	}
	row := e.waitForDone(t, id)
	if row.Status != "ready" || !is(row.Language, "es") || !is(row.Text, "hola\nmundo") {
		t.Fatalf("%+v %v", row, row.Error)
	}
	var segs []map[string]any
	_ = json.Unmarshal([]byte(*row.SegmentsJSON), &segs)
	if len(segs) != 2 {
		t.Fatalf("segments %s", *row.SegmentsJSON)
	}
	ups := e.s3.list()
	if len(ups) != 1 || ups[0].bucket != "b" || !strings.HasSuffix(ups[0].local, fmt.Sprintf("vod-%d.srt", id)) ||
		ups[0].key != "streamhub/live/rec-1.srt" || ups[0].contentType != "application/x-subrip" {
		t.Fatalf("uploads %+v", ups)
	}
	if !is(row.SrtKey, "streamhub/live/rec-1.srt") {
		t.Fatalf("srtKey %v", row.SrtKey)
	}
	vod, _ := e.vods.FindByID(bg, app, id)
	var tags struct {
		Transcript struct {
			SrtKey   string `json:"srtKey"`
			Language string `json:"language"`
		} `json:"transcript"`
		EgressID string `json:"egressId"`
	}
	_ = json.Unmarshal([]byte(*vod.MetatagsJSON), &tags)
	if tags.Transcript.SrtKey != "streamhub/live/rec-1.srt" || tags.Transcript.Language != "es" || tags.EgressID != "EG_1" {
		t.Fatalf("metatags %s", *vod.MetatagsJSON)
	}
	calls := e.runner.calls()
	if len(calls) != 1 || calls[0][5] != "0:a:0" {
		t.Fatalf("ffmpeg calls %v", calls)
	}
	// The local SRT + mp3 temps are cleaned up.
	if _, err := os.Stat(ups[0].local); !os.IsNotExist(err) {
		t.Fatal("local srt left behind")
	}
}

func TestOpenAIMultiTrackSpeakers(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "sk-test")
	id := e.seedVod(t, seed{})
	e.runner.streams = 2
	e.svc.HTTP = openAI(200, func(n int) string {
		return fmt.Sprintf(`{"text":"speech %d","language":"en","segments":[{"start":%d,"end":%d,"text":"speech %d"}]}`, n, n, n+1, n)
	})
	if _, err := e.svc.Trigger(bg, app, id); err != nil {
		t.Fatal(err)
	}
	row := e.waitForDone(t, id)
	if row.Status != "ready" || *row.SpeakersJSON != `["track-1","track-2"]` {
		t.Fatalf("%+v", row)
	}
	if !strings.Contains(*row.SegmentsJSON, `"speaker":"track-1"`) || strings.Index(*row.SegmentsJSON, "track-1") > strings.Index(*row.SegmentsJSON, "track-2") {
		t.Fatalf("segments %s", *row.SegmentsJSON)
	}
	calls := e.runner.calls()
	if len(calls) != 2 || calls[0][5] != "0:a:0" || calls[1][5] != "0:a:1" {
		t.Fatalf("calls %v", calls)
	}
}

func TestTrackModeSpeakerIsStreamID(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "sk-test")
	id := e.seedVod(t, seed{metatags: `{"egressId":"EG_1","mode":"track"}`, streamID: sp("cam-entrance")})
	e.svc.HTTP = openAI(200, fixed(`{"text":"one publisher","language":"en","segments":[{"start":0,"end":1,"text":"one publisher"}]}`))
	_, _ = e.svc.Trigger(bg, app, id)
	row := e.waitForDone(t, id)
	if row.Status != "ready" || *row.SpeakersJSON != `["cam-entrance"]` || !is(row.Text, "[cam-entrance] one publisher") {
		t.Fatalf("%+v", row)
	}
}

func TestOpenAIWithoutTimestamps(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "sk-test", "openaiModel", "gpt-4o-transcribe")
	id := e.seedVod(t, seed{})
	e.svc.HTTP = openAI(200, fixed(`{"text":"plain text only"}`))
	_, _ = e.svc.Trigger(bg, app, id)
	row := e.waitForDone(t, id)
	if row.Status != "ready" || *row.SegmentsJSON != `[{"start":0,"end":12.5,"text":"plain text only","speaker":null}]` {
		t.Fatalf("%+v %v", row, row.SegmentsJSON)
	}
}

func TestOpenAINoAPIKey(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "")
	id := e.seedVod(t, seed{})
	_, _ = e.svc.Trigger(bg, app, id)
	row := e.waitForDone(t, id)
	if row.Status != "failed" || !strings.Contains(*row.Error, "API key") || len(e.s3.list()) != 0 {
		t.Fatalf("%+v", row)
	}
}

func TestOpenAIHTTPError(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "sk-test")
	id := e.seedVod(t, seed{})
	e.svc.HTTP = openAI(429, fixed(`rate limited`))
	_, _ = e.svc.Trigger(bg, app, id)
	row := e.waitForDone(t, id)
	if row.Status != "failed" || *row.Error != "OpenAI transcription failed (HTTP 429): rate limited" {
		t.Fatalf("%+v %v", row, *row.Error)
	}
}

func TestS3UploadFailureKeepsTranscript(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "sk-test")
	id := e.seedVod(t, seed{})
	e.svc.HTTP = openAI(200, fixed(`{"text":"ok","language":"en","segments":[{"start":0,"end":1,"text":"ok"}]}`))
	e.s3.fail = errors.New("bucket down")
	_, _ = e.svc.Trigger(bg, app, id)
	row := e.waitForDone(t, id)
	if row.Status != "ready" || row.SrtKey != nil || !is(row.Text, "ok") {
		t.Fatalf("%+v", row)
	}
}

func waitFile(t *testing.T, p string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(p); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %s", p)
}

func TestLocalWorkerFlow(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "local", "model", "small", "language", "auto")
	id := e.seedVod(t, seed{})
	if _, err := e.svc.Trigger(bg, app, id); err != nil {
		t.Fatal(err)
	}
	jobPath := filepath.Join(e.appDir, "transcripts", "jobs", fmt.Sprintf("vod-%d.json", id))
	waitFile(t, jobPath)
	raw, _ := os.ReadFile(jobPath)
	var job struct {
		VodID  int64  `json:"vodId"`
		App    string `json:"app"`
		Model  string `json:"model"`
		Tracks []struct {
			Path    string  `json:"path"`
			Speaker *string `json:"speaker"`
		} `json:"tracks"`
	}
	_ = json.Unmarshal(raw, &job)
	if job.VodID != id || job.App != app || job.Model != "small" || len(job.Tracks) != 1 ||
		!regexp.MustCompile(`vod-\d+-a0\.mp3$`).MatchString(job.Tracks[0].Path) {
		t.Fatalf("job %s", raw)
	}
	// Play the worker: claim the job, write the result.
	if err := os.Rename(jobPath, jobPath+".working"); err != nil {
		t.Fatal(err)
	}
	result := filepath.Join(e.appDir, "transcripts", "results", fmt.Sprintf("vod-%d.json", id))
	_ = os.MkdirAll(filepath.Dir(result), 0o755)
	_ = os.WriteFile(result, []byte(fmt.Sprintf(`{"ok":true,"vodId":%d,"language":"en","tracks":[{"segments":[{"start":0,"end":2,"text":"local whisper"},{"start":2,"end":4,"text":"works offline"}]}]}`, id)), 0o644)
	row := e.waitForDone(t, id)
	if row.Status != "ready" || !is(row.Provider, "local") || !is(row.Language, "en") || !is(row.Text, "local whisper\nworks offline") {
		t.Fatalf("%+v", row)
	}
	if ups := e.s3.list(); len(ups) != 1 || ups[0].key != "rec-1.srt" || ups[0].contentType != "application/x-subrip" {
		t.Fatalf("uploads %+v", ups)
	}
	for _, p := range []string{result, jobPath + ".working"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s not cleaned up", p)
		}
	}
}

func TestLocalWorkerError(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "local")
	id := e.seedVod(t, seed{})
	_, _ = e.svc.Trigger(bg, app, id)
	waitFile(t, filepath.Join(e.appDir, "transcripts", "jobs", fmt.Sprintf("vod-%d.json", id)))
	result := filepath.Join(e.appDir, "transcripts", "results", fmt.Sprintf("vod-%d.json", id))
	_ = os.WriteFile(result, []byte(`{"ok":false,"error":"model download failed"}`), 0o644)
	row := e.waitForDone(t, id)
	if row.Status != "failed" || !is(row.Error, "model download failed") {
		t.Fatalf("%+v", row)
	}
}

func TestExtractionFailure(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "sk-test")
	id := e.seedVod(t, seed{})
	e.runner.fail = true
	_, _ = e.svc.Trigger(bg, app, id)
	row := e.waitForDone(t, id)
	if row.Status != "failed" || !strings.Contains(*row.Error, "audio extraction failed") || len(e.s3.list()) != 0 {
		t.Fatalf("%+v", row)
	}
}

func TestNoAudioStream(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "sk-test")
	id := e.seedVod(t, seed{})
	e.runner.streams = 0
	_, _ = e.svc.Trigger(bg, app, id)
	row := e.waitForDone(t, id)
	if row.Status != "failed" || !strings.Contains(*row.Error, "no audio track") {
		t.Fatalf("%+v", row)
	}
}

func TestGetTranscript(t *testing.T) {
	e := newEnv(t)
	_, err := e.svc.GetTranscript(bg, app, 12345)
	wantHTTP(t, err, 404)
	_ = e.repo.Begin(bg, app, 7, "local", "small")
	_ = e.repo.Apply(bg, app, 7, (&Patch{}).Set("status", "ready").Set("text", "hi").
		Set("segments_json", `[{"start":0,"end":1,"text":"hi"}]`).Set("speakers_json", "[]").Set("srt_key", "rec.srt"))
	v, err := e.svc.GetTranscript(bg, app, 7)
	if err != nil || v.Status != "ready" || len(v.Segments) != 1 || !is(v.SrtURL, "https://s3.test/rec.srt?sig=test") {
		t.Fatalf("%+v %v", v, err)
	}
	if got, _ := y.Stringify(v.Segments); got != `[{"start":0,"end":1,"text":"hi"}]` {
		t.Fatalf("segments round-trip: %s", got)
	}
}

func TestGetSrt(t *testing.T) {
	e := newEnv(t)
	_ = e.repo.Begin(bg, app, 8, "local", "small")
	_ = e.repo.Apply(bg, app, 8, (&Patch{}).Set("status", "ready").Set("segments_json", `[{"start":0,"end":1,"text":"uno","speaker":"a"}]`))
	name, content, err := e.svc.GetSrt(bg, app, 8)
	if err != nil || name != "vod-8.srt" || content != "1\n00:00:00,000 --> 00:00:01,000\n[a] uno\n" {
		t.Fatalf("%s %q %v", name, content, err)
	}
	_ = e.repo.Begin(bg, app, 9, "local", "small")
	_, _, err = e.svc.GetSrt(bg, app, 9)
	wantHTTP(t, err, 409)
	_, _, err = e.svc.GetSrt(bg, app, 10)
	wantHTTP(t, err, 404)
}

func TestGetSrtFilenameFromVodName(t *testing.T) {
	e := newEnv(t)
	id := e.seedVod(t, seed{}) // name rec-1.mp4
	_ = e.repo.Begin(bg, app, id, "local", "small")
	_ = e.repo.Apply(bg, app, id, (&Patch{}).Set("status", "ready").Set("segments_json", `[]`))
	if name, _, _ := e.svc.GetSrt(bg, app, id); name != fmt.Sprintf("rec-1-%d.srt", id) {
		t.Fatalf("filename %s", name)
	}
}

func TestOnVodReadyGating(t *testing.T) {
	e := newEnv(t)
	id := e.seedVod(t, seed{})
	e.svc.OnVodReady(app, id)
	e.install(t, false)
	e.svc.OnVodReady(app, id)
	if row, _ := e.repo.GetByVod(bg, app, id); row != nil {
		t.Fatal("not installed/disabled → nothing")
	}
	e.install(t, true, "autoTranscribe", false)
	e.svc.OnVodReady(app, id)
	if row, _ := e.repo.GetByVod(bg, app, id); row != nil {
		t.Fatal("autoTranscribe off → nothing")
	}
}

func TestOnVodReadyAuto(t *testing.T) {
	e := newEnv(t)
	e.install(t, true, "provider", "openai", "apiKey", "sk-test", "autoTranscribe", true)
	id := e.seedVod(t, seed{})
	e.svc.HTTP = openAI(200, fixed(`{"text":"auto","language":"en","segments":[{"start":0,"end":1,"text":"auto"}]}`))
	e.svc.OnVodReady(app, id)
	row := e.waitForDone(t, id)
	if row == nil || row.Status != "ready" || !is(row.Text, "auto") {
		t.Fatalf("%+v", row)
	}
}

func TestSupportsVerboseJSON(t *testing.T) {
	if !SupportsVerboseJSON(" Whisper-1 ") || SupportsVerboseJSON("gpt-4o-transcribe") {
		t.Fatal("verbose_json only for whisper-*")
	}
}
