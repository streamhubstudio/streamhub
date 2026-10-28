package recording

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	lkproto "github.com/livekit/protocol/livekit"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// recording.service.spec / recording.trackmode.spec / vod-probe.spec /
// vod-retention.service.spec / vods.repository.spec invariants.

type rcApps struct {
	cfgs map[string]*contracts.AppConfig
	root string
	fail bool
}

func (a *rcApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	var out []contracts.AppRecord
	for n := range a.cfgs {
		out = append(out, contracts.AppRecord{ID: 1, Name: n, DisplayName: strings.ToUpper(n)})
	}
	return out, nil
}
func (a *rcApps) Get(_ context.Context, n string) (*contracts.AppRecord, error) {
	if _, ok := a.cfgs[n]; !ok {
		return nil, nil
	}
	return &contracts.AppRecord{ID: 7, Name: n, DisplayName: strings.ToUpper(n)}, nil
}
func (a *rcApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (a *rcApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (a *rcApps) GetConfig(_ context.Context, n string) (*contracts.AppConfig, error) {
	c, ok := a.cfgs[n]
	if !ok || a.fail {
		return nil, httpx.NotFound(`app "` + n + `" not found`)
	}
	return c, nil
}
func (a *rcApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (a *rcApps) AppDir(n string) string { return filepath.Join(a.root, "apps", n) }

type rcS3 struct {
	mu        sync.Mutex
	uploads   []string // key|contentType
	deletes   []string
	failKey   string
	failDel   bool
	presigned []string
	noPresign bool
}

func (s *rcS3) Upload(_ context.Context, _ contracts.S3Config, local, key, ct string) (*contracts.S3UploadResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failKey != "" && strings.HasSuffix(key, s.failKey) {
		return nil, errors.New("S3 upload failed: AccessDenied")
	}
	s.uploads = append(s.uploads, key+"|"+ct)
	st, _ := os.Stat(local)
	var size int64
	if st != nil {
		size = st.Size()
	}
	return &contracts.S3UploadResult{Key: key, Bucket: "b", URL: "https://b.s3/" + key, SizeBytes: size}, nil
}
func (s *rcS3) PresignGet(_ context.Context, _ contracts.S3Config, key string, ttl float64, o *contracts.S3PresignOptions) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.noPresign {
		return "", errors.New("presign boom")
	}
	disp := ""
	if o != nil {
		disp = "&rcd=" + o.ResponseContentDisposition
	}
	u := fmt.Sprintf("https://signed/%s?ttl=%.0f%s", key, ttl, disp)
	s.presigned = append(s.presigned, u)
	return u, nil
}
func (s *rcS3) Delete(_ context.Context, _ contracts.S3Config, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failDel {
		return errors.New("s3 down")
	}
	s.deletes = append(s.deletes, key)
	return nil
}
func (s *rcS3) Exists(context.Context, contracts.S3Config, string) (bool, error) { return true, nil }

type rcLK struct {
	mu      sync.Mutex
	started []any
	stopped []string
	fail    error
	n       int
}

func (l *rcLK) StartEgress(_ context.Context, in livekit.StartEgressInput) (livekit.EgressInfo, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fail != nil {
		return livekit.EgressInfo{}, l.fail
	}
	l.n++
	l.started = append(l.started, in)
	return livekit.EgressInfo{EgressID: fmt.Sprintf("EG_%d", l.n), Status: "EGRESS_STARTING"}, nil
}
func (l *rcLK) StartTrackCompositeEgress(_ context.Context, in livekit.TrackCompositeInput) (livekit.EgressInfo, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fail != nil {
		return livekit.EgressInfo{}, l.fail
	}
	l.n++
	l.started = append(l.started, in)
	return livekit.EgressInfo{EgressID: fmt.Sprintf("EG_%d", l.n), Status: "EGRESS_STARTING"}, nil
}
func (l *rcLK) StopEgress(_ context.Context, id string) (livekit.EgressInfo, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fail != nil {
		return livekit.EgressInfo{}, l.fail
	}
	l.stopped = append(l.stopped, id)
	return livekit.EgressInfo{EgressID: id, Status: "EGRESS_ENDING"}, nil
}

type rcCB struct {
	mu     sync.Mutex
	events []tcCallback
}

func (c *rcCB) Dispatch(_ context.Context, app, event string, payload any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, _ := json.Marshal(payload)
	c.events = append(c.events, tcCallback{app, event, string(b)})
	return nil
}

func (c *rcCB) names() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, e := range c.events {
		out = append(out, e.Event)
	}
	return out
}

func (c *rcCB) body(event string) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.events {
		if e.Event == event {
			var m map[string]any
			_ = json.Unmarshal([]byte(e.Body), &m)
			return m
		}
	}
	return nil
}

// rcRunner answers ffprobe with a canned video and writes snapshot JPEGs.
type rcRunner struct {
	mu        sync.Mutex
	calls     [][]string
	noSnap    bool
	probeFail bool
}

func (r *rcRunner) Run(_ context.Context, bin string, args []string, _ time.Duration) ([]byte, error) {
	r.mu.Lock()
	r.calls = append(r.calls, append([]string{bin}, args...))
	r.mu.Unlock()
	if bin == "ffprobe" {
		if r.probeFail {
			return nil, errors.New("ffprobe failed")
		}
		return []byte(`{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720,"duration":"10.5"}],"format":{}}`), nil
	}
	if bin == "ffmpeg" && args[len(args)-1] != "" && strings.HasSuffix(args[len(args)-1], ".jpg") {
		if r.noSnap {
			return nil, errors.New("ffmpeg failed")
		}
		_ = os.WriteFile(args[len(args)-1], []byte("jpg"), 0o644)
	}
	return nil, nil
}

type rcHarness struct {
	t    *testing.T
	s    *Service
	apps *rcApps
	s3   *rcS3
	lk   *rcLK
	cb   *rcCB
	logs *tcLogsFake
	run  *rcRunner
	dir  string
}

