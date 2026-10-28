package livecontrol

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
)

// Port of live-control.service.spec.ts: transitions + side effects, the S3
// storage guard and end-to-end cover resolution against a REAL
// live-control.db, with faked apps/streams/s3/livekit/callbacks.

type fakeApps struct {
	dir    string
	bucket string
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Get(_ context.Context, name string) (*contracts.AppRecord, error) {
	return &contracts.AppRecord{ID: 1, Name: name}, nil
}
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(_ context.Context, name string) (*contracts.AppConfig, error) {
	return &contracts.AppConfig{Name: name, S3: contracts.S3Config{Bucket: f.bucket}}, nil
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (f *fakeApps) AppDir(string) string { return f.dir }

type fakeStreams struct{ rows []streams.StreamRecord }

func (f *fakeStreams) List(context.Context, string) ([]streams.StreamRecord, error) {
	return f.rows, nil
}
func (f *fakeStreams) Get(_ context.Context, _ string, id string) (*streams.StreamRecord, error) {
	for _, r := range f.rows {
		if r.StreamID == id {
			r := r
			return &r, nil
		}
	}
	return nil, nil
}

type muteCall struct {
	room, identity, sid string
	muted               bool
}

type fakeLK struct {
	mu    sync.Mutex
	parts []livekit.ParticipantDetail
	mutes []muteCall
	sent  []string
}

func (f *fakeLK) ListParticipantsDetailed(context.Context, string) ([]livekit.ParticipantDetail, error) {
	return f.parts, nil
}
func (f *fakeLK) MutePublishedTrack(_ context.Context, room, identity, sid string, muted bool) (livekit.MutedTrack, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mutes = append(f.mutes, muteCall{room, identity, sid, muted})
	return livekit.MutedTrack{TrackSid: sid, Muted: muted}, nil
}
func (f *fakeLK) SendData(_ context.Context, room, payload string, o livekit.SendDataOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, room+"|"+*o.Topic+"|"+payload)
	return nil
}

type fakeS3 struct {
	uploads, deletes int
}

func (f *fakeS3) UploadBuffer(_ context.Context, cfg contracts.S3Config, body []byte, key, _ string) (*contracts.S3UploadResult, error) {
	f.uploads++
	return &contracts.S3UploadResult{Key: key, Bucket: cfg.Bucket, SizeBytes: int64(len(body))}, nil
}
func (f *fakeS3) PresignGet(context.Context, contracts.S3Config, string, float64, *contracts.S3PresignOptions) (string, error) {
	return "https://signed/x", nil
}
func (f *fakeS3) Delete(context.Context, contracts.S3Config, string) error { f.deletes++; return nil }

type dispatch struct {
	app, event string
	body       eventPayload
}

type fakeCallbacks struct{ calls []dispatch }

func (f *fakeCallbacks) Dispatch(_ context.Context, app, event string, payload any) error {
	f.calls = append(f.calls, dispatch{app, event, payload.(eventPayload)})
	return nil
}

type harness struct {
	svc  *Service
	s3   *fakeS3
	lk   *fakeLK
	cb   *fakeCallbacks
	repo *plugins.Repo
}

func build(t *testing.T, bucket string, cfg *y.Map) *harness {
	t.Helper()
	store, _, dir := testutil.Store(t)
	repo := plugins.NewRepo(store)
	if cfg != nil {
		if err := repo.Install(context.Background(), "live", PluginID, cfg, true); err != nil {
			t.Fatal(err)
		}
	}
	h := &harness{s3: &fakeS3{}, cb: &fakeCallbacks{}, repo: repo, lk: &fakeLK{parts: []livekit.ParticipantDetail{{
		Identity: "pub1", Tracks: []livekit.TrackView{{Sid: "AT1", Type: "audio"}, {Sid: "VT1", Type: "video"}},
	}}}}
	pub := "pub1"
	st := &fakeStreams{rows: []streams.StreamRecord{{StreamID: "s1", Type: "rtmp", Room: "live-room1", Status: "live",
		StartedAt: "2026-07-13T00:00:00Z", Participant: &pub}}}
	lcStore := NewStore()
	t.Cleanup(lcStore.CloseAll)
	h.svc = New(Deps{
		Apps: &fakeApps{dir: filepath.Join(dir, "apps", "live"), bucket: bucket}, Installs: repo, Store: lcStore, S3: h.s3,
		Streams:   func() Streams { return st },
		LiveKit:   func() LiveKit { return h.lk },
		Callbacks: func() plugins.Dispatcher { return h.cb },
	})
	h.svc.async = func(f func()) { f() }
	return h
}

func (h *harness) lastEvent(t *testing.T) dispatch {
	t.Helper()
	if len(h.cb.calls) == 0 {
		t.Fatal("no callbacks dispatched")
	}
	return h.cb.calls[len(h.cb.calls)-1]
}

func png(name string) Upload { return Upload{Body: []byte("x"), Filename: name, MimeType: "image/png"} }

var ctx = context.Background()

func TestTransitionPause(t *testing.T) {
	h := build(t, "b1", nil)
	v, err := h.svc.Transition(ctx, "live", "s1", "pause", Override{})
	if err != nil {
		t.Fatal(err)
	}
	if v.State != "paused" || v.Cover == nil || v.Cover.Mode != "text" {
		t.Fatalf("view: %+v", v)
	}
	if len(h.lk.mutes) != 1 || h.lk.mutes[0] != (muteCall{"live-room1", "pub1", "AT1", true}) {
		t.Fatalf("only the audio track is muted: %+v", h.lk.mutes)
	}
	if len(h.lk.sent) != 1 || !strings.HasPrefix(h.lk.sent[0], "live-room1|live-control|{\"type\":\"live-control\",\"app\":\"live\",\"stream\":\"s1\",\"state\":\"paused\"") {
		t.Fatalf("data push: %v", h.lk.sent)
	}
	e := h.lastEvent(t)
	if e.app != "live" || e.event != "livecontrol.paused" || e.body.Stream != "s1" || !eqStr(e.body.Room, "live-room1") {
		t.Fatalf("event: %+v", e)
	}
}

func TestTransitionResume(t *testing.T) {
	h := build(t, "b1", nil)
	if _, err := h.svc.Transition(ctx, "live", "s1", "pause", Override{}); err != nil {
		t.Fatal(err)
	}
	v, err := h.svc.Transition(ctx, "live", "s1", "resume", Override{})
	if err != nil {
		t.Fatal(err)
	}
	if v.State != "live" || v.Cover != nil {
		t.Fatalf("view: %+v", v)
	}
	if last := h.lk.mutes[len(h.lk.mutes)-1]; last != (muteCall{"live-room1", "pub1", "AT1", false}) {
		t.Fatalf("unmute: %+v", last)
	}
	if e := h.lastEvent(t); e.event != "livecontrol.resumed" {
		t.Fatalf("event: %s", e.event)
	}
}

func TestTransitionFinish(t *testing.T) {
	h := build(t, "b1", nil)
	v, err := h.svc.Transition(ctx, "live", "s1", "finish", Override{})
	if err != nil || v.State != "finished" {
		t.Fatalf("%+v %v", v, err)
	}
	if e := h.lastEvent(t); e.event != "livecontrol.finished" {
		t.Fatalf("event: %s", e.event)
	}
}

func TestNoServerSideMuteWhenDisabled(t *testing.T) {
	cfg := y.NewMap()
	cfg.Set("muteAudioServerSide", false)
	h := build(t, "b1", cfg)
	if _, err := h.svc.Transition(ctx, "live", "s1", "pause", Override{}); err != nil {
		t.Fatal(err)
	}
	if len(h.lk.mutes) != 0 {
		t.Fatalf("muted: %+v", h.lk.mutes)
	}
}

func wantStatus(t *testing.T, err error, status int, msg string) {
	t.Helper()
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != status {
		t.Fatalf("want HTTP %d, got %v", status, err)
	}
	if msg != "" && !strings.Contains(err.Error(), msg) {
		t.Fatalf("want %q in %q", msg, err.Error())
	}
}

func TestPauseUnknownAsset(t *testing.T) {
	h := build(t, "b1", nil)
	_, err := h.svc.Transition(ctx, "live", "s1", "pause", Override{AssetID: i64(999), SetAsset: true})
	wantStatus(t, err, http.StatusBadRequest, "asset '999' not found")
}

func TestUploadImageAsset(t *testing.T) {
	h := build(t, "b1", nil)
	a, err := h.svc.UploadAsset(ctx, "live", Upload{Body: []byte("img"), Filename: "a b.png", MimeType: "image/png"}, sp("Intro"))
	if err != nil {
		t.Fatal(err)
	}
	if a.Kind != "image" || !eqStr(a.Label, "Intro") || a.Filename != "a_b.png" || h.s3.uploads != 1 {
		t.Fatalf("asset: %+v", a)
	}
	if !strings.HasPrefix(a.S3Key, "live-control/assets/") || !strings.HasSuffix(a.S3Key, "-a_b.png") {
		t.Fatalf("key: %s", a.S3Key)
	}
	list, err := h.svc.ListAssets(ctx, "live")
	if err != nil || len(list) != 1 || !eqStr(list[0].URL, "https://signed/x") {
		t.Fatalf("list: %+v %v", list, err)
	}
}

func TestUploadRejectsNonMedia(t *testing.T) {
	h := build(t, "b1", nil)
	_, err := h.svc.UploadAsset(ctx, "live", Upload{Body: []byte("x"), Filename: "a.pdf", MimeType: "application/pdf"}, nil)
	wantStatus(t, err, http.StatusBadRequest, "unsupported asset type")
}

func TestUploadBucketGuard(t *testing.T) {
	h := build(t, "", nil)
	_, err := h.svc.UploadAsset(ctx, "live", png("a.png"), nil)
	wantStatus(t, err, http.StatusConflict, "")
	body := err.(*httpx.Error).Body.(storageError)
	if body.Error != "storage_not_configured" || body.App != "live" {
		t.Fatalf("body: %+v", body)
	}
}

func TestPauseWithImageAsset(t *testing.T) {
	h := build(t, "b1", nil)
	a, err := h.svc.UploadAsset(ctx, "live", Upload{Body: []byte("img"), Filename: "cover.jpg", MimeType: "image/jpeg"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	v, err := h.svc.Transition(ctx, "live", "s1", "pause", Override{Mode: sp("image"), SetMode: true, AssetID: &a.ID, SetAsset: true})
	if err != nil {
		t.Fatal(err)
	}
	if v.Cover.Mode != "image" || v.Cover.AssetID == nil || *v.Cover.AssetID != a.ID || !eqStr(v.Cover.AssetURL, "https://signed/x") {
		t.Fatalf("cover: %+v", v.Cover)
	}
}

func TestDeleteAsset(t *testing.T) {
	h := build(t, "b1", nil)
	a, err := h.svc.UploadAsset(ctx, "live", png("a.png"), nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := h.svc.DeleteAsset(ctx, "live", a.ID)
	if err != nil || !res.Removed || h.s3.deletes != 1 {
		t.Fatalf("%+v %v deletes=%d", res, err, h.s3.deletes)
	}
	if list, _ := h.svc.ListAssets(ctx, "live"); len(list) != 0 {
		t.Fatalf("list: %+v", list)
	}
	_, err = h.svc.DeleteAsset(ctx, "live", a.ID)
	wantStatus(t, err, http.StatusNotFound, "not found")
}

func TestListStreamsJoinsState(t *testing.T) {
	h := build(t, "b1", nil)
	if _, err := h.svc.Transition(ctx, "live", "s1", "pause", Override{}); err != nil {
		t.Fatal(err)
	}
	l, err := h.svc.ListStreams(ctx, "live")
	if err != nil || len(l.Streams) != 1 || l.Streams[0].Control.State != "paused" {
		t.Fatalf("%+v %v", l, err)
	}
}

func TestPublicState(t *testing.T) {
	h := build(t, "b1", nil)
	v, err := h.svc.PublicState(ctx, "live", "s1", "")
	if err != nil || v.State != "live" || v.Cover != nil {
		t.Fatalf("untouched: %+v %v", v, err)
	}
	if _, err := h.svc.Transition(ctx, "live", "s1", "pause", Override{}); err != nil {
		t.Fatal(err)
	}
	v, err = h.svc.PublicState(ctx, "live", "", "live-room1")
	if err != nil || v.StreamID != "s1" || v.State != "paused" {
		t.Fatalf("by room: %+v %v", v, err)
	}
	// Suffix match: "room1" resolves the prefixed room "live-room1".
	if v, _ = h.svc.PublicState(ctx, "live", "", "room1"); v.StreamID != "s1" {
		t.Fatalf("suffix: %+v", v)
	}
	if v, _ = h.svc.PublicState(ctx, "live", "", "ghost"); v.StreamID != "" || !eqStr(v.Room, "ghost") || v.State != "live" {
		t.Fatalf("unknown: %+v", v)
	}
}

func TestSettingsValidateAsset(t *testing.T) {
	h := build(t, "b1", nil)
	_, err := h.svc.UpdateSettings(ctx, "live", SettingsPatch{Pause: i64(42), SetPause: true})
	wantStatus(t, err, http.StatusBadRequest, "not found")
	a, err := h.svc.UploadAsset(ctx, "live", png("a.png"), nil)
	if err != nil {
		t.Fatal(err)
	}
	s, err := h.svc.UpdateSettings(ctx, "live", SettingsPatch{Pause: &a.ID, SetPause: true})
	if err != nil || s.DefaultPauseAssetID == nil || *s.DefaultPauseAssetID != a.ID {
		t.Fatalf("%+v %v", s, err)
	}
	// An explicit null clears; an absent key is left alone.
	s, _ = h.svc.UpdateSettings(ctx, "live", SettingsPatch{SetFinish: true})
	if s.DefaultPauseAssetID == nil {
		t.Fatal("absent key must be kept")
	}
	s, _ = h.svc.UpdateSettings(ctx, "live", SettingsPatch{SetPause: true})
	if s.DefaultPauseAssetID != nil {
		t.Fatal("null must clear")
	}
}

func TestSinceKeptOnSameState(t *testing.T) {
	h := build(t, "b1", nil)
	v1, _ := h.svc.Transition(ctx, "live", "s1", "pause", Override{CardTitle: sp("A"), SetTitle: true})
	v2, _ := h.svc.Transition(ctx, "live", "s1", "pause", Override{})
	if *v1.Since != *v2.Since {
		t.Fatalf("re-pause must keep since: %s vs %s", *v1.Since, *v2.Since)
	}
	if !eqStr(v2.Cover.CardTitle, "A") {
		t.Fatalf("absent override fields are kept: %+v", v2.Cover)
	}
}
