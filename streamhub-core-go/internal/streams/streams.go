// Package streams is the port of src/modules/streams: active streams
// listing/detail/stop reconciled against LiveKit, on-demand snapshots, the
// per-stream plugin opt-out (stream-plugins.service.ts), the live HLS egress
// (hls.service.ts) and the auto-HLS watchdog + DVR janitor for 24/7 linear
// channels (hls-watchdog.service.ts, hls-dvr-janitor.ts).
//
// Source of truth is the per-app `streams` table; LiveKit calls go through the
// narrow interfaces in deps.go and every external call (LiveKit, ffmpeg, S3)
// degrades to a controlled error, never a crash.
package streams

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// StreamRecord is the shared-contract StreamRecord (JSON as Node returns it).
type StreamRecord struct {
	ID            int64   `json:"id"`
	AppID         int64   `json:"appId"`
	StreamID      string  `json:"streamId"`
	Type          string  `json:"type"`
	Room          string  `json:"room"`
	Participant   *string `json:"participant"`
	Status        string  `json:"status"`
	StartedAt     string  `json:"startedAt"`
	EndedAt       *string `json:"endedAt"`
	LastStatsJSON *string `json:"lastStatsJson"`
	// Viewers is present only on detail reads with features.viewerCounter on.
	Viewers *int `json:"viewers,omitempty"`
}

// RoomLiveStats is one room of the per-app live aggregate.
type RoomLiveStats struct {
	Room       string `json:"room"`
	Viewers    *int   `json:"viewers"`
	Publishers int    `json:"publishers"`
	StartedAt  string `json:"startedAt,omitempty"`
}

// AppLiveStats is the live aggregate of one app (GET /apps/:app/stats).
type AppLiveStats struct {
	ActiveStreams int64           `json:"activeStreams"`
	TotalViewers  *int            `json:"totalViewers"`
	Rooms         []RoomLiveStats `json:"rooms"`
}

// SnapshotInput is the contract SnapshotInput.
type SnapshotInput struct {
	AppName             string
	RoomName            string
	ParticipantIdentity *string
}

// SnapshotResult is the contract SnapshotResult.
type SnapshotResult struct {
	Key string `json:"key"`
	URL string `json:"url"`
}

// CaptureFunc grabs one frame of source into outPath (ffmpeg by default).
type CaptureFunc func(ctx context.Context, source, outPath string) error

// Deps wires the Service. Apps / S3 are optional as in Node (@Optional).
type Deps struct {
	Config *config.Config
	Store  *db.Service
	Global *sql.DB
	Apps   contracts.AppsService
	S3     contracts.S3Service
	Opt    Optional
	Log    *slog.Logger
	// Capture overrides the ffmpeg frame grab (tests).
	Capture CaptureFunc
	// Now overrides the clock (tests).
	Now func() time.Time
}

// Service is StreamsService.
type Service struct {
	cfg     *config.Config
	store   *db.Service
	global  *sql.DB
	apps    contracts.AppsService
	s3      contracts.S3Service
	opt     Optional
	log     *slog.Logger
	capture CaptureFunc
	now     func() time.Time
}