func rcConfig(mod func(*contracts.AppConfig)) *contracts.AppConfig {
	c := &contracts.AppConfig{Name: "live", RoomPrefix: "live"}
	c.Recording.Enabled = true
	c.Recording.Mode = "room-composite"
	c.S3.Bucket = "bucket"
	c.Variables = map[string]string{"site": "hq", "evil": "../../etc"}
	if mod != nil {
		mod(c)
	}
	return c
}

func newRC(t *testing.T, mod func(*contracts.AppConfig)) *rcHarness {
	t.Helper()
	store, _, dir := testutil.Store(t)
	h := &rcHarness{t: t, apps: &rcApps{cfgs: map[string]*contracts.AppConfig{"live": rcConfig(mod)}, root: dir},
		s3: &rcS3{}, lk: &rcLK{}, cb: &rcCB{}, logs: &tcLogsFake{}, run: &rcRunner{}, dir: dir}
	h.s = NewService(Deps{Config: &config.Config{DataDir: dir}, Store: store, Apps: h.apps, S3: h.s3, LiveKit: h.lk,
		Logs: h.logs, Callbacks: h.cb, Runner: h.run, Log: testutil.Log()})
	t.Cleanup(func() {
		h.s.mu.Lock()
		ids := make([]string, 0)
		for id := range h.s.sessions {
			ids = append(ids, id)
		}
		h.s.mu.Unlock()
		for _, id := range ids {
			h.s.clearSession(context.Background(), id)
		}
	})
	return h
}

func (h *rcHarness) vod(id int64) *VodRecord {
	h.t.Helper()
	v, err := h.s.vods.FindByID(context.Background(), "live", id)
	if err != nil || v == nil {
		h.t.Fatalf("vod %d: %v", id, err)
	}
	return v
}

func meta(t *testing.T, v *VodRecord) map[string]any {
	t.Helper()
	var m map[string]any
	if v.MetatagsJSON == nil || json.Unmarshal([]byte(*v.MetatagsJSON), &m) != nil {
		t.Fatalf("metatags %v", v.MetatagsJSON)
	}
	return m
}

func httpStatus(err error) (int, string) {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Status, he.Error()
	}
	return 0, fmt.Sprint(err)
}

func TestStartValidation(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	if st, msg := httpStatus(func() error { _, e := h.s.StartRecording(ctx, StartInput{AppName: "live"}); return e }()); st != 400 || msg != "roomName is required" {
		t.Fatal(st, msg)
	}
	h.apps.cfgs["live"].Recording.Enabled = false
	if st, msg := httpStatus(func() error { _, e := h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r"}); return e }()); st != 400 || msg != "recording is disabled for app 'live'" {
		t.Fatal(st, msg)
	}
	// bucket guard: 409 with the machine-readable body, no egress
	h.apps.cfgs["live"].Recording.Enabled = true
	h.apps.cfgs["live"].S3.Bucket = "  "
	_, err := h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r"})
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != 409 {
		t.Fatal(err)
	}
	b, _ := json.Marshal(he.Body)
	if string(b) != `{"error":"storage_not_configured","message":"app 'live' has no S3 storage bucket configured; recordings cannot be uploaded","app":"live"}` || len(h.lk.started) != 0 {
		t.Fatal(string(b))
	}
	if st, msg := httpStatus(func() error { _, e := h.s.StartRecording(ctx, StartInput{AppName: "ghost", RoomName: "r"}); return e }()); st != 404 ||
		msg != `app 'ghost' config unavailable: app "ghost" not found` {
		t.Fatal(st, msg)
	}
}

func TestStartHappyPath(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, func(c *contracts.AppConfig) { c.Recording.Layout = "grid" })
	h.s.now = func() time.Time { return time.UnixMilli(1_700_000_000_123) }
	hd, err := h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "live-r1", StreamID: " cam/1 "})
	if err != nil {
		t.Fatal(err)
	}
	if hd.Status != "recording" || hd.EgressID != "EG_1" {
		t.Fatal(hd)
	}
	in := h.lk.started[0].(livekit.StartEgressInput)
	wantPath := filepath.Join(h.apps.AppDir("live"), "recordings", "cam-1-1700000000123.mp4")
	if in.Mode != "room-composite" || in.Layout != "grid" || in.OutputFilepath != wantPath || in.ParticipantIdentity != "" || in.SnapshotIntervalS != 0 {
		t.Fatalf("%+v", in)
	}
	v := h.vod(hd.VodID)
	if v.Status != "recording" || *v.StreamID != "cam/1" || *v.Room != "live-r1" || v.Name != "cam-1-1700000000123.mp4" || v.AppID != 7 ||
		*v.StartedAt != "2023-11-14T22:13:20.123Z" {
		t.Fatalf("%+v", v)
	}
	if *v.MetatagsJSON != `{"egressId":"EG_1","mode":"room-composite","room":"live-r1","app":"live","sessionId":"live:cam-1-1700000000123","splitMinutes":0,"snapshotSeconds":0,"partIndex":0,"isPart":false}` {
		t.Fatal(*v.MetatagsJSON)
	}
	if ev := h.cb.body("recording_started"); ev["streamId"] != "cam/1" || ev["mode"] != "room-composite" || ev["vodId"] != float64(hd.VodID) {
		t.Fatal(h.cb.events)
	}
	if !strings.Contains(h.cb.events[0].Body, `{"vodId":1,"egressId":"EG_1","app":"live","room":"live-r1","streamId":"cam/1","mode":"room-composite","splitMinutes":0,"snapshotSeconds":0}`) {
		t.Fatal(h.cb.events[0].Body)
	}
	// streamId defaults to the room; participant mode egresses identity == streamId
	h.apps.cfgs["live"].Recording.Mode = "participant"
	hd, _ = h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "live-r2"})
	if in := h.lk.started[1].(livekit.StartEgressInput); in.ParticipantIdentity != "live-r2" || *h.vod(hd.VodID).StreamID != "live-r2" {
		t.Fatal(in)
	}
	// egress failure → 500, no VOD persisted
	h.lk.fail = errors.New("LiveKit startEgress failed: down")
	_, err = h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r3"})
	if st, msg := httpStatus(err); st != 500 || msg != "failed to start egress: LiveKit startEgress failed: down" {
		t.Fatal(st, msg)
	}
	if n, _ := h.s.vods.Count(ctx, "live", VodFilters{}); n != 2 {
		t.Fatal(n)
	}
}

