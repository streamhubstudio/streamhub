package recording

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	lk "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of recording.service.ts (SPEC §5 recording, §8 flow):
//
//	start → egress to apps/<app>/<localDir>/ + VOD row `recording`
//	egress complete webhook → OnEgressEvent → `uploading` + upload job
//	upload job → probe → snapshot → S3 upload → (delete local) → `ready`
//	  → vod_ready / recording_part_ready / recording_ready → transcode job
//	failure → `failed`, local kept, recording_failed callback.
//
// The BullMQ upload queue becomes an in-process worker pool (concurrency 2,
// started from a plane starter); before Start the job runs inline, which is
// Node's "queue unavailable" fallback.

const (
	presignTTL  = 7 * 24 * 3600 // 7 days
	downloadTTL = 3600
)

var (
	splitAllowed    = map[float64]bool{0: true, 15: true, 30: true, 60: true, 90: true, 120: true}
	snapshotAllowed = map[float64]bool{0: true, 1: true, 30: true, 60: true, 120: true, 360: true}
)

// Handle is RecordingHandle.
type RecordingHandle struct {
	VodID    int64  `json:"vodId"`
	EgressID string `json:"egressId"`
	Status   string `json:"status"`
}

// StartInput is StartRecordingInput + the API record mode override.
type StartInput struct {
	AppName             string
	RoomName            string
	StreamID            string
	RecordMode          string // composite (default) | track | audio
	ParticipantIdentity string
}

type egressRef struct {
	app       string
	vodID     int64
	sessionID string
}

// session is a live split/snapshot recording.
type session struct {
	id, app, room, mode, participant, layout, streamID, baseSlug, fileStem string
	splitMinutes, snapshotSeconds                                          float64
	partIndex                                                              int
	currentVodID                                                           int64
	currentEgressID                                                        string
	snapsDir                                                               string
	snapPrefixes                                                           []string
	uploaded                                                               map[string]bool
	stop                                                                   context.CancelFunc
	mu                                                                     sync.Mutex
}

// Service is the RecordingService port; it implements livekit.Recording and
// dbadmin.VodDeleter.
type Service struct {
	cfg       *config.Config
	store     *db.Service
	vods      *Vods
	variants  *Variants
	apps      contracts.AppsService
	s3        contracts.S3Service
	lk        LiveKit
	logs      Logs
	callbacks Callbacks
	runner    Runner
	log       *slog.Logger
	opt       Optional
	Transcode *VodTranscode
	now       func() time.Time

	mu       sync.Mutex
	egress   map[string]egressRef
	sessions map[string]*session

	queue *jobQueue
}

// NewService builds the recording service (and its transcode pipeline).
func NewService(d Deps) *Service {
	r := d.Runner
	if r == nil {
		r = ExecRunner{}
	}
	appDB := func(ctx context.Context, app string) (*sql.DB, error) { return d.Store.App(ctx, app) }
	vods, variants := NewVods(appDB), NewVariants(appDB)
	s := &Service{
		cfg: d.Config, store: d.Store, vods: vods, variants: variants, apps: d.Apps, s3: d.S3, lk: d.LiveKit,
		logs: d.Logs, callbacks: d.Callbacks, runner: r, log: d.Log, opt: d.Optional, now: time.Now,
		egress: map[string]egressRef{}, sessions: map[string]*session{},
	}
	s.Transcode = NewVodTranscode(TranscodeDeps{
		Apps: d.Apps, S3: d.S3, Vods: vods, Variants: variants, Logs: d.Logs, Callbacks: d.Callbacks,
		Runner: r, Drm: NewDrmService(d.Secrets, r, d.Log), Log: d.Log,
	})
	s.queue = newJobQueue(2, func(ctx context.Context, j uploadJob) { s.processUpload(ctx, j.app, j.vodID) })
	return s
}

// Vods exposes the repository (app stats, retention).
func (s *Service) Vods() *Vods { return s.vods }

// Run starts the upload workers (2) and the transcode worker (1) on ctx
// (a plane starter); cancelling ctx tears the live sessions down.
func (s *Service) Run(ctx context.Context) {
	s.queue.start(ctx)
	s.Transcode.Start(ctx)
	go func() {
		<-ctx.Done()
		s.mu.Lock()
		ids := make([]string, 0, len(s.sessions))
		for id := range s.sessions {
			ids = append(ids, id)
		}
		s.mu.Unlock()
		for _, id := range ids {
			s.clearSession(context.WithoutCancel(ctx), id)
		}
	}()
}

