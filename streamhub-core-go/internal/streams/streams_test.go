package streams

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

var bg = context.Background()

func wantStatus(t *testing.T, err error, status int, msg string) {
	t.Helper()
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != status {
		t.Fatalf("want %d, got %v", status, err)
	}
	if msg != "" && he.Error() != msg {
		t.Fatalf("message = %q, want %q", he.Error(), msg)
	}
}

func TestCanonicalStreamID(t *testing.T) {
	if got := CanonicalStreamID("live-room", "cam-1"); got != "live-room/cam-1" {
		t.Fatal(got)
	}
}

func TestUpsert(t *testing.T) {
	h := newHarness(t, nil)
	rec, err := h.svc.UpsertRecord(bg, testApp, "live-room/cam1", "webrtc", "live-room", "cam1")
	if err != nil || rec.Status != "active" || rec.Type != "webrtc" || rec.Room != "live-room" || *rec.Participant != "cam1" || rec.EndedAt != nil {
		t.Fatalf("create: %+v %v", rec, err)
	}
	// Idempotent on the canonical key.
	_, _ = h.svc.UpsertRecord(bg, testApp, "live-room/cam1", "webrtc", "live-room", "cam1")
	if n := len(h.rows()); n != 1 {
		t.Fatalf("rows = %d", n)
	}
	// Never downgrades an ingress type back to webrtc.
	_, _ = h.svc.UpsertRecord(bg, testApp, "live-room/enc", "rtmp", "live-room", "enc")
	rec, _ = h.svc.UpsertRecord(bg, testApp, "live-room/enc", "webrtc", "live-room", "enc")
	if rec.Type != "rtmp" {
		t.Fatalf("downgraded to %s", rec.Type)
	}
	// ws-mjpeg is sticky too.
	_, _ = h.svc.UpsertRecord(bg, testApp, "cam/esp", "ws-mjpeg", "cam", "esp")
	if rec, _ = h.svc.UpsertRecord(bg, testApp, "cam/esp", "webrtc", "cam", "esp"); rec.Type != "ws-mjpeg" {
		t.Fatalf("ws-mjpeg downgraded to %s", rec.Type)
	}
	// Reactivates an ended row.
	_ = h.svc.End(bg, testApp, "live-room/cam1")
	rec, _ = h.svc.UpsertRecord(bg, testApp, "live-room/cam1", "webrtc", "live-room", "cam1")
	if rec.Status != "active" || rec.EndedAt != nil {
		t.Fatalf("not reactivated: %+v", rec)
	}
	// Unknown app → 404.
	_, err = h.svc.UpsertRecord(bg, "ghost", "x/y", "webrtc", "x", "y")
	wantStatus(t, err, 404, "app 'ghost' not found")
	// participant "" stores NULL.
	rec, _ = h.svc.UpsertRecord(bg, testApp, "room-only", "rtmp", "room-only", "")
	if rec.Participant != nil {
		t.Fatal("participant should be null")
	}
}

func TestOneRtmpIngressIsOneStream(t *testing.T) {
	ingress := Participant{Identity: "enc", Tracks: 1, Ingress: true}
	rooms := &fakeRooms{rooms: []string{"live-room"}, participants: map[string][]Participant{"live-room": {ingress}}}
	h := newHarness(t, rooms)
	id := CanonicalStreamID("live-room", "enc")
	_ = h.svc.Upsert(bg, testApp, id, "rtmp", "live-room", "enc")   // ingress_started
	_ = h.svc.Upsert(bg, testApp, id, "webrtc", "live-room", "enc") // participant_joined
	list, err := h.svc.List(bg, testApp)                            // reconcile
	if err != nil || len(list) != 1 || list[0].StreamID != id || list[0].Type != "rtmp" {
		t.Fatalf("%+v %v", list, err)
	}

	// Reconcile alone (no webhook) creates the same canonical row, kind-aware.
	h2 := newHarness(t, rooms)
	list, _ = h2.svc.List(bg, testApp)
	if len(list) != 1 || list[0].StreamID != id || list[0].Type != "rtmp" {
		t.Fatalf("%+v", list)
	}
}