func TestSplitSnapshotAndTemplate(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, func(c *contracts.AppConfig) {
		c.Recording.SplitMinutes = 15
		c.Recording.SnapshotSeconds = 30
		c.Recording.FilenameTemplate = "${app}_${var.site}_${var.evil}"
	})
	hd, err := h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r"})
	if err != nil {
		t.Fatal(err)
	}
	in := h.lk.started[0].(livekit.StartEgressInput)
	if filepath.Base(in.OutputFilepath) != "live_hq_.-.-etc-p000.mp4" || in.SnapshotIntervalS != 30 ||
		in.SnapshotFilePrefix != filepath.Join(h.apps.AppDir("live"), "snapshots", "live_hq_.-.-etc-p000_") {
		t.Fatalf("%+v", in)
	}
	m := meta(t, h.vod(hd.VodID))
	if m["isPart"] != true || m["splitMinutes"] != float64(15) || m["snapshotPrefix"] != "live_hq_.-.-etc-p000_" {
		t.Fatal(m)
	}
	if len(h.s.sessions) != 1 {
		t.Fatal("session not retained")
	}
	// rotation: stop the part, launch p001 into the same session
	sid := m["sessionId"].(string)
	h.s.rotate(ctx, sid)
	in2 := h.lk.started[1].(livekit.StartEgressInput)
	if h.lk.stopped[0] != "EG_1" || filepath.Base(in2.OutputFilepath) != "live_hq_.-.-etc-p001.mp4" {
		t.Fatal(h.lk.stopped, in2.OutputFilepath)
	}
	// stop by the FIRST vod id stops the CURRENT part and ends the session
	stop, err := h.s.StopRecording(ctx, "live", fmt.Sprint(hd.VodID))
	if err != nil || stop.EgressID != "EG_2" || stop.VodID != hd.VodID+1 || len(h.s.sessions) != 0 {
		t.Fatal(stop, err)
	}
	// out-of-set values clamp to 0 (continuous, no image output)
	h2 := newRC(t, func(c *contracts.AppConfig) { c.Recording.SplitMinutes = 7; c.Recording.SnapshotSeconds = 5 })
	hd, _ = h2.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r"})
	in = h2.lk.started[0].(livekit.StartEgressInput)
	if strings.Contains(in.OutputFilepath, "-p000") || in.SnapshotFilePrefix != "" || meta(t, h2.vod(hd.VodID))["isPart"] != false || len(h2.s.sessions) != 0 {
		t.Fatal(in)
	}
}

func TestTrackModes(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, func(c *contracts.AppConfig) { c.Recording.SnapshotSeconds = 30 })
	hd, err := h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r", StreamID: "pub", RecordMode: "track"})
	if err != nil {
		t.Fatal(err)
	}
	tr := h.lk.started[0].(livekit.TrackCompositeInput)
	if tr.ParticipantIdentity != "pub" || tr.AudioOnly || meta(t, h.vod(hd.VodID))["mode"] != "track" {
		t.Fatal(tr)
	}
	h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r", StreamID: "pub", RecordMode: "audio", ParticipantIdentity: " host "})
	tr = h.lk.started[1].(livekit.TrackCompositeInput)
	if tr.ParticipantIdentity != "host" || !tr.AudioOnly {
		t.Fatal(tr)
	}
	if m := meta(t, h.vod(2)); m["snapshotSeconds"] != float64(0) {
		t.Fatal("audio mode must force live snapshots off")
	}
	// composite / omitted keeps the app-config egress
	h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r", RecordMode: "composite"})
	if _, ok := h.lk.started[2].(livekit.StartEgressInput); !ok {
		t.Fatal("composite went track")
	}
}

func TestStopAndRecordLive(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	hd, _ := h.s.StartForStream(ctx, "live", "s1", "live-room", "", "")
	if in := h.lk.started[0].(livekit.StartEgressInput); in.RoomName != "live-room" || *h.vod(hd.VodID).StreamID != "s1" {
		t.Fatal(in)
	}
	stop, err := h.s.StopForStream(ctx, "live", "s1")
	if err != nil || stop.EgressID != "EG_1" || stop.Status != "recording" {
		t.Fatal(stop, err)
	}
	if _, err := h.s.StopRecording(ctx, "live", "EG_1"); err != nil {
		t.Fatal("stop by egress id", err)
	}
	if st, msg := httpStatus(func() error { _, e := h.s.StopRecording(ctx, "live", "99"); return e }()); st != 404 || msg != "recording 99 not found" {
		t.Fatal(st, msg)
	}
	if st, msg := httpStatus(func() error { _, e := h.s.StopForStream(ctx, "live", "nope"); return e }()); st != 404 || msg != "no in-progress recording for stream 'nope'" {
		t.Fatal(st, msg)
	}
	h.lk.fail = errors.New("LiveKit stopEgress failed: gone")
	if st, msg := httpStatus(func() error { _, e := h.s.StopRecording(ctx, "live", "1"); return e }()); st != 500 || msg != "failed to stop egress: LiveKit stopEgress failed: gone" {
		t.Fatal(st, msg)
	}
}

// start + make the egress file exist (the egress would have written it)
func (h *rcHarness) recorded(mod func(*StartInput)) (*RecordingHandle, string) {
	h.t.Helper()
	in := StartInput{AppName: "live", RoomName: "live-r", StreamID: "cam"}
	if mod != nil {
		mod(&in)
	}
	hd, err := h.s.StartRecording(context.Background(), in)
	if err != nil {
		h.t.Fatal(err)
	}
	p := *h.vod(hd.VodID).LocalPath
	if err := os.WriteFile(p, []byte("mp4"), 0o644); err != nil {
		h.t.Fatal(err)
	}
	return hd, p
}

func ev(status, errText string) *lkproto.WebhookEvent {
	return &lkproto.WebhookEvent{EgressInfo: &lkproto.EgressInfo{Error: errText}}
}