// New builds the service.
func New(d Deps) *Service {
	s := &Service{
		cfg: d.Config, store: d.Store, global: d.Global, apps: d.Apps, s3: d.S3,
		opt: d.Opt, log: d.Log, capture: d.Capture, now: d.Now,
	}
	if s.capture == nil {
		s.capture = s.ffmpegCapture
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.log == nil {
		s.log = slog.Default()
	}
	return s
}

// PruneGrace is the window before a fresh stream row can be pruned, so a
// joined-but-not-yet-publishing participant doesn't flap ended→active.
const PruneGrace = 15 * time.Second

type appRow struct {
	id     int64
	name   string
	prefix sql.NullString
}

type streamRow struct {
	id            int64
	appID         int64
	streamID      string
	typ           string
	room          sql.NullString
	participant   sql.NullString
	status        string
	startedAt     string
	endedAt       sql.NullString
	lastStatsJSON sql.NullString
}

const streamCols = "id, app_id, stream_id, type, room, participant, status, started_at, ended_at, last_stats_json"

func scanStream(sc interface{ Scan(...any) error }) (*streamRow, error) {
	var r streamRow
	err := sc.Scan(&r.id, &r.appID, &r.streamID, &r.typ, &r.room, &r.participant, &r.status, &r.startedAt, &r.endedAt, &r.lastStatsJSON)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func nullPtr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	s := n.String
	return &s
}

func (r *streamRow) record() StreamRecord {
	return StreamRecord{
		ID: r.id, AppID: r.appID, StreamID: r.streamID, Type: r.typ, Room: r.room.String,
		Participant: nullPtr(r.participant), Status: r.status, StartedAt: r.startedAt,
		EndedAt: nullPtr(r.endedAt), LastStatsJSON: nullPtr(r.lastStatsJSON),
	}
}

// internalError is Nest's body for an unexpected (non-HTTP) exception.
func internalError() error { return httpx.Internal("Internal server error") }

func (s *Service) requireApp(ctx context.Context, name string) (*appRow, error) {
	var a appRow
	err := s.global.QueryRowContext(ctx, "SELECT id, name, livekit_room_prefix FROM apps WHERE name = ?", name).
		Scan(&a.id, &a.name, &a.prefix)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.NotFound(fmt.Sprintf("app '%s' not found", name))
	}
	if err != nil {
		return nil, httpx.Unavailable(fmt.Sprintf("db error: %s", err))
	}
	return &a, nil
}

func (s *Service) appDB(ctx context.Context, name string) (*sql.DB, error) {
	h, err := s.store.App(ctx, name)
	if err != nil {
		return nil, internalError()
	}
	return h, nil
}

func (s *Service) open(ctx context.Context, name string) (*appRow, *sql.DB, error) {
	app, err := s.requireApp(ctx, name)
	if err != nil {
		return nil, nil, err
	}
	adb, err := s.appDB(ctx, name)
	if err != nil {
		return nil, nil, err
	}
	return app, adb, nil
}

func getRow(ctx context.Context, adb *sql.DB, streamID string) (*streamRow, error) {
	r, err := scanStream(adb.QueryRowContext(ctx, "SELECT "+streamCols+" FROM streams WHERE stream_id = ?", streamID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError()
	}
	return r, nil
}

func queryRows(ctx context.Context, adb *sql.DB, q string, args ...any) ([]*streamRow, error) {
	rows, err := adb.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, internalError()
	}
	defer rows.Close()
	var out []*streamRow
	for rows.Next() {
		r, err := scanStream(rows)
		if err != nil {
			return nil, internalError()
		}
		out = append(out, r)
	}
	if rows.Err() != nil {
		return nil, internalError()
	}
	return out, nil
}

// List returns the active streams of an app, reconciled against LiveKit.
func (s *Service) List(ctx context.Context, appName string) ([]StreamRecord, error) {
	app, adb, err := s.open(ctx, appName)
	if err != nil {
		return nil, err
	}
	s.reconcile(ctx, app, adb)
	rows, err := queryRows(ctx, adb, "SELECT "+streamCols+" FROM streams WHERE status = 'active' ORDER BY started_at DESC")
	if err != nil {
		return nil, err
	}
	out := make([]StreamRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.record())
	}
	return out, nil
}

// liveStats is the JSON written to last_stats_json on a detail read.
type liveStats struct {
	Live         bool `json:"live"`
	Participants int  `json:"participants"`
	Publishers   int  `json:"publishers"`
	Viewers      int  `json:"viewers"`
}

// Get returns one stream (active or ended) or nil. Active streams get a
// best-effort live enrichment (participants/viewers); `viewers` is exposed
// only when the app enables features.viewerCounter.
func (s *Service) Get(ctx context.Context, appName, streamID string) (*StreamRecord, error) {
	_, adb, err := s.open(ctx, appName)
	if err != nil {
		return nil, err
	}
	row, err := getRow(ctx, adb, streamID)
	if err != nil || row == nil {
		return nil, err
	}
	var viewers *int
	if rooms := get(s.opt.Rooms); row.status == "active" && row.room.String != "" && rooms != nil {
		parts, err := rooms.ListParticipants(ctx, row.room.String)
		if err != nil {
			s.log.Debug(fmt.Sprintf("enrich get(%s) failed: %s", streamID, err))
		} else {
			publishers, v := 0, 0
			for _, p := range parts {
				if p.Tracks > 0 {
					publishers++
				} else if !p.Hidden {
					v++
				}
			}
			viewers = &v
			stats, _ := jsx.Stringify(liveStats{true, len(parts), publishers, v})
			_, _ = adb.ExecContext(ctx, "UPDATE streams SET last_stats_json = ? WHERE id = ?", stats, row.id)
			row.lastStatsJSON = sql.NullString{String: stats, Valid: true}
		}
	}
	if viewers != nil && s.apps != nil {
		if cfg, err := s.apps.GetConfig(ctx, appName); err == nil && !cfg.Features.ViewerCounter {
			viewers = nil
		}
	}
	rec := row.record()
	if viewers != nil {
		rec.Viewers = viewers
		if m := get(s.opt.Metrics); m != nil && row.room.String != "" {
			m.SetViewers(appName, row.room.String, float64(*viewers))
		}
	}
	return &rec, nil
}

