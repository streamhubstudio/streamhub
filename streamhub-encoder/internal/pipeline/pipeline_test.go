package pipeline

import (
	"flag"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

var update = flag.Bool("update", false, "rewrite golden files")

func ch(mut func(c *config.Channel)) config.Channel {
	c := config.Channel{ID: "ch1", Enabled: true, Input: config.Input{Type: "test"},
		Video: config.Video{Codec: "h264", Encoder: "x264", Width: 1920, Height: 1080, FPS: "30", BitrateKbps: 6000}}
	if mut != nil {
		mut(&c)
	}
	c.ApplyDefaults()
	return c
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	p := filepath.Join("testdata", "golden", name+".txt")
	if *update {
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(got+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("missing golden %s (run go test -update): %v", p, err)
	}
	if strings.TrimRight(string(want), "\n") != got {
		t.Errorf("%s mismatch\n--- want\n%s\n--- got\n%s", name, want, got)
	}
}

// One golden per encoder backend, input type, rate control and special mode.
func TestEngineGolden(t *testing.T) {
	cases := map[string]config.Channel{
		"x264-test-1080p30-cbr": ch(func(c *config.Channel) { c.Overlay = config.Overlay{Timecode: true, Clock: true, Text: "CAM 1"} }),
		"x264-vbr-bframes":      ch(func(c *config.Channel) { c.Video.RateControl = "vbr"; c.Video.MaxKbps = 9000; c.Video.BFrames = 2 }),
		"x264-lowlatency-baseline": ch(func(c *config.Channel) {
			c.Video.LowLatency = true
			c.Video.Profile = "baseline"
		}),
		"x264-1080i50-interlaced": ch(func(c *config.Channel) {
			c.Input.Interlaced = true
			c.Video.FPS, c.Video.Interlaced = "25", true
		}),
		"x264-test-interlaced-deinterlace": ch(func(c *config.Channel) {
			c.Input.Interlaced = true
			c.Video.FPS = "25"
		}),
		"x265-srt-input-backup": ch(func(c *config.Channel) {
			c.Input = config.Input{Type: "srt", URI: "srt://:9000?mode=listener"}
			c.Backup = &config.Input{Type: "udp", URI: "udp://@239.1.1.1:5000"}
			c.Video.Codec, c.Video.Encoder, c.Video.BFrames = "h265", "x265", 3
		}),
		"x265-lowlatency-file-loop": ch(func(c *config.Channel) {
			c.Input = config.Input{Type: "file", URI: "/media/clip.mp4", Loop: true}
			c.Video.Codec, c.Video.Encoder, c.Video.LowLatency = "h265", "x265", true
			c.Video.Width, c.Video.Height = 1280, 720
		}),
		"nvenc-h264-rtsp": ch(func(c *config.Channel) {
			c.Input = config.Input{Type: "rtsp", URI: "rtsp://cam.local:554/stream1"}
			c.Video.Encoder = "nvenc"
			c.Video.GPU = 1
		}),
		"nvenc-h265-2160p-vbr-mux-cbr": ch(func(c *config.Channel) {
			c.Video.Codec, c.Video.Encoder, c.Video.Width, c.Video.Height = "h265", "nvenc", 3840, 2160
			c.Video.RateControl, c.Video.BitrateKbps, c.Video.MaxKbps = "vbr", 15000, 20000
			c.Mux.MuxRateKbps = 25000
		}),
		"qsv-h265":       ch(func(c *config.Channel) { c.Video.Codec, c.Video.Encoder, c.Video.Preset = "h265", "qsv", "fast" }),
		"vaapi-h264-vbr": ch(func(c *config.Channel) { c.Video.Encoder, c.Video.RateControl = "vaapi", "vbr" }),
		"decklink-8ch-map": ch(func(c *config.Channel) {
			c.Input = config.Input{Type: "decklink", Device: 1, Connection: "sdi", Mode: "1080i50", AudioInputCh: 8}
			c.Video.FPS = "25"
			c.Audio = config.Audio{Channels: 2, Map: []int{2, 3}, GainDb: -6}
		}),
		"decklink-71-audio": ch(func(c *config.Channel) {
			c.Input = config.Input{Type: "decklink", Mode: "auto", AudioInputCh: 8}
			c.Audio = config.Audio{Channels: 8, BitrateKbps: 384}
		}),
		"v4l2-mjpeg-alsa": ch(func(c *config.Channel) {
			c.Input = config.Input{Type: "v4l2", DevicePath: "/dev/video2", Format: "mjpeg", AudioDevice: "hw:1,0"}
			c.Video.Width, c.Video.Height = 1280, 720
		}),
		"v4l2-raw-noaudio": ch(func(c *config.Channel) {
			c.Input = config.Input{Type: "v4l2"}
			c.Audio.Disabled = true
		}),
		"rtmp-input-audio-off": ch(func(c *config.Channel) {
			c.Input = config.Input{Type: "rtmp", URI: "rtmp://origin/live/cam"}
			c.Audio.Disabled = true
		}),
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			e, err := BuildEngine(c, 41000, AllCaps{})
			if err != nil {
				t.Fatal(err)
			}
			got := e.Element + "\n" + e.Description
			if len(e.Feeder) > 0 {
				got += "\nFEEDER ffmpeg " + strings.Join(e.Feeder, " ")
			}
			golden(t, "engine-"+name, got)
		})
	}
}

