package streams

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// G5 — the DVR window: playlist parsing/timing/rendering (pure), the HLS
// plan per app config, the on-disk dvr.m3u8 writer and its wiring into
// Hls.Start/Stop and the watchdog.

const t0 = 1_761_700_000_000.0 // 2025-10-29T01:06:40Z, epoch ms

// eventPlaylist is what LiveKit's egress writes as index.m3u8 (EVENT type,
// a PROGRAM-DATE-TIME per segment).
func eventPlaylist(n int, ended bool) string {
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n")
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "#EXT-X-PROGRAM-DATE-TIME:%s\n#EXTINF:4.000,\nsegment_%05d.ts\n", FormatPDT(t0+float64(i)*4000), i)
	}
	if ended {
		b.WriteString("#EXT-X-ENDLIST\n")
	}
	return b.String()
}

func TestParseMediaPlaylistAndTimeline(t *testing.T) {
	p := ParseMediaPlaylist(eventPlaylist(3, true))
	if p.Version != 4 || p.TargetDuration != 4 || p.MediaSequence != 0 || !p.Ended || len(p.Segments) != 3 {
		t.Fatalf("%+v", p)
	}
	if p.Segments[1] != (MediaSegment{URI: "segment_00001.ts", Duration: 4, PDT: t0 + 4000}) {
		t.Fatalf("%+v", p.Segments[1])
	}
	tl := p.Timeline(nil)
	if tl[0].Start != t0 || tl[2].End != t0+12000 {
		t.Fatalf("%+v", tl)
	}

	// PDT only on the 2nd segment: carried forward, back-filled before it.
	p = ParseMediaPlaylist("#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-PROGRAM-DATE-TIME:2025-10-29T01:06:40.000Z\n#EXTINF:4,\nb.ts\n#EXTINF:6.5,\nc.ts\n")
	tl = p.Timeline(nil)
	if tl[0].Start != t0-2000 || tl[1].Start != t0 || tl[2].Start != t0+4000 || tl[2].End != t0+10500 {
		t.Fatalf("%+v", tl)
	}

	// No PDT: anchored on the newest segment's mtime (= its end).
	p = ParseMediaPlaylist("#EXTM3U\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXTINF:4,\nc.ts\n")
	mt := map[string]float64{"b.ts": t0}
	tl = p.Timeline(func(u string) (float64, bool) { v, ok := mt[u]; return v, ok })
	if tl[1].End != t0 || tl[0].Start != t0-8000 || tl[2].End != t0+4000 {
		t.Fatalf("%+v", tl)
	}
	if p.Timeline(nil) != nil || p.Timeline(func(string) (float64, bool) { return 0, false }) != nil {
		t.Fatal("nothing anchors → nil timeline")
	}

	// Garbage tolerated: an orphan URI and a bad EXTINF never panic.
	p = ParseMediaPlaylist("orphan.ts\n#EXTINF:abc,\nx.ts\n#EXT-X-PROGRAM-DATE-TIME:yesterday\n#EXTINF:-1,\ny.ts\n")
	if len(p.Segments) != 2 || p.Segments[0].Duration != 0 || p.Segments[1].PDT != 0 || p.Segments[1].Duration != 0 {
		t.Fatalf("%+v", p.Segments)
	}
	if ms, ok := ParsePDT("2025-10-29T01:06:40.000+0000"); !ok || ms != t0 {
		t.Fatalf("ffmpeg PDT spelling: %v %v", ms, ok)
	}

	// A playlist caught mid-rewrite: the partial last line is not a segment.
	partial := []byte("#EXTM3U\n#EXTINF:4,\na.ts\n#EXTINF:4,\nsegm")
	if p := ParseMediaPlaylist(string(CompleteLines(partial))); len(p.Segments) != 1 || p.Segments[0].URI != "a.ts" {
		t.Fatalf("%+v", p.Segments)
	}
	if CompleteLines([]byte("no newline")) != nil || string(CompleteLines([]byte("x\n"))) != "x\n" {
		t.Fatal("CompleteLines")
	}
}

