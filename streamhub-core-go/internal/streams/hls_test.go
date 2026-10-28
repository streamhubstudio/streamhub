package streams

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

const hourMs = 3600_000.0

func TestSelectExpiredSegments(t *testing.T) {
	now := 1_000_000_000_000.0
	out := SelectExpiredSegments([]SegmentStat{
		{"seg_recent.ts", now - 60_000},
		{"seg_old.ts", now - 2*hourMs},
		{"seg_ref.ts", now - 5*hourMs},
	}, map[string]bool{"seg_ref.ts": true}, hourMs, now)
	if !reflect.DeepEqual(out, []string{"seg_old.ts"}) {
		t.Fatal(out)
	}
	if out := SelectExpiredSegments([]SegmentStat{{"a.ts", 0}}, map[string]bool{"a.ts": true}, 1000, now); len(out) != 0 {
		t.Fatal(out)
	}
}

func TestParsePlaylistSegments(t *testing.T) {
	set := ParsePlaylistSegments(strings.Join([]string{
		"#EXTM3U", "#EXT-X-VERSION:3", "#EXTINF:4.000,", "segment_00010.ts", "",
		"#EXTINF:4.000,", "sub/segment_00011.ts?token=abc", "#EXT-X-ENDLIST",
	}, "\r\n"))
	if len(set) != 2 || !set["segment_00010.ts"] || !set["segment_00011.ts"] {
		t.Fatal(set)
	}
}

func TestPruneDvrDir(t *testing.T) {
	now := time.Now()
	nowMs := float64(now.UnixNano()) / 1e6
	seg := func(dir, name string, age time.Duration) {
		p := filepath.Join(dir, name)
		_ = writeFile(p, "x")
		_ = os.Chtimes(p, now.Add(-age), now.Add(-age))
	}
	t.Run("deletes only old unreferenced", func(t *testing.T) {
		dir := t.TempDir()
		seg(dir, "seg_old.ts", 2*time.Hour)
		seg(dir, "seg_recent.ts", time.Minute)
		seg(dir, "seg_ref_old.ts", 3*time.Hour)
		_ = writeFile(filepath.Join(dir, "live.m3u8"), "#EXTM3U\nseg_recent.ts\nseg_ref_old.ts\n")
		res := PruneDvrDir(dir, 3600, PruneOptions{Now: nowMs})
		if !reflect.DeepEqual(res.Deleted, []string{"seg_old.ts"}) || res.Kept != 2 {
			t.Fatalf("%+v", res)
		}
		for name, want := range map[string]bool{"seg_old.ts": false, "seg_recent.ts": true, "seg_ref_old.ts": true} {
			if _, err := os.Stat(filepath.Join(dir, name)); (err == nil) != want {
				t.Fatalf("%s exists=%v", name, err == nil)
			}
		}
	})
	t.Run("no live playlist → safety guard", func(t *testing.T) {
		dir := t.TempDir()
		seg(dir, "seg_old.ts", 5*time.Hour)
		if res := PruneDvrDir(dir, 3600, PruneOptions{Now: nowMs}); len(res.Deleted) != 0 {
			t.Fatal(res)
		}
	})
	t.Run("missing dir", func(t *testing.T) {
		res := PruneDvrDir(filepath.Join(t.TempDir(), "nope"), 3600, PruneOptions{Now: nowMs})
		if len(res.Deleted) != 0 || res.Kept != 0 || res.Deleted == nil {
			t.Fatal(res)
		}
	})
	if Safe("live-ch1") != "live-ch1" || Safe("live/ch 1") != "live_ch_1" {
		t.Fatal("safe slug")
	}
}

// fakeEgress scripts the LiveKit HLS egress surface.
type fakeEgress struct {
	live    []HlsEgressInfo
	listErr error
	started []StartHlsEgressInput
	stopped []string
}

func (f *fakeEgress) StartHlsEgress(_ context.Context, in StartHlsEgressInput) (*HlsEgressInfo, error) {
	f.started = append(f.started, in)
	return &HlsEgressInfo{EgressID: "EG_new", Status: "EGRESS_STARTING", RoomName: in.RoomName}, nil
}
func (f *fakeEgress) ListHlsEgress(context.Context, string) ([]HlsEgressInfo, error) {
	return f.live, f.listErr
}
func (f *fakeEgress) StopEgress(_ context.Context, id string) (*EgressInfo, error) {
	f.stopped = append(f.stopped, id)
	return &EgressInfo{EgressID: id, Status: "EGRESS_ENDING"}, nil
}