// StreamRoom is streams.get(app, id)?.room ("" when absent).
func (s *Service) StreamRoom(ctx context.Context, appName, streamID string) (string, error) {
	rec, err := s.Get(ctx, appName, streamID)
	if err != nil || rec == nil {
		return "", err
	}
	return rec.Room, nil
}

// LiveStats is the live aggregate of an app: active stream count plus
// per-room publishers/viewers. Viewers are null (per room and total) when the
// viewerCounter feature is off or LiveKit is unreachable.
func (s *Service) LiveStats(ctx context.Context, appName string) (*AppLiveStats, error) {
	app, adb, err := s.open(ctx, appName)
	if err != nil {
		return nil, err
	}
	s.reconcile(ctx, app, adb)
	var active int64
	if err := adb.QueryRowContext(ctx, "SELECT COUNT(*) AS n FROM streams WHERE status = 'active'").Scan(&active); err != nil {
		return nil, internalError()
	}
	rows, err := adb.QueryContext(ctx, "SELECT room, started_at FROM streams "+
		"WHERE status = 'active' AND room IS NOT NULL ORDER BY started_at ASC")
	if err != nil {
		return nil, internalError()
	}
	type roomStart struct{ room, startedAt string }
	var order []roomStart
	seen := map[string]bool{}
	for rows.Next() {
		var rs roomStart
		if err := rows.Scan(&rs.room, &rs.startedAt); err != nil {
			rows.Close()
			return nil, internalError()
		}
		if !seen[rs.room] {
			seen[rs.room] = true
			order = append(order, rs)
		}
	}
	rows.Close()

	viewerCounter := false
	if s.apps != nil {
		if cfg, err := s.apps.GetConfig(ctx, appName); err == nil {
			viewerCounter = cfg.Features.ViewerCounter
		}
	}
	zero := func() *int { z := 0; return &z }
	out := &AppLiveStats{ActiveStreams: active, Rooms: []RoomLiveStats{}}
	if viewerCounter {
		out.TotalViewers = zero()
	}
	rooms := get(s.opt.Rooms)
	for _, rs := range order {
		publishers := 0
		var viewers *int
		if viewerCounter {
			viewers = zero()
		}
		if rooms != nil {
			parts, err := rooms.ListParticipants(ctx, rs.room)
			if err != nil {
				s.log.Debug(fmt.Sprintf("liveStats listParticipants(%s) failed: %s", rs.room, err))
				viewers = nil
			} else {
				v := 0
				for _, p := range parts {
					if p.Tracks > 0 {
						publishers++
					} else if !p.Hidden {
						v++
					}
				}
				if viewerCounter {
					viewers = &v
					if m := get(s.opt.Metrics); m != nil {
						m.SetViewers(appName, rs.room, float64(v))
					}
				}
			}
		} else {
			viewers = nil
		}
		if viewerCounter && viewers != nil && out.TotalViewers != nil {
			*out.TotalViewers += *viewers
		}
		out.Rooms = append(out.Rooms, RoomLiveStats{rs.room, viewers, publishers, rs.startedAt})
	}
	return out, nil
}

// Stop tears down the LiveKit side (best-effort) and always marks the row
// ended; 404 when the stream is unknown.
func (s *Service) Stop(ctx context.Context, appName, streamID string) error {
	_, adb, err := s.open(ctx, appName)
	if err != nil {
		return err
	}
	row, err := getRow(ctx, adb, streamID)
	if err != nil {
		return err
	}
	if row == nil {
		return httpx.NotFound(fmt.Sprintf("stream '%s' not found", streamID))
	}
	if row.status == "active" {
		s.teardownLiveKit(ctx, adb, row)
	}
	if _, err := adb.ExecContext(ctx, "UPDATE streams SET status = 'ended', ended_at = datetime('now') WHERE id = ?", row.id); err != nil {
		return internalError()
	}
	if m := get(s.opt.Metrics); m != nil {
		m.StreamStopped(appName)
	}
	return nil
}

