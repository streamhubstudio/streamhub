package restream

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
)

const (
	// maxTargetsPerRoom caps simultaneous live destinations (one egress each).
	maxTargetsPerRoom = 10
	// retryLimit bounds the per-endpoint relaunch (AntMedia endpointRepublishLimit=3).
	retryLimit       = 3
	retryBackoffBase = 5 * time.Second
)

// LiveKit is the slice of the guarded LiveKit wrapper restream uses.
type LiveKit interface {
	StartStreamEgress(ctx context.Context, in livekit.StartStreamEgressInput) (livekit.StreamEgressInfo, error)
	ListStreamEgress(ctx context.Context, roomPrefix string) ([]livekit.StreamEgressInfo, error)
	StopEgress(ctx context.Context, egressID string) (livekit.EgressInfo, error)
}

// Streams resolves a stream id to its row (nil when absent).
type Streams interface {
	Get(ctx context.Context, app, streamID string) (*streams.StreamRecord, error)
}

// Logs is LogsServiceContract.write.
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Callbacks is the HMAC-signed callback dispatcher.
type Callbacks interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// AddInput is the validated AddRestreamDto.
type AddInput struct {
	Platform *string
	URL      string
	Key      string
	Name     *string
	Layout   string
}

// RestreamTargetView is a destination as exposed by the API — the key is ALWAYS masked.
type RestreamTargetView struct {
	ID        int64   `json:"id"`
	Name      *string `json:"name"`
	Platform  string  `json:"platform"`
	Room      string  `json:"room"`
	StreamID  *string `json:"streamId"`
	URLMasked string  `json:"urlMasked"`
	EgressID  *string `json:"egressId"`
	Status    string  `json:"status"`
	Error     *string `json:"error"`
	Retries   int64   `json:"retries"`
	StartedAt string  `json:"startedAt"`
	EndedAt   *string `json:"endedAt"`
}

func ptr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	return &n.String
}

// View is RestreamService.toView.
func View(t *Target) RestreamTargetView {
	return RestreamTargetView{
		ID: t.ID, Name: ptr(t.Name), Platform: t.Platform, Room: t.Room, StreamID: ptr(t.StreamID),
		URLMasked: t.URLMasked, EgressID: ptr(t.EgressID), Status: t.Status, Error: ptr(t.Error),
		Retries: t.Retries, StartedAt: t.StartedAt, EndedAt: ptr(t.EndedAt),
	}
}

// Service is RestreamService.
type Service struct {
	repo      *Repository
	lk        func() LiveKit
	streams   Streams
	logs      func() Logs
	callbacks func() Callbacks
	log       *slog.Logger

	mu sync.Mutex
	// egressApp is egressId → app: webhook fallback when no app resolves.
	egressApp map[string]string
	timers    map[*time.Timer]struct{}
	closed    bool
	// afterFunc schedules a retry (time.AfterFunc; tests replace it).
	afterFunc func(time.Duration, func()) *time.Timer
}

// Deps wires the service; getters may return nil (not wired).
type Deps struct {
	Repo      *Repository
	LiveKit   func() LiveKit
	Streams   Streams
	Logs      func() Logs
	Callbacks func() Callbacks
	Log       *slog.Logger
}

// NewService builds the service.
func NewService(d Deps) *Service {
	log := d.Log
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		repo: d.Repo, lk: d.LiveKit, streams: d.Streams, logs: d.Logs, callbacks: d.Callbacks, log: log,
		egressApp: map[string]string{}, timers: map[*time.Timer]struct{}{}, afterFunc: time.AfterFunc,
	}
}

// Start cancels the pending retries when ctx ends (OnModuleDestroy).
func (s *Service) Start(ctx context.Context) {
	go func() {
		<-ctx.Done()
		s.Close()
	}()
}

// Close stops every pending retry timer.
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for t := range s.timers {
		t.Stop()
	}
	clear(s.timers)
}

func (s *Service) write(level, msg string, meta map[string]any) {
	if s.logs != nil {
		if l := s.logs(); l != nil {
			l.Write(level, "restream", msg, meta, nil)
			return
		}
	}
	s.log.Info(msg, "source", "restream", "level", level, "meta", meta)
}

func (s *Service) livekit() (LiveKit, error) {
	if s.lk != nil {
		if l := s.lk(); l != nil {
			return l, nil
		}
	}
	return nil, fmt.Errorf("LiveKit service unavailable")
}

func (s *Service) setEgressApp(id, app string) {
	s.mu.Lock()
	s.egressApp[id] = app
	s.mu.Unlock()
}