func TestListReconcileDiscovery(t *testing.T) {
	rooms := &fakeRooms{
		rooms: []string{"live-a", "live-b", "other-room"},
		participants: map[string][]Participant{
			"live-a":     {pub("cam1"), pub("cam2"), viewer("v1")},
			"live-b":     {pub("cam1")},
			"other-room": {pub("x")},
		},
	}
	h := newHarness(t, rooms)
	h.insertActive("live-a/cam1", "webrtc", "live-a", "cam1", 0) // pre-existing webhook row
	list, err := h.svc.List(bg, testApp)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, s := range list {
		got[s.StreamID]++
	}
	want := map[string]int{"live-a/cam1": 1, "live-a/cam2": 1, "live-b/cam1": 1}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k, n := range want {
		if got[k] != n {
			t.Fatalf("got %v", got)
		}
	}
	// A subscriber (0 tracks) is never a stream; other apps' rooms ignored.
	if _, ok := h.rows()["live-a/v1"]; ok {
		t.Fatal("viewer became a stream")
	}
	if _, ok := h.rows()["other-room/x"]; ok {
		t.Fatal("foreign room discovered")
	}
	// Ended rows are excluded.
	_ = h.svc.End(bg, testApp, "live-b/cam1")
	rooms.participants["live-b"] = nil
	list, _ = h.svc.List(bg, testApp)
	for _, s := range list {
		if s.StreamID == "live-b/cam1" {
			t.Fatal("ended row listed")
		}
	}
}

func TestReconcilePrune(t *testing.T) {
	cases := []struct {
		name      string
		rooms     *fakeRooms
		seed      func(h *harness)
		id        string
		wantEnded bool
	}{
		{"aged row whose participant stopped publishing", &fakeRooms{rooms: []string{"live-room"}, participants: map[string][]Participant{"live-room": {viewer("cam1")}}},
			func(h *harness) { h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 60) }, "live-room/cam1", true},
		{"aged row whose room is gone", &fakeRooms{},
			func(h *harness) { h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 60) }, "live-room/cam1", true},
		{"grace window protects fresh rows", &fakeRooms{},
			func(h *harness) { h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 2) }, "live-room/cam1", false},
		{"room whose participants could not be listed", &fakeRooms{rooms: []string{"live-room"}, failRooms: map[string]bool{"live-room": true}},
			func(h *harness) { h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 60) }, "live-room/cam1", false},
		{"LiveKit unreachable prunes nothing", &fakeRooms{unreachable: true},
			func(h *harness) { h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 60) }, "live-room/cam1", false},
		{"ws-mjpeg is never pruned", &fakeRooms{},
			func(h *harness) { h.insertActive("cam/esp32", "ws-mjpeg", "cam", "esp32", 600) }, "cam/esp32", false},
		{"passthrough is never pruned", &fakeRooms{},
			func(h *harness) { h.insertActive("live-pt/passthrough", "rtmp", "live-pt", "passthrough", 600) }, "live-pt/passthrough", false},
		{"legacy non-canonical rows are ended", &fakeRooms{unreachable: true},
			func(h *harness) { h.insertActive("IN_abc", "rtmp", "live-room", "enc", 0) }, "IN_abc", true},
		{"legacy ws-mjpeg rows are kept", &fakeRooms{unreachable: true},
			func(h *harness) { h.insertActive("espcam", "ws-mjpeg", "cam", "", 0) }, "espcam", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, tc.rooms)
			tc.seed(h)
			if _, err := h.svc.List(bg, testApp); err != nil {
				t.Fatal(err)
			}
			if ended := h.rows()[tc.id].status == "ended"; ended != tc.wantEnded {
				t.Fatalf("ended = %v, want %v", ended, tc.wantEnded)
			}
		})
	}
}

