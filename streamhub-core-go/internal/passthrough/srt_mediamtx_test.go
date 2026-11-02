package passthrough

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
)

func srtOn(c *config.Config) {
	c.MediamtxEnable, c.MediamtxHookSecret = true, secret
	c.MediamtxSrtEnable, c.MediamtxSrtPort = true, 8890
}

// INVARIANT (E2): with STREAMHUB_MEDIAMTX_SRT_ENABLE an SRT passthrough
// ingress no longer gets its own (key-blind) ffmpeg listener: its URL is
// MediaMTX's :8890 with streamid=publish:<app>/<key>, nothing spawns at
// create / boot re-arm, and the ready hook arms an SRT PULL off loopback.
func TestSrtBehindMediamtx(t *testing.T) {
	f := newSvc(t, srtOn)
	info := f.create(t, "live-srt", "srt", "")
	if info.SrtURL != "srt://media.test:8890?streamid=publish:live/"+info.StreamKey || f.sp.count() != 0 {
		t.Fatalf("create: %+v spawns=%d", info, f.sp.count())
	}
	front := NewFront(f.svc, f.keys, func(context.Context) ([]string, error) { return []string{app}, nil }, nil)
	if armed := front.RearmAll(bg); armed != 0 || f.sp.count() != 0 {
		t.Fatalf("boot re-arm spawned a listener: armed=%d spawns=%d", armed, f.sp.count())
	}
	r := f.svc.HandlePublish(bg, app, info.StreamKey, nil)
	if !r.Accepted || r.Port != 8890 || f.sp.count() != 1 {
		t.Fatalf("ready: %+v spawns=%d", r, f.sp.count())
	}
	want := "-hide_banner -loglevel warning -i srt://127.0.0.1:8890?streamid=read:live/" + info.StreamKey +
		" -c copy -f hls -hls_time 4 -hls_list_size 6 -hls_flags delete_segments+append_list -hls_segment_filename " +
		filepath.Join(f.cfg.DataDir, "apps/live/hls/live-srt/seg_%05d.ts") + " " + filepath.Join(f.cfg.DataDir, "apps/live/hls/live-srt/index.m3u8")
	if a := argOf(f.sp.last()); a != want {
		t.Fatalf("pull args:\n got %s\nwant %s", a, want)
	}
	if got, _ := f.svc.Get(bg, app, info.IngressID); got == nil || !strings.Contains(got.SrtURL, ":8890?streamid=publish:live/") {
		t.Fatalf("get: %+v", got)
	}
}

// The switch is off by default: SRT keeps the legacy listener byte-for-byte.
func TestSrtListenerWithoutTheSwitch(t *testing.T) {
	f := newSvc(t, func(c *config.Config) { c.MediamtxEnable = true; c.MediamtxSrtPort = 8890 })
	info := f.create(t, "live-srt", "srt", "")
	if info.SrtURL != "srt://media.test:1937?streamid="+info.StreamKey || !strings.Contains(argOf(f.sp.last()), "srt://0.0.0.0:1937?mode=listener") {
		t.Fatalf("legacy srt: %+v", info)
	}
}

// SECURITY (E2): the auth hook checks SRT publishes against minted keys
// (MediaMTX maps streamid publish:<app>/<key> to the path <app>/<key>), and
// an SRT read — the public listener could otherwise serve any stream raw —
// passes only from loopback (the core's own ffmpeg).
func TestHookAuthSrt(t *testing.T) {
	h := newHooks(t, srtOn)
	_, key := h.register(t, "ch-srt", "srt", "")
	cases := []struct {
		name, body string
		code       int
	}{
		{"minted key", `{"action":"publish","protocol":"srt","ip":"203.0.113.5","path":"live/` + key + `"}`, 200},
		{"unknown key", `{"action":"publish","protocol":"srt","ip":"203.0.113.5","path":"live/ptk_guess"}`, 401},
		{"no key", `{"action":"publish","protocol":"srt","ip":"203.0.113.5","path":"live"}`, 401},
		{"other app", `{"action":"publish","protocol":"srt","ip":"203.0.113.5","path":"other/` + key + `"}`, 401},
		{"read from loopback", `{"action":"read","protocol":"srt","ip":"127.0.0.1","path":"live/` + key + `"}`, 200},
		{"read from the internet", `{"action":"read","protocol":"srt","ip":"203.0.113.5","path":"live/` + key + `"}`, 401},
		{"read from the LAN", `{"action":"read","protocol":"srt","ip":"192.168.1.20","path":"live/` + key + `"}`, 401},
		{"read without ip", `{"action":"read","protocol":"srt","path":"live/` + key + `"}`, 401},
		{"rtmp read unchanged", `{"action":"read","protocol":"rtmp","ip":"203.0.113.5","path":"live/` + key + `"}`, 200},
	}
	for _, c := range cases {
		code, m := h.do(t, hookReq{path: "auth", body: c.body})
		if code != c.code {
			t.Errorf("%s: %d %v", c.name, code, m)
		}
	}
}