func TestEgressEvents(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	hd, local := h.recorded(nil)
	for _, st := range []string{"EGRESS_STARTING", "EGRESS_ACTIVE"} {
		_ = h.s.OnEgressEvent(ctx, hd.EgressID, st, ev(st, ""))
	}
	if h.vod(hd.VodID).Status != "recording" {
		t.Fatal("progress advanced the flow")
	}
	if err := h.s.OnEgressEvent(ctx, "EG_unknown", "EGRESS_COMPLETE", ev("", "")); err != nil {
		t.Fatal(err)
	}
	// complete (inline: no workers started) → probe, snapshot, upload, ready
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	v := h.vod(hd.VodID)
	if v.Status != "ready" || *v.FileKey != filepath.Base(local) || *v.S3URL != "https://b.s3/"+filepath.Base(local) ||
		*v.PublicURL != "https://signed/"+filepath.Base(local)+"?ttl=604800" || *v.DurationS != 10.5 || *v.Width != 1280 ||
		*v.Format != "h264" || v.SnapshotKey == nil || *v.LocalPath != local || v.EndedAt == nil {
		t.Fatalf("%+v", v)
	}
	m := meta(t, v)
	if m["codec"] != "h264" || m["durationS"] != 10.5 || m["egressId"] != hd.EgressID {
		t.Fatal(m)
	}
	if got := h.cb.names(); !reflect.DeepEqual(got, []string{"recording_started", "vod_ready", "recording_ready"}) {
		t.Fatal(got)
	}
	if r := h.cb.body("recording_ready"); r["split"] != false || r["partIndex"] != float64(0) || r["format"] != "h264" {
		t.Fatal(r)
	}
	if !exists(local) {
		t.Fatal("local deleted without delete_local_after_upload")
	}
	// failed egress → failed + recording_failed with the egress error
	hd2, _ := h.recorded(nil)
	_ = h.s.OnEgressEvent(ctx, hd2.EgressID, "EGRESS_FAILED", ev("", "chrome crashed"))
	if h.vod(hd2.VodID).Status != "failed" {
		t.Fatal("not failed")
	}
	if f := h.cb.body("recording_failed"); f["reason"] != "egress EGRESS_FAILED" || f["detail"] != "chrome crashed" || f["room"] != "live-r" {
		t.Fatal(f)
	}
	// unknown egress resolved from metatags after a restart (cold map)
	hd3, _ := h.recorded(nil)
	h.s.egress = map[string]egressRef{}
	_ = h.s.OnEgressEvent(ctx, hd3.EgressID, "EGRESS_ABORTED", ev("", ""))
	if h.vod(hd3.VodID).Status != "failed" {
		t.Fatal("cold locate")
	}
}

func TestUploadFailures(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	hd, local := h.recorded(nil)
	_ = os.Remove(local)
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	if h.vod(hd.VodID).Status != "failed" || h.cb.body("recording_failed")["reason"] != "local recording file missing" {
		t.Fatal(h.cb.events)
	}
	// upload failure keeps the local file (SPEC §8.4)
	h.apps.cfgs["live"].Recording.DeleteLocalAfterUpload = true
	hd, local = h.recorded(nil)
	h.s3.failKey = ".mp4"
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	if h.vod(hd.VodID).Status != "failed" || !exists(local) {
		t.Fatal("upload failure")
	}
	// success with delete_local_after_upload: local + snapshot removed, local_path NULL
	h.s3.failKey = ""
	hd, local = h.recorded(nil)
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	v := h.vod(hd.VodID)
	snap := filepath.Join(h.apps.AppDir("live"), "snapshots", strings.TrimSuffix(filepath.Base(local), ".mp4")+".jpg")
	if v.Status != "ready" || v.LocalPath != nil || exists(local) || exists(snap) {
		t.Fatalf("%+v", v)
	}
	// a snapshot failure is best-effort (null snapshot key, still ready)
	h.run.noSnap = true
	hd, _ = h.recorded(nil)
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	if v := h.vod(hd.VodID); v.Status != "ready" || v.SnapshotKey != nil {
		t.Fatalf("%+v", v)
	}
}

func TestTranscodeHandOff(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	hd, _ := h.recorded(nil)
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	if h.logs.has("vod transcode job enqueued") || strings.Contains(fmt.Sprint(h.run.calls), "hls_segment_filename") {
		t.Fatal("transcoding disabled must not run")
	}
	// opt-in + delete_local_after_upload: local deferred to the transcode job
	h = newRC(t, func(c *contracts.AppConfig) {
		c.Transcoding.Enabled = true
		c.Transcoding.Encoding = "h264+vp8"
		c.Recording.DeleteLocalAfterUpload = true
	})
	hd, local := h.recorded(nil)
	qctx, stop := context.WithCancel(ctx)
	h.s.Transcode.Start(qctx) // queue the variants job instead of running it inline
	// stop the worker before t.TempDir is removed: the queued job writes into it
	t.Cleanup(func() { stop(); <-h.s.Transcode.Done() })
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	v := h.vod(hd.VodID)
	if v.Status != "ready" || v.LocalPath == nil || *v.LocalPath != local {
		t.Fatalf("source must survive until the transcode job: %+v", v)
	}
	if !h.logs.has("vod transcode job enqueued") {
		t.Fatal("not enqueued")
	}
}