func TestListWithoutLiveKitAndUnknownApp(t *testing.T) {
	h := newHarness(t, nil)
	h.insertActive("legacy", "rtmp", "live-room", "", 600)
	h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 600)
	list, err := h.svc.List(bg, testApp)
	if err != nil || len(list) != 2 {
		t.Fatalf("rows touched without LiveKit: %+v %v", list, err)
	}
	_, err = h.svc.List(bg, "ghost")
	wantStatus(t, err, 404, "app 'ghost' not found")
	if _, err := os.Stat(filepath.Join(h.dir, "apps", "ghost", "app.db")); err == nil {
		t.Fatal("stray app.db for an unknown app")
	}
}

func TestGet(t *testing.T) {
	rooms := &fakeRooms{participants: map[string][]Participant{
		"live-room": {pub("cam1"), viewer("v1"), viewer("v2"), {Identity: "qc", Hidden: true}},
	}}
	h := newHarness(t, rooms)
	if rec, err := h.svc.Get(bg, testApp, "nope"); rec != nil || err != nil {
		t.Fatal("unknown stream should be nil")
	}
	h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 0)

	// viewerCounter on: real subscribers only (no publishers, no hidden).
	h.apps.cfg = func(string) (*contracts.AppConfig, error) {
		return &contracts.AppConfig{Features: contracts.AppFeatures{ViewerCounter: true}}, nil
	}
	rec, err := h.svc.Get(bg, testApp, "live-room/cam1")
	if err != nil || rec.Viewers == nil || *rec.Viewers != 2 {
		t.Fatalf("%+v %v", rec, err)
	}
	if rec.LastStatsJSON == nil || *rec.LastStatsJSON != `{"live":true,"participants":4,"publishers":1,"viewers":2}` {
		t.Fatalf("last_stats_json = %v", rec.LastStatsJSON)
	}
	// viewerCounter off: hidden.
	h.apps.cfg = func(string) (*contracts.AppConfig, error) { return &contracts.AppConfig{}, nil }
	if rec, _ = h.svc.Get(bg, testApp, "live-room/cam1"); rec.Viewers != nil {
		t.Fatal("viewers exposed with the feature off")
	}
	// Unreadable config: the computed count is still exposed.
	h.apps.cfg = func(string) (*contracts.AppConfig, error) { return nil, errors.New("boom") }
	if rec, _ = h.svc.Get(bg, testApp, "live-room/cam1"); rec.Viewers == nil {
		t.Fatal("viewers hidden on config error")
	}
}

func TestStop(t *testing.T) {
	rooms := &fakeRooms{}
	h := newHarness(t, rooms)
	wantStatus(t, h.svc.Stop(bg, testApp, "nope"), 404, "stream 'nope' not found")

	h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 0)
	if err := h.svc.Stop(bg, testApp, "live-room/cam1"); err != nil {
		t.Fatal(err)
	}
	if len(rooms.removed) != 1 || rooms.removed[0] != "live-room|cam1" || h.rows()["live-room/cam1"].status != "ended" {
		t.Fatalf("removed=%v rows=%v", rooms.removed, h.rows())
	}
	// Already ended → no LiveKit teardown, still 204.
	if err := h.svc.Stop(bg, testApp, "live-room/cam1"); err != nil || len(rooms.removed) != 1 {
		t.Fatal("teardown on an ended stream")
	}
	// Ingress stream → deletes the matching ingress.
	rooms.ingresses = []Ingress{{"IN_other", "live-room", "x"}, {"IN_1", "live-room", "enc"}}
	h.insertActive("live-room/enc", "rtmp", "live-room", "enc", 0)
	_ = h.svc.Stop(bg, testApp, "live-room/enc")
	if len(rooms.deletedIngr) != 1 || rooms.deletedIngr[0] != "IN_1" {
		t.Fatalf("deleted ingress %v", rooms.deletedIngr)
	}
	// ws-mjpeg → no LiveKit call at all.
	h.insertActive("cam/esp", "ws-mjpeg", "cam", "esp", 0)
	_ = h.svc.Stop(bg, testApp, "cam/esp")
	if len(rooms.removed) != 1 || len(rooms.deletedRooms) != 0 {
		t.Fatal("ws-mjpeg teardown touched LiveKit")
	}
}