func (s *Service) warn(msg string) {
	if s.log != nil {
		s.log.Warn(msg, "source", "recording")
	}
}

func (s *Service) dispatch(ctx context.Context, app, event string, payload any) {
	if s.callbacks == nil {
		return
	}
	if err := s.callbacks.Dispatch(ctx, app, event, payload); err != nil {
		s.warn(fmt.Sprintf("callback %s failed: %s", event, err))
	}
}

// loadConfig maps a config failure to 404 "app '<x>' config unavailable: …".
func (s *Service) loadConfig(ctx context.Context, app string) (*contracts.AppConfig, error) {
	cfg, err := s.apps.GetConfig(ctx, app)
	if err != nil {
		return nil, httpx.NotFound(fmt.Sprintf("app '%s' config unavailable: %s", app, err.Error()))
	}
	return cfg, nil
}

func normalize(v float64, allowed map[float64]bool) float64 {
	if math.IsNaN(v) || !allowed[v] {
		return 0
	}
	return v
}

var slugRun = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)
var slugEdge = regexp.MustCompile(`^-+|-+$`)

func slug(s string) string {
	out := slugEdge.ReplaceAllString(slugRun.ReplaceAllString(s, "-"), "")
	if out == "" {
		return "rec"
	}
	return out
}

func str(s string) *string { return &s }

// storageNotConfigured is the bucket guard's 409 body.
type storageNotConfigured struct {
	Error   string `json:"error"`
	Message string `json:"message"`
	App     string `json:"app"`
}

// startedPayload is the recording_started callback body.
type startedPayload struct {
	VodID           int64   `json:"vodId"`
	EgressID        string  `json:"egressId"`
	App             string  `json:"app"`
	Room            string  `json:"room"`
	StreamID        string  `json:"streamId"`
	Mode            string  `json:"mode"`
	SplitMinutes    float64 `json:"splitMinutes"`
	SnapshotSeconds float64 `json:"snapshotSeconds"`
}

// Start begins a recording (RecordingServiceContract.start).
func (s *Service) StartRecording(ctx context.Context, in StartInput) (*RecordingHandle, error) {
	if in.RoomName == "" {
		return nil, httpx.BadRequest("roomName is required")
	}
	cfg, err := s.loadConfig(ctx, in.AppName)
	if err != nil {
		return nil, err
	}
	if !cfg.Recording.Enabled {
		return nil, httpx.BadRequest(fmt.Sprintf("recording is disabled for app '%s'", in.AppName))
	}
	if jsTrim(cfg.S3.Bucket) == "" {
		write(s.logs, "warn", "recording blocked: no S3 bucket", map[string]any{"appName": in.AppName})
		return nil, &httpx.Error{Status: 409, Body: storageNotConfigured{
			"storage_not_configured",
			fmt.Sprintf("app '%s' has no S3 storage bucket configured; recordings cannot be uploaded", in.AppName),
			in.AppName,
		}}
	}
	mode := cfg.Recording.Mode
	if in.RecordMode == "track" || in.RecordMode == "audio" {
		mode = in.RecordMode
	} else if mode == "" {
		mode = "room-composite"
	}
	streamID := jsTrim(in.StreamID)
	if streamID == "" {
		streamID = in.RoomName
	}
	var participant string
	if mode == "participant" || mode == "track" || mode == "audio" {
		participant = jsTrim(in.ParticipantIdentity)
		if participant == "" {
			participant = streamID
		}
	}
	split := normalize(cfg.Recording.SplitMinutes, splitAllowed)
	snaps := 0.0
	if mode != "track" && mode != "audio" {
		snaps = normalize(cfg.Recording.SnapshotSeconds, snapshotAllowed)
	}
	baseSlug := fmt.Sprintf("%s-%d", slug(streamID), s.now().UnixMilli())
	stem := RenderFilenameTemplate(cfg.Recording.FilenameTemplate, TemplateTokens{
		App: in.AppName, StreamID: streamID, Room: in.RoomName, Type: "mp4", Variables: cfg.Variables, Now: s.now(),
	})
	if stem == "" {
		stem = baseSlug
	}
	sess := &session{
		id: in.AppName + ":" + baseSlug, app: in.AppName, room: in.RoomName, mode: mode, participant: participant,
		layout: cfg.Recording.Layout, streamID: streamID, baseSlug: baseSlug, fileStem: stem,
		splitMinutes: split, snapshotSeconds: snaps, uploaded: map[string]bool{},
	}
	if snaps > 0 {
		sess.snapsDir = filepath.Join(s.apps.AppDir(in.AppName), "snapshots")
	}
	vodID, egressID, err := s.launchPart(ctx, sess, cfg)
	if err != nil {
		return nil, err
	}
	sess.currentVodID, sess.currentEgressID = vodID, egressID
	s.mu.Lock()
	s.egress[egressID] = egressRef{in.AppName, vodID, sess.id}
	s.mu.Unlock()

	if split > 0 || snaps > 0 {
		sctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		sess.stop = cancel
		s.mu.Lock()
		s.sessions[sess.id] = sess
		s.mu.Unlock()
		if split > 0 {
			go s.every(sctx, time.Duration(split)*time.Minute, func() { s.rotate(sctx, sess.id) })
		}
		if snaps > 0 {
			sweep := time.Duration(math.Max(2000, math.Min(snaps, 30)*1000)) * time.Millisecond
			go s.every(sctx, sweep, func() { s.sweepSnapshots(sctx, sess) })
		}
	}
	write(s.logs, "info", "recording started", map[string]any{
		"appName": in.AppName, "vodId": vodID, "egressId": egressID, "room": in.RoomName,
		"mode": mode, "splitMinutes": split, "snapshotSeconds": snaps,
	})
	if m := get(s.opt.Metrics); m != nil {
		m.RecordingStarted(in.AppName)
	}
	s.dispatch(ctx, in.AppName, "recording_started", startedPayload{vodID, egressID, in.AppName, in.RoomName, streamID, mode, split, snaps})
	return &RecordingHandle{vodID, egressID, "recording"}, nil
}