func TestListAndDownload(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	for i := 0; i < 3; i++ {
		h.recorded(nil)
	}
	f := func(v float64) *float64 { return &v }
	page, _ := h.s.ListVods(ctx, "live", ListQuery{Limit: f(5000), Offset: f(-3)})
	if page.Limit != 1000 || page.Offset != 0 || page.Total != 3 || len(page.Data) != 3 || page.Data[0].ID != 3 {
		t.Fatal(page)
	}
	page, _ = h.s.ListVods(ctx, "live", ListQuery{Limit: f(1), Offset: f(1)})
	if page.Total != 3 || len(page.Data) != 1 || page.Data[0].ID != 2 {
		t.Fatal(page)
	}
	page, _ = h.s.ListVods(ctx, "live", ListQuery{All: true, Limit: f(1)})
	if page.Limit != 3 || page.Offset != 0 || len(page.Data) != 3 {
		t.Fatal(page)
	}
	ids, _ := h.s.ListVodIDs(ctx, "live", 2, 0)
	if !reflect.DeepEqual(ids, []int64{3, 2}) {
		t.Fatal(ids)
	}
	// download: 409 not ready, then s3 presign with attachment disposition
	if st, msg := httpStatus(func() error { _, e := h.s.GetDownload(ctx, "live", 1); return e }()); st != 409 || msg != "vod 1 is not ready (status: recording)" {
		t.Fatal(st, msg)
	}
	_ = h.s.OnEgressEvent(ctx, "EG_1", "EGRESS_COMPLETE", ev("", ""))
	dl, err := h.s.GetDownload(ctx, "live", 1)
	name := strings.TrimSuffix(*h.vod(1).FileKey, ".mp4") + "-1.mp4"
	if err != nil || dl.Source != "s3" || dl.ExpiresInSeconds != 3600 || dl.Filename != name ||
		dl.URL != fmt.Sprintf(`https://signed/%s?ttl=3600&rcd=attachment; filename="%s"`, *h.vod(1).FileKey, name) {
		t.Fatal(dl, err)
	}
	raw, err := h.s.OpenLocalRaw(ctx, "live", 1)
	if err != nil || raw.ContentType != "video/mp4" || raw.Filename != name {
		t.Fatal(raw, err)
	}
	// local-only: no file key → local source; gone → 404
	_ = h.s.vods.Update(ctx, "live", 1, (&VodPatch{}).Set("file_key", nil))
	if dl, _ := h.s.GetDownload(ctx, "live", 1); dl.Source != "local" {
		t.Fatal(dl)
	}
	_ = os.Remove(*h.vod(1).LocalPath)
	if st, msg := httpStatus(func() error { _, e := h.s.GetDownload(ctx, "live", 1); return e }()); st != 404 ||
		msg != "vod 1 has no downloadable file (no S3 object and no local recording present)" {
		t.Fatal(st, msg)
	}
	if st, msg := httpStatus(func() error { _, e := h.s.OpenLocalRaw(ctx, "live", 1); return e }()); st != 404 || msg != "vod 1 has no local file to stream" {
		t.Fatal(st, msg)
	}
	if st, _ := httpStatus(func() error { _, e := h.s.OpenLocalRaw(ctx, "live", 2); return e }()); st != 409 {
		t.Fatal(st)
	}
	if st, msg := httpStatus(func() error { _, e := h.s.GetDownload(ctx, "live", 77); return e }()); st != 404 || msg != "vod 77 not found" {
		t.Fatal(st, msg)
	}
}

func TestGetVodURLsAndVariants(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	hd, _ := h.recorded(nil)
	// not ready: no URLs, no config load
	d, _ := h.s.GetVod(ctx, "live", hd.VodID)
	if d.URL != nil || d.PresignedURL != nil || d.PublicURLOut != nil || d.VodAdaptive != nil || len(d.Variants) != 0 {
		t.Fatal(d)
	}
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	key := *h.vod(hd.VodID).FileKey
	// no public base → presigned
	d, _ = h.s.GetVod(ctx, "live", hd.VodID)
	if *d.URL != "https://signed/"+key+"?ttl=604800" || d.PublicURLOut != nil {
		t.Fatal(d)
	}
	b, _ := json.Marshal(d)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	if out["publicUrl"] != nil || out["url"] == nil || out["variants"] == nil {
		t.Fatal(string(b))
	}
	// variants: master + renditions + alternate
	for _, v := range []VariantInsert{
		{VodID: hd.VodID, Kind: "rendition", Format: "hls-h264", Height: fptr(360), FileKey: str("hls/x/360p/index.m3u8")},
		{VodID: hd.VodID, Kind: "alternate", Format: "webm-vp8", FileKey: str("x.webm")},
		{VodID: hd.VodID, Kind: "rendition", Format: "hls-h264", Height: fptr(720), FileKey: str("hls/x/720p/index.m3u8")},
		{VodID: hd.VodID, Kind: "master", Format: "hls", FileKey: str("hls/x/master.m3u8")},
	} {
		_, _ = h.s.variants.Insert(ctx, "live", v)
	}
	d, _ = h.s.GetVod(ctx, "live", hd.VodID)
	kinds := []string{}
	for _, v := range d.Variants {
		kinds = append(kinds, v.Kind+fmt.Sprint(v.URL != nil))
	}
	if !reflect.DeepEqual(kinds, []string{"mastertrue", "renditionfalse", "renditionfalse", "alternatetrue"}) || *d.Variants[1].Height != 720 ||
		d.VodAdaptive == nil || d.VodAdaptive.MasterKey != "hls/x/master.m3u8" {
		t.Fatal(kinds, d.VodAdaptive)
	}
	// public base: deterministic, segment-encoded URLs everywhere
	h.apps.cfgs["live"].S3.PublicURL = "https://cdn.example.com//"
	d, _ = h.s.GetVod(ctx, "live", hd.VodID)
	if *d.URL != "https://cdn.example.com/"+key || *d.Variants[1].URL != "https://cdn.example.com/hls/x/720p/index.m3u8" || *d.PresignedURL == "" {
		t.Fatal(*d.URL)
	}
	if joinPublicURL("https://c/", "/a b/ñ.mp4") != "https://c/a%20b/%C3%B1.mp4" {
		t.Fatal(joinPublicURL("https://c/", "/a b/ñ.mp4"))
	}
	// presign failure degrades to null URLs
	h.apps.cfgs["live"].S3.PublicURL = ""
	h.s3.noPresign = true
	d, _ = h.s.GetVod(ctx, "live", hd.VodID)
	if d.URL != nil || d.Variants[0].URL != nil {
		t.Fatal(d)
	}
}

func fptr(f float64) *float64 { return &f }