func TestEnd(t *testing.T) {
	rooms := &fakeRooms{}
	h := newHarness(t, rooms)
	h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 0)
	if err := h.svc.End(bg, testApp, "live-room/cam1"); err != nil || h.rows()["live-room/cam1"].status != "ended" {
		t.Fatal("not ended")
	}
	if len(rooms.removed) != 0 {
		t.Fatal("end() must not tear down LiveKit")
	}
	if err := h.svc.End(bg, testApp, "unknown"); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.End(bg, testApp, "live-room/cam1"); err != nil {
		t.Fatal(err)
	}
	wantStatus(t, h.svc.End(bg, "ghost", "x"), 404, "app 'ghost' not found")
}

func TestSnapshotGuards(t *testing.T) {
	h := newHarness(t, nil)
	_, err := h.svc.Snapshot(bg, SnapshotInput{AppName: testApp, RoomName: "  "})
	wantStatus(t, err, 400, "roomName is required")
	_, err = h.svc.Snapshot(bg, SnapshotInput{AppName: "ghost", RoomName: "r"})
	wantStatus(t, err, 404, "app 'ghost' not found")
}

func TestSnapshotRoomSource(t *testing.T) {
	h := newHarness(t, nil)
	h.svc.cfg.RtmpPublicHost = "media.example"
	res, err := h.svc.Snapshot(bg, SnapshotInput{AppName: testApp, RoomName: "lobby"})
	if err != nil {
		t.Fatal(err)
	}
	if h.sources[0] != "rtmp://media.example:1935/live/lobby" {
		t.Fatal(h.sources[0])
	}
	if !regexp.MustCompile(`^snapshots/lobby-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.jpg$`).MatchString(res.Key) {
		t.Fatalf("key %q", res.Key)
	}
	// STREAMHUB_SNAPSHOT_SOURCE template wins.
	t.Setenv("STREAMHUB_SNAPSHOT_SOURCE", "srt://x/{app}/{room}?p={participant}&r={room}")
	pid := "cam$&"
	_, _ = h.svc.Snapshot(bg, SnapshotInput{AppName: testApp, RoomName: "lobby", ParticipantIdentity: &pid})
	if h.sources[1] != "srt://x/live/lobby?p=cam{participant}&r=lobby" {
		t.Fatal(h.sources[1])
	}
}