// every runs fn on a ticker until ctx is cancelled (setInterval).
func (s *Service) every(ctx context.Context, d time.Duration, fn func()) {
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn()
		}
	}
}

// metatags is the VOD metatags_json written at part launch (Node key order).
type metatags struct {
	EgressID        string  `json:"egressId"`
	Mode            string  `json:"mode"`
	Room            string  `json:"room"`
	App             string  `json:"app"`
	SessionID       string  `json:"sessionId"`
	SplitMinutes    float64 `json:"splitMinutes"`
	SnapshotSeconds float64 `json:"snapshotSeconds"`
	PartIndex       int     `json:"partIndex"`
	IsPart          bool    `json:"isPart"`
	SnapshotPrefix  string  `json:"snapshotPrefix,omitempty"`
}

// launchPart starts one egress part (one MP4) and persists its VOD row.
func (s *Service) launchPart(ctx context.Context, sess *session, cfg *contracts.AppConfig) (int64, string, error) {
	localDir := cfg.Recording.LocalDir
	if localDir == "" {
		localDir = "recordings"
	}
	dir := filepath.Join(s.apps.AppDir(sess.app), localDir)
	tag := ""
	splitting := sess.splitMinutes > 0
	if splitting {
		tag = fmt.Sprintf("-p%03d", sess.partIndex)
	}
	filename := sess.fileStem + tag + ".mp4"
	out := filepath.Join(dir, filename)
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return 0, "", httpx.Internal("cannot create recordings dir: " + nodeFsMessage(err))
	}
	var snapPrefix string
	if sess.snapshotSeconds > 0 && sess.snapsDir != "" {
		if err := os.MkdirAll(sess.snapsDir, 0o777); err != nil {
			s.warn("cannot create snapshots dir: " + err.Error())
		}
		base := strings.TrimSuffix(filename, nodeExtname(filename))
		snapPrefix = filepath.Join(sess.snapsDir, base+"_")
		sess.mu.Lock()
		sess.snapPrefixes = append(sess.snapPrefixes, base+"_")
		sess.mu.Unlock()
	}

	var info lk.EgressInfo
	var err error
	if sess.mode == "track" || sess.mode == "audio" {
		info, err = s.lk.StartTrackCompositeEgress(ctx, lk.TrackCompositeInput{
			AppName: sess.app, RoomName: sess.room, ParticipantIdentity: sess.participant,
			OutputFilepath: out, AudioOnly: sess.mode == "audio",
		})
	} else {
		in := lk.StartEgressInput{
			AppName: sess.app, RoomName: sess.room, Mode: sess.mode, ParticipantIdentity: sess.participant,
			Layout: cfg.Recording.Layout, OutputFilepath: out, SnapshotFilePrefix: snapPrefix,
		}
		if sess.snapshotSeconds > 0 {
			in.SnapshotIntervalS = sess.snapshotSeconds
		}
		info, err = s.lk.StartEgress(ctx, in)
	}
	if err != nil {
		write(s.logs, "error", "startEgress failed", map[string]any{"appName": sess.app, "roomName": sess.room, "error": err.Error()})
		return 0, "", httpx.Internal("failed to start egress: " + err.Error())
	}

	appID := s.resolveAppID(ctx, sess.app)
	meta := metatags{
		EgressID: info.EgressID, Mode: sess.mode, Room: sess.room, App: sess.app, SessionID: sess.id,
		SplitMinutes: sess.splitMinutes, SnapshotSeconds: sess.snapshotSeconds, PartIndex: sess.partIndex, IsPart: splitting,
	}
	if snapPrefix != "" {
		meta.SnapshotPrefix = filepath.Base(snapPrefix)
	}
	mj, _ := jsx.Stringify(meta)
	vodID, err := s.vods.Insert(ctx, sess.app, VodInsert{
		AppID: appID, StreamID: str(sess.streamID), Room: str(sess.room), Name: filename, Status: "recording",
		LocalPath: str(out), StartedAt: str(jsx.ISO(s.now())), MetatagsJSON: &mj,
	})
	if err != nil {
		write(s.logs, "error", "vod insert failed", map[string]any{"appName": sess.app, "egressId": info.EgressID, "error": err.Error()})
		s.safeStopEgress(ctx, info.EgressID)
		return 0, "", httpx.Internal("failed to persist recording: " + err.Error())
	}
	return vodID, info.EgressID, nil
}

