package clips

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/fsperm"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/recording"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/streams"
)

// Events dispatched through the callbacks funnel (webhook + MQTT + the
// Streamflow trigger tap).
const (
	EventReady  = "clip.ready"
	EventFailed = "clip.failed"
)

// maxOriginData bounds the trigger payload a clip keeps for its link back.
const maxOriginData = 4096

// StreamLookup resolves a stream id to its room ("" = no room).
type StreamLookup interface {
	StreamRoom(ctx context.Context, app, streamID string) (room string, found bool, err error)
}

// Publisher is the recording upload flow (recording.Service).
type Publisher interface {
	CheckStorage(ctx context.Context, app string) error
	PublishFile(ctx context.Context, in recording.PublishInput) (*recording.VodRecord, error)
}

// VodFinder reads a VOD row (recording.Vods).
type VodFinder interface {
	FindByID(ctx context.Context, app string, id int64) (*recording.VodRecord, error)
}

// Dispatcher is the callbacks funnel.
type Dispatcher interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// Logs is the logs module writer.
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Deps wire the service. Callbacks / Logs are lazy (later planes).
type Deps struct {
	Apps      contracts.AppsService
	Streams   StreamLookup
	Publisher Publisher
	Store     *Store
	Vods      VodFinder
	Runner    recording.Runner // ffmpeg (nil → recording.ExecRunner)
	Callbacks func() Dispatcher
	Logs      func() Logs
	Log       *slog.Logger
	Now       func() time.Time
	Sleep     func(ctx context.Context, d time.Duration) error
	NewID     func() string
}

// Service runs clip jobs: an in-process queue with a per-app concurrency
// cap (features.clips.max_concurrent) — jobs past the cap wait in FIFO.
type Service struct {
	d Deps

	mu      sync.Mutex
	root    context.Context
	running map[string]int
	waiting map[string][]job
	wg      sync.WaitGroup
}

type job struct {
	app  string
	clip *Clip
	plan streams.HlsPlan
	max  int // the app's max_concurrent when queued
}

