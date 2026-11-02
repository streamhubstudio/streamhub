package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeGate: app "priv" needs ?st=good (anything else 403); "geo" is blocked
// for everyone; every other app is public. It records what it was asked.
type fakeGate struct{ asked []string }

func (g *fakeGate) AuthorizeHLS(r *http.Request, app, dir string) HLSDecision {
	g.asked = append(g.asked, app+"/"+dir)
	switch app {
	case "priv":
		if st := r.URL.Query().Get("st"); st == "good" {
			return HLSDecision{Private: true, Token: st}
		}
		return HLSDecision{Status: 403, Code: "forbidden", Message: "HLS playback for this app requires a valid token (?st=)"}
	case "geo":
		return HLSDecision{Status: 403, Code: "geo_blocked", Message: "playback is not available in your region"}
	}
	return HLSDecision{}
}

const privPlaylist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4.0,\nseg_00001.ts\n#EXTINF:4.0,\nseg_00002.ts\n"

func gatedSite(t *testing.T, g HLSGate) http.Handler {
	t.Helper()
	data := t.TempDir()
	for _, app := range []string{"pub", "priv", "geo"} {
		dir := filepath.Join(data, "apps", app, "hls", "room")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for name, body := range map[string]string{"index.m3u8": privPlaylist, "seg_00001.ts": "TSDATA"} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	mux := http.NewServeMux()
	Mount(mux, Options{DataDir: data, WebDir: t.TempDir(), Gate: g})
	return mux
}

// The G2 "hecho": a private app without a token → 403 on the playlist AND
// the segments (even a missing one: no existence oracle); with a token → 200,
// the playlist rewritten so the player carries the token to every segment.
func TestHLSGatePrivateAppNeedsToken(t *testing.T) {
	h := gatedSite(t, &fakeGate{})
	for _, target := range []string{"/hls/priv/room/index.m3u8", "/hls/priv/room/seg_00001.ts",
		"/hls/priv/room/seg_99999.ts", "/hls/priv/room/index.m3u8?st=bad"} {
		w := serve(h, "GET", "x", target)
		if w.Code != 403 || !strings.Contains(w.Body.String(), "requires a valid token") ||
			w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: %d %q cc=%q", target, w.Code, w.Body.String(), w.Header().Get("Cache-Control"))
		}
	}

	w := serve(h, "GET", "x", "/hls/priv/room/index.m3u8?st=good")
	if w.Code != 200 {
		t.Fatalf("playlist with token: %d", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{"\nseg_00001.ts?st=good\n", "\nseg_00002.ts?st=good\n", `URI="key.bin?st=good"`} {
		if !strings.Contains(body, want) {
			t.Errorf("rewritten playlist lacks %q:\n%s", want, body)
		}
	}
	if cc := w.Header().Get("Cache-Control"); !strings.HasPrefix(cc, "private") {
		t.Errorf("private playlist cache-control %q", cc)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/vnd.apple.mpegurl" {
		t.Errorf("content-type %q", ct)
	}

	w = serve(h, "GET", "x", "/hls/priv/room/seg_00001.ts?st=good")
	if w.Code != 200 || w.Body.String() != "TSDATA" || w.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatalf("segment with token: %d %q cc=%q", w.Code, w.Body.String(), w.Header().Get("Cache-Control"))
	}
	if w := serve(h, "GET", "x", "/hls/priv/room/seg_99999.ts?st=good"); w.Code != 404 {
		t.Fatalf("authorized miss: %d", w.Code)
	}
	if w := serve(h, "HEAD", "x", "/hls/priv/room/index.m3u8?st=good"); w.Code != 200 {
		t.Fatalf("HEAD with token: %d", w.Code)
	}
	// CORS preflight is never gated.
	if w := serve(h, "OPTIONS", "x", "/hls/priv/room/index.m3u8"); w.Code != 204 {
		t.Fatalf("OPTIONS: %d", w.Code)
	}
}

// Public apps are served exactly like before: no token, playlist verbatim,
// public cache policy.
func TestHLSGatePublicAppUnchanged(t *testing.T) {
	h := gatedSite(t, &fakeGate{})
	w := serve(h, "GET", "x", "/hls/pub/room/index.m3u8")
	if w.Code != 200 || w.Body.String() != privPlaylist {
		t.Fatalf("public playlist: %d %q", w.Code, w.Body.String())
	}
	if w := serve(h, "GET", "x", "/hls/pub/room/seg_00001.ts"); w.Code != 200 ||
		w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("public segment: %d %q", w.Code, w.Header().Get("Cache-Control"))
	}
	if w := serve(h, "GET", "x", "/hls/geo/room/index.m3u8"); w.Code != 403 || !strings.Contains(w.Body.String(), "geo_blocked") {
		t.Fatalf("geo: %d %s", w.Code, w.Body.String())
	}
	// No gate → the pre-3.4 mount, and no /hls-auth route.
	open := gatedSite(t, nil)
	if w := serve(open, "GET", "x", "/hls/priv/room/index.m3u8"); w.Code != 200 || w.Body.String() != privPlaylist {
		t.Fatalf("ungated: %d", w.Code)
	}
}