// nodeFsMessage approximates an fs error message (code: detail).
func nodeFsMessage(err error) string { return err.Error() }

// nodeExtname is path.extname (a leading-dot basename has no extension).
func nodeExtname(p string) string {
	base := filepath.Base(p)
	i := strings.LastIndex(base, ".")
	if i <= 0 || strings.Trim(base, ".") == "" {
		return ""
	}
	return base[i:]
}

func (s *Service) resolveAppID(ctx context.Context, app string) int64 {
	rec, err := s.apps.Get(ctx, app)
	if err == nil && rec != nil {
		return rec.ID
	}
	return 0
}

// rotate stops the current part and starts the next one (split rotation).
func (s *Service) rotate(ctx context.Context, id string) {
	s.mu.Lock()
	sess := s.sessions[id]
	s.mu.Unlock()
	if sess == nil {
		return
	}
	cfg, err := s.loadConfig(ctx, sess.app)
	if err != nil {
		s.warn("rotate: config load failed: " + err.Error())
		return
	}
	s.safeStopEgress(ctx, sess.currentEgressID)
	sess.partIndex++
	vodID, egressID, err := s.launchPart(ctx, sess, cfg)
	if err != nil {
		if s.log != nil {
			s.log.Error(fmt.Sprintf("rotate %s failed: %s", id, err))
		}
		return
	}
	sess.currentVodID, sess.currentEgressID = vodID, egressID
	s.mu.Lock()
	s.egress[egressID] = egressRef{sess.app, vodID, id}
	s.mu.Unlock()
	write(s.logs, "info", "recording split rotated", map[string]any{
		"appName": sess.app, "sessionId": id, "partIndex": sess.partIndex, "vodId": vodID, "egressId": egressID,
	})
}

// StopRecording stops a recording by vod id or egress id.
func (s *Service) StopRecording(ctx context.Context, app, recordingID string) (*RecordingHandle, error) {
	vod, egressID, err := s.resolveRecording(ctx, app, recordingID)
	if err != nil {
		return nil, err
	}
	sid, _ := parseMeta(vod.MetatagsJSON).Get("sessionId").(string)
	s.mu.Lock()
	sess := s.sessions[sid]
	s.mu.Unlock()
	liveEgress, liveVod := egressID, vod.ID
	if sess != nil {
		if sess.currentEgressID != "" {
			liveEgress = sess.currentEgressID
		}
		liveVod = sess.currentVodID
		s.clearSession(ctx, sid)
	}
	if _, err := s.lk.StopEgress(ctx, liveEgress); err != nil {
		write(s.logs, "error", "stopEgress failed", map[string]any{"appName": app, "egressId": liveEgress, "error": err.Error()})
		return nil, httpx.Internal("failed to stop egress: " + err.Error())
	}
	write(s.logs, "info", "recording stop requested", map[string]any{"appName": app, "vodId": liveVod, "egressId": liveEgress})
	return &RecordingHandle{liveVod, liveEgress, vod.Status}, nil
}