func (s *Service) dropEgressApp(id string) {
	s.mu.Lock()
	delete(s.egressApp, id)
	s.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Public API (controller)
// ---------------------------------------------------------------------------

type startedPayload struct {
	App      string  `json:"app"`
	Room     string  `json:"room"`
	StreamID string  `json:"streamId"`
	TargetID int64   `json:"targetId"`
	Name     *string `json:"name"`
	Platform string  `json:"platform"`
	URL      string  `json:"url"`
	EgressID string  `json:"egressId"`
	Status   string  `json:"status"`
}

type stoppedPayload struct {
	App      string  `json:"app"`
	Room     string  `json:"room"`
	StreamID *string `json:"streamId"`
	TargetID int64   `json:"targetId"`
	Name     *string `json:"name"`
	Platform string  `json:"platform"`
	URL      string  `json:"url"`
	EgressID string  `json:"egressId"`
	Reason   string  `json:"reason"`
}

type failedPayload struct {
	App       string  `json:"app"`
	Room      string  `json:"room"`
	StreamID  *string `json:"streamId"`
	TargetID  int64   `json:"targetId"`
	Name      *string `json:"name"`
	Platform  string  `json:"platform"`
	URL       string  `json:"url"`
	EgressID  *string `json:"egressId"`
	Error     string  `json:"error"`
	Retries   int64   `json:"retries"`
	WillRetry bool    `json:"willRetry"`
}

// Add adds a destination: build URL → start egress → persist → callback.
func (s *Service) Add(ctx context.Context, app, streamID string, in AddInput) (*RestreamTargetView, error) {
	platform, err := normalizePlatform(in.Platform)
	if err != nil {
		return nil, err
	}
	room, err := s.resolveRoom(ctx, app, streamID)
	if err != nil {
		return nil, err
	}
	url, err := BuildTargetURL(platform, in.URL, in.Key)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}
	masked := MaskRtmpURL(url)

	dup, err := s.repo.FindLiveByURL(ctx, app, room, url)
	if err != nil {
		return nil, err
	}
	if dup != nil {
		return nil, httpx.Conflict(fmt.Sprintf("destination already active for room '%s' (%s)", room, masked))
	}
	n, err := s.repo.CountLiveByRoom(ctx, app, room)
	if err != nil {
		return nil, err
	}
	if n >= maxTargetsPerRoom {
		return nil, httpx.BadRequest(fmt.Sprintf("room '%s' already has %d live destinations", room, maxTargetsPerRoom))
	}

	lk, err := s.livekit()
	var info livekit.StreamEgressInfo
	if err == nil {
		info, err = lk.StartStreamEgress(ctx, livekit.StartStreamEgressInput{AppName: app, RoomName: room, RtmpURL: url, Layout: in.Layout})
	}
	if err != nil {
		s.write("error", "startStreamEgress failed", map[string]any{
			"appName": app, "room": room, "platform": platform, "url": masked, "error": err.Error(),
		})
		return nil, httpx.Internal("failed to start restream: " + err.Error())
	}

	var name *string
	if in.Name != nil {
		if t := strings.TrimSpace(*in.Name); t != "" {
			name = &t
		}
	}
	row, err := s.repo.Insert(ctx, Insert{
		App: app, Room: room, StreamID: &streamID, Name: name, Platform: platform,
		URL: url, URLMasked: masked, EgressID: info.EgressID,
	})
	if err != nil {
		return nil, err
	}
	s.setEgressApp(info.EgressID, app)

	s.write("info", "restream destination started", map[string]any{
		"appName": app, "room": room, "streamId": streamID, "platform": platform,
		"url": masked, "egressId": info.EgressID, "status": info.Status,
	})
	s.dispatch(ctx, app, "restream_started", startedPayload{
		App: app, Room: room, StreamID: streamID, TargetID: row.ID, Name: ptr(row.Name), Platform: platform,
		URL: masked, EgressID: info.EgressID, Status: row.Status,
	})
	v := View(row)
	return &v, nil
}