// UpsertRecord creates/updates the canonical stream row and returns it. The
// type is never downgraded from an ingress type (rtmp/whip/rtsp/ws-mjpeg)
// back to webrtc (webhook order-independent). participant "" stores NULL.
func (s *Service) UpsertRecord(ctx context.Context, appName, streamID, typ, room, participant string) (*StreamRecord, error) {
	app, adb, err := s.open(ctx, appName)
	if err != nil {
		return nil, err
	}
	var part any
	if participant != "" {
		part = participant
	}
	_, err = adb.ExecContext(ctx, `INSERT INTO streams (app_id, stream_id, type, room, participant, status)
         VALUES (?, ?, ?, ?, ?, 'active')
         ON CONFLICT(stream_id) DO UPDATE SET
           type = CASE
             WHEN excluded.type = 'webrtc'
                  AND streams.type IN ('rtmp','whip','rtsp','ws-mjpeg')
               THEN streams.type
             ELSE excluded.type
           END,
           room = excluded.room,
           participant = excluded.participant,
           status = 'active',
           ended_at = NULL`, app.id, streamID, typ, room, part)
	if err != nil {
		return nil, internalError()
	}
	row, err := getRow(ctx, adb, streamID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, internalError()
	}
	rec := row.record()
	return &rec, nil
}

// Upsert is UpsertRecord for callers that only need the side effect.
func (s *Service) Upsert(ctx context.Context, appName, streamID, typ, room, participant string) error {
	_, err := s.UpsertRecord(ctx, appName, streamID, typ, room, participant)
	return err
}

// End marks a stream ended without LiveKit teardown (webhook path).
// Idempotent: a missing or already-ended row is a no-op.
func (s *Service) End(ctx context.Context, appName, streamID string) error {
	_, adb, err := s.open(ctx, appName)
	if err != nil {
		return err
	}
	res, err := adb.ExecContext(ctx, "UPDATE streams SET status = 'ended', ended_at = datetime('now') "+
		"WHERE stream_id = ? AND status = 'active'", streamID)
	if err != nil {
		return internalError()
	}
	if n, _ := res.RowsAffected(); n > 0 {
		if m := get(s.opt.Metrics); m != nil {
			m.StreamStopped(appName)
		}
	}
	return nil
}

// CanonicalStreamID is the single stream key of a participant-backed stream
// (`${room}/${identity}`), shared by the webhook path and reconcile.
func CanonicalStreamID(room, identity string) string { return room + "/" + identity }

func kindToType(p Participant) string {
	if p.Ingress {
		return "rtmp"
	}
	return "webrtc"
}

func appPrefix(a *appRow) string {
	if p := jsTrim(a.prefix.String); p != "" {
		return p
	}
	return a.name
}

func roomBelongs(a *appRow, room string) bool {
	prefix := appPrefix(a)
	return room == prefix || strings.HasPrefix(room, prefix)
}

// ageOf is Date.now() - Date.parse(`${startedAt.replace(' ', 'T')}Z`); an
// unparsable timestamp is +Inf (prunable).
func (s *Service) ageOf(startedAt string) (time.Duration, bool) {
	t, err := time.Parse(time.RFC3339Nano, strings.Replace(startedAt, " ", "T", 1)+"Z")
	if err != nil {
		return 0, false
	}
	return s.now().Sub(t), true
}