func linearCfg(alwaysOn, dvr bool) func(string) (*contracts.AppConfig, error) {
	return func(string) (*contracts.AppConfig, error) {
		return &contracts.AppConfig{Features: contracts.AppFeatures{Linear: &contracts.LinearChannelFeatures{
			AlwaysOnHls: alwaysOn, Dvr: dvr, DvrWindowSeconds: 3600, RoomEmptyTimeoutSeconds: 86400,
		}}}, nil
	}
}

func withEgress(h *harness, e *fakeEgress) *Hls {
	h.svc.opt.Egress = func() Egress { return e }
	return NewHls(h.svc)
}

func TestHlsStartStopStatus(t *testing.T) {
	h := newHarness(t, nil)
	eg := &fakeEgress{}
	hls := withEgress(h, eg)
	h.insertActive("live/ch 1/cam", "webrtc", "live/ch 1", "cam", 0)

	_, err := hls.Start(bg, testApp, "nope", "https://x")
	wantStatus(t, err, 404, "stream 'nope' not found")

	res, err := hls.Start(bg, testApp, "live/ch 1/cam", "https://x")
	if err != nil || res.EgressID != "EG_new" || res.PlaylistURL != "https://x/hls/live/live_ch_1/index.m3u8" {
		t.Fatalf("%+v %v", res, err)
	}
	in := eg.started[0]
	if in.OutputDir != filepath.Join(h.dir, "apps", testApp, "hls", "live_ch_1") || in.PlaylistName != "index.m3u8" || in.LivePlaylistName != "" || in.SegmentDurationS != 4 {
		t.Fatalf("%+v", in)
	}
	if h.cb.calls[0].event != "hls_started" {
		t.Fatal(h.cb.calls)
	}

	// Idempotent: an active egress for the exact room is reused.
	eg.live = []HlsEgressInfo{{"EG_other", "EGRESS_ACTIVE", "live/ch 10"}, {"EG_live", "EGRESS_ACTIVE", "live/ch 1"}}
	res, _ = hls.Start(bg, testApp, "live/ch 1/cam", "https://x")
	if res.EgressID != "EG_live" || len(eg.started) != 1 {
		t.Fatalf("%+v", res)
	}

	st, _ := hls.Status(bg, testApp, "live/ch 1/cam", "https://x")
	if !st.Active {
		t.Fatal("status should be active")
	}
	stop, _ := hls.Stop(bg, testApp, "live/ch 1/cam")
	if stop.EgressID == nil || *stop.EgressID != "EG_live" || stop.Status != "EGRESS_ENDING" || !reflect.DeepEqual(eg.stopped, []string{"EG_live"}) {
		t.Fatalf("%+v", stop)
	}

	// Nothing active: stop is lenient; status falls back to the on-disk playlist.
	eg.live = nil
	stop, _ = hls.Stop(bg, testApp, "live/ch 1/cam")
	if stop.EgressID != nil || stop.Status != "inactive" {
		t.Fatalf("%+v", stop)
	}
	if st, _ = hls.Status(bg, testApp, "live/ch 1/cam", ""); st.Active {
		t.Fatal("no playlist on disk yet")
	}
	_ = writeFile(filepath.Join(in.OutputDir, "index.m3u8"), "#EXTM3U")
	eg.listErr = httpx.Unavailable("LiveKit listHlsEgress failed: fetch failed")
	if st, _ = hls.Status(bg, testApp, "live/ch 1/cam", ""); !st.Active {
		t.Fatal("on-disk playlist must count as active")
	}
	// start propagates a listing failure (Node does not catch it there).
	_, err = hls.Start(bg, testApp, "live/ch 1/cam", "")
	wantStatus(t, err, 503, "LiveKit listHlsEgress failed: fetch failed")
}

func TestHlsDvrManifestAndNoRoom(t *testing.T) {
	h := newHarness(t, nil)
	eg := &fakeEgress{}
	hls := withEgress(h, eg)
	h.apps.cfg = linearCfg(true, true)
	h.insertActive("live-ch1/enc", "rtmp", "live-ch1", "enc", 0)
	res, _ := hls.Start(bg, testApp, "live-ch1/enc", "")
	if res.PlaylistURL != "/hls/live/live-ch1/live.m3u8" || eg.started[0].LivePlaylistName != "live.m3u8" || eg.started[0].PlaylistName != "index.m3u8" {
		t.Fatalf("%+v %+v", res, eg.started[0])
	}
	h.insertActive("roomless", "rtmp", "", "", 0)
	_, err := hls.Status(bg, testApp, "roomless", "")
	wantStatus(t, err, 400, "stream 'roomless' has no room for HLS")
}