// List returns the stream's starting/active/failed destinations, upgrading
// starting → active from the live egress listing first (best-effort).
func (s *Service) List(ctx context.Context, app, streamID string) ([]RestreamTargetView, error) {
	room, err := s.resolveRoom(ctx, app, streamID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.ListByRoom(ctx, app, room)
	if err != nil {
		return nil, err
	}
	if slices.ContainsFunc(rows, func(r *Target) bool { return r.Status == "starting" }) {
		s.refreshFromLiveKit(ctx, app, room, rows)
		if rows, err = s.repo.ListByRoom(ctx, app, room); err != nil {
			return nil, err
		}
	}
	out := make([]RestreamTargetView, 0, len(rows))
	for _, r := range rows {
		out = append(out, View(r))
	}
	return out, nil
}

// Remove stops ONE destination by egress id (the others keep pushing).
func (s *Service) Remove(ctx context.Context, app, streamID, egressID string) (*RestreamTargetView, error) {
	id := strings.TrimSpace(egressID)
	if id == "" {
		return nil, httpx.BadRequest("egress id is required")
	}
	room, err := s.resolveRoom(ctx, app, streamID)
	if err != nil {
		return nil, err
	}
	row, err := s.repo.ByEgressID(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if row == nil || row.Room != room {
		return nil, httpx.NotFound(fmt.Sprintf("restream destination '%s' not found for stream '%s'", id, streamID))
	}
	// Mark terminal FIRST so the egress_ended webhook (fired by stopEgress)
	// sees a stopped row and does not double-fire restream_stopped.
	if err := s.repo.SetStatus(ctx, app, row.ID, "stopped", nil); err != nil {
		return nil, err
	}
	s.dropEgressApp(id)
	if row.Status == "starting" || row.Status == "active" {
		lk, err := s.livekit()
		if err == nil {
			_, err = lk.StopEgress(ctx, id)
		}
		if err != nil {
			s.write("warn", "stopEgress failed (continuing)", map[string]any{"appName": app, "egressId": id, "error": err.Error()})
		}
	}
	s.write("info", "restream destination stopped", map[string]any{
		"appName": app, "room": room, "streamId": streamID, "egressId": id, "url": row.URLMasked,
	})
	sid := streamID
	s.dispatch(ctx, app, "restream_stopped", stoppedPayload{
		App: app, Room: room, StreamID: &sid, TargetID: row.ID, Name: ptr(row.Name), Platform: row.Platform,
		URL: row.URLMasked, EgressID: id, Reason: "stopped_by_user",
	})
	updated, err := s.repo.ByID(ctx, app, row.ID)
	if err != nil || updated == nil {
		updated = row
	}
	v := View(updated)
	return &v, nil
}

// ---------------------------------------------------------------------------
// Webhook path (livekit plane → "restream")
// ---------------------------------------------------------------------------

// OnEgressEvent advances a destination from a LiveKit egress webhook
// (app "" = unresolved). Non-restream egresses match no row → no-op. Never
// fails: the sink always acks and one endpoint never disturbs the others.
func (s *Service) OnEgressEvent(ctx context.Context, app, egressID, status string) error {
	if err := s.onEgressEvent(ctx, app, egressID, status); err != nil {
		s.log.Warn(fmt.Sprintf("onEgressEvent(%s, %s) failed: %s", egressID, status, err))
	}
	return nil
}

func (s *Service) onEgressEvent(ctx context.Context, app, egressID, status string) error {
	if app == "" {
		s.mu.Lock()
		app = s.egressApp[egressID]
		s.mu.Unlock()
	}
	if app == "" {
		return nil
	}
	row, err := s.repo.ByEgressID(ctx, app, egressID)
	if err != nil || row == nil {
		return err
	}
	// Terminal rows never move again (e.g. stop-by-user already recorded).
	if row.Status == "stopped" {
		return nil
	}
	switch status {
	case "EGRESS_ACTIVE":
		if row.Status != "active" {
			return s.repo.SetStatus(ctx, app, row.ID, "active", nil)
		}
	case "EGRESS_FAILED", "EGRESS_LIMIT_REACHED":
		return s.onFailed(ctx, app, row, status)
	case "EGRESS_COMPLETE", "EGRESS_ABORTED":
		if row.Status == "failed" {
			return nil // already surfaced as failed
		}
		if err := s.repo.SetStatus(ctx, app, row.ID, "stopped", nil); err != nil {
			return err
		}
		s.dropEgressApp(egressID)
		reason := "completed"
		if status == "EGRESS_ABORTED" {
			reason = "aborted"
		}
		s.dispatch(ctx, app, "restream_stopped", stoppedPayload{
			App: app, Room: row.Room, StreamID: ptr(row.StreamID), TargetID: row.ID, Name: ptr(row.Name),
			Platform: row.Platform, URL: row.URLMasked, EgressID: egressID, Reason: reason,
		})
	}
	return nil // EGRESS_STARTING / EGRESS_ENDING → nothing to record
}

// ---------------------------------------------------------------------------
// Per-endpoint failure + bounded retry (best-effort)
// ---------------------------------------------------------------------------

func (s *Service) onFailed(ctx context.Context, app string, row *Target, status string) error {
	msg := "egress " + strings.ToLower(status)
	if err := s.repo.SetStatus(ctx, app, row.ID, "failed", &msg); err != nil {
		return err
	}
	s.dropEgressApp(row.EgressID.String)
	s.write("warn", "restream destination failed", map[string]any{
		"appName": app, "room": row.Room, "egressId": ptr(row.EgressID), "url": row.URLMasked,
		"retries": row.Retries, "status": status,
	})
	willRetry := status == "EGRESS_FAILED" && row.Retries < retryLimit
	s.dispatch(ctx, app, "restream_failed", failedPayload{
		App: app, Room: row.Room, StreamID: ptr(row.StreamID), TargetID: row.ID, Name: ptr(row.Name),
		Platform: row.Platform, URL: row.URLMasked, EgressID: ptr(row.EgressID), Error: msg,
		Retries: row.Retries, WillRetry: willRetry,
	})
	// Relaunch with exponential backoff — never blocks the caller, never
	// affects other destinations. LIMIT_REACHED is not retried.
	if willRetry {
		s.scheduleRetry(app, row.ID, row.Retries)
	}
	return nil
}

func (s *Service) scheduleRetry(app string, targetID, retries int64) {
	delay := retryBackoffBase * time.Duration(1<<retries)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	var t *time.Timer
	t = s.afterFunc(delay, func() {
		s.mu.Lock()
		delete(s.timers, t)
		s.mu.Unlock()
		s.retry(context.Background(), app, targetID)
	})
	s.timers[t] = struct{}{}
}

// retry relaunches the egress of a failed target (if still failed).
func (s *Service) retry(ctx context.Context, app string, targetID int64) {
	row, err := s.repo.ByID(ctx, app, targetID)
	if err != nil {
		s.log.Warn(fmt.Sprintf("retry(%s, %d) failed: %s", app, targetID, err))
		return
	}
	if row == nil || row.Status != "failed" {
		return // stopped/recovered meanwhile
	}
	next := row.Retries + 1
	lk, err := s.livekit()
	var info livekit.StreamEgressInfo
	if err == nil {
		info, err = lk.StartStreamEgress(ctx, livekit.StartStreamEgressInput{AppName: app, RoomName: row.Room, RtmpURL: row.URL})
	}
	if err != nil {
		_ = s.repo.BumpRetries(ctx, app, row.ID, next)
		s.write("warn", "restream retry failed", map[string]any{
			"appName": app, "room": row.Room, "url": row.URLMasked, "retries": next, "error": err.Error(),
		})
		if next < retryLimit {
			s.scheduleRetry(app, row.ID, next)
		}
		return
	}
	if err := s.repo.SetEgress(ctx, app, row.ID, info.EgressID, next); err != nil {
		s.log.Warn(fmt.Sprintf("retry(%s, %d) failed: %s", app, targetID, err))
		return
	}
	s.setEgressApp(info.EgressID, app)
	s.write("info", "restream destination relaunched", map[string]any{
		"appName": app, "room": row.Room, "egressId": info.EgressID, "url": row.URLMasked, "retries": next,
	})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func normalizePlatform(p *string) (string, error) {
	platform := "custom"
	if p != nil {
		platform = *p
	}
	if !slices.Contains(Platforms, platform) {
		return "", httpx.BadRequest("platform must be one of: " + strings.Join(Platforms, ", "))
	}
	return platform, nil
}

// resolveRoom maps a stream id to its (namespaced) LiveKit room.
func (s *Service) resolveRoom(ctx context.Context, app, streamID string) (string, error) {
	st, err := s.streams.Get(ctx, app, streamID)
	if err != nil {
		return "", err
	}
	if st == nil {
		return "", httpx.NotFound(fmt.Sprintf("stream '%s' not found", streamID))
	}
	room := strings.TrimSpace(st.Room)
	if room == "" {
		return "", httpx.BadRequest(fmt.Sprintf("stream '%s' has no room to restream", streamID))
	}
	return room, nil
}

// refreshFromLiveKit upgrades 'starting' rows to 'active' (webhooks remain
// the source of truth; a listing failure is ignored).
func (s *Service) refreshFromLiveKit(ctx context.Context, app, room string, rows []*Target) {
	lk, err := s.livekit()
	if err != nil {
		return
	}
	live, err := lk.ListStreamEgress(ctx, room)
	if err != nil {
		s.log.Debug("refreshFromLiveKit failed: " + err.Error())
		return
	}
	active := map[string]bool{}
	for _, e := range live {
		if e.Status == "EGRESS_ACTIVE" {
			active[e.EgressID] = true
		}
	}
	for _, r := range rows {
		if r.Status == "starting" && r.EgressID.Valid && r.EgressID.String != "" && active[r.EgressID.String] {
			_ = s.repo.SetStatus(ctx, app, r.ID, "active", nil)
		}
	}
}

func (s *Service) dispatch(ctx context.Context, app, event string, payload any) {
	if s.callbacks == nil {
		return
	}
	cb := s.callbacks()
	if cb == nil {
		return
	}
	if err := cb.Dispatch(ctx, app, event, payload); err != nil {
		s.log.Warn(fmt.Sprintf("callback %s failed: %s", event, err))
	}
}