func authReq(h http.Handler, header, uri string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", "/hls-auth", nil)
	if header != "" {
		r.Header.Set(header, uri)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// /hls-auth is what nginx auth_request / Caddy forward_auth ask before
// serving a segment from disk: 204 or 403, judged on the NORMALIZED path the
// proxy will serve (a "../" dance cannot borrow a public app's verdict).
func TestHLSAuthEndpoint(t *testing.T) {
	g := &fakeGate{}
	h := gatedSite(t, g)
	cases := []struct {
		header, uri string
		want        int
	}{
		{"X-Original-URI", "/hls/pub/room/seg_00001.ts", 204},
		{"X-Original-URI", "/hls/priv/room/seg_00001.ts", 403},
		{"X-Original-URI", "/hls/priv/room/seg_00001.ts?st=good", 204},
		{"X-Forwarded-Uri", "/hls/priv/room/seg_00001.ts?st=good", 204},
		{"X-Forwarded-Uri", "/hls/priv/room/seg_00001.ts?st=bad", 403},
		{"X-Original-URI", "/hls/pub/x/../../priv/room/seg_00001.ts", 403},
		{"X-Original-URI", "/hls/pub/x/../../priv/room/seg_00001.ts?st=good", 204},
		{"X-Original-URI", "/hls/geo/room/seg_00001.ts", 403},
		{"X-Original-URI", "/hls/pub/.hidden/seg.ts", 403},
		{"X-Original-URI", "/api/v1/apps", 403},
		{"X-Original-URI", "not a uri", 403},
		{"", "", 403},
	}
	for _, c := range cases {
		if w := authReq(h, c.header, c.uri); w.Code != c.want {
			t.Errorf("%s %q: %d, want %d (%s)", c.header, c.uri, w.Code, c.want, w.Body.String())
		}
	}
	// The proxy derives the segment Cache-Control from the scope header.
	if w := authReq(h, "X-Original-URI", "/hls/priv/room/seg_00001.ts?st=good"); w.Header().Get(HLSScopeHeader) != "private" {
		t.Errorf("private scope %q", w.Header().Get(HLSScopeHeader))
	}
	if w := authReq(h, "X-Original-URI", "/hls/pub/room/seg_00001.ts"); w.Header().Get(HLSScopeHeader) != "public" {
		t.Errorf("public scope %q", w.Header().Get(HLSScopeHeader))
	}
	// The traversal case was judged as "priv", never as "pub".
	for _, a := range g.asked {
		if strings.HasPrefix(a, "pub/x") {
			t.Fatalf("traversal judged as %q", a)
		}
	}
}

func TestRewritePlaylist(t *testing.T) {
	in := "#EXTM3U\r\n" +
		"#EXT-X-MAP:URI=\"init.mp4\"\r\n" +
		"#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key-id\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\r\n" +
		"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/index.m3u8?lang=es\"\r\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=800000\r\n" +
		"720p/index.m3u8\r\n" +
		"#EXTINF:4,\r\n" +
		"seg1.ts\r\n" +
		"#EXTINF:4,\r\n" +
		"https://cdn.example.com/seg2.ts\r\n" +
		"//other.example.com/seg3.ts\r\n" +
		"/hls/live/room/seg4.ts#frag\r\n" +
		"\r\n"
	got := string(RewritePlaylist([]byte(in), "123.abc"))
	want := "#EXTM3U\r\n" +
		"#EXT-X-MAP:URI=\"init.mp4?st=123.abc\"\r\n" +
		"#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key-id\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\r\n" +
		"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/index.m3u8?lang=es&st=123.abc\"\r\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=800000\r\n" +
		"720p/index.m3u8?st=123.abc\r\n" +
		"#EXTINF:4,\r\n" +
		"seg1.ts?st=123.abc\r\n" +
		"#EXTINF:4,\r\n" +
		"https://cdn.example.com/seg2.ts\r\n" +
		"//other.example.com/seg3.ts\r\n" +
		"/hls/live/room/seg4.ts?st=123.abc#frag\r\n" +
		"\r\n"
	if got != want {
		t.Fatalf("rewrite:\n%s\nwant:\n%s", got, want)
	}
	if string(RewritePlaylist([]byte(in), "")) != in {
		t.Fatal("empty token must leave the playlist untouched")
	}
	for in, want := range map[string]string{
		"/hls/a/b/index.m3u8":           "/hls/a/b/index.m3u8?st=T",
		"https://x/hls/a/b/live.m3u8?x": "https://x/hls/a/b/live.m3u8?x&st=T",
		"/hls/a/b/index.m3u8#t=1":       "/hls/a/b/index.m3u8?st=T#t=1",
	} {
		if got := WithHLSToken(in, "T"); got != want {
			t.Errorf("WithHLSToken(%q) = %q", in, got)
		}
	}
	if WithHLSToken("/x", "") != "/x" {
		t.Error("empty token")
	}
}