// reconcile syncs the DB against live LiveKit state: ends legacy
// non-canonical rows, discovers live publishers as canonical rows and prunes
// active rows whose (room, participant) is gone. No-op when LiveKit is not
// configured or unreachable.
func (s *Service) reconcile(ctx context.Context, app *appRow, adb *sql.DB) {
	rooms := get(s.opt.Rooms)
	if rooms == nil {
		return
	}
	_, _ = adb.ExecContext(ctx, "UPDATE streams SET status = 'ended', ended_at = datetime('now') "+
		"WHERE status = 'active' AND instr(stream_id, '/') = 0 "+
		"AND type != 'ws-mjpeg'")

	all, err := rooms.ListRooms(ctx)
	if err != nil {
		s.log.Debug(fmt.Sprintf("reconcile listRooms failed: %s", err))
		return
	}
	var appRooms []string
	for _, r := range all {
		if roomBelongs(app, r) {
			appRooms = append(appRooms, r)
		}
	}
	liveByRoom := map[string]map[string]bool{}
	unknown := map[string]bool{}
	for _, room := range appRooms {
		parts, err := rooms.ListParticipants(ctx, room)
		if err != nil {
			s.log.Debug(fmt.Sprintf("listParticipants(%s) failed: %s", room, err))
			unknown[room] = true
			continue
		}
		set := map[string]bool{}
		for _, p := range parts {
			if p.Tracks == 0 {
				continue
			}
			set[p.Identity] = true
			id := CanonicalStreamID(room, p.Identity)
			var existing int64
			err := adb.QueryRowContext(ctx, "SELECT id FROM streams WHERE stream_id = ? AND status = 'active'", id).Scan(&existing)
			if errors.Is(err, sql.ErrNoRows) {
				if err := s.Upsert(ctx, app.name, id, kindToType(p), room, p.Identity); err != nil {
					s.log.Debug(fmt.Sprintf("discover upsert failed: %s", err))
				}
			}
		}
		liveByRoom[room] = set
	}

	live := map[string]bool{}
	for _, r := range appRooms {
		live[r] = true
	}
	active, err := queryRows(ctx, adb, "SELECT "+streamCols+" FROM streams WHERE status = 'active'")
	if err != nil {
		return
	}
	for _, r := range active {
		room := r.room.String
		if room == "" {
			continue
		}
		// ws-mjpeg (gateway-owned) and passthrough (remux) streams never live
		// in LiveKit: pruning them here would end every live one on list().
		if r.typ == "ws-mjpeg" || r.participant.String == "passthrough" {
			continue
		}
		if age, ok := s.ageOf(r.startedAt); ok && age < PruneGrace {
			continue
		}
		if unknown[room] {
			continue
		}
		roomGone := !live[room]
		publishers, known := liveByRoom[room]
		participantGone := !roomGone && r.participant.String != "" && known && !publishers[r.participant.String]
		if roomGone || participantGone {
			_, _ = adb.ExecContext(ctx, "UPDATE streams SET status = 'ended', ended_at = datetime('now') WHERE id = ?", r.id)
		}
	}
}

func (s *Service) teardownLiveKit(ctx context.Context, adb *sql.DB, row *streamRow) {
	room := row.room.String
	if room == "" || row.typ == "ws-mjpeg" {
		return
	}
	rooms := get(s.opt.Rooms)
	err := func() error {
		participant := row.participant.String
		if row.typ == "webrtc" && participant != "" && rooms != nil {
			return rooms.RemoveParticipant(ctx, room, participant)
		}
		if (row.typ == "rtmp" || row.typ == "whip" || row.typ == "rtsp") && rooms != nil {
			if id := s.findIngressID(ctx, rooms, room, participant); id != "" {
				return rooms.DeleteIngress(ctx, id)
			} else if participant != "" {
				return rooms.RemoveParticipant(ctx, room, participant)
			}
			return nil
		}
		if rooms != nil {
			var n int64
			_ = adb.QueryRowContext(ctx, "SELECT COUNT(*) AS n FROM streams WHERE room = ? AND status = 'active' AND id != ?", room, row.id).Scan(&n)
			if n == 0 {
				return rooms.DeleteRoom(ctx, room)
			}
		}
		return nil
	}()
	if err != nil {
		s.log.Warn(fmt.Sprintf("livekit teardown for %s failed (continuing): %s", row.streamID, err))
	}
}