func TestDeleteVodCascade(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	hd, local := h.recorded(nil)
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	v := h.vod(hd.VodID)
	_, _ = h.s.variants.Insert(ctx, "live", VariantInsert{VodID: hd.VodID, Kind: "rendition", Format: "hls-h264",
		FileKey: str("hls/b/720p/index.m3u8"), ExtraJSON: str(`{"segmentKeys":["hls/b/720p/seg_0000.ts",5,"hls/b/720p/seg_0001.ts"]}`)})
	r, err := h.s.DeleteVodCascade(ctx, "live", hd.VodID)
	if err != nil || r.S3Deleted != 5 || !r.LocalDeleted || exists(local) {
		t.Fatal(r, err)
	}
	if !reflect.DeepEqual(h.s3.deletes, []string{*v.FileKey, *v.SnapshotKey, "hls/b/720p/index.m3u8", "hls/b/720p/seg_0000.ts", "hls/b/720p/seg_0001.ts"}) {
		t.Fatal(h.s3.deletes)
	}
	if rows, _ := h.s.variants.ListByVod(ctx, "live", hd.VodID); len(rows) != 0 {
		t.Fatal("variant rows left")
	}
	if st, msg := httpStatus(func() error { _, e := h.s.DeleteVodCascade(ctx, "live", hd.VodID); return e }()); st != 404 || msg != fmt.Sprintf("vod %d not found", hd.VodID) {
		t.Fatal(st, msg)
	}
	// no objects → 0 / false; S3 failure still drops the row
	hd, _ = h.recorded(nil)
	_ = os.Remove(*h.vod(hd.VodID).LocalPath)
	if r, _ := h.s.DeleteVodCascade(ctx, "live", hd.VodID); r.S3Deleted != 0 || r.LocalDeleted {
		t.Fatal(r)
	}
	hd, _ = h.recorded(nil)
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	h.s3.failDel = true
	if r, err := h.s.DeleteVodCascade(ctx, "live", hd.VodID); err != nil || r.S3Deleted != 0 {
		t.Fatal(r, err)
	}
	if v, _ := h.s.vods.FindByID(ctx, "live", hd.VodID); v != nil {
		t.Fatal("row kept on S3 failure")
	}
}

func TestProbeVod(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	hd, local := h.recorded(nil)
	p, err := h.s.ProbeVod(ctx, "live", hd.VodID)
	if err != nil || !p.Probed || *p.DurationS != 10.5 || *p.Format != "h264" {
		t.Fatal(p, err)
	}
	if last := h.run.calls[len(h.run.calls)-1]; last[len(last)-1] != local {
		t.Fatal("probe source must be the local file", last)
	}
	// never clobbers an existing format; a failed probe leaves the row
	_ = h.s.vods.Update(ctx, "live", hd.VodID, (&VodPatch{}).Set("format", "keep"))
	p, _ = h.s.ProbeVod(ctx, "live", hd.VodID)
	if *p.Format != "keep" {
		t.Fatal(*p.Format)
	}
	h.run.probeFail = true
	if p, _ = h.s.ProbeVod(ctx, "live", hd.VodID); p.Probed {
		t.Fatal("failed probe reported probed")
	}
	// no local → presigned S3 URL (600 s); no media at all → 404
	_ = os.Remove(local)
	_ = h.s.vods.Update(ctx, "live", hd.VodID, (&VodPatch{}).Set("file_key", "k.mp4"))
	h.run.probeFail = false
	h.s.ProbeVod(ctx, "live", hd.VodID)
	if last := h.run.calls[len(h.run.calls)-1]; last[len(last)-1] != "https://signed/k.mp4?ttl=600" {
		t.Fatal(last)
	}
	_ = h.s.vods.Update(ctx, "live", hd.VodID, (&VodPatch{}).Set("file_key", nil))
	if st, msg := httpStatus(func() error { _, e := h.s.ProbeVod(ctx, "live", hd.VodID); return e }()); st != 404 ||
		msg != fmt.Sprintf("vod %d has no media to probe (no local file and no S3 object)", hd.VodID) {
		t.Fatal(st, msg)
	}
}

func TestRetention(t *testing.T) {
	ctx := context.Background()
	if RetentionCutoffISO(time.Now(), 0) != nil || RetentionCutoffISO(time.Now(), -1) != nil {
		t.Fatal("off")
	}
	now := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	if c := RetentionCutoffISO(now, 7); *c != "2026-03-03T12:00:00.000Z" {
		t.Fatal(*c)
	}
	h := newRC(t, nil)
	r := NewRetention(h.s)
	seed := func(started, status string) int64 {
		id, _ := h.s.vods.Insert(ctx, "live", VodInsert{AppID: 1, Name: "x.mp4", Status: status, StartedAt: &started})
		return id
	}
	old := seed("2026-01-01T00:00:00.000Z", "ready")
	oldFailed := seed("2026-01-02T00:00:00.000Z", "failed")
	oldLive := seed("2026-01-01T00:00:00.000Z", "recording")
	recent := seed("2026-03-09T00:00:00.000Z", "ready")
	if res := r.SweepOnce(ctx, now); res.Apps != 0 || res.Deleted != 0 {
		t.Fatal("retention OFF must keep everything", res)
	}
	h.apps.cfgs["live"].Recording.RetentionDays = 30
	h.s3.failDel = true
	res := r.SweepOnce(ctx, now)
	if res.Apps != 1 || res.Deleted != 2 {
		t.Fatal(res)
	}
	for id, want := range map[int64]bool{old: false, oldFailed: false, oldLive: true, recent: true} {
		if v, _ := h.s.vods.FindByID(ctx, "live", id); (v != nil) != want {
			t.Errorf("vod %d kept=%v", id, v != nil)
		}
	}
	if !h.logs.has("vod retention pruned") {
		t.Fatal("not logged")
	}
	h.apps.fail = true
	if res := r.SweepOnce(ctx, now); res.Apps != 0 {
		t.Fatal(res)
	}
}