func TestBuildWindowPlaylist(t *testing.T) {
	p := ParseMediaPlaylist(eventPlaylist(10, false))
	out := BuildWindowPlaylist(p, p.Timeline(nil), 3)
	want := "#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n" +
		"#EXT-X-PROGRAM-DATE-TIME:" + FormatPDT(t0+28000) + "\n#EXTINF:4.000,\nsegment_00007.ts\n" +
		"#EXT-X-PROGRAM-DATE-TIME:" + FormatPDT(t0+32000) + "\n#EXTINF:4.000,\nsegment_00008.ts\n" +
		"#EXT-X-PROGRAM-DATE-TIME:" + FormatPDT(t0+36000) + "\n#EXTINF:4.000,\nsegment_00009.ts\n"
	if out != want {
		t.Fatalf("got\n%s\nwant\n%s", out, want)
	}
	if strings.Contains(out, "PLAYLIST-TYPE") {
		t.Fatal("a sliding window must not claim EVENT")
	}
	if all := BuildWindowPlaylist(p, nil, 0); strings.Count(all, "#EXTINF") != 10 || strings.Contains(all, "PROGRAM-DATE-TIME") ||
		!strings.Contains(all, "#EXT-X-MEDIA-SEQUENCE:0\n") {
		t.Fatalf("n=0 keeps all, no timeline → no PDT:\n%s", all)
	}

	// Discontinuities: dropped ones advance the sequence, kept ones stay tagged.
	src := "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:4,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nb.ts\n" +
		"#EXT-X-DISCONTINUITY\n#EXTINF:9.2,\nc.ts\n#EXTINF:4,\nd.ts\n#EXT-X-ENDLIST\n"
	out = BuildWindowPlaylist(ParseMediaPlaylist(src), nil, 2)
	if !strings.Contains(out, "#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-DISCONTINUITY-SEQUENCE:1\n#EXT-X-DISCONTINUITY\n#EXTINF:9.200,\nc.ts\n") ||
		!strings.Contains(out, "#EXT-X-TARGETDURATION:10\n") || !strings.HasSuffix(out, "d.ts\n#EXT-X-ENDLIST\n") {
		t.Fatalf("%s", out)
	}
}

func dvrCfg(dvr *contracts.DvrFeatures, hls *contracts.HlsFeatures, linear *contracts.LinearChannelFeatures) *contracts.AppConfig {
	return &contracts.AppConfig{Features: contracts.AppFeatures{Dvr: dvr, Hls: hls, Linear: linear}}
}

