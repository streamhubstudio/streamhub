package streams

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

const testApp = "live"

// fakeApps is a contracts.AppsService over a fixed config per app.
type fakeApps struct {
	dataDir string
	names   []string
	cfg     func(name string) (*contracts.AppConfig, error)
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	out := []contracts.AppRecord{}
	for _, n := range f.names {
		out = append(out, contracts.AppRecord{Name: n})
	}
	return out, nil
}
func (f *fakeApps) Get(_ context.Context, name string) (*contracts.AppRecord, error) {
	return &contracts.AppRecord{Name: name}, nil
}
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, errors.New("unused")
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(_ context.Context, name string) (*contracts.AppConfig, error) {
	if f.cfg == nil {
		return &contracts.AppConfig{Name: name}, nil
	}
	return f.cfg(name)
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, errors.New("unused")
}
func (f *fakeApps) AppDir(name string) string { return filepath.Join(f.dataDir, "apps", name) }

// fakeRooms is a scripted LiveKit RoomService/Ingress client.
type fakeRooms struct {
	mu           sync.Mutex
	rooms        []string
	participants map[string][]Participant
	failRooms    map[string]bool // listParticipants throws
	unreachable  bool            // listRooms throws
	ingresses    []Ingress
	removed      []string
	deletedRooms []string
	deletedIngr  []string
}

func (f *fakeRooms) ListRooms(context.Context) ([]string, error) {
	if f.unreachable {
		return nil, errors.New("ECONNREFUSED")
	}
	return f.rooms, nil
}
func (f *fakeRooms) ListParticipants(_ context.Context, room string) ([]Participant, error) {
	if f.failRooms[room] {
		return nil, errors.New("listParticipants(" + room + ") boom")
	}
	return f.participants[room], nil
}
func (f *fakeRooms) RemoveParticipant(_ context.Context, room, identity string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, room+"|"+identity)
	return nil
}
func (f *fakeRooms) DeleteRoom(_ context.Context, room string) error {
	f.deletedRooms = append(f.deletedRooms, room)
	return nil
}
func (f *fakeRooms) ListIngress(context.Context, string) ([]Ingress, error) { return f.ingresses, nil }
func (f *fakeRooms) DeleteIngress(_ context.Context, id string) error {
	f.deletedIngr = append(f.deletedIngr, id)
	return nil
}

func pub(identity string) Participant { return Participant{Identity: identity, Tracks: 1} }
func viewer(identity string) Participant {
	return Participant{Identity: identity}
}

type dispatched struct {
	app, event string
	payload    any
}

type fakeCallbacks struct{ calls []dispatched }

func (f *fakeCallbacks) Dispatch(_ context.Context, app, event string, payload any) error {
	f.calls = append(f.calls, dispatched{app, event, payload})
	return nil
}

type logLine struct {
	level, source, message string
	meta                   any
}

type fakeLogs struct{ lines []logLine }

func (f *fakeLogs) Write(level, source, message string, meta any, _ *int64) {
	f.lines = append(f.lines, logLine{level, source, message, meta})
}

type fakeS3 struct{ uploads []string }

func (f *fakeS3) Upload(_ context.Context, _ contracts.S3Config, _, key, _ string) (*contracts.S3UploadResult, error) {
	f.uploads = append(f.uploads, key)
	return &contracts.S3UploadResult{Key: key, Bucket: "b", URL: "https://b/" + key, SizeBytes: 4}, nil
}
func (f *fakeS3) PresignGet(_ context.Context, _ contracts.S3Config, key string, _ float64, _ *contracts.S3PresignOptions) (string, error) {
	return "https://signed/" + key, nil
}
func (f *fakeS3) Delete(context.Context, contracts.S3Config, string) error         { return nil }
func (f *fakeS3) Exists(context.Context, contracts.S3Config, string) (bool, error) { return true, nil }

// harness is one service over a fresh DATA_DIR with the `live` app seeded.
type harness struct {
	t     *testing.T
	svc   *Service
	store *db.Service
	adb   *sql.DB
	dir   string
	appID int64
	rooms *fakeRooms
	apps  *fakeApps
	cb    *fakeCallbacks
	logs  *fakeLogs
	s3    *fakeS3
	// capture records the ffmpeg sources.
	sources []string
}

func newHarness(t *testing.T, rooms *fakeRooms) *harness {
	t.Helper()
	store, g, dir := testutil.Store(t)
	res, err := g.Exec("INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)", testApp, testApp)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	adb, err := store.App(context.Background(), testApp)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, store: store, adb: adb, dir: dir, appID: id, rooms: rooms,
		apps: &fakeApps{dataDir: dir, names: []string{testApp}}, cb: &fakeCallbacks{}, logs: &fakeLogs{}, s3: &fakeS3{}}
	opt := Optional{
		Callbacks: func() Callbacks { return h.cb },
		Logs:      func() Logs { return h.logs },
	}
	if rooms != nil {
		opt.Rooms = func() Rooms { return rooms }
	}
	h.svc = New(Deps{
		Config: &config.Config{DataDir: dir, NodeEnv: "test"}, Store: store, Global: g, Apps: h.apps, S3: h.s3, Opt: opt, Log: testutil.Log(),
		Capture: func(_ context.Context, source, out string) error {
			h.sources = append(h.sources, source)
			return writeFile(out, "jpeg")
		},
	})
	return h
}

// insertActive inserts an active row started agoSeconds in the past
// (participant "" = NULL).
func (h *harness) insertActive(streamID, typ, room, participant string, agoSeconds int) {
	h.t.Helper()
	var part any
	if participant != "" {
		part = participant
	}
	testutil.Exec(h.t, h.adb, `INSERT INTO streams (app_id, stream_id, type, room, participant, status, started_at)
		VALUES (?, ?, ?, ?, ?, 'active', datetime('now', ?))`, h.appID, streamID, typ, room, part, "-"+strconv.Itoa(agoSeconds)+" seconds")
}

type rowView struct{ streamID, typ, status string }

func (h *harness) rows() map[string]rowView {
	h.t.Helper()
	rs, err := h.adb.Query("SELECT stream_id, type, status FROM streams")
	if err != nil {
		h.t.Fatal(err)
	}
	defer rs.Close()
	out := map[string]rowView{}
	for rs.Next() {
		var r rowView
		if err := rs.Scan(&r.streamID, &r.typ, &r.status); err != nil {
			h.t.Fatal(err)
		}
		out[r.streamID] = r
	}
	return out
}

func writeFile(p, s string) error { return os.WriteFile(p, []byte(s), 0o644) }