// StartForStream records a live stream's room.
func (s *Service) StartForStream(ctx context.Context, app, streamID, room, recordMode, participant string) (*RecordingHandle, error) {
	return s.StartRecording(ctx, StartInput{AppName: app, RoomName: room, StreamID: streamID, RecordMode: recordMode, ParticipantIdentity: participant})
}

// StopForStream stops the in-progress recording of a stream.
func (s *Service) StopForStream(ctx context.Context, app, streamID string) (*RecordingHandle, error) {
	vod, err := s.vods.FindActiveByStream(ctx, app, streamID)
	if err != nil {
		return nil, err
	}
	if vod == nil {
		return nil, httpx.NotFound(fmt.Sprintf("no in-progress recording for stream '%s'", streamID))
	}
	return s.StopRecording(ctx, app, strconv.FormatInt(vod.ID, 10))
}

// clearSession stops a session's timers, drops it, then sweeps snapshots.
func (s *Service) clearSession(ctx context.Context, id string) {
	s.mu.Lock()
	sess := s.sessions[id]
	delete(s.sessions, id)
	s.mu.Unlock()
	if sess == nil {
		return
	}
	if sess.stop != nil {
		sess.stop()
	}
	s.sweepSnapshots(ctx, sess)
}

var jpegName = regexp.MustCompile(`(?i)\.(jpe?g)$`)

type snapshotPayload struct {
	App       string  `json:"app"`
	Room      string  `json:"room"`
	StreamID  string  `json:"streamId"`
	VodID     int64   `json:"vodId"`
	Key       string  `json:"key"`
	URL       string  `json:"url"`
	SizeBytes float64 `json:"sizeBytes"`
}

type streamSnapshotPayload struct {
	snapshotPayload
	Source string `json:"source"`
}

// sweepSnapshots uploads new egress JPEGs and fires snapshot callbacks.
func (s *Service) sweepSnapshots(ctx context.Context, sess *session) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.snapsDir == "" || sess.snapshotSeconds <= 0 {
		return
	}
	entries, err := os.ReadDir(sess.snapsDir)
	if err != nil {
		return
	}
	var matches []string
	for _, e := range entries {
		f := e.Name()
		if !jpegName.MatchString(f) || sess.uploaded[f] {
			continue
		}
		for _, p := range sess.snapPrefixes {
			if strings.HasPrefix(f, p) {
				matches = append(matches, f)
				break
			}
		}
	}
	if len(matches) == 0 {
		return
	}
	cfg, err := s.loadConfig(ctx, sess.app)
	if err != nil {
		s.warn("snapshot sweep: config load failed: " + err.Error())
		return
	}
	sort.Strings(matches)
	for _, f := range matches {
		local := filepath.Join(sess.snapsDir, f)
		sess.uploaded[f] = true
		st, err := os.Stat(local)
		if err != nil || !st.Mode().IsRegular() || st.Size() == 0 {
			delete(sess.uploaded, f)
			continue
		}
		up, err := s.s3.Upload(ctx, cfg.S3, local, "snapshots/"+f, "image/jpeg")
		if err != nil {
			delete(sess.uploaded, f)
			s.warn(fmt.Sprintf("snapshot upload %s failed: %s", f, err))
			continue
		}
		url := up.URL
		if p, err := s.s3.PresignGet(ctx, cfg.S3, up.Key, presignTTL, nil); err == nil {
			url = p
		}
		if cfg.Recording.DeleteLocalAfterUpload {
			s.removeLocal(local)
		}
		write(s.logs, "info", "snapshot taken", map[string]any{"appName": sess.app, "sessionId": sess.id, "key": up.Key})
		p := snapshotPayload{sess.app, sess.room, sess.streamID, sess.currentVodID, up.Key, url, float64(up.SizeBytes)}
		s.dispatch(ctx, sess.app, "snapshot_taken", p)
		s.dispatch(ctx, sess.app, "stream.snapshot", streamSnapshotPayload{p, "periodic"})
	}
}

// ---------------------------------------------------------------------------
// Egress webhook → upload flow (livekit.Recording)
// ---------------------------------------------------------------------------