func TestPlanFor(t *testing.T) {
	legacy := &contracts.LinearChannelFeatures{Dvr: true, DvrWindowSeconds: 1800}
	cases := []struct {
		name string
		cfg  *contracts.AppConfig
		want HlsPlan
	}{
		{"nil config: historical", nil, HlsPlan{SegmentSeconds: 4, Manifest: "index.m3u8"}},
		{"no blocks: historical", dvrCfg(nil, nil, &contracts.LinearChannelFeatures{}), HlsPlan{SegmentSeconds: 4, Manifest: "index.m3u8"}},
		{"hlsTime only", dvrCfg(nil, &contracts.HlsFeatures{SegmentSeconds: 2}, nil), HlsPlan{SegmentSeconds: 2, Manifest: "index.m3u8"}},
		{"hlsListSize window", dvrCfg(nil, &contracts.HlsFeatures{SegmentSeconds: 2, ListSize: 15}, nil),
			HlsPlan{SegmentSeconds: 2, Manifest: "dvr.m3u8", WindowSegments: 15}},
		{"dvr disabled = absent", dvrCfg(&contracts.DvrFeatures{WindowMinutes: 60}, nil, nil), HlsPlan{SegmentSeconds: 4, Manifest: "index.m3u8"}},
		{"dvr 60 min @ 4 s", dvrCfg(&contracts.DvrFeatures{Enabled: true, WindowMinutes: 60}, nil, nil),
			HlsPlan{SegmentSeconds: 4, Manifest: "dvr.m3u8", WindowSegments: 900, DvrSeconds: 3600, PruneSeconds: 3612, Protect: "dvr.m3u8", AlwaysOn: true}},
		{"dvr derives hlsListSize, overriding list_size", dvrCfg(&contracts.DvrFeatures{Enabled: true, WindowMinutes: 1}, &contracts.HlsFeatures{SegmentSeconds: 7, ListSize: 3}, nil),
			HlsPlan{SegmentSeconds: 7, Manifest: "dvr.m3u8", WindowSegments: 9, DvrSeconds: 60, PruneSeconds: 81, Protect: "dvr.m3u8", AlwaysOn: true}},
		{"legacy linear.dvr unchanged", dvrCfg(nil, nil, legacy),
			HlsPlan{SegmentSeconds: 4, Manifest: "live.m3u8", LivePlaylist: true, PruneSeconds: 1800, Protect: "live.m3u8"}},
		{"features.dvr wins over linear.dvr", dvrCfg(&contracts.DvrFeatures{Enabled: true, WindowMinutes: 10}, nil, legacy),
			HlsPlan{SegmentSeconds: 4, Manifest: "dvr.m3u8", WindowSegments: 150, DvrSeconds: 600, PruneSeconds: 612, Protect: "dvr.m3u8", AlwaysOn: true}},
		{"linear always-on alone", dvrCfg(nil, nil, &contracts.LinearChannelFeatures{AlwaysOnHls: true}), HlsPlan{SegmentSeconds: 4, Manifest: "index.m3u8", AlwaysOn: true}},
	}
	for _, tc := range cases {
		if got := PlanFor(tc.cfg); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
}

func writeSegments(t *testing.T, dir string, n int) {
	t.Helper()
	_ = os.MkdirAll(dir, 0o755)
	for i := 0; i < n; i++ {
		if err := writeFile(filepath.Join(dir, fmt.Sprintf("segment_%05d.ts", i)), "ts"); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWindowWriter(t *testing.T) {
	dir := t.TempDir()
	writeSegments(t, dir, 6)
	w := NewWindowWriter()
	w.Track(dir, 4) // no index.m3u8 yet: tracked, nothing written
	if _, err := os.Stat(filepath.Join(dir, WindowPlaylistName)); err == nil {
		t.Fatal("no source yet → no window")
	}
	_ = writeFile(filepath.Join(dir, PlaylistName), eventPlaylist(5, false))
	w.TickOnce()
	got, _ := os.ReadFile(filepath.Join(dir, WindowPlaylistName))
	if strings.Count(string(got), "#EXTINF") != 4 || !strings.Contains(string(got), "#EXT-X-MEDIA-SEQUENCE:1\n") {
		t.Fatalf("%s", got)
	}

	// The egress appended a segment: the next tick slides the window.
	_ = writeFile(filepath.Join(dir, PlaylistName), eventPlaylist(6, false))
	w.TickOnce()
	got, _ = os.ReadFile(filepath.Join(dir, WindowPlaylistName))
	if !strings.Contains(string(got), "#EXT-X-MEDIA-SEQUENCE:2\n") || !strings.HasSuffix(string(got), "segment_00005.ts\n") {
		t.Fatalf("%s", got)
	}

	// Source ended: written one last time (with ENDLIST), then untracked.
	_ = writeFile(filepath.Join(dir, PlaylistName), eventPlaylist(6, true))
	w.TickOnce()
	got, _ = os.ReadFile(filepath.Join(dir, WindowPlaylistName))
	if !strings.HasSuffix(string(got), "#EXT-X-ENDLIST\n") {
		t.Fatalf("%s", got)
	}
	if _, ok := w.Tracked(dir); ok {
		t.Fatal("an ended source is untracked")
	}
	if _, err := os.Stat(filepath.Join(dir, "."+WindowPlaylistName+".tmp")); err == nil {
		t.Fatal("tmp file left behind")
	}
}

func TestHlsStartDvrPlan(t *testing.T) {
	h := newHarness(t, nil)
	eg := &fakeEgress{}
	hls := withEgress(h, eg)
	h.apps.cfg = func(string) (*contracts.AppConfig, error) {
		return dvrCfg(&contracts.DvrFeatures{Enabled: true, WindowMinutes: 60}, &contracts.HlsFeatures{SegmentSeconds: 2}, nil), nil
	}
	h.insertActive("cam1/enc", "rtsp", "cam1", "enc", 0)
	res, err := hls.Start(bg, testApp, "cam1/enc", "https://x")
	if err != nil || res.PlaylistURL != "https://x/hls/live/cam1/dvr.m3u8" || res.Dvr == nil || *res.Dvr != (HlsDvrInfo{3600, 2}) {
		t.Fatalf("%+v %v", res, err)
	}
	in := eg.started[0]
	if in.SegmentDurationS != 2 || in.LivePlaylistName != "" || in.PlaylistName != "index.m3u8" {
		t.Fatalf("egress input %+v", in)
	}
	if n, ok := hls.Windows.Tracked(in.OutputDir); !ok || n != 1800 {
		t.Fatalf("window not tracked: %d %v", n, ok)
	}
	st, _ := hls.Status(bg, testApp, "cam1/enc", "https://x")
	if st.PlaylistURL != res.PlaylistURL || st.Dvr == nil {
		t.Fatalf("%+v", st)
	}
	eg.live = []HlsEgressInfo{{EgressID: "EG_new", Status: "EGRESS_ACTIVE", RoomName: "cam1"}}
	if _, err := hls.Stop(bg, testApp, "cam1/enc"); err != nil {
		t.Fatal(err)
	}
	if _, ok := hls.Windows.Tracked(in.OutputDir); ok {
		t.Fatal("stop must untrack the window")
	}
	// No features.dvr → the status result carries no dvr key.
	h.apps.cfg = nil
	if st, _ := hls.Status(bg, testApp, "cam1/enc", ""); st.Dvr != nil || !strings.HasSuffix(st.PlaylistURL, "/index.m3u8") {
		t.Fatalf("%+v", st)
	}
}

func TestWatchdogDvrRelaunchTrackAndPrune(t *testing.T) {
	h := newHarness(t, nil)
	eg := &fakeEgress{}
	hls := withEgress(h, eg)
	h.apps.cfg = func(string) (*contracts.AppConfig, error) {
		return dvrCfg(&contracts.DvrFeatures{Enabled: true, WindowMinutes: 1}, nil, nil), nil
	}
	h.insertActive("cam1/enc", "rtsp", "cam1", "enc", 0)
	dir := filepath.Join(h.dir, "apps", testApp, "hls", "cam1")
	writeSegments(t, dir, 3)
	old := time.Now().Add(-2 * time.Hour)
	for _, n := range []string{"segment_00000.ts", "segment_00001.ts"} {
		_ = os.Chtimes(filepath.Join(dir, n), old, old)
	}
	// segment_00001 is old but still in the window → never pruned.
	_ = writeFile(filepath.Join(dir, PlaylistName), "#EXTM3U\n#EXTINF:4,\nsegment_00001.ts\n#EXTINF:4,\nsegment_00002.ts\n")

	res := NewWatchdog(h.svc, hls).ReconcileOnce(bg, time.Now())
	if res.Relaunched != 1 || len(eg.started) != 1 {
		t.Fatalf("features.dvr implies always-on: %+v", res)
	}
	if _, ok := hls.Windows.Tracked(dir); !ok {
		t.Fatal("watchdog must (re)track the window")
	}
	if res.Pruned != 1 {
		t.Fatalf("pruned %d", res.Pruned)
	}
	if _, err := os.Stat(filepath.Join(dir, "segment_00000.ts")); err == nil {
		t.Fatal("expired unreferenced segment kept")
	}
	if _, err := os.Stat(filepath.Join(dir, "segment_00001.ts")); err != nil {
		t.Fatal("a segment referenced by dvr.m3u8 was pruned")
	}
}

// STREAMHUB_HLS_SEGMENT_S is the node-wide default; features.hls wins per app.
func TestPlanForSegmentsDefault(t *testing.T) {
	if PlanFor(nil).SegmentSeconds != 4 || PlanForSegments(nil, 0).SegmentSeconds != 4 {
		t.Fatal("historical default")
	}
	if p := PlanForSegments(nil, 2); p.SegmentSeconds != 2 {
		t.Fatal(p)
	}
	app := &contracts.AppConfig{Features: contracts.AppFeatures{Hls: &contracts.HlsFeatures{SegmentSeconds: 6}}}
	if p := PlanForSegments(app, 2); p.SegmentSeconds != 6 {
		t.Fatal(p)
	}
}