// A looping file is fed by ffmpeg -stream_loop through stdin (continuous
// timestamps), never by fallbacksrc restart-on-eos (+2 s PTS jump per loop).
func TestFileLoopUsesFeeder(t *testing.T) {
	ch := config.Channel{ID: "f", Input: config.Input{Type: config.InFile, URI: "file:///media/my clip.mp4", Loop: true},
		Video: config.Video{Codec: "h264", Encoder: "x264", Width: 1280, Height: 720, FPS: "25", BitrateKbps: 2000}}
	ch.ApplyDefaults()
	e, err := BuildEngine(ch, 41000, AllCaps{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(e.Description, `uri="fd://0"`) || strings.Contains(e.Description, "restart-on-eos") {
		t.Fatalf("loop file must read fd://0 without restart-on-eos: %s", e.Description)
	}
	if !slices.Contains(e.Feeder, "-stream_loop") || !slices.Contains(e.Feeder, "/media/my clip.mp4") {
		t.Fatalf("feeder: %v", e.Feeder)
	}
	path, args := e.Command("/usr/bin/gst-launch-1.0", "/usr/bin/ffmpeg")
	if path != "/bin/sh" || len(args) != 2 || args[0] != "-c" {
		t.Fatalf("command: %s %v", path, args)
	}
	if !strings.HasPrefix(args[1], "'/usr/bin/ffmpeg' '-nostdin'") || !strings.Contains(args[1], `'/media/my clip.mp4'`) ||
		!strings.Contains(args[1], " | exec '/usr/bin/gst-launch-1.0' '-e' ") {
		t.Fatalf("shell line: %s", args[1])
	}
	// non-looping file and live inputs run gst-launch directly
	ch.Input.Loop = false
	e, _ = BuildEngine(ch, 41000, AllCaps{})
	if p, _ := e.Command("gst-launch-1.0", "ffmpeg"); p != "gst-launch-1.0" || e.Feeder != nil {
		t.Fatalf("non-loop file: %s %v", p, e.Feeder)
	}
}

func TestOutputGolden(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	h264 := ch(nil)
	h265 := ch(func(c *config.Channel) { c.Video.Codec, c.Video.Encoder = "h265", "x265" })
	noAudio := ch(func(c *config.Channel) { c.Audio.Disabled = true; c.Video.LowLatency = true })
	cases := []struct {
		name string
		c    config.Channel
		o    config.Output
	}{
		{"srt-caller-pass-sid", h264, config.Output{ID: "a", Type: "srt", URL: "srt://203.0.113.5:9000", SRT: &config.SRTOptions{LatencyMs: 800, Passphrase: "0123456789abcdef", StreamID: "#!::r=live/cam1,m=publish"}}},
		{"srt-listener", h264, config.Output{ID: "a", Type: "srt", URL: "srt://:9001"}},
		{"udp-multicast-iface", h264, config.Output{ID: "a", Type: "udp", URL: "udp://239.1.1.1:5000", UDP: &config.UDPOptions{TTL: 8, Iface: "eth1"}}},
		{"udp-unicast", h264, config.Output{ID: "a", Type: "udp", URL: "udp://10.0.0.9:5000"}},
		{"rtp", h264, config.Output{ID: "a", Type: "rtp", URL: "rtp://239.2.2.2:5004"}},
		{"rtmp-h264", h264, config.Output{ID: "a", Type: "rtmp", URL: "rtmp://live.twitch.tv/app/live_123"}},
		{"rtmps-h265-enhanced", h265, config.Output{ID: "a", Type: "rtmp", URL: "rtmps://a.rtmps.youtube.com:443/live2/key"}},
		{"rtmp-noaudio", noAudio, config.Output{ID: "a", Type: "rtmp", URL: "rtmp://h/app/s"}},
		{"whip", noAudio, config.Output{ID: "a", Type: "whip", URL: "https://sfu/w", WHIP: &config.WHIPOptions{BearerToken: "tok"}}},
		{"hls-h264", h264, config.Output{ID: "a", Type: "hls", URL: "https://cdn.example.com/ingest/ch1/index.m3u8"}},
		{"hls-h265-fmp4", h265, config.Output{ID: "a", Type: "hls", URL: "http://cdn/x/index.m3u8"}},
		{"file", h264, config.Output{ID: "a", Type: "file", URL: "/var/lib/streamhub-encoder/rec/ch1-{ts}.ts"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := tc.o
			o.Enabled = true
			o.ApplyDefaults(tc.c.ID)
			cmd, err := BuildOutput(tc.c, o, 41001, now)
			if err != nil {
				t.Fatal(err)
			}
			golden(t, "output-"+tc.name, cmd.Path+"\n"+strings.Join(cmd.Args, "\n")+"\nENV "+strings.Join(cmd.Env, " "))
		})
	}
	golden(t, "whip-helper", WHIPHelper(41001, 50000, 50001, true))
}

func TestResolveEncoderAuto(t *testing.T) {
	v := config.Video{Codec: "h265", Encoder: "auto"}
	if b, e, _ := ResolveEncoder(v, StaticCaps{"x265enc": true, "nvh265enc": true}); b != "nvenc" || e != "nvh265enc" {
		t.Fatalf("auto should prefer NVENC, got %s/%s", b, e)
	}
	if b, _, _ := ResolveEncoder(v, StaticCaps{"x265enc": true, "vah265enc": true}); b != "vaapi" {
		t.Fatalf("auto should prefer VAAPI over x265, got %s", b)
	}
	if b, _, _ := ResolveEncoder(v, StaticCaps{"x265enc": true}); b != "x265" {
		t.Fatalf("auto fallback x265, got %s", b)
	}
	if _, _, err := ResolveEncoder(v, StaticCaps{}); err == nil {
		t.Fatal("no encoder must fail")
	}
	vi := config.Video{Codec: "h264", Encoder: "auto", Interlaced: true}
	if b, _, _ := ResolveEncoder(vi, StaticCaps{"x264enc": true, "nvh264enc": true}); b != "x264" {
		t.Fatalf("interlaced must pick x264, got %s", b)
	}
	if _, _, err := ResolveEncoder(config.Video{Codec: "h264", Encoder: "nvenc"}, StaticCaps{"x264enc": true}); err == nil || !strings.Contains(err.Error(), "nvh264enc") {
		t.Fatalf("explicit missing HW encoder must fail clearly: %v", err)
	}
}

func TestLaunchArgsKeepsQuotedValues(t *testing.T) {
	got := LaunchArgs(`a  b="x y ! z" ! c`)
	want := []string{"-e", "a", `b="x y ! z"`, "!", "c"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q want %q", got, want)
	}
}

// User strings can never inject pipeline elements.
func TestInjectionRejected(t *testing.T) {
	c := ch(func(c *config.Channel) { c.Overlay.Text = `x" ! filesink location=/etc/passwd` })
	if _, err := BuildEngine(c, 1, AllCaps{}); err == nil {
		t.Fatal("quote in overlay text must be rejected")
	}
	c = ch(func(c *config.Channel) { c.Input = config.Input{Type: "srt", URI: `srt://h:1" ! fakesink`} })
	if _, err := BuildEngine(c, 1, AllCaps{}); err == nil {
		t.Fatal("quote in URI must be rejected")
	}
	o := config.Output{ID: "a", Type: "srt", Enabled: true, URL: "srt://h:9000", SRT: &config.SRTOptions{StreamID: `a" ! x`}}
	o.ApplyDefaults("ch1")
	if _, err := BuildOutput(ch(nil), o, 1, time.Now()); err == nil {
		t.Fatal("quote in streamid must be rejected")
	}
}

func TestStreamHubOutputNeedsResolution(t *testing.T) {
	o := config.Output{ID: "sh", Type: "streamhub", Enabled: true, StreamHub: &config.StreamHubOutput{BaseURL: "https://sh", App: "live", Token: "sk_x"}}
	o.ApplyDefaults("ch1")
	if _, err := BuildOutput(ch(nil), o, 1, time.Now()); err == nil {
		t.Fatal("streamhub outputs must be resolved before building")
	}
}