// classify maps an egress status to progress | complete | failed.
func classify(status string) string {
	s := strings.ToUpper(status)
	switch {
	case strings.Contains(s, "FAIL") || strings.Contains(s, "ABORT"):
		return "failed"
	case strings.Contains(s, "COMPLETE") || strings.Contains(s, "ENDED") || strings.Contains(s, "LIMIT_REACHED"):
		return "complete"
	}
	return "progress"
}

// OnEgressEvent advances the flow on egress_updated / egress_ended.
func (s *Service) OnEgressEvent(ctx context.Context, egressID, status string, ev *livekit.WebhookEvent) error {
	phase := classify(status)
	if phase == "progress" {
		return nil
	}
	ref := s.locate(ctx, egressID)
	if ref == nil {
		s.warn("egress event for unknown egress " + egressID)
		return nil
	}
	if phase == "failed" {
		detail := "unknown egress error"
		if e := ev.GetEgressInfo().GetError(); e != "" {
			detail = e
		}
		s.markFailed(ctx, ref.app, ref.vodID, "egress "+status, detail)
		s.forget(egressID)
		return nil
	}
	p := (&VodPatch{}).Set("status", "uploading").Set("ended_at", jsx.ISO(s.now()))
	if err := s.vods.Update(ctx, ref.app, ref.vodID, p); err != nil {
		s.warn("could not mark uploading: " + err.Error())
	}
	if s.queue.enqueue(ctx, uploadJob{ref.app, ref.vodID}) {
		write(s.logs, "info", "upload job enqueued", map[string]any{"appName": ref.app, "vodId": ref.vodID, "egressId": egressID})
	}
	s.forget(egressID)
	return nil
}

// Start implements livekit.Recording (auto-record on room_started).
func (s *Service) Start(ctx context.Context, app, room string) (int64, string, error) {
	h, err := s.StartRecording(ctx, StartInput{AppName: app, RoomName: room})
	if err != nil {
		return 0, "", err
	}
	return h.VodID, h.EgressID, nil
}

func (s *Service) forget(egressID string) {
	s.mu.Lock()
	delete(s.egress, egressID)
	s.mu.Unlock()
}

// locate finds the app+vod of an egress: memory, then every app DB.
func (s *Service) locate(ctx context.Context, egressID string) *egressRef {
	s.mu.Lock()
	ref, ok := s.egress[egressID]
	s.mu.Unlock()
	if ok {
		return &ref
	}
	list, err := s.apps.List(ctx, nil)
	if err != nil {
		return nil
	}
	for _, a := range list {
		if v, err := s.vods.FindByEgressID(ctx, a.Name, egressID); err == nil && v != nil {
			return &egressRef{app: a.Name, vodID: v.ID}
		}
	}
	return nil
}

// readyPayload is the vod_ready body (+ part/recording extras).
type readyPayload struct {
	VodID       int64    `json:"vodId"`
	App         string   `json:"app"`
	Room        *string  `json:"room"`
	StreamID    *string  `json:"streamId"`
	FileKey     string   `json:"fileKey"`
	S3URL       string   `json:"s3Url"`
	PublicURL   string   `json:"publicUrl"`
	SnapshotKey *string  `json:"snapshotKey"`
	SizeBytes   float64  `json:"sizeBytes"`
	DurationS   *float64 `json:"durationS"`
	Width       *float64 `json:"width"`
	Height      *float64 `json:"height"`
	Format      *string  `json:"format"`
}

type partReadyPayload struct {
	readyPayload
	PartIndex float64 `json:"partIndex"`
	SessionID *string `json:"sessionId,omitempty"`
}

type recordingReadyPayload struct {
	partReadyPayload
	Split bool `json:"split"`
}

// processUpload is the upload job (SPEC §8.3/§8.4).
func (s *Service) processUpload(ctx context.Context, app string, vodID int64) {
	vod, err := s.vods.FindByID(ctx, app, vodID)
	if err != nil || vod == nil {
		s.warn(fmt.Sprintf("upload job: vod %d (%s) missing", vodID, app))
		return
	}
	if vod.LocalPath == nil || !exists(*vod.LocalPath) {
		detail := "(null)"
		if vod.LocalPath != nil {
			detail = *vod.LocalPath
		}
		s.markFailed(ctx, app, vodID, "local recording file missing", detail)
		return
	}
	local := *vod.LocalPath
	cfg, err := s.apps.GetConfig(ctx, app)
	if err != nil {
		s.markFailed(ctx, app, vodID, "config load failed", fmt.Sprintf("app '%s' config unavailable: %s", app, err.Error()))
		return
	}
	if err := s.upload(ctx, app, cfg, vod, local); err != nil {
		s.markFailed(ctx, app, vodID, "upload flow failed", err.Error())
	}
}