// New builds the service.
func New(d Deps) *Service {
	if d.Runner == nil {
		d.Runner = recording.ExecRunner{}
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Sleep == nil {
		d.Sleep = func(ctx context.Context, dur time.Duration) error {
			t := time.NewTimer(dur)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		}
	}
	if d.NewID == nil {
		d.NewID = func() string {
			b := make([]byte, 8)
			_, _ = rand.Read(b)
			return "clp_" + hex.EncodeToString(b)
		}
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	return &Service{d: d, root: context.Background(), running: map[string]int{}, waiting: map[string][]job{}}
}

func (s *Service) nowMs() float64 { return float64(s.d.Now().UnixMilli()) }

func (s *Service) logWrite(level, msg string, meta any) {
	if s.d.Logs != nil {
		if l := s.d.Logs(); l != nil {
			l.Write(level, "clips", msg, meta, nil)
		}
	}
}

func (s *Service) dispatch(ctx context.Context, app, event string, payload any) {
	if s.d.Callbacks == nil {
		return
	}
	if cb := s.d.Callbacks(); cb != nil {
		_ = cb.Dispatch(ctx, app, event, payload)
	}
}

// Start is the plane starter: it adopts the root context and fails the
// clips a previous core left queued/running (their queue died with it).
func (s *Service) Start(ctx context.Context) {
	s.mu.Lock()
	s.root = ctx
	s.mu.Unlock()
	list, err := s.d.Apps.List(ctx, nil)
	if err != nil {
		return
	}
	for _, a := range list {
		if ids, _ := s.d.Store.FailInterrupted(ctx, a.Name, "interrupted by a core restart"); len(ids) > 0 {
			s.logWrite("warn", "clips interrupted by restart marked failed", map[string]any{"app": a.Name, "clips": ids})
		}
	}
}

// Wait blocks until every running job finished (tests, shutdown).
func (s *Service) Wait() { s.wg.Wait() }

// settings is the app's features.clips (nil = disabled) + its HLS plan.
func (s *Service) settings(ctx context.Context, app string) (*contracts.ClipsFeatures, streams.HlsPlan, error) {
	cfg, err := s.d.Apps.GetConfig(ctx, app)
	if err != nil {
		return nil, streams.HlsPlan{}, httpx.NotFound(fmt.Sprintf("app '%s' config unavailable: %s", app, err.Error()))
	}
	c := cfg.Features.Clips
	if c == nil || !c.Enabled {
		return nil, streams.HlsPlan{}, httpx.BadRequest(fmt.Sprintf("clips are disabled for app '%s' (features.clips.enabled)", app))
	}
	return c, streams.PlanFor(cfg), nil
}

func (s *Service) roomDir(app, room string) string {
	return filepath.Join(s.d.Apps.AppDir(app), "hls", streams.Safe(room))
}

// timeline reads the room's index.m3u8 and places the segments still on
// disk on the wall clock (pruned ones are dropped).
func (s *Service) timeline(app, room string) []streams.TimedSegment {
	dir := s.roomDir(app, room)
	body, err := os.ReadFile(filepath.Join(dir, streams.PlaylistName))
	if err != nil {
		return nil
	}
	p := streams.ParseMediaPlaylist(string(streams.CompleteLines(body)))
	stat := func(uri string) (os.FileInfo, error) { return os.Stat(filepath.Join(dir, filepath.Base(uri))) }
	tl := p.Timeline(func(uri string) (float64, bool) {
		st, err := stat(uri)
		if err != nil {
			return 0, false
		}
		return float64(st.ModTime().UnixNano()) / 1e6, true
	})
	out := make([]streams.TimedSegment, 0, len(tl))
	for _, seg := range tl {
		if _, err := stat(seg.URI); err == nil {
			out = append(out, seg)
		}
	}
	return out
}

// CreateInput is one clip request.
type CreateInput struct {
	App      string
	StreamID string // REST path; "" when the caller knows only the room
	Room     string // used when StreamID is ""
	Request  Request
	Origin   *Origin
}

// Create validates, persists a queued clip and schedules it.
func (s *Service) Create(ctx context.Context, in CreateInput) (*Clip, error) {
	limits, plan, err := s.settings(ctx, in.App)
	if err != nil {
		return nil, err
	}
	room := in.Room
	var streamID *string
	if in.StreamID != "" {
		r, found, err := s.d.Streams.StreamRoom(ctx, in.App, in.StreamID)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, httpx.NotFound(fmt.Sprintf("stream '%s' not found", in.StreamID))
		}
		if r == "" {
			return nil, httpx.BadRequest(fmt.Sprintf("stream '%s' has no room to clip", in.StreamID))
		}
		room, streamID = r, &in.StreamID
	}
	if room == "" {
		return nil, httpx.BadRequest("room is required")
	}
	r, err := in.Request.Resolve()
	if err != nil {
		return nil, err
	}
	win, ok := WindowOf(s.timeline(in.App, room))
	if !ok {
		return nil, httpx.Conflict(fmt.Sprintf("no HLS segments on disk for room '%s': start its HLS egress (or enable features.dvr) to clip it", room))
	}
	if err := Validate(r, limits.MaxSeconds, win, s.nowMs()); err != nil {
		return nil, err
	}
	if err := s.d.Publisher.CheckStorage(ctx, in.App); err != nil {
		return nil, err
	}
	if n, err := s.d.Store.CountActive(ctx, in.App); err != nil {
		return nil, err
	} else if n >= int(limits.MaxQueued) {
		return nil, httpx.Nest(http.StatusTooManyRequests, fmt.Sprintf("app '%s' already has %d clips queued or running (features.clips.max_queued)", in.App, n))
	}
	origin := in.Origin
	if origin == nil {
		origin = &Origin{Kind: "api"}
	}
	if len(origin.Data) > maxOriginData {
		origin.Data = nil
	}
	c := &Clip{ID: s.d.NewID(), App: in.App, StreamID: streamID, Room: room, fromMs: r.FromMs, toMs: r.ToMs}
	if err := s.d.Store.Insert(ctx, in.App, c, origin); err != nil {
		return nil, err
	}
	saved, err := s.d.Store.Get(ctx, in.App, c.ID)
	if err != nil || saved == nil {
		return nil, httpx.Internal("failed to persist clip")
	}
	s.logWrite("info", "clip queued", map[string]any{"app": in.App, "clipId": c.ID, "room": room, "from": saved.From, "to": saved.To})
	s.schedule(job{in.App, saved, plan, max(1, int(limits.MaxConcurrent))})
	return saved, nil
}

// schedule runs the job now when under the app's cap, else queues it.
func (s *Service) schedule(j job) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running[j.app] >= j.max {
		s.waiting[j.app] = append(s.waiting[j.app], j)
		return
	}
	s.launchLocked(j)
}

