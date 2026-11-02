package livekit

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/playback"
)

// fakePlay is the playback guard of the token routes (G2): it records the
// grants it was asked about and mints a fixed token for private apps.
type fakePlay struct {
	checks []playback.PlaybackRequest
	minted []string
	deny   error
	apps   *fakeApps
}

func (f *fakePlay) CheckPlayback(_ context.Context, in playback.PlaybackRequest) error {
	f.checks = append(f.checks, in)
	return f.deny
}

func (f *fakePlay) MintHLS(ctx context.Context, app, dir string) (playback.HLSGrant, error) {
	f.minted = append(f.minted, app+"/"+dir)
	cfg, err := f.apps.GetConfig(ctx, app)
	if err != nil {
		return playback.HLSGrant{}, err
	}
	if cfg.Features.PublicPlayback {
		return playback.HLSGrant{}, nil
	}
	return playback.HLSGrant{Required: true, Token: "1800000000.TOKEN", Exp: 1800000000, TTLSeconds: 600}, nil
}

func withPlay(t *testing.T) (*harness, *fakePlay) {
	h := newHarness(t)
	cfg := appCfg("priv")
	cfg.Features.PublicPlayback = false
	h.apps.cfgs["priv"] = cfg
	p := &fakePlay{apps: h.apps}
	h.m.play = p
	return h, p
}

func TestPlayTokenRunsTheGuard(t *testing.T) {
	h, p := withPlay(t)
	expect(t, h.do("GET", "/apps/live/play-token/demo?token=viewer-cred", nil), 200)
	if len(p.checks) != 1 || p.checks[0].App != "live" || p.checks[0].Room != "demo" || p.checks[0].Mode != "viewer" ||
		p.checks[0].Token != "viewer-cred" || p.checks[0].Req == nil {
		t.Fatalf("checks %+v", p.checks)
	}
	expect(t, h.do("GET", "/apps/live/radio/demo/listen-token", nil), 200)
	if p.checks[1].Mode != "listener" {
		t.Fatalf("listener mode %+v", p.checks[1])
	}
	p.deny = httpx.Forbidden("playback is not available in your region")
	for _, path := range []string{"/apps/live/play-token/demo", "/apps/live/radio/demo/listen-token", "/apps/live/hls-token/demo"} {
		r := h.do("GET", path, nil)
		expect(t, r, 403)
		if r.message() != "playback is not available in your region" || r.Header.Get("Access-Control-Allow-Origin") != "*" {
			t.Fatalf("%s: %s", path, r.Raw)
		}
	}
	// A private app without a signed URL is refused BEFORE the guard (and
	// its webhook) is consulted.
	p.deny, p.checks = nil, nil
	expect(t, h.do("GET", "/apps/priv/play-token/demo", nil), 403)
	if len(p.checks) != 0 {
		t.Fatal("the guard ran for an unsigned private request")
	}
}

func TestHLSTokenRoute(t *testing.T) {
	h, p := withPlay(t)
	t.Setenv("PUBLIC_BASE_URL", "https://sh.example.com")

	// Public app: nothing to mint, bare playlist URL.
	r := h.do("GET", "/apps/live/hls-token/ch1", nil)
	expect(t, r, 200)
	d := r.data()
	if d["required"] != false || d["st"] != "" || d["playlistUrl"] != "https://sh.example.com/hls/live/ch1/index.m3u8" ||
		r.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("public %v", d)
	}

	// Private app: the signed capability is required, then the token.
	r = h.do("GET", "/apps/priv/hls-token/demo", nil)
	expect(t, r, 403)
	if r.message() != "playback for this app requires a valid signed URL" {
		t.Fatal(r.Raw)
	}
	s := h.do("POST", "/apps/priv/play-token/demo/sign", map[string]any{"ttlSeconds": 60}).data()
	q := fmt.Sprintf("?exp=%.0f&sig=%s", s["exp"], s["sig"])
	r = h.do("GET", "/apps/priv/hls-token/demo"+q, nil)
	expect(t, r, 200)
	d = r.data()
	if d["required"] != true || d["st"] != "1800000000.TOKEN" || d["ttlSeconds"] != float64(600) ||
		d["playlistUrl"] != "https://sh.example.com/hls/priv/demo/index.m3u8?st=1800000000.TOKEN" {
		t.Fatalf("private %v", d)
	}
	if last := p.checks[len(p.checks)-1]; last.Mode != "hls" || last.App != "priv" {
		t.Fatalf("hls grant not checked: %+v", last)
	}
	// A capability for another room never mints this one.
	expect(t, h.do("GET", "/apps/priv/hls-token/other"+q, nil), 403)
	expect(t, h.do("GET", "/apps/nope/hls-token/demo", nil), 404)

	h.m.play = nil
	expect(t, h.do("GET", "/apps/live/hls-token/ch1", nil), 503)
}

func TestSignPlaybackCarriesHLSTokenForPrivateApps(t *testing.T) {
	h, _ := withPlay(t)
	t.Setenv("PUBLIC_BASE_URL", "https://sh.example.com")
	d := h.do("POST", "/apps/priv/play-token/demo/sign", nil).data()
	if d["hlsToken"] != "1800000000.TOKEN" || d["hlsExp"] != float64(1800000000) ||
		d["hlsUrl"] != "https://sh.example.com/hls/priv/demo/index.m3u8?st=1800000000.TOKEN" {
		t.Fatalf("private sign %v", d)
	}
	d = h.do("POST", "/apps/live/play-token/demo/sign", nil).data()
	for _, k := range []string{"hlsToken", "hlsExp", "hlsUrl"} {
		if _, has := d[k]; has {
			t.Fatalf("public sign must not carry %s: %v", k, d)
		}
	}
	if !strings.HasPrefix(d["playUrl"].(string), "https://sh.example.com/play/live/demo?") {
		t.Fatalf("public sign %v", d)
	}
}

// fakeEdge stands in for cluster.HLSEdgeSelector: only app "live" is steered.
type fakeEdge struct{ base string }

func (f fakeEdge) HLSBase(_ context.Context, app, origin string) string {
	if app == "live" && f.base != "" {
		return f.base
	}
	return origin
}

// STREAMHUB_HLS_EDGE_SELECT: hls-token's playlistUrl uses the selected edge;
// the sign hlsUrl of a private app follows the selector's (origin) decision.
func TestHLSTokenRouteUsesSelectedEdge(t *testing.T) {
	h, _ := withPlay(t)
	t.Setenv("PUBLIC_BASE_URL", "https://sh.example.com")
	h.m.opt.HLSEdge = func() HLSEdge { return fakeEdge{"https://cdn1.example.com"} }
	d := h.do("GET", "/apps/live/hls-token/ch1", nil).data()
	if d["playlistUrl"] != "https://cdn1.example.com/hls/live/ch1/index.m3u8" {
		t.Fatalf("edge %v", d)
	}
	s := h.do("POST", "/apps/priv/play-token/demo/sign", nil).data()
	if s["hlsUrl"] != "https://sh.example.com/hls/priv/demo/index.m3u8?st=1800000000.TOKEN" || s["playUrl"] == nil {
		t.Fatalf("sign %v", s)
	}
	h.m.opt.HLSEdge = func() HLSEdge { return fakeEdge{} }
	if d := h.do("GET", "/apps/live/hls-token/ch1", nil).data(); d["playlistUrl"] != "https://sh.example.com/hls/live/ch1/index.m3u8" {
		t.Fatalf("fallback %v", d)
	}
}
