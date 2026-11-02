package streams

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// LT4 #3: after `docker compose restart egress` LiveKit kept listing the dead
// egress as EGRESS_ACTIVE (and could not stop it): Start reused the corpse
// forever and Stop answered "inactive". These lock the on-disk liveness check
// (index.m3u8 must advance within 3 segment durations, past a startup grace)
// and that Start, Stop and the watchdog act on one same set.

// touchPlaylist writes <dir>/index.m3u8 last modified `age` ago.
func touchPlaylist(t *testing.T, dir string, age time.Duration) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, PlaylistName)
	if err := writeFile(p, "#EXTM3U\n"); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-age)
	if err := os.Chtimes(p, at, at); err != nil {
		t.Fatal(err)
	}
}

func TestHlsStartJudgesActiveEgressByItsPlaylist(t *testing.T) {
	const none = -1
	cases := []struct {
		name        string
		segS        int           // STREAMHUB_HLS_SEGMENT_S (0 = unset → 4)
		status      string        // listed status
		startedAgo  time.Duration // 0 = LiveKit reports no started_at
		playlistAge time.Duration // none = no playlist on disk
		replaced    bool
	}{
		{"advancing → reused", 0, "EGRESS_ACTIVE", 10 * time.Minute, 2 * time.Second, false},
		{"frozen past 3×segment → replaced", 0, "EGRESS_ACTIVE", 10 * time.Minute, 60 * time.Second, true},
		{"frozen, no started_at (core restarted) → replaced", 0, "EGRESS_ACTIVE", 0, 60 * time.Second, true},
		{"within 3×segment → reused", 0, "EGRESS_ACTIVE", 10 * time.Minute, 10 * time.Second, false},
		{"startup grace → reused", 0, "EGRESS_ACTIVE", 19 * time.Second, 15 * time.Second, false},
		{"playlist older than the egress → no evidence, reused", 0, "EGRESS_ACTIVE", time.Minute, 2 * time.Minute, false},
		{"no playlist on this disk → no evidence, reused", 0, "EGRESS_ACTIVE", 10 * time.Minute, none, false},
		{"still starting → reused", 0, "EGRESS_STARTING", 0, 60 * time.Second, false},
		{"2 s segments: 8 s idle is stale", 2, "EGRESS_ACTIVE", 10 * time.Minute, 8 * time.Second, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, nil)
			h.svc.cfg.HLSSegmentS = tc.segS
			eg := &fakeEgress{}
			hls := withEgress(h, eg)
			h.insertActive("live-ch1/a", "rtmp", "live-ch1", "a", 0)
			e := HlsEgressInfo{EgressID: "EG_live", Status: tc.status, RoomName: "live-ch1"}
			if tc.startedAgo > 0 {
				e.StartedAt = time.Now().Add(-tc.startedAgo)
			}
			eg.live = []HlsEgressInfo{e}
			if tc.playlistAge != none {
				touchPlaylist(t, hls.roomDir(testApp, "live-ch1"), tc.playlistAge)
			}
			res, err := hls.Start(bg, testApp, "live-ch1/a", "")
			if err != nil {
				t.Fatal(err)
			}
			if !tc.replaced {
				if res.EgressID != "EG_live" || len(eg.started) != 0 || len(eg.stopped) != 0 {
					t.Fatalf("want reuse: %+v started=%d stopped=%v", res, len(eg.started), eg.stopped)
				}
				return
			}
			wantSeg := 4
			if tc.segS > 0 {
				wantSeg = tc.segS
			}
			if res.EgressID != "EG_new" || len(eg.started) != 1 || eg.started[0].SegmentDurationS != wantSeg ||
				!reflect.DeepEqual(eg.stopped, []string{"EG_live"}) {
				t.Fatalf("want replace: %+v started=%+v stopped=%v", res, eg.started, eg.stopped)
			}
			var warned bool
			for _, l := range h.logs.lines {
				warned = warned || (l.level == "warn" && l.message == "stale hls egress replaced")
			}
			if !warned || h.cb.calls[len(h.cb.calls)-1].event != "hls_started" {
				t.Fatalf("logs=%+v calls=%+v", h.logs.lines, h.cb.calls)
			}
		})
	}
}