func (s *Service) launchLocked(j job) {
	s.running[j.app]++
	s.wg.Add(1)
	ctx := s.root
	go func() {
		defer s.wg.Done()
		s.process(ctx, j)
		s.mu.Lock()
		defer s.mu.Unlock()
		s.running[j.app]--
		if q := s.waiting[j.app]; len(q) > 0 {
			next := q[0]
			s.waiting[j.app] = q[1:]
			s.launchLocked(next)
		}
	}()
}

// readyPayload is the clip.ready body.
type readyPayload struct {
	ClipID    string   `json:"clipId"`
	App       string   `json:"app"`
	Room      string   `json:"room"`
	StreamID  *string  `json:"streamId"`
	From      string   `json:"from"`
	To        string   `json:"to"`
	DurationS float64  `json:"durationS"`
	VodID     int64    `json:"vodId"`
	FileKey   *string  `json:"fileKey"`
	URL       *string  `json:"url"`
	SizeBytes *float64 `json:"sizeBytes"`
	Source    string   `json:"source"`
	Origin    *Origin  `json:"origin"`
}

// failedPayload is the clip.failed body.
type failedPayload struct {
	ClipID   string  `json:"clipId"`
	App      string  `json:"app"`
	Room     string  `json:"room"`
	StreamID *string `json:"streamId"`
	From     string  `json:"from"`
	To       string  `json:"to"`
	Error    string  `json:"error"`
	Origin   *Origin `json:"origin"`
}

func (s *Service) fail(ctx context.Context, j job, reason string) {
	msg := reason
	_ = s.d.Store.SetStatus(ctx, j.app, j.clip.ID, StatusFailed, nil, &msg)
	s.logWrite("error", "clip failed", map[string]any{"app": j.app, "clipId": j.clip.ID, "error": reason})
	c := j.clip
	s.dispatch(ctx, j.app, EventFailed, failedPayload{c.ID, j.app, c.Room, c.StreamID, c.From, c.To, reason, c.Origin})
}

// waitForRange sleeps until the range's last segment should be on disk,
// then (bounded) until the timeline actually covers the range end.
func (s *Service) waitForRange(ctx context.Context, j job, segS float64) []streams.TimedSegment {
	r := j.clip.Range()
	readyAt := ReadyAt(r, segS)
	deadline := readyAt + 30_000
	if d := readyAt - s.nowMs(); d > 0 {
		if s.d.Sleep(ctx, time.Duration(d)*time.Millisecond) != nil {
			return nil
		}
	}
	for {
		tl := s.timeline(j.app, j.clip.Room)
		if w, ok := WindowOf(tl); ok && w.EndMs >= r.ToMs {
			return tl
		}
		if s.nowMs() >= deadline {
			return tl // the stream may have ended: cut what exists
		}
		if s.d.Sleep(ctx, time.Duration(math.Max(segS, 1)*1000)*time.Millisecond) != nil {
			return nil
		}
	}
}