func TestVodsRepository(t *testing.T) {
	ctx := context.Background()
	store, _, _ := testutil.Store(t)
	r := NewVods(store.App)
	ins := func(room, status, started string, size float64, egress string) int64 {
		mj := fmt.Sprintf(`{"egressId":%q}`, egress)
		id, err := r.Insert(ctx, "a", VodInsert{AppID: 1, StreamID: str("s-" + room), Room: str(room), Name: room + ".mp4", Status: status, StartedAt: &started, MetatagsJSON: &mj})
		if err != nil {
			t.Fatal(err)
		}
		_ = r.Update(ctx, "a", id, (&VodPatch{}).Set("size_bytes", size))
		return id
	}
	ins("r1", "ready", "2026-01-01T00:00:00Z", 30, "E1")
	ins("r2", "failed", "2026-01-02T00:00:00Z", 10, "E2")
	ins("r1", "recording", "2026-01-03T00:00:00Z", 10, "E2")
	ids := func(vs []VodRecord) (out []int64) {
		for _, v := range vs {
			out = append(out, v.ID)
		}
		return
	}
	all, _ := r.List(ctx, "a", VodListOptions{Limit: 200})
	if !reflect.DeepEqual(ids(all), []int64{3, 2, 1}) {
		t.Fatal(ids(all))
	}
	bySize, _ := r.List(ctx, "a", VodListOptions{Order: "size_bytes", Dir: "asc", All: true})
	if !reflect.DeepEqual(ids(bySize), []int64{2, 3, 1}) {
		t.Fatal(ids(bySize))
	}
	since, until := "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"
	if n, _ := r.Count(ctx, "a", VodFilters{Since: &since, Until: &until}); n != 2 {
		t.Fatal(n)
	}
	room, st := "r1", "ready"
	if n, _ := r.Count(ctx, "a", VodFilters{Room: &room, Status: &st}); n != 1 {
		t.Fatal(n)
	}
	if v, _ := r.FindByEgressID(ctx, "a", "E2"); v.ID != 3 {
		t.Fatal("newest egress match", v.ID)
	}
	if v, _ := r.FindActiveByStream(ctx, "a", "s-r1"); v.ID != 3 {
		t.Fatal(v)
	}
	if v, _ := r.FindActiveByStream(ctx, "a", "s-r2"); v != nil {
		t.Fatal("failed vod is not active")
	}
	if by, _ := r.CountByStatus(ctx, "a"); by != (VodsByStatus{1, 0, 1, 1}) {
		t.Fatal(by)
	}
	if by, _ := r.CountByStatus(ctx, "empty"); by != (VodsByStatus{}) {
		t.Fatal(by)
	}
	_ = r.Update(ctx, "a", 1, (&VodPatch{}).Set("format", nil).Set("width", 640))
	v, _ := r.FindByID(ctx, "a", 1)
	if v.Format != nil || *v.Width != 640 || *v.SizeBytes != 30 {
		t.Fatalf("%+v", v)
	}
	b, _ := json.Marshal(v)
	if !strings.Contains(string(b), `"sizeBytes":30,`) || !strings.Contains(string(b), `"endedAt":null`) {
		t.Fatal(string(b))
	}
	_ = r.Delete(ctx, "a", 1)
	if v, _ := r.FindByID(ctx, "a", 1); v != nil {
		t.Fatal("not deleted")
	}
}

