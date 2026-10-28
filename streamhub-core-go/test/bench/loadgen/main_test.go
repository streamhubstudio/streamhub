package main

import (
	"net/url"
	"reflect"
	"testing"
	"time"
)

// Pure helpers of the hls mode (ex scripts/hls-loadtest.mjs). No network.

func TestRampSteps(t *testing.T) {
	if got, _ := rampSteps("100, 500,1000", 0); !reflect.DeepEqual(got, []int{100, 500, 1000}) {
		t.Fatal(got)
	}
	if got, _ := rampSteps("100,500", 250); !reflect.DeepEqual(got, []int{250}) {
		t.Fatal("-viewers wins over -ramp", got)
	}
	for _, bad := range []string{"", "100,x", "0", "-5"} {
		if _, err := rampSteps(bad, 0); err == nil {
			t.Errorf("%q should fail", bad)
		}
	}
}

func TestIsKnee(t *testing.T) {
	for _, c := range []struct {
		p95, errPct float64
		want        bool
	}{
		{1999, 0, false}, {2000, 2, false}, {2001, 0, true}, {10, 2.1, true},
	} {
		if got := isKnee(c.p95, c.errPct, 2*time.Second, 2); got != c.want {
			t.Errorf("p95 %v err %v → %v", c.p95, c.errPct, got)
		}
	}
}

func TestMasterVariantAndResolve(t *testing.T) {
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nhigh/index.m3u8\n"
	if v := masterVariant(master); v != "low/index.m3u8" {
		t.Fatal(v)
	}
	if v := masterVariant("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg_1.ts\n"); v != "" {
		t.Fatal("media playlist is not a master", v)
	}
	base, _ := url.Parse("https://h.example/hls/live/room/index.m3u8?t=1")
	for ref, want := range map[string]string{
		"seg_00001.ts":             "https://h.example/hls/live/room/seg_00001.ts",
		"/hls/live/room/x.ts":      "https://h.example/hls/live/room/x.ts",
		"https://cdn.example/a.ts": "https://cdn.example/a.ts",
		"seg.ts?tok=abc":           "https://h.example/hls/live/room/seg.ts?tok=abc",
	} {
		if got := resolveRef(base, ref); got != want {
			t.Errorf("%s → %s want %s", ref, got, want)
		}
	}
}

func TestParsePlaylist(t *testing.T) {
	segs, mseq, target := parsePlaylist("#EXTM3U\r\n#EXT-X-TARGETDURATION:4\r\n#EXT-X-MEDIA-SEQUENCE:17\r\n#EXTINF:4.000,\r\nseg_00017.ts\r\n#EXTINF:4.000,\r\nseg_00018.ts\r\n")
	if !reflect.DeepEqual(segs, []string{"seg_00017.ts", "seg_00018.ts"}) || mseq != 17 || target != 4 {
		t.Fatal(segs, mseq, target)
	}
}