// process is one clip job: wait → select → ffmpeg → publish → clip.ready.
func (s *Service) process(ctx context.Context, j job) {
	c := j.clip
	_ = s.d.Store.SetStatus(ctx, j.app, c.ID, StatusRunning, nil, nil)
	tl := s.waitForRange(ctx, j, float64(j.plan.SegmentSeconds))
	if ctx.Err() != nil {
		s.fail(context.WithoutCancel(ctx), j, "cancelled (core shutting down)")
		return
	}
	sel, ok := Select(tl, c.Range())
	if !ok {
		s.fail(ctx, j, "the clip range is no longer (or not yet) on disk — pruned from the DVR window or never recorded")
		return
	}
	work := filepath.Join(s.d.Apps.AppDir(j.app), "clips")
	if err := os.MkdirAll(work, fsperm.Private); err != nil {
		s.fail(ctx, j, "cannot create clips dir: "+err.Error())
		return
	}
	dir := s.roomDir(j.app, c.Room)
	paths := make([]string, len(sel.Segments))
	for i, seg := range sel.Segments {
		paths[i] = filepath.Join(dir, filepath.Base(seg.URI))
	}
	list := filepath.Join(work, "."+c.ID+".ffconcat")
	defer os.Remove(list)
	if err := os.WriteFile(list, []byte(ConcatList(paths)), 0o644); err != nil {
		s.fail(ctx, j, "cannot write the concat list: "+err.Error())
		return
	}
	name := ClipName(c.Room, c.fromMs, c.ID)
	out := filepath.Join(work, name)
	timeout := time.Duration(math.Max(60, sel.DurationS*2+30)) * time.Second
	if _, err := s.d.Runner.Run(ctx, "ffmpeg", FfmpegArgs(list, out, sel), timeout); err != nil {
		os.Remove(out)
		s.fail(ctx, j, "ffmpeg failed: "+err.Error())
		return
	}
	if st, err := os.Stat(out); err != nil || st.Size() == 0 {
		os.Remove(out)
		s.fail(ctx, j, "ffmpeg produced no output")
		return
	}
	meta := yamljs.NewMap()
	meta.Set("source", recording.VodSourceClip)
	meta.Set("clipId", c.ID)
	meta.Set("clipFrom", c.From)
	meta.Set("clipTo", c.To)
	if c.Origin != nil {
		if b, err := json.Marshal(c.Origin); err == nil {
			if v, err := yamljs.ParseJSON(b); err == nil {
				meta.Set("origin", v)
			}
		}
	}
	sid := ""
	if c.StreamID != nil {
		sid = *c.StreamID
	}
	vod, err := s.d.Publisher.PublishFile(ctx, recording.PublishInput{
		App: j.app, StreamID: sid, Room: c.Room, Name: name, KeyPrefix: "clips/", Source: recording.VodSourceClip,
		LocalPath: out, StartedAt: time.UnixMilli(int64(c.fromMs)), EndedAt: time.UnixMilli(int64(c.toMs)), Meta: meta,
	})
	if err != nil {
		os.Remove(out)
		s.fail(ctx, j, "upload failed: "+err.Error())
		return
	}
	_ = s.d.Store.SetStatus(ctx, j.app, c.ID, StatusReady, &vod.ID, nil)
	s.logWrite("info", "clip ready", map[string]any{"app": j.app, "clipId": c.ID, "vodId": vod.ID})
	s.dispatch(ctx, j.app, EventReady, readyPayload{
		c.ID, j.app, c.Room, c.StreamID, c.From, c.To, math.Round(sel.DurationS*1000) / 1000,
		vod.ID, vod.FileKey, vod.PublicURL, vod.SizeBytes, recording.VodSourceClip, c.Origin,
	})
}

// ClipName is the MP4 (and S3 key) basename: clip-<room>-<UTC stamp>-<id>.mp4.
func ClipName(room string, fromMs float64, id string) string {
	stamp := time.UnixMilli(int64(fromMs)).UTC().Format("20060102-150405")
	return fmt.Sprintf("clip-%s-%s-%s.mp4", streams.Safe(room), stamp, id)
}

// Get returns one clip of an app (404 when missing), with its VOD's URL
// (presigned or public) once ready.
func (s *Service) Get(ctx context.Context, app, id string) (*Clip, error) {
	if err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	c, err := s.d.Store.Get(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, httpx.NotFound(fmt.Sprintf("clip '%s' not found", id))
	}
	if c.VodID != nil && s.d.Vods != nil {
		if v, err := s.d.Vods.FindByID(ctx, app, *c.VodID); err == nil && v != nil {
			c.URL = v.PublicURL
		}
	}
	return c, nil
}

// List returns the newest clips of an app (or of one stream).
func (s *Service) List(ctx context.Context, app string, streamID *string, limit int) ([]Clip, error) {
	if err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	return s.d.Store.List(ctx, app, streamID, limit)
}

// requireApp 404s an unknown app before its app.db would be opened (and
// created) for it.
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

// WaitDone polls a clip until it is ready/failed or timeout elapses (the
// Streamflow action.clip `wait` option); the last state is returned.
func (s *Service) WaitDone(ctx context.Context, app, id string, timeout time.Duration) (*Clip, error) {
	deadline := s.d.Now().Add(timeout)
	for {
		c, err := s.Get(ctx, app, id)
		if err != nil {
			return nil, err
		}
		if c.Status == StatusReady || c.Status == StatusFailed || !s.d.Now().Before(deadline) {
			return c, nil
		}
		if err := s.d.Sleep(ctx, time.Second); err != nil {
			return c, nil
		}
	}
}