func (s *Service) findIngressID(ctx context.Context, rooms Rooms, room, participant string) string {
	list, err := rooms.ListIngress(ctx, room)
	if err != nil {
		s.log.Debug(fmt.Sprintf("listIngress(%s) failed: %s", room, err))
		return ""
	}
	for _, i := range list {
		if i.RoomName == room && (participant == "" || i.ParticipantIdentity == participant) {
			return i.IngressID
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

// Snapshot captures one frame of a room (ffmpeg), uploads it to the app S3
// bucket when possible and fires stream.snapshot.
func (s *Service) Snapshot(ctx context.Context, in SnapshotInput) (*SnapshotResult, error) {
	app, err := s.requireApp(ctx, in.AppName)
	if err != nil {
		return nil, err
	}
	room := jsTrim(in.RoomName)
	if room == "" {
		return nil, httpx.BadRequest("roomName is required")
	}
	participant := ""
	if in.ParticipantIdentity != nil {
		participant = *in.ParticipantIdentity
	}
	return s.captureUpload(ctx, app, room, "", s.snapshotSource(app, room, participant))
}

// SnapshotByStream snapshots a stream by id: passthrough streams (no LiveKit
// room) use the newest on-disk HLS segment, LiveKit-backed ones the room's
// RTMP source. 404 unknown stream, 503 no source.
func (s *Service) SnapshotByStream(ctx context.Context, appName, streamID string) (*SnapshotResult, error) {
	app, err := s.requireApp(ctx, appName)
	if err != nil {
		return nil, err
	}
	stream, err := s.Get(ctx, appName, streamID)
	if err != nil {
		return nil, err
	}
	if stream == nil {
		return nil, httpx.NotFound(fmt.Sprintf("stream '%s' not found", streamID))
	}
	room := jsTrim(stream.Room)
	passthrough := (stream.Participant != nil && *stream.Participant == "passthrough") || room == ""
	key := room
	if key == "" {
		key = streamID
	}
	var source string
	if passthrough {
		source = s.latestHlsSegment(app.name, key)
		if source == "" {
			return nil, httpx.Unavailable(fmt.Sprintf("no live HLS segment available to snapshot stream '%s'", streamID))
		}
	} else {
		participant := ""
		if stream.Participant != nil {
			participant = *stream.Participant
		}
		source = s.snapshotSource(app, room, participant)
	}
	return s.captureUpload(ctx, app, key, streamID, source)
}

// snapshotEvent is the stream.snapshot callback payload (Node key order).
type snapshotEvent struct {
	App       string `json:"app"`
	Room      string `json:"room"`
	StreamID  string `json:"streamId,omitempty"`
	Key       string `json:"key"`
	URL       string `json:"url"`
	SizeBytes *int64 `json:"sizeBytes,omitempty"`
	Source    string `json:"source"`
}

func (s *Service) captureUpload(ctx context.Context, app *appRow, room, streamID, source string) (*SnapshotResult, error) {
	dir := filepath.Join(s.cfg.DataDir, "apps", app.name, "snapshots")
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return nil, httpx.Unavailable(fmt.Sprintf("cannot create snapshots dir: Error: %s", err))
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(jsx.ISO(s.now()))
	fileName := Safe(room) + "-" + stamp + ".jpg"
	localPath := filepath.Join(dir, fileName)

	if err := s.capture(ctx, source, localPath); err != nil {
		return nil, err
	}
	if m := get(s.opt.Metrics); m != nil {
		m.SnapshotTaken(app.name)
	}

	logical := "snapshots/" + fileName
	result := &SnapshotResult{Key: logical, URL: "file://" + localPath}
	var size *int64
	if s.apps != nil && s.s3 != nil {
		func() {
			cfg, err := s.apps.GetConfig(ctx, app.name)
			if err != nil {
				s.log.Warn(fmt.Sprintf("snapshot S3 upload failed, returning local: %s", err))
				return
			}
			key := logical
			if cfg.S3.Prefix != "" {
				key = cfg.S3.Prefix + "/" + logical
			}
			res, err := s.s3.Upload(ctx, cfg.S3, localPath, key, "image/jpeg")
			if err != nil {
				s.log.Warn(fmt.Sprintf("snapshot S3 upload failed, returning local: %s", err))
				return
			}
			n := res.SizeBytes
			size = &n
			url := res.URL
			if signed, err := s.s3.PresignGet(ctx, cfg.S3, res.Key, 3600, nil); err == nil {
				url = signed
			} else {
				s.log.Debug(fmt.Sprintf("presign failed, using object url: %s", err))
			}
			result = &SnapshotResult{Key: res.Key, URL: url}
		}()
	}
	s.dispatch(ctx, app.name, "stream.snapshot", snapshotEvent{
		App: app.name, Room: room, StreamID: streamID, Key: result.Key, URL: result.URL, SizeBytes: size, Source: "on_demand",
	})
	return result, nil
}

// latestHlsSegment is the newest non-empty .ts segment of a room (checks the
// passthrough dir and the LiveKit-egress safe-slug dir), or "".
func (s *Service) latestHlsSegment(appName, room string) string {
	slugs := []string{room}
	if safe := Safe(room); safe != room {
		slugs = append(slugs, safe)
	}
	for _, slug := range slugs {
		dir := filepath.Join(s.cfg.DataDir, "apps", appName, "hls", slug)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		best, bestMod := "", time.Time{}
		for _, e := range entries {
			if !strings.HasSuffix(e.Name(), ".ts") {
				continue
			}
			full := filepath.Join(dir, e.Name())
			st, err := os.Stat(full)
			if err != nil {
				continue
			}
			if st.Mode().IsRegular() && st.Size() > 0 && (best == "" || st.ModTime().After(bestMod)) {
				best, bestMod = full, st.ModTime()
			}
		}
		if best != "" {
			return best
		}
	}
	return ""
}

func (s *Service) dispatch(ctx context.Context, app, event string, payload any) {
	cb := get(s.opt.Callbacks)
	if cb == nil {
		return
	}
	if err := cb.Dispatch(ctx, app, event, payload); err != nil {
		s.log.Warn(fmt.Sprintf("callback %s failed: %s", event, err))
	}
}

// snapshotSource is STREAMHUB_SNAPSHOT_SOURCE ({app}/{room}/{participant})
// or rtmp://<rtmp public host>:1935/<prefix>/<room>.
func (s *Service) snapshotSource(app *appRow, room, participant string) string {
	if tpl := s.cfg.Env("STREAMHUB_SNAPSHOT_SOURCE"); tpl != "" {
		out := jsReplaceAll(tpl, "{app}", app.name)
		out = jsReplaceAll(out, "{room}", room)
		return jsReplaceAll(out, "{participant}", participant)
	}
	host := s.cfg.RtmpPublicHost
	if host == "" {
		host = "127.0.0.1"
	}
	return fmt.Sprintf("rtmp://%s:1935/%s/%s", host, appPrefix(app), room)
}

// ffmpegCapture runs ffmpeg for a single frame (20 s timeout).
func (s *Service) ffmpegCapture(ctx context.Context, source, outPath string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-y", "-loglevel", "error", "-rw_timeout", "10000000",
		"-i", source, "-frames:v", "1", "-q:v", "2", outPath)
	err := cmd.Run()
	if err == nil {
		return nil
	}
	if errors.Is(err, exec.ErrNotFound) {
		return httpx.Unavailable("ffmpeg is not installed/available")
	}
	s.log.Warn(fmt.Sprintf("ffmpeg snapshot failed: %s", err))
	return httpx.Unavailable("snapshot capture failed (source unreachable or no video frame)")
}

// Safe is the filesystem/URL-safe room segment: every UTF-16 code unit
// outside [a-zA-Z0-9_-] becomes '_'.
func Safe(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		case r >= 0x10000:
			b.WriteString("__")
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// jsReplaceAll is String#replace(/<literal>/g, repl) including the
// replacement patterns ($$, $&, $`, $').
func jsReplaceAll(s, pattern, repl string) string {
	if !strings.Contains(repl, "$") {
		return strings.ReplaceAll(s, pattern, repl)
	}
	var b strings.Builder
	i := 0
	for {
		j := strings.Index(s[i:], pattern)
		if j < 0 {
			b.WriteString(s[i:])
			return b.String()
		}
		start := i + j
		end := start + len(pattern)
		b.WriteString(s[i:start])
		for k := 0; k < len(repl); k++ {
			if repl[k] != '$' || k+1 >= len(repl) {
				b.WriteByte(repl[k])
				continue
			}
			switch repl[k+1] {
			case '$':
				b.WriteByte('$')
			case '&':
				b.WriteString(pattern)
			case '`':
				b.WriteString(s[:start])
			case '\'':
				b.WriteString(s[end:])
			default:
				b.WriteByte('$')
				continue
			}
			k++
		}
		i = end
		if len(pattern) == 0 {
			if i >= len(s) {
				return b.String()
			}
			b.WriteByte(s[i])
			i++
		}
	}
}

// jsTrim is String#trim.
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
			return true
		}
		return r >= 0x2000 && r <= 0x200a
	})
}
