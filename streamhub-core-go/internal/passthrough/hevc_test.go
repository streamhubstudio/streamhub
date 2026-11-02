package passthrough

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/web"
)

func fakeTracks(tracks []string, err error, seen *string) TrackProber {
	return func(_ context.Context, path string) ([]string, error) {
		if seen != nil {
			*seen = path
		}
		return tracks, err
	}
}

// INVARIANT (E1): with STREAMHUB_PASSTHROUGH_HEVC on, a pull-driven publish
// whose video MediaMTX reports as H.265 is segmented as fMP4 HLS (init.mp4
// + .m4s, hvc1 tag); H.264, a failed probe or the switch off keep the
// MPEG-TS argv byte for byte.
func TestHEVCPassthroughSegmentsFMP4(t *testing.T) {
	hlsDir := func(f *svcFixture, room string) string { return filepath.Join(f.cfg.DataDir, "apps/live/hls", room) }
	tsTail := func(dir string) string {
		return " -c copy -f hls -hls_time 4 -hls_list_size 6 -hls_flags delete_segments+append_list -hls_segment_filename " +
			filepath.Join(dir, "seg_%05d.ts") + " " + filepath.Join(dir, "index.m3u8")
	}

	f := newSvc(t, func(c *config.Config) { srtOn(c); c.PassthroughHEVC = true })
	var probed string
	f.svc.Tracks = fakeTracks([]string{"H265", "MPEG-4 Audio"}, nil, &probed)
	info := f.create(t, "live-hevc", "srt", "")
	f.svc.HandlePublish(bg, app, info.StreamKey, nil)
	dir := hlsDir(f, "live-hevc")
	want := "-hide_banner -loglevel warning -i srt://127.0.0.1:8890?streamid=read:live/" + info.StreamKey +
		" -c copy -tag:v hvc1 -f hls -hls_time 4 -hls_list_size 6 -hls_flags delete_segments+append_list" +
		" -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename " +
		filepath.Join(dir, "seg_%05d.m4s") + " " + filepath.Join(dir, "index.m3u8")
	if a := argOf(f.sp.last()); a != want {
		t.Fatalf("hevc argv:\n got %s\nwant %s", a, want)
	}
	if probed != "live/"+info.StreamKey {
		t.Fatalf("probed path %q", probed)
	}

	// H.264 on the same switch → MPEG-TS
	f.svc.Tracks = fakeTracks([]string{"H264", "MPEG-4 Audio"}, nil, nil)
	avc := f.create(t, "live-avc", "rtmp", "")
	f.svc.HandlePublish(bg, app, avc.StreamKey, nil)
	if a := argOf(f.sp.last()); !strings.HasSuffix(a, tsTail(hlsDir(f, "live-avc"))) {
		t.Fatalf("h264 argv: %s", a)
	}
	// probe failure → MPEG-TS (never blocks the publish)
	f.svc.Tracks = fakeTracks(nil, errors.New("api down"), nil)
	f.svc.HandleDone(bg, app, info.StreamKey) // notready, then a new publish
	if r := f.svc.HandlePublish(bg, app, info.StreamKey, nil); !r.Accepted || !strings.HasSuffix(argOf(f.sp.last()), tsTail(dir)) {
		t.Fatalf("probe failure: %+v %s", r, argOf(f.sp.last()))
	}

	// switch off (default) → no probe at all, MPEG-TS
	off := newSvc(t, srtOn)
	off.svc.Tracks = func(context.Context, string) ([]string, error) {
		t.Fatal("probed with the switch off")
		return nil, nil
	}
	k := off.create(t, "live-hevc", "srt", "")
	off.svc.HandlePublish(bg, app, k.StreamKey, nil)
	if a := argOf(off.sp.last()); !strings.HasSuffix(a, tsTail(hlsDir(off, "live-hevc"))) {
		t.Fatalf("switch off argv: %s", a)
	}
}

func TestMediamtxTracksProber(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/paths/get/live/ptk_abc" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"name":"live/ptk_abc","ready":true,"tracks":["H265","Opus"]}`))
	}))
	defer srv.Close()
	got, err := mediamtxTracks(srv.URL)(bg, "live/ptk_abc")
	if err != nil || len(got) != 2 || !IsHEVCTrack(got[0]) || IsHEVCTrack(got[1]) {
		t.Fatalf("tracks %v %v", got, err)
	}
	if _, err := mediamtxTracks(srv.URL)(bg, "live/nope"); err == nil {
		t.Fatal("404 accepted")
	}
	for _, c := range []string{"H265", "h265", "HEVC", "H.265"} {
		if !IsHEVCTrack(c) {
			t.Errorf("%s not HEVC", c)
		}
	}
}

func TestFMP4CacheHeaders(t *testing.T) {
	seg := web.HLSCacheHeaders("/data/apps/live/hls/r/seg_00001.m4s", false, false)
	if seg["Content-Type"] != "video/iso.segment" || !strings.Contains(seg["Cache-Control"], "immutable") {
		t.Fatalf("m4s: %v", seg)
	}
	init := web.HLSCacheHeaders("/data/apps/live/hls/r/init.mp4", false, false)
	if init["Content-Type"] != "video/mp4" || init["Cache-Control"] != "no-cache" {
		t.Fatalf("init: %v", init)
	}
}
