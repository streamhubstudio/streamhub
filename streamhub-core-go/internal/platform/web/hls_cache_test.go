package web

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// LT4 #9: STREAMHUB_HLS_SEGMENT_S / STREAMHUB_HLS_PLAYLIST_MAX_AGE only move
// the LIVE playlist header under STREAMHUB_HLS_CDN; the defaults are the
// historical string byte for byte, segments/finished/no-CDN never change.
func TestHLSCachePolicyLivePlaylist(t *testing.T) {
	cases := []struct {
		seg, maxAge int
		want        string
	}{
		{4, 1, "public, max-age=1, stale-while-revalidate=2"}, // defaults (pre-knob header)
		{0, 1, "public, max-age=1, stale-while-revalidate=2"}, // unset segment = 4
		{2, 1, "public, max-age=1, stale-while-revalidate=1"},
		{1, 1, "public, max-age=1, stale-while-revalidate=1"}, // SWR floor 1 s
		{6, 2, "public, max-age=2, stale-while-revalidate=3"},
		{10, 10, "public, max-age=10, stale-while-revalidate=5"},
		{4, 0, "public, max-age=0, must-revalidate"}, // no TTL, no stale serving
		{2, 0, "public, max-age=0, must-revalidate"},
	}
	for _, c := range cases {
		p := HLSCachePolicy{SegmentS: c.seg, PlaylistMaxAge: c.maxAge}
		if got := p.Headers("/d/apps/a/hls/r/index.m3u8", true, false)["Cache-Control"]; got != c.want {
			t.Errorf("seg=%d maxAge=%d: live playlist %q, want %q", c.seg, c.maxAge, got, c.want)
		}
		for file, want := range map[string]string{
			"/d/apps/a/hls/r/segment_00001.ts": "public, max-age=31536000, immutable",
			"/d/apps/a/hls/r/seg_00001.m4s":    "public, max-age=31536000, immutable",
			"/d/apps/a/hls/r/init.mp4":         "no-cache",
		} {
			if got := p.Headers(file, true, false)["Cache-Control"]; got != want {
				t.Errorf("seg=%d maxAge=%d: %s → %q, want %q", c.seg, c.maxAge, file, got, want)
			}
		}
		if got := p.Headers("x/index.m3u8", true, true)["Cache-Control"]; got != "public, max-age=3600" {
			t.Errorf("finished playlist: %q", got)
		}
		if got := p.Headers("x/index.m3u8", false, false)["Cache-Control"]; got != "no-cache, no-store, must-revalidate" {
			t.Errorf("no CDN: %q", got)
		}
	}
	if got := HLSCacheHeaders("x/index.m3u8", true, false)["Cache-Control"]; got != "public, max-age=1, stale-while-revalidate=2" {
		t.Errorf("HLSCacheHeaders default: %q", got)
	}
}

// The policy reaches /hls through Options.HLSCache (nil = the default).
func TestHLSMountUsesCachePolicy(t *testing.T) {
	data := t.TempDir()
	dir := filepath.Join(data, "apps", "pub", "hls", "room")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.m3u8"), []byte("#EXTM3U\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		policy *HLSCachePolicy
		want   string
	}{
		{nil, "public, max-age=1, stale-while-revalidate=2"},
		{&HLSCachePolicy{SegmentS: 2, PlaylistMaxAge: 0}, "public, max-age=0, must-revalidate"},
	} {
		mux := http.NewServeMux()
		Mount(mux, Options{DataDir: data, WebDir: t.TempDir(), HLSCDN: true, HLSCache: c.policy})
		w := serve(mux, "GET", "x", "/hls/pub/room/index.m3u8")
		if w.Code != 200 || w.Header().Get("Cache-Control") != c.want {
			t.Errorf("%+v: %d %q, want %q", c.policy, w.Code, w.Header().Get("Cache-Control"), c.want)
		}
	}
}