func (s *Service) upload(ctx context.Context, app string, cfg *contracts.AppConfig, vod *VodRecord, local string) error {
	media := ProbeMedia(ctx, s.runner, local)
	snapKey, snapLocal := s.buildSnapshot(ctx, app, cfg, vod, local)
	up, err := s.s3.Upload(ctx, cfg.S3, local, filepath.Base(local), "video/mp4")
	if err != nil {
		return err
	}
	publicURL := up.URL
	if p, err := s.s3.PresignGet(ctx, cfg.S3, up.Key, presignTTL, nil); err == nil {
		publicURL = p
	} else {
		s.warn("presign failed: " + err.Error())
	}
	wantsVariants := s.Transcode != nil && s.Transcode.Needed(cfg)
	if cfg.Recording.DeleteLocalAfterUpload {
		if !wantsVariants {
			s.removeLocal(local)
		}
		s.removeLocal(snapLocal)
	}
	meta := parseMeta(vod.MetatagsJSON)
	meta.Set("room", nullStr(vod.Room))
	meta.Set("app", app)
	meta.Set("durationS", nullNum(media.DurationS))
	meta.Set("width", nullNum(media.Width))
	meta.Set("height", nullNum(media.Height))
	meta.Set("codec", nullStr(media.Format))
	mj, _ := yamljs.Stringify(meta)
	var localPath any = local
	if cfg.Recording.DeleteLocalAfterUpload && !wantsVariants {
		localPath = nil
	}
	p := (&VodPatch{}).Set("status", "ready").Set("file_key", up.Key).Set("s3_url", up.URL).Set("public_url", publicURL).
		Set("size_bytes", up.SizeBytes).Set("duration_s", ptrVal(media.DurationS)).Set("width", ptrVal(media.Width)).
		Set("height", ptrVal(media.Height)).Set("format", ptrVal(media.Format)).Set("snapshot_key", ptrVal(snapKey)).
		Set("local_path", localPath).Set("metatags_json", mj)
	if err := s.vods.Update(ctx, app, vod.ID, p); err != nil {
		return err
	}
	write(s.logs, "info", "vod ready", map[string]any{"appName": app, "vodId": vod.ID, "fileKey": up.Key, "sizeBytes": up.SizeBytes})
	if m := get(s.opt.Metrics); m != nil {
		m.VodGenerated(app)
	}

	old := parseMeta(vod.MetatagsJSON)
	isPart := yamljs.Truthy(old.Get("isPart"))
	partIndex := yamljs.ToNumber(yamljs.Coalesce(old.Get("partIndex"), 0.0)) // Number(x ?? 0) || 0
	if math.IsNaN(partIndex) {
		partIndex = 0
	}
	var sessionID *string
	if sid, ok := old.Get("sessionId").(string); ok {
		sessionID = &sid
	}
	ended := true
	if sessionID != nil {
		s.mu.Lock()
		_, live := s.sessions[*sessionID]
		s.mu.Unlock()
		ended = !live
	}
	ready := readyPayload{vod.ID, app, vod.Room, vod.StreamID, up.Key, up.URL, publicURL, snapKey,
		float64(up.SizeBytes), media.DurationS, media.Width, media.Height, media.Format}
	s.dispatch(ctx, app, "vod_ready", ready)
	part := partReadyPayload{ready, partIndex, sessionID}
	if isPart {
		s.dispatch(ctx, app, "recording_part_ready", part)
	}
	if !isPart || ended {
		s.dispatch(ctx, app, "recording_ready", recordingReadyPayload{part, isPart})
	}
	if t := get(s.opt.Transcription); t != nil {
		t.OnVodReady(app, vod.ID)
	}
	if wantsVariants {
		s.Transcode.Enqueue(ctx, TranscodeJob{AppName: app, VodID: vod.ID, SourcePath: local, DeleteSourceAfter: cfg.Recording.DeleteLocalAfterUpload})
	}
	return nil
}