func TestSnapshotByStream(t *testing.T) {
	s3cfg := func(string) (*contracts.AppConfig, error) {
		return &contracts.AppConfig{S3: contracts.S3Config{Prefix: "streamhub/live", Provider: "aws", Bucket: "b"}}, nil
	}
	t.Run("unknown stream 404", func(t *testing.T) {
		h := newHarness(t, nil)
		_, err := h.svc.SnapshotByStream(bg, testApp, "nope")
		wantStatus(t, err, 404, "stream 'nope' not found")
	})
	t.Run("LiveKit-backed → room RTMP source + stream.snapshot", func(t *testing.T) {
		h := newHarness(t, nil)
		h.apps.cfg = s3cfg
		h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 0)
		res, err := h.svc.SnapshotByStream(bg, testApp, "live-room/cam1")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(h.sources[0], "rtmp://") {
			t.Fatal(h.sources[0])
		}
		if !regexp.MustCompile(`^streamhub/live/snapshots/live-room-.*\.jpg$`).MatchString(res.Key) || res.URL != "https://signed/"+res.Key {
			t.Fatalf("%+v", res)
		}
		ev := h.cb.calls[len(h.cb.calls)-1]
		p := ev.payload.(snapshotEvent)
		if ev.event != "stream.snapshot" || p.App != testApp || p.StreamID != "live-room/cam1" || p.Source != "on_demand" || p.SizeBytes == nil || *p.SizeBytes != 4 {
			t.Fatalf("%+v", ev)
		}
	})
	t.Run("passthrough → newest on-disk HLS segment", func(t *testing.T) {
		h := newHarness(t, nil)
		h.apps.cfg = s3cfg
		h.insertActive("live-room/passthrough", "rtmp", "live-room", "passthrough", 0)
		dir := filepath.Join(h.dir, "apps", testApp, "hls", "live-room")
		_ = os.MkdirAll(dir, 0o755)
		_ = writeFile(filepath.Join(dir, "seg_00001.ts"), "a")
		_ = writeFile(filepath.Join(dir, "empty.ts"), "")
		newer := filepath.Join(dir, "seg_00002.ts")
		_ = writeFile(newer, "bb")
		future := time.Now().Add(5 * time.Second)
		_ = os.Chtimes(newer, future, future)
		if _, err := h.svc.SnapshotByStream(bg, testApp, "live-room/passthrough"); err != nil {
			t.Fatal(err)
		}
		if h.sources[0] != newer {
			t.Fatal(h.sources[0])
		}
	})
	t.Run("passthrough without a segment → 503", func(t *testing.T) {
		h := newHarness(t, nil)
		h.insertActive("live-room/passthrough", "rtmp", "live-room", "passthrough", 0)
		_, err := h.svc.SnapshotByStream(bg, testApp, "live-room/passthrough")
		wantStatus(t, err, 503, "no live HLS segment available to snapshot stream 'live-room/passthrough'")
	})
	t.Run("no S3 → local file reference", func(t *testing.T) {
		h := newHarness(t, nil)
		h.svc.s3 = nil
		h.insertActive("live-room/cam1", "webrtc", "live-room", "cam1", 0)
		res, _ := h.svc.SnapshotByStream(bg, testApp, "live-room/cam1")
		if !strings.HasPrefix(res.Key, "snapshots/") || res.URL != "file://"+filepath.Join(h.dir, "apps", testApp, "snapshots", strings.TrimPrefix(res.Key, "snapshots/")) {
			t.Fatalf("%+v", res)
		}
	})
}

func TestLiveStats(t *testing.T) {
	rooms := &fakeRooms{rooms: []string{"live-a"}, participants: map[string][]Participant{"live-a": {pub("cam1"), viewer("v1")}}}
	h := newHarness(t, rooms)
	h.apps.cfg = func(string) (*contracts.AppConfig, error) {
		return &contracts.AppConfig{Features: contracts.AppFeatures{ViewerCounter: true}}, nil
	}
	st, err := h.svc.LiveStats(bg, testApp)
	if err != nil || st.ActiveStreams != 1 || st.TotalViewers == nil || *st.TotalViewers != 1 || len(st.Rooms) != 1 || st.Rooms[0].Publishers != 1 {
		t.Fatalf("%+v %v", st, err)
	}
	h.apps.cfg = nil
	st, _ = h.svc.LiveStats(bg, testApp)
	if st.TotalViewers != nil || st.Rooms[0].Viewers != nil {
		t.Fatal("viewers must be null with the feature off")
	}
}

func TestSafeAndHelpers(t *testing.T) {
	cases := map[string]string{"live/lobby room": "live_lobby_room", "a-b_C9": "a-b_C9", "ñ😀": "___"}
	for in, want := range cases {
		if got := Safe(in); got != want {
			t.Errorf("Safe(%q) = %q, want %q", in, got, want)
		}
	}
	if got := jsReplaceAll("a{x}b{x}", "{x}", "[$$|$&|$`|$']"); got != "a[$|{x}|a|b{x}]b[$|{x}|a{x}b|]" {
		t.Fatal(got)
	}
	r, _ := http.NewRequest("GET", "http://core/x", nil)
	r.Host = "core:3020"
	r.Header.Set("X-Forwarded-Proto", " https , http")
	if got := BaseURL("", r, "0.0.0.0", 3020); got != "https://core:3020" {
		t.Fatal(got)
	}
	r.Header.Set("X-Forwarded-Host", "pub.example")
	if got := BaseURL("", r, "", 0); got != "https://pub.example" {
		t.Fatal(got)
	}
	if got := BaseURL("https://x.example//", r, "", 0); got != "https://x.example" {
		t.Fatal(got)
	}
}