// The LT4 flow end to end: a corpse LiveKit lists as active and cannot stop.
func TestHlsCorpseRecoveryStartStopAgree(t *testing.T) {
	h := newHarness(t, nil)
	eg := &fakeEgress{stopErr: httpx.Unavailable("LiveKit stopEgress failed: no response from servers")}
	hls := withEgress(h, eg)
	h.insertActive("live-ch1/a", "rtmp", "live-ch1", "a", 0)
	dir := hls.roomDir(testApp, "live-ch1")
	corpse := HlsEgressInfo{EgressID: "EG_dead", Status: "EGRESS_ACTIVE", RoomName: "live-ch1", StartedAt: time.Now().Add(-10 * time.Minute)}
	eg.live = []HlsEgressInfo{corpse}
	touchPlaylist(t, dir, 180*time.Second)

	// Stop acts on exactly what Start would reuse: it tries the corpse; the
	// stop fails and the playlist is frozen → the core forgets it.
	stop, err := hls.Stop(bg, testApp, "live-ch1/a")
	if err != nil || stop.EgressID != nil || stop.Status != "inactive" || !reflect.DeepEqual(eg.stopped, []string{"EG_dead"}) {
		t.Fatalf("%+v %v stopped=%v", stop, err, eg.stopped)
	}
	// LiveKit still lists the corpse, but Start no longer reuses it.
	res, err := hls.Start(bg, testApp, "live-ch1/a", "")
	if err != nil || res.EgressID != "EG_new" || len(eg.started) != 1 || len(eg.stopped) != 1 {
		t.Fatalf("%+v %v started=%d stopped=%v", res, err, len(eg.started), eg.stopped)
	}
	if st, _ := hls.Status(bg, testApp, "live-ch1/a", ""); !st.Active {
		t.Fatal("status: playlist on disk")
	}

	// Both listed now; the fresh egress writes → it is the one reused/stopped.
	eg.stopErr = nil
	eg.live = []HlsEgressInfo{corpse, {EgressID: "EG_new", Status: "EGRESS_ACTIVE", RoomName: "live-ch1", StartedAt: time.Now()}}
	touchPlaylist(t, dir, 0)
	if res, _ = hls.Start(bg, testApp, "live-ch1/a", ""); res.EgressID != "EG_new" || len(eg.started) != 1 {
		t.Fatalf("%+v started=%d", res, len(eg.started))
	}
	stop, _ = hls.Stop(bg, testApp, "live-ch1/a")
	if stop.EgressID == nil || *stop.EgressID != "EG_new" || !reflect.DeepEqual(eg.stopped, []string{"EG_dead", "EG_new"}) {
		t.Fatalf("%+v stopped=%v", stop, eg.stopped)
	}

	// LiveKit drops the corpse → the core forgets it was abandoned.
	eg.live = nil
	if _, err := hls.Start(bg, testApp, "live-ch1/a", ""); err != nil || len(hls.abandoned) != 0 {
		t.Fatalf("%v abandoned=%v", err, hls.abandoned)
	}
}

// A stop that fails on an egress still writing must not orphan it: the next
// start reuses it instead of launching a second writer into the room.
func TestHlsStopFailureOnLiveEgressKeepsIt(t *testing.T) {
	h := newHarness(t, nil)
	eg := &fakeEgress{stopErr: httpx.Unavailable("LiveKit stopEgress failed: fetch failed")}
	hls := withEgress(h, eg)
	h.insertActive("live-ch1/a", "rtmp", "live-ch1", "a", 0)
	eg.live = []HlsEgressInfo{{EgressID: "EG_live", Status: "EGRESS_ACTIVE", RoomName: "live-ch1", StartedAt: time.Now().Add(-time.Hour)}}
	touchPlaylist(t, hls.roomDir(testApp, "live-ch1"), time.Second)
	if stop, _ := hls.Stop(bg, testApp, "live-ch1/a"); stop.EgressID != nil || stop.Status != "inactive" {
		t.Fatalf("%+v", stop)
	}
	if res, _ := hls.Start(bg, testApp, "live-ch1/a", ""); res.EgressID != "EG_live" || len(eg.started) != 0 {
		t.Fatalf("%+v started=%d", res, len(eg.started))
	}
}

// An egress this core just launched keeps its grace even before LiveKit
// reports a started_at, over a playlist a previous egress left behind.
func TestHlsLaunchGraceWithoutStartedAt(t *testing.T) {
	h := newHarness(t, nil)
	eg := &fakeEgress{}
	hls := withEgress(h, eg)
	h.insertActive("live-ch1/a", "rtmp", "live-ch1", "a", 0)
	touchPlaylist(t, hls.roomDir(testApp, "live-ch1"), time.Hour)
	if res, _ := hls.Start(bg, testApp, "live-ch1/a", ""); res.EgressID != "EG_new" {
		t.Fatalf("%+v", res)
	}
	eg.live = []HlsEgressInfo{{EgressID: "EG_new", Status: "EGRESS_ACTIVE", RoomName: "live-ch1"}}
	if res, _ := hls.Start(bg, testApp, "live-ch1/a", ""); res.EgressID != "EG_new" || len(eg.started) != 1 || len(eg.stopped) != 0 {
		t.Fatalf("%+v started=%d stopped=%v", res, len(eg.started), eg.stopped)
	}
}

// Always-on: the watchdog treats a frozen egress as dead and relaunches it
// (through Start, which replaces it); an advancing one is left alone.
func TestWatchdogRelaunchesStaleEgress(t *testing.T) {
	for _, tc := range []struct {
		age        time.Duration
		relaunched int
	}{{2 * time.Second, 0}, {60 * time.Second, 1}} {
		h := newHarness(t, nil)
		eg := &fakeEgress{live: []HlsEgressInfo{{EgressID: "EG", Status: "EGRESS_ACTIVE", RoomName: "live-ch1", StartedAt: time.Now().Add(-time.Hour)}}}
		hls := withEgress(h, eg)
		h.apps.cfg = linearCfg(true, false)
		h.insertActive("live-ch1/a", "rtmp", "live-ch1", "a", 0)
		touchPlaylist(t, hls.roomDir(testApp, "live-ch1"), tc.age)
		res := NewWatchdog(h.svc, hls).ReconcileOnce(bg, time.Now())
		if res.Relaunched != tc.relaunched || len(eg.started) != tc.relaunched || len(eg.stopped) != tc.relaunched {
			t.Fatalf("age=%v: %+v started=%d stopped=%v", tc.age, res, len(eg.started), eg.stopped)
		}
	}
}