// Cross-runtime vectors from testdata/gen-recording-vectors.js.
func TestRecordingNodeVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/recording_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Probes []struct {
			Output *string `json:"output"`
			Failed bool    `json:"failed"`
			Argv   struct {
				Bin  string   `json:"bin"`
				Args []string `json:"args"`
			} `json:"argv"`
			Result ProbedMedia `json:"result"`
		} `json:"probes"`
		Snapshots []struct {
			Bin  string   `json:"bin"`
			Args []string `json:"args"`
		} `json:"snapshots"`
		Templates []struct{ Template, Out string } `json:"templates"`
		Now       string                           `json:"now"`
		Downloads []struct {
			Vod struct {
				Name   string  `json:"name"`
				Room   *string `json:"room"`
				Format *string `json:"format"`
			} `json:"vod"`
			Out string `json:"out"`
		} `json:"downloads"`
		Types []struct{ Path, Out string } `json:"types"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, p := range v.Probes {
		r := &cannedRunner{out: p.Output, fail: p.Failed}
		got := ProbeMedia(context.Background(), r, "/data/apps/live/recordings/a b.mp4")
		if !reflect.DeepEqual(got, p.Result) || r.bin != p.Argv.Bin || !reflect.DeepEqual(r.args, p.Argv.Args) {
			gb, _ := json.Marshal(got)
			wb, _ := json.Marshal(p.Result)
			t.Errorf("probe %v: go %s node %s argv %v", p.Output, gb, wb, r.args)
		}
	}
	for i, at := range []float64{1, -3, 2.5} {
		if got := SnapshotArgs("/in.mp4", "/out.jpg", at); !reflect.DeepEqual(got, v.Snapshots[i].Args) {
			t.Errorf("snapshot %v: %v", at, got)
		}
	}
	now, _ := time.Parse(time.RFC3339, v.Now)
	for _, tc := range v.Templates {
		got := RenderFilenameTemplate(tc.Template, TemplateTokens{App: "live", StreamID: "cam/1", Room: "live-room", Type: "mp4",
			Variables: map[string]string{"site": "hq", "evil": "../../etc/passwd", "dots": "...."}, Now: now})
		if got != tc.Out {
			t.Errorf("template %q: go %q node %q", tc.Template, got, tc.Out)
		}
	}
	for _, d := range v.Downloads {
		if got := downloadFilename(&VodRecord{Name: d.Vod.Name, Room: d.Vod.Room, Format: d.Vod.Format}, 42); got != d.Out {
			t.Errorf("download %+v: go %q node %q", d.Vod, got, d.Out)
		}
	}
	for _, c := range v.Types {
		if got := rawContentType(c.Path); got != c.Out {
			t.Errorf("type %s: %s", c.Path, got)
		}
	}
}

type cannedRunner struct {
	out  *string
	fail bool
	bin  string
	args []string
}

func (c *cannedRunner) Run(_ context.Context, bin string, args []string, _ time.Duration) ([]byte, error) {
	c.bin, c.args = bin, args
	if c.fail {
		return nil, errors.New("spawn ffprobe ENOENT")
	}
	return []byte(*c.out), nil
}

func TestClassifyAndSlug(t *testing.T) {
	for in, want := range map[string]string{"EGRESS_STARTING": "progress", "EGRESS_ACTIVE": "progress", "EGRESS_ENDING": "progress",
		"EGRESS_COMPLETE": "complete", "EGRESS_LIMIT_REACHED": "complete", "egress_ended": "complete", "EGRESS_FAILED": "failed",
		"EGRESS_ABORTED": "failed", "": "progress"} {
		if got := classify(in); got != want {
			t.Errorf("%s → %s", in, got)
		}
	}
	for in, want := range map[string]string{"cam/1": "cam-1", "--a b--": "a-b", "///": "rec", "ok.v_1-x": "ok.v_1-x"} {
		if got := slug(in); got != want {
			t.Errorf("slug %q → %q", in, got)
		}
	}
}

func TestSplitPartCallbacksAndSnapshotSweep(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, func(c *contracts.AppConfig) { c.Recording.SplitMinutes = 15; c.Recording.SnapshotSeconds = 30 })
	hd, _ := h.recorded(nil)
	m := meta(t, h.vod(hd.VodID))
	sid := m["sessionId"].(string)
	// a part completing while the session is live → part_ready, no recording_ready
	_ = h.s.OnEgressEvent(ctx, hd.EgressID, "EGRESS_COMPLETE", ev("", ""))
	if got := h.cb.names(); !reflect.DeepEqual(got, []string{"recording_started", "vod_ready", "recording_part_ready"}) {
		t.Fatal(got)
	}
	if p := h.cb.body("recording_part_ready"); p["sessionId"] != sid || p["partIndex"] != float64(0) {
		t.Fatal(p)
	}
	// egress JPEGs of this session are uploaded once each, with both events
	h.s.mu.Lock()
	sess := h.s.sessions[sid]
	h.s.mu.Unlock()
	pre := sess.snapPrefixes[0]
	for _, f := range []string{pre + "00001.jpg", pre + "00002.JPEG", "other_00001.jpg", pre + "notes.txt"} {
		_ = os.WriteFile(filepath.Join(sess.snapsDir, f), []byte("img"), 0o644)
	}
	_ = os.WriteFile(filepath.Join(sess.snapsDir, pre+"00003.jpg"), nil, 0o644) // empty: retried later
	h.s.sweepSnapshots(ctx, sess)
	h.s.sweepSnapshots(ctx, sess)
	n := 0
	for _, u := range h.s3.uploads {
		if strings.HasPrefix(u, "snapshots/") {
			n++
		}
	}
	if n != 2 || len(h.cb.names()) != 3+4 {
		t.Fatal(h.s3.uploads, h.cb.names())
	}
	if p := h.cb.body("stream.snapshot"); p["source"] != "periodic" || p["key"] != "snapshots/"+pre+"00001.jpg" || p["vodId"] != float64(hd.VodID) {
		t.Fatal(p)
	}
	// stop ends the session → the last part fires recording_ready (split:true)
	_, _ = h.s.StopRecording(ctx, "live", fmt.Sprint(hd.VodID))
	hd2 := h.vod(hd.VodID)
	p2, _ := h.s.vods.Insert(ctx, "live", VodInsert{AppID: 1, Name: "p.mp4", Status: "recording", LocalPath: str(*hd2.LocalPath),
		MetatagsJSON: str(fmt.Sprintf(`{"egressId":"EG_last","sessionId":%q,"isPart":true,"partIndex":1}`, sid))})
	_ = os.WriteFile(*hd2.LocalPath, []byte("mp4"), 0o644)
	h.cb.events = nil
	_ = h.s.OnEgressEvent(ctx, "EG_last", "EGRESS_COMPLETE", ev("", ""))
	if r := h.cb.body("recording_ready"); r == nil || r["split"] != true || r["partIndex"] != float64(1) || h.vod(p2).Status != "ready" {
		t.Fatal(h.cb.names())
	}
}

func TestBootRecovery(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, func(c *contracts.AppConfig) {
		c.Recording.DeleteLocalAfterUpload = true
		c.Transcoding.Enabled = true
		c.Transcoding.Encoding = "h264+vp8"
	})
	dir := filepath.Join(h.apps.AppDir("live"), "recordings")
	_ = os.MkdirAll(dir, 0o755)
	seed := func(name, status string, withFile bool) int64 {
		p := filepath.Join(dir, name)
		if withFile {
			_ = os.WriteFile(p, []byte("mp4"), 0o644)
		}
		id, err := h.s.vods.Insert(ctx, "live", VodInsert{AppID: 1, Name: name, Status: status, LocalPath: &p, Room: str("live-r")})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	up := seed("up.mp4", "uploading", true)
	gone := seed("gone.mp4", "uploading", false)
	rec := seed("rec.mp4", "recording", true)
	pending := seed("pending.mp4", "ready", true)
	done := seed("done.mp4", "ready", false)

	// no workers yet → recovered jobs run inline (deterministic for the test)
	res := h.s.Recover(ctx)
	if res.Uploads != 1 || res.Transcodes != 1 {
		t.Fatal(res)
	}
	if v := h.vod(up); v.Status != "ready" {
		t.Fatalf("interrupted upload not resumed: %+v", v)
	}
	if h.vod(gone).Status != "uploading" || h.vod(rec).Status != "recording" || h.vod(done).Status != "ready" {
		t.Fatal("recovery touched rows it must leave alone")
	}
	// the pending transcode ran: source removed, local_path nulled
	if v := h.vod(pending); v.LocalPath != nil || exists(filepath.Join(dir, "pending.mp4")) {
		t.Fatalf("pending transcode not resumed: %+v", v)
	}
	if !h.logs.has("recording jobs recovered at boot") {
		t.Fatal("not logged")
	}
	// without delete_local_after_upload a ready+local row is NOT a pending transcode
	h2 := newRC(t, func(c *contracts.AppConfig) { c.Transcoding.Enabled = true; c.Transcoding.Encoding = "h264+vp8" })
	d2 := filepath.Join(h2.apps.AppDir("live"), "recordings")
	_ = os.MkdirAll(d2, 0o755)
	p := filepath.Join(d2, "kept.mp4")
	_ = os.WriteFile(p, []byte("mp4"), 0o644)
	_, _ = h2.s.vods.Insert(ctx, "live", VodInsert{AppID: 1, Name: "kept.mp4", Status: "ready", LocalPath: &p})
	if res := h2.s.Recover(ctx); res.Transcodes != 0 {
		t.Fatal(res)
	}
}