func TestHlsWithoutLiveKitModule(t *testing.T) {
	h := newHarness(t, nil)
	hls := NewHls(h.svc)
	h.insertActive("live-ch1/enc", "rtmp", "live-ch1", "enc", 0)
	_, err := hls.Start(bg, testApp, "live-ch1/enc", "")
	wantStatus(t, err, 503, "LiveKit listHlsEgress failed: api-key and api-secret must be set")
	if st, err := hls.Stop(bg, testApp, "live-ch1/enc"); err != nil || st.Status != "inactive" {
		t.Fatalf("%+v %v", st, err)
	}
}

func TestWatchdogReconcileOnce(t *testing.T) {
	cases := []struct {
		name           string
		cfg            func(string) (*contracts.AppConfig, error)
		live           []HlsEgressInfo
		listErr        error
		rows           [][2]string // stream id, room
		wantStarts     int
		wantChecked    int
		wantRelaunched int
	}{
		{"relaunches a dead egress exactly once", linearCfg(true, false), nil, nil, [][2]string{{"live-ch1/a", "live-ch1"}}, 1, 1, 1},
		{"leaves a live egress alone", linearCfg(true, false), []HlsEgressInfo{{"EG", "EGRESS_ACTIVE", "live-ch1"}}, nil, [][2]string{{"live-ch1/a", "live-ch1"}}, 0, 1, 0},
		{"skips apps without features.linear", nil, nil, nil, [][2]string{{"live-ch1/a", "live-ch1"}}, 0, 0, 0},
		{"skips alwaysOn:false + dvr:false", linearCfg(false, false), nil, nil, [][2]string{{"live-ch1/a", "live-ch1"}}, 0, 0, 0},
		{"one start per distinct room", linearCfg(true, false), nil, nil, [][2]string{{"live-ch1/a", "live-ch1"}, {"live-ch1/b", "live-ch1"}}, 1, 1, 1},
		{"listing failure assumes alive", linearCfg(true, false), nil, httpx.Unavailable("boom"), [][2]string{{"live-ch1/a", "live-ch1"}}, 0, 1, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, nil)
			eg := &fakeEgress{live: tc.live, listErr: tc.listErr}
			hls := withEgress(h, eg)
			h.apps.cfg = tc.cfg
			for _, r := range tc.rows {
				h.insertActive(r[0], "rtmp", r[1], strings.SplitN(r[0], "/", 2)[1], 0)
			}
			res := NewWatchdog(h.svc, hls).ReconcileOnce(bg, time.Now())
			if len(eg.started) != tc.wantStarts || res.Checked != tc.wantChecked || res.Relaunched != tc.wantRelaunched {
				t.Fatalf("starts=%d res=%+v", len(eg.started), res)
			}
		})
	}
}

func TestWatchdogDvrPrune(t *testing.T) {
	h := newHarness(t, nil)
	hls := withEgress(h, &fakeEgress{live: []HlsEgressInfo{{"EG", "EGRESS_ACTIVE", "live-ch1"}}})
	h.apps.cfg = linearCfg(false, true)
	h.insertActive("live-ch1/a", "rtmp", "live-ch1", "a", 0)
	dir := filepath.Join(h.dir, "apps", testApp, "hls", "live-ch1")
	_ = os.MkdirAll(dir, 0o755)
	old := time.Now().Add(-2 * time.Hour)
	_ = writeFile(filepath.Join(dir, "seg_old.ts"), "x")
	_ = os.Chtimes(filepath.Join(dir, "seg_old.ts"), old, old)
	_ = writeFile(filepath.Join(dir, "live.m3u8"), "#EXTM3U\n")
	res := NewWatchdog(h.svc, hls).ReconcileOnce(bg, time.Now())
	if res.Pruned != 1 || res.Checked != 1 {
		t.Fatalf("%+v", res)
	}
	last := h.logs.lines[len(h.logs.lines)-1]
	if last.source != "hls-watchdog" || last.message != "pruned DVR segments" {
		t.Fatalf("%+v", last)
	}
}

func TestWatchdogInterval(t *testing.T) {
	h := newHarness(t, nil)
	w := NewWatchdog(h.svc, NewHls(h.svc))
	for raw, want := range map[string]time.Duration{"": 30 * time.Second, "abc": 30 * time.Second, "4": 30 * time.Second, "12.9": 12 * time.Second, " 5 ": 5 * time.Second} {
		t.Setenv("STREAMHUB_HLS_WATCHDOG_INTERVAL_S", raw)
		if got := w.interval(); got != want {
			t.Errorf("%q → %v, want %v", raw, got, want)
		}
	}
}