func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullNum(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

// ptrVal is a SQL bind value: nil pointer → NULL.
func ptrVal[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

// buildSnapshot extracts + uploads a JPEG (best-effort: nil on failure).
func (s *Service) buildSnapshot(ctx context.Context, app string, cfg *contracts.AppConfig, vod *VodRecord, local string) (*string, string) {
	dir := filepath.Join(s.apps.AppDir(app), "snapshots")
	if err := os.MkdirAll(dir, 0o777); err != nil {
		s.warn("snapshot failed: " + err.Error())
		return nil, ""
	}
	base := strings.TrimSuffix(filepath.Base(local), nodeExtname(local))
	stem := RenderFilenameTemplate(cfg.Recording.SnapshotTemplate, TemplateTokens{
		App: app, StreamID: deref(vod.StreamID), Room: deref(vod.Room), Type: "jpg", Variables: cfg.Variables, Now: s.now(),
	})
	if stem == "" {
		stem = base
	}
	out := filepath.Join(dir, stem+".jpg")
	if !ExtractSnapshot(ctx, s.runner, local, out, 1) || !exists(out) {
		return nil, ""
	}
	res, err := s.s3.Upload(ctx, cfg.S3, out, stem+".jpg", "image/jpeg")
	if err != nil {
		s.warn("snapshot failed: " + err.Error())
		return nil, ""
	}
	return &res.Key, out
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

type failedPayload struct {
	VodID    int64   `json:"vodId"`
	App      string  `json:"app"`
	Room     *string `json:"room"`
	StreamID *string `json:"streamId"`
	Reason   string  `json:"reason"`
	Detail   string  `json:"detail"`
}

func (s *Service) markFailed(ctx context.Context, app string, vodID int64, reason, detail string) {
	if err := s.vods.Update(ctx, app, vodID, (&VodPatch{}).Set("status", "failed")); err != nil && s.log != nil {
		s.log.Error("could not mark vod failed: " + err.Error())
	}
	write(s.logs, "error", reason, map[string]any{"appName": app, "vodId": vodID, "detail": detail})
	if m := get(s.opt.Metrics); m != nil {
		m.RecordingFailed(app, reason)
	}
	vod, _ := s.vods.FindByID(ctx, app, vodID)
	p := failedPayload{VodID: vodID, App: app, Reason: reason, Detail: detail}
	if vod != nil {
		p.Room, p.StreamID = vod.Room, vod.StreamID
	}
	s.dispatch(ctx, app, "recording_failed", p)
}

var intLike = regexp.MustCompile(`^\s*[+-]?\d+`)

// resolveRecording finds a VOD by numeric id or egress id.
func (s *Service) resolveRecording(ctx context.Context, app, id string) (*VodRecord, string, error) {
	var vod *VodRecord
	// parseInt(id) round-trips exactly to the trimmed id → numeric lookup.
	if m := intLike.FindString(id); m != "" {
		if n, err := strconv.ParseInt(strings.TrimSpace(m), 10, 64); err == nil && strconv.FormatInt(n, 10) == strings.TrimSpace(id) {
			v, err := s.vods.FindByID(ctx, app, n)
			if err != nil {
				return nil, "", err
			}
			vod = v
		}
	}
	if vod == nil {
		v, err := s.vods.FindByEgressID(ctx, app, id)
		if err != nil {
			return nil, "", err
		}
		vod = v
	}
	if vod == nil {
		return nil, "", httpx.NotFound(fmt.Sprintf("recording %s not found", id))
	}
	egressID, _ := parseMeta(vod.MetatagsJSON).Get("egressId").(string)
	if egressID == "" {
		egressID = id
	}
	return vod, egressID, nil
}

// parseMeta is parseMeta: an object, else {} (never fails).
func parseMeta(raw *string) *yamljs.Map {
	if raw == nil || *raw == "" {
		return yamljs.NewMap()
	}
	v, err := yamljs.ParseJSON([]byte(*raw))
	if m, ok := v.(*yamljs.Map); err == nil && ok {
		return m
	}
	return yamljs.NewMap()
}

func (s *Service) safeStopEgress(ctx context.Context, id string) {
	if _, err := s.lk.StopEgress(ctx, id); err != nil {
		s.warn("cleanup stopEgress failed: " + err.Error())
	}
}

func (s *Service) removeLocal(p string) {
	if p == "" {
		return
	}
	if exists(p) {
		if err := os.Remove(p); err != nil {
			s.warn(fmt.Sprintf("could not delete local %s: %s", p, err))
		}
	}
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
