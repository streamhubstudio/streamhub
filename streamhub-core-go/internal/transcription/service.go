package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/recording"
)

// Port of transcription.service.ts. The pipeline runs in a background
// goroutine and never throws into the recording flow: failures land on the
// transcript row (status failed + error) and the plugin logs.

// PluginID is the plugin this module backs.
const PluginID = "transcription"

const srtPresignTTL = 3600

// Vods is the vods repository surface used.
type Vods interface {
	FindByID(ctx context.Context, app string, id int64) (*recording.VodRecord, error)
	Update(ctx context.Context, app string, id int64, p *recording.VodPatch) error
}

// View is a transcript row + parsed fields + a fresh SRT URL.
type TranscriptView struct {
	VodID     int64    `json:"vodId"`
	Status    string   `json:"status"`
	Provider  *string  `json:"provider"`
	Model     *string  `json:"model"`
	Language  *string  `json:"language"`
	Text      *string  `json:"text"`
	Segments  []any    `json:"segments"`
	Speakers  []string `json:"speakers"`
	SrtKey    *string  `json:"srtKey"`
	SrtURL    *string  `json:"srtUrl"`
	Error     *string  `json:"error"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
}

// Deps wires the service.
type Deps struct {
	Repo     *Repo
	Vods     Vods
	Installs *plugins.Repo
	Registry *plugins.Registry
	Apps     contracts.AppsService
	S3       contracts.S3Service
	Logs     plugins.LogWriter
	Log      *slog.Logger
}

// Service is TranscriptionService.
type Service struct {
	d       Deps
	mu      sync.Mutex
	running map[string]bool
	// test seams
	Runner       Runner
	HTTP         *http.Client
	PollInterval time.Duration
	PollTimeout  time.Duration
	now          func() time.Time
	// Go runs the background pipeline (tests may run it inline).
	Go func(func())
}

// New builds the service.
func New(d Deps) *Service {
	return &Service{d: d, running: map[string]bool{}, Runner: ExecRunner, PollInterval: 2 * time.Second,
		PollTimeout: 30 * time.Minute, now: time.Now, Go: func(f func()) { go f() }}
}

func key(app string, vodID int64) string { return app + ":" + strconv.FormatInt(vodID, 10) }

func (s *Service) isRunning(k string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running[k]
}

func provider(cfg *y.Map) string {
	if y.ToString(y.Coalesce(cfg.Get("provider"), "local")) == "openai" {
		return "openai"
	}
	return "local"
}

func model(cfg *y.Map) string {
	if provider(cfg) == "openai" {
		return y.ToString(y.Coalesce(cfg.Get("openaiModel"), "whisper-1"))
	}
	return y.ToString(y.Coalesce(cfg.Get("model"), "small"))
}

func (s *Service) enabledConfig(ctx context.Context, app string) *y.Map {
	meta := s.d.Registry.GetMeta(PluginID)
	if meta == nil {
		return nil
	}
	row, _ := s.d.Installs.Get(ctx, app, PluginID)
	if row == nil || !row.Enabled {
		return nil
	}
	cfg, err := plugins.ValidateConfig(meta, row.Config, false)
	if err != nil {
		return nil
	}
	return cfg
}

// OnVodReady is the recording hook (auto-transcribe). Never fails.
func (s *Service) OnVodReady(app string, vodID int64) {
	ctx := context.Background()
	cfg := s.enabledConfig(ctx, app)
	if cfg == nil || cfg.Get("autoTranscribe") != true {
		return
	}
	if err := s.d.Repo.Begin(ctx, app, vodID, provider(cfg), model(cfg)); err != nil {
		return
	}
	s.start(app, vodID, cfg)
}

func (s *Service) requireApp(ctx context.Context, app string) error {
	rec, err := s.d.Apps.Get(ctx, app)
	if err != nil {
		return err
	}
	if rec == nil {
		return httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	return nil
}

// Trigger starts (or re-runs) a VOD's transcription; returns the queued row.
func (s *Service) Trigger(ctx context.Context, app string, vodID int64) (*TranscriptView, error) {
	if err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	meta := s.d.Registry.GetMeta(PluginID)
	if meta == nil {
		return nil, httpx.NotFound("transcription plugin is not available")
	}
	row, err := s.d.Installs.Get(ctx, app, PluginID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, httpx.BadRequest(fmt.Sprintf("plugin '%s' is not installed in app '%s'", PluginID, app))
	}
	if !row.Enabled {
		return nil, httpx.BadRequest(fmt.Sprintf("plugin '%s' is not enabled in app '%s'", PluginID, app))
	}
	vod, err := s.d.Vods.FindByID(ctx, app, vodID)
	if err != nil {
		return nil, err
	}
	if vod == nil {
		return nil, httpx.NotFound(fmt.Sprintf("vod %d not found", vodID))
	}
	if vod.Status != "ready" {
		return nil, httpx.Conflict(fmt.Sprintf("vod %d is not ready (status: %s)", vodID, vod.Status))
	}
	if s.isRunning(key(app, vodID)) {
		return nil, httpx.Conflict(fmt.Sprintf("transcription of vod %d is already in progress", vodID))
	}
	cfg, err := plugins.ValidateConfig(meta, row.Config, false)
	if err != nil {
		return nil, httpx.Internal(err.Error())
	}
	if err := s.d.Repo.Begin(ctx, app, vodID, provider(cfg), model(cfg)); err != nil {
		return nil, err
	}
	view, err := s.GetTranscript(ctx, app, vodID)
	if err != nil {
		return nil, err
	}
	s.start(app, vodID, cfg)
	return view, nil
}

func parseList(js *string) []any {
	out := []any{}
	if js == nil {
		return out
	}
	if v, err := y.ParseJSON([]byte(*js)); err == nil {
		if l, ok := v.([]any); ok {
			return l
		}
	}
	return out
}

// GetTranscript is the transcript view (404 when never queued).
func (s *Service) GetTranscript(ctx context.Context, app string, vodID int64) (*TranscriptView, error) {
	if err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	row, err := s.d.Repo.GetByVod(ctx, app, vodID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, httpx.NotFound(fmt.Sprintf("vod %d has no transcript — trigger one with POST /vods/%d/transcribe", vodID, vodID))
	}
	var srtURL *string
	if row.SrtKey != nil && *row.SrtKey != "" {
		if cfg, err := s.d.Apps.GetConfig(ctx, app); err == nil {
			if u, err := s.d.S3.PresignGet(ctx, cfg.S3, *row.SrtKey, srtPresignTTL, nil); err == nil {
				srtURL = &u
			}
		}
	}
	speakers := []string{}
	for _, v := range parseList(row.SpeakersJSON) {
		if s, ok := v.(string); ok {
			speakers = append(speakers, s)
		}
	}
	return &TranscriptView{VodID: row.VodID, Status: row.Status, Provider: row.Provider, Model: row.Model, Language: row.Language,
		Text: row.Text, Segments: parseList(row.SegmentsJSON), Speakers: speakers, SrtKey: row.SrtKey, SrtURL: srtURL,
		Error: row.Error, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

var (
	stemExt  = regexp.MustCompile(`\.[^./\\]+$`)
	badChars = regexp.MustCompile(`[\\/"'\r\n\t]+`)
	nonWord  = regexp.MustCompile(`[^\w.\-]+`)
)

// segmentsOf decodes stored segments for the SRT rebuild.
func segmentsOf(list []any) []Segment {
	out := make([]Segment, 0, len(list))
	for _, v := range list {
		m, ok := v.(*y.Map)
		if !ok || m == nil {
			continue
		}
		seg := Segment{Start: y.ToNumber(m.Get("start")), End: y.ToNumber(m.Get("end"))}
		seg.Text, _ = m.Get("text").(string)
		if sp, ok := m.Get("speaker").(string); ok {
			seg.Speaker = &sp
		}
		out = append(out, seg)
	}
	return out
}

// GetSrt rebuilds the SubRip document from the stored segments.
func (s *Service) GetSrt(ctx context.Context, app string, vodID int64) (string, string, error) {
	if err := s.requireApp(ctx, app); err != nil {
		return "", "", err
	}
	row, err := s.d.Repo.GetByVod(ctx, app, vodID)
	if err != nil {
		return "", "", err
	}
	if row == nil {
		return "", "", httpx.NotFound(fmt.Sprintf("vod %d has no transcript", vodID))
	}
	if row.Status != "ready" {
		return "", "", httpx.Conflict(fmt.Sprintf("transcript of vod %d is not ready (status: %s)", vodID, row.Status))
	}
	stem := "vod"
	if vod, _ := s.d.Vods.FindByID(ctx, app, vodID); vod != nil {
		stem = vod.Name
	}
	stem = stemExt.ReplaceAllString(stem, "")
	safe := nonWord.ReplaceAllString(badChars.ReplaceAllString(stem, "_"), "-")
	if safe == "" {
		safe = "vod"
	}
	return fmt.Sprintf("%s-%d.srt", safe, vodID), BuildSrt(segmentsOf(parseList(row.SegmentsJSON))), nil
}

func (s *Service) workDir(app string) string {
	return filepath.Join(s.d.Apps.AppDir(app), "transcripts")
}

func (s *Service) write(level, msg string, meta any) {
	if s.d.Logs != nil {
		s.d.Logs.Write(level, "plugin:"+PluginID, msg, meta, nil)
	}
}

type failMeta struct {
	App   string `json:"app"`
	VodID int64  `json:"vodId"`
	Error string `json:"error"`
}

type doneMeta struct {
	App      string   `json:"app"`
	VodID    int64    `json:"vodId"`
	Provider string   `json:"provider"`
	Language *string  `json:"language"`
	Segments int      `json:"segments"`
	Speakers []string `json:"speakers"`
	SrtKey   *string  `json:"srtKey"`
}

type audioTrack struct {
	path    string
	speaker *string
}

// start claims the job synchronously (as Node's execute() does before its
// first await, so an immediate re-trigger is a 409) and runs it in the
// background; an already-running job is left alone.
func (s *Service) start(app string, vodID int64, cfg *y.Map) {
	k := key(app, vodID)
	s.mu.Lock()
	if s.running[k] {
		s.mu.Unlock()
		return
	}
	s.running[k] = true
	s.mu.Unlock()
	s.Go(func() { s.execute(context.Background(), app, vodID, cfg) })
}

// execute runs a claimed job and releases it.
func (s *Service) execute(ctx context.Context, app string, vodID int64, cfg *y.Map) {
	k := key(app, vodID)
	var cleanup []string
	defer func() {
		s.mu.Lock()
		delete(s.running, k)
		s.mu.Unlock()
		for _, p := range cleanup {
			_ = os.Remove(p)
		}
	}()
	if err := s.run(ctx, app, vodID, cfg, &cleanup); err != nil {
		msg := err.Error()
		if msg == "" {
			msg = "transcription failed"
		}
		_ = s.d.Repo.Apply(ctx, app, vodID, (&Patch{}).Set("status", "failed").Set("error", msg))
		s.write("error", "transcription failed", failMeta{app, vodID, msg})
	}
}

func (s *Service) run(ctx context.Context, app string, vodID int64, cfg *y.Map, cleanup *[]string) error {
	if err := s.d.Repo.Apply(ctx, app, vodID, (&Patch{}).Set("status", "processing")); err != nil {
		return err
	}
	vod, err := s.d.Vods.FindByID(ctx, app, vodID)
	if err != nil {
		return err
	}
	if vod == nil {
		return fmt.Errorf("vod %d disappeared", vodID)
	}
	appCfg, err := s.d.Apps.GetConfig(ctx, app)
	if err != nil {
		return err
	}
	source, err := s.resolveSource(ctx, vod, appCfg)
	if err != nil {
		return err
	}
	tracks, err := s.extractTracks(ctx, app, vod, source, cleanup)
	if err != nil {
		return err
	}
	prov := provider(cfg)
	var lang *string
	var results []TrackTranscript
	if prov == "openai" {
		lang, results, err = s.transcribeOpenAI(ctx, tracks, cfg, vod)
	} else {
		lang, results, err = s.transcribeLocal(ctx, app, vodID, tracks, cfg, cleanup)
	}
	if err != nil {
		return err
	}
	merged := MergeTrackSegments(results)
	if len(merged) == 0 {
		return fmt.Errorf("transcription produced no segments")
	}
	text, speakers, srt := PlainTranscriptText(merged), CollectSpeakers(merged), BuildSrt(merged)
	var srtKey *string
	local := filepath.Join(s.workDir(app), fmt.Sprintf("vod-%d.srt", vodID))
	if err := s.uploadSrt(ctx, appCfg, local, srt, SrtKeyForVod(vod.FileKey, vodID), cleanup, &srtKey); err != nil {
		s.write("warn", "SRT upload to S3 failed — transcript kept without S3 copy", failMeta{app, vodID, err.Error()})
	}
	segJSON, _ := jsx.Stringify(merged)
	spkJSON, _ := jsx.Stringify(speakers)
	if err := s.d.Repo.Apply(ctx, app, vodID, (&Patch{}).Set("status", "ready").Set("language", nullable(lang)).Set("text", text).
		Set("segments_json", segJSON).Set("speakers_json", spkJSON).Set("srt_key", nullable(srtKey)).Set("error", nil)); err != nil {
		return err
	}
	s.tagVod(ctx, app, vodID, srtKey, lang)
	s.write("info", "vod transcribed", doneMeta{app, vodID, prov, lang, len(merged), speakers, srtKey})
	return nil
}

func nullable(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func (s *Service) uploadSrt(ctx context.Context, cfg *contracts.AppConfig, local, srt, key string, cleanup *[]string, out **string) error {
	if err := os.MkdirAll(filepath.Dir(local), 0o777); err != nil {
		return err
	}
	if err := os.WriteFile(local, []byte(srt), 0o644); err != nil {
		return err
	}
	*cleanup = append(*cleanup, local)
	res, err := s.d.S3.Upload(ctx, cfg.S3, local, key, "application/x-subrip")
	if err != nil {
		return err
	}
	*out = &res.Key
	return nil
}

func (s *Service) resolveSource(ctx context.Context, vod *recording.VodRecord, cfg *contracts.AppConfig) (string, error) {
	if vod.LocalPath != nil && *vod.LocalPath != "" {
		if _, err := os.Stat(*vod.LocalPath); err == nil {
			return *vod.LocalPath, nil
		}
	}
	if vod.FileKey != nil && *vod.FileKey != "" {
		return s.d.S3.PresignGet(ctx, cfg.S3, *vod.FileKey, 600, nil)
	}
	return "", fmt.Errorf("vod %d has no media to transcribe (no local file and no S3 object)", vod.ID)
}

func parseMeta(js *string) *y.Map {
	if js != nil {
		if v, err := y.ParseJSON([]byte(*js)); err == nil {
			if m, ok := v.(*y.Map); ok {
				return m
			}
		}
	}
	return y.NewMap()
}

func (s *Service) extractTracks(ctx context.Context, app string, vod *recording.VodRecord, source string, cleanup *[]string) ([]audioTrack, error) {
	count := ProbeAudioStreamCount(ctx, source, s.Runner)
	if count == 0 {
		return nil, fmt.Errorf("vod %d has no audio track", vod.ID)
	}
	n := count
	if n < 0 {
		n = 1
	}
	var single *string
	switch y.ToString(y.Coalesce(parseMeta(vod.MetatagsJSON).Get("mode"), "")) {
	case "track", "audio", "participant":
		single = vod.StreamID
	}
	tmp := filepath.Join(s.workDir(app), "tmp")
	var out []audioTrack
	for i := 0; i < n; i++ {
		path := filepath.Join(tmp, fmt.Sprintf("vod-%d-a%d.mp3", vod.ID, i))
		if !ExtractMp3Track(ctx, source, path, i, s.Runner) {
			return nil, fmt.Errorf("audio extraction failed (ffmpeg, stream %d of %d)", i, n)
		}
		*cleanup = append(*cleanup, path)
		sp := single
		if n > 1 {
			l := fmt.Sprintf("track-%d", i+1)
			sp = &l
		}
		out = append(out, audioTrack{path, sp})
	}
	return out, nil
}

func (s *Service) transcribeOpenAI(ctx context.Context, tracks []audioTrack, cfg *y.Map, vod *recording.VodRecord) (*string, []TrackTranscript, error) {
	key := y.Trim(y.ToString(y.Coalesce(cfg.Get("apiKey"), "")))
	if key == "" {
		return nil, nil, fmt.Errorf("provider 'openai' needs the API key config (plugin field 'apiKey')")
	}
	mdl := y.ToString(y.Coalesce(cfg.Get("openaiModel"), "whisper-1"))
	lang := y.ToString(y.Coalesce(cfg.Get("language"), "auto"))
	var detected *string
	var out []TrackTranscript
	for _, t := range tracks {
		res, err := TranscribeOpenAI(ctx, OpenAIOptions{APIKey: key, Model: mdl, Language: lang, FilePath: t.path, Client: s.HTTP})
		if err != nil {
			return nil, nil, err
		}
		if detected == nil {
			detected = res.Language
		}
		segs := res.Segments
		if len(segs) == 0 {
			dur := 0.0
			if vod.DurationS != nil {
				dur = *vod.DurationS
			}
			segs = []Segment{{Start: 0, End: dur, Text: res.Text}}
		}
		out = append(out, TrackTranscript{Speaker: t.speaker, Segments: segs})
	}
	return detected, out, nil
}

type jobTrack struct {
	Path    string  `json:"path"`
	Speaker *string `json:"speaker"`
}

type job struct {
	VodID    int64      `json:"vodId"`
	App      string     `json:"app"`
	Language string     `json:"language"`
	Model    string     `json:"model"`
	Tracks   []jobTrack `json:"tracks"`
}

func (s *Service) transcribeLocal(ctx context.Context, app string, vodID int64, tracks []audioTrack, cfg *y.Map, cleanup *[]string) (*string, []TrackTranscript, error) {
	jobs, results := filepath.Join(s.workDir(app), "jobs"), filepath.Join(s.workDir(app), "results")
	_ = os.MkdirAll(jobs, 0o777)
	_ = os.MkdirAll(results, 0o777)
	jobPath := filepath.Join(jobs, fmt.Sprintf("vod-%d.json", vodID))
	resultPath := filepath.Join(results, fmt.Sprintf("vod-%d.json", vodID))
	_ = os.Remove(resultPath)
	j := job{VodID: vodID, App: app, Language: y.ToString(y.Coalesce(cfg.Get("language"), "auto")),
		Model: y.ToString(y.Coalesce(cfg.Get("model"), "small"))}
	for _, t := range tracks {
		j.Tracks = append(j.Tracks, jobTrack{t.path, t.speaker})
	}
	if j.Tracks == nil {
		j.Tracks = []jobTrack{}
	}
	body, _ := jsx.Stringify(j)
	if err := os.WriteFile(jobPath+".tmp", []byte(body), 0o644); err != nil {
		return nil, nil, err
	}
	if err := os.Rename(jobPath+".tmp", jobPath); err != nil {
		return nil, nil, err
	}
	*cleanup = append(*cleanup, jobPath, jobPath+".working", resultPath)
	deadline := s.now().Add(s.PollTimeout)
	for {
		if _, err := os.Stat(resultPath); err == nil {
			break
		}
		if !s.now().Before(deadline) {
			if _, err := os.Stat(jobPath); err == nil {
				return nil, nil, fmt.Errorf("transcription worker never picked up the job — is the plugin worker running? (check GET plugins/transcription/worker/status)")
			}
			return nil, nil, fmt.Errorf("transcription worker timed out producing a result")
		}
		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-time.After(s.PollInterval):
		}
	}
	raw, err := os.ReadFile(resultPath)
	var res struct {
		OK       bool    `json:"ok"`
		Error    string  `json:"error"`
		Language *string `json:"language"`
		Tracks   []struct {
			Speaker  *string   `json:"speaker"`
			Segments []Segment `json:"segments"`
		} `json:"tracks"`
	}
	if err == nil {
		err = json.Unmarshal(raw, &res)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("unreadable worker result: %s", err)
	}
	if !res.OK {
		msg := res.Error
		if msg == "" {
			msg = "transcription worker reported failure"
		}
		return nil, nil, fmt.Errorf("%s", msg)
	}
	out := make([]TrackTranscript, 0, len(res.Tracks))
	for i, t := range res.Tracks {
		sp := t.Speaker
		if i < len(tracks) {
			sp = tracks[i].speaker
			if sp == nil {
				sp = t.Speaker
			}
		}
		out = append(out, TrackTranscript{Speaker: sp, Segments: t.Segments})
	}
	return res.Language, out, nil
}

type transcriptTag struct {
	SrtKey      *string `json:"srtKey"`
	Language    *string `json:"language"`
	GeneratedAt string  `json:"generatedAt"`
}

func (s *Service) tagVod(ctx context.Context, app string, vodID int64, srtKey, lang *string) {
	vod, err := s.d.Vods.FindByID(ctx, app, vodID)
	if err != nil || vod == nil {
		return
	}
	tags := parseMeta(vod.MetatagsJSON)
	tags.Set("transcript", transcriptTag{srtKey, lang, jsx.ISO(s.now())})
	js, err := y.Stringify(tags)
	if err != nil {
		return
	}
	_ = s.d.Vods.Update(ctx, app, vodID, (&recording.VodPatch{}).Set("metatags_json", js))
}
