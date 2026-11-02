package streams

import (
	"context"
	"testing"
)

// fakeTokens mints for app "live" only when private is set.
type fakeTokens struct {
	private bool
	asked   []string
}

func (f *fakeTokens) HLSTokenFor(_ context.Context, app, dir string) string {
	f.asked = append(f.asked, app+"/"+dir)
	if !f.private {
		return ""
	}
	return "1800000000.TOK"
}

// G2: the playlistUrl of a PRIVATE app carries its ?st= token, bound to the
// on-disk room dir (Safe(room)); a public app's URL is unchanged.
func TestHlsPlaylistURLSignedForPrivateApps(t *testing.T) {
	h := newHarness(t, nil)
	eg := &fakeEgress{}
	hls := withEgress(h, eg)
	tok := &fakeTokens{}
	h.svc.opt.HLSTokens = func() HLSTokens { return tok }
	h.insertActive("live/ch 1/cam", "webrtc", "live/ch 1", "cam", 0)

	res, err := hls.Start(bg, testApp, "live/ch 1/cam", "https://x")
	if err != nil || res.PlaylistURL != "https://x/hls/live/live_ch_1/index.m3u8" {
		t.Fatalf("public: %+v %v", res, err)
	}
	tok.private = true
	res, _ = hls.Start(bg, testApp, "live/ch 1/cam", "https://x")
	if res.PlaylistURL != "https://x/hls/live/live_ch_1/index.m3u8?st=1800000000.TOK" {
		t.Fatalf("private start: %+v", res)
	}
	st, _ := hls.Status(bg, testApp, "live/ch 1/cam", "https://x")
	if st.PlaylistURL != "https://x/hls/live/live_ch_1/index.m3u8?st=1800000000.TOK" {
		t.Fatalf("private status: %+v", st)
	}
	for _, a := range tok.asked {
		if a != testApp+"/live_ch_1" {
			t.Fatalf("token minted for %q, want the room dir", a)
		}
	}
}

// fakeEdge stands in for cluster.HLSEdgeSelector: app "live" goes to the edge.
type fakeEdge struct{ base string }

func (f fakeEdge) HLSBase(_ context.Context, app, origin string) string {
	if app == testApp && f.base != "" {
		return f.base
	}
	return origin
}

// STREAMHUB_HLS_EDGE_SELECT: the playlistUrl base comes from the edge
// selector (start + status); the ?st= of a private app is kept as is.
func TestHlsPlaylistURLUsesSelectedEdge(t *testing.T) {
	h := newHarness(t, nil)
	hls := withEgress(h, &fakeEgress{})
	h.svc.opt.HLSEdge = func() HLSEdge { return fakeEdge{"https://cdn1.example.com"} }
	h.insertActive("live/ch 1/cam", "webrtc", "live/ch 1", "cam", 0)

	res, err := hls.Start(bg, testApp, "live/ch 1/cam", "https://x")
	if err != nil || res.PlaylistURL != "https://cdn1.example.com/hls/live/live_ch_1/index.m3u8" {
		t.Fatalf("start: %+v %v", res, err)
	}
	st, _ := hls.Status(bg, testApp, "live/ch 1/cam", "https://x")
	if st.PlaylistURL != res.PlaylistURL {
		t.Fatalf("status: %+v", st)
	}
	// no healthy edge → the origin base, unchanged
	h.svc.opt.HLSEdge = func() HLSEdge { return fakeEdge{} }
	if st, _ := hls.Status(bg, testApp, "live/ch 1/cam", "https://x"); st.PlaylistURL != "https://x/hls/live/live_ch_1/index.m3u8" {
		t.Fatalf("fallback: %+v", st)
	}
	// the selector's own decision is final: a token still rides along
	h.svc.opt.HLSEdge = func() HLSEdge { return fakeEdge{"https://cdn1.example.com"} }
	h.svc.opt.HLSTokens = func() HLSTokens { return &fakeTokens{private: true} }
	if st, _ := hls.Status(bg, testApp, "live/ch 1/cam", "https://x"); st.PlaylistURL != "https://cdn1.example.com/hls/live/live_ch_1/index.m3u8?st=1800000000.TOK" {
		t.Fatalf("token: %+v", st)
	}
}
