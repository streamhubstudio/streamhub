package pipeline

import (
	"strings"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

func TestEngineProGolden(t *testing.T) {
	cases := map[string]config.Channel{
		"x265-main10-hlg": ch(func(c *config.Channel) {
			c.Video.Codec, c.Video.Encoder, c.Video.BitDepth, c.Video.HDR = "h265", "x265", 10, "hlg"
		}),
		"x265-main422-10": ch(func(c *config.Channel) {
			c.Video.Codec, c.Video.Encoder, c.Video.BitDepth, c.Video.Chroma = "h265", "x265", 10, "422"
		}),
		"x265-pq-hdr10": ch(func(c *config.Channel) {
			c.Video.Codec, c.Video.Encoder, c.Video.BitDepth, c.Video.HDR, c.Video.MaxCLL = "h265", "x265", 10, "pq", "1000,400"
		}),
		"nvenc-main10-pq-2160p60": ch(func(c *config.Channel) {
			c.Video.Codec, c.Video.Encoder, c.Video.BitDepth, c.Video.HDR = "h265", "nvenc", 10, "pq"
			c.Video.Width, c.Video.Height, c.Video.FPS, c.Video.BitrateKbps = 3840, 2160, "60", 30000
		}),
		"x264-ladder-tracks-taps": ch(func(c *config.Channel) {
			c.Video.Renditions = []config.Rendition{{Width: 1280, Height: 720, BitrateKbps: 3000}, {Width: 854, Height: 480, BitrateKbps: 1200}}
			c.Audio.Lang = "spa"
			c.Audio.Tracks = []config.AudioTrack{{Lang: "eng"}, {Lang: "por", Codec: "ac3", Channels: 2, BitrateKbps: 192}}
		}),
		"decklink-16ch-tracks": ch(func(c *config.Channel) {
			c.Input = config.Input{Type: "decklink", Mode: "1080i50", AudioInputCh: 16}
			c.Video.FPS = "25"
			c.Audio = config.Audio{Channels: 2, Map: []int{0, 1}, Lang: "spa", Tracks: []config.AudioTrack{
				{Lang: "eng", Channels: 2, Map: []int{2, 3}}, {Lang: "qaa", Channels: 6, Map: []int{8, 9, 10, 11, 12, 13}, Codec: "ac3", BitrateKbps: 384}}}
		}),
		"x264-timecode-sei-logo-mp2": ch(func(c *config.Channel) {
			c.Video.TimecodeSEI = true
			c.Overlay.Logo, c.Overlay.LogoX, c.Overlay.LogoY, c.Overlay.LogoAlpha = "/var/lib/streamhub-encoder/logo.png", 40, 30, 0.8
			c.Audio.Codec, c.Audio.BitrateKbps = "mp2", 192
		}),
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			e, err := BuildEngineWith(c, Ports{Bus: 41000, Thumb: 41001, PCM: 41002}, AllCaps{})
			if err != nil {
				t.Fatal(err)
			}
			golden(t, "engine-"+name, e.Element+"\n"+e.Description)
		})
	}
}

func TestEngineProSemantics(t *testing.T) {
	c := ch(func(c *config.Channel) {
		c.Video.Codec, c.Video.Encoder, c.Video.BitDepth, c.Video.HDR = "h265", "nvenc", 10, "pq"
	})
	e, err := BuildEngineWith(c, Ports{Bus: 1}, AllCaps{})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"format=P010_10LE", "colorimetry=bt2100-pq", "mastering-display-info=(string)34000:16000:13250:34500:7500:3000:15635:16450:10000000:1", "content-light-level=(string)1000:400", "profile=main-10"} {
		if !strings.Contains(e.Description, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(e.Description, "jpegenc") || strings.Contains(e.Description, "audiobuffersplit") {
		t.Error("taps must be absent when their ports are 0")
	}
	// auto: 4:2:2 → x265, 10-bit skips QSV/VAAPI, timecode SEI → x264
	if b, _, _ := ResolveEncoder(config.Video{Codec: "h265", Encoder: "auto", BitDepth: 10, Chroma: "422"}, AllCaps{}); b != "x265" {
		t.Errorf("422 → %s", b)
	}
	if b, _, _ := ResolveEncoder(config.Video{Codec: "h265", Encoder: "auto", BitDepth: 10}, StaticCaps{"qsvh265enc": true, "x265enc": true}); b != "x265" {
		t.Errorf("10-bit → %s", b)
	}
	if b, _, _ := ResolveEncoder(config.Video{Codec: "h264", Encoder: "auto", TimecodeSEI: true}, AllCaps{}); b != "x264" {
		t.Errorf("tc SEI → %s", b)
	}
}

func TestOutputProGolden(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	ladder := ch(func(c *config.Channel) {
		c.Video.Renditions = []config.Rendition{{Width: 1280, Height: 720, BitrateKbps: 3000}, {Width: 854, Height: 480, BitrateKbps: 1200, Name: "sd"}}
		c.Video.LowLatency = true
	})
	cases := []struct {
		name string
		c    config.Channel
		o    config.Output
	}{
		{"rist-bonding", ladder, config.Output{ID: "a", Type: "rist", URL: "rist://198.51.100.7:8000", RIST: &config.RISTOptions{Bonding: []string{"203.0.113.9:8000"}, BufferMs: 1500}}},
		{"rist-simple", ladder, config.Output{ID: "a", Type: "rist", URL: "rist://198.51.100.7:8000"}},
		{"record-ring", ladder, config.Output{ID: "a", Type: "record", URL: "/var/lib/streamhub-encoder/rec"}},
		{"hls-ladder-cmaf", ladder, config.Output{ID: "a", Type: "hls", URL: "https://cdn/live/ch1/master.m3u8", HLS: &config.HLSOptions{Ladder: true, CMAF: true}}},
		{"rtmp-rendition-720", ladder, config.Output{ID: "a", Type: "rtmp", URL: "rtmp://yt/live2/k", Rendition: 1}},
		{"srt-rendition-480", ladder, config.Output{ID: "a", Type: "srt", URL: "srt://h:9000", Rendition: 2, SRT: &config.SRTOptions{Passphrase: "0123456789abcdef", PBKeyLen: 32, StreamID: "publish:x"}}},
		{"udp-rendition", ladder, config.Output{ID: "a", Type: "udp", URL: "udp://239.1.1.1:5000", Rendition: 1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := tc.o
			o.Enabled = true
			cc := tc.c
			cc.Outputs = []config.Output{o}
			cc.ApplyDefaults()
			if errs := cc.Validate(); len(errs) > 0 {
				t.Fatal(errs)
			}
			cmd, err := BuildOutput(cc, cc.Outputs[0], 41001, now)
			if err != nil {
				t.Fatal(err)
			}
			golden(t, "output-"+tc.name, cmd.Path+"\n"+strings.Join(cmd.Args, "\n"))
		})
	}
}

func TestProValidation(t *testing.T) {
	bad := map[string]func(c *config.Channel){
		"10bit h264": func(c *config.Channel) { c.Video.BitDepth = 10 },
		"422 nvenc": func(c *config.Channel) {
			c.Video.Codec, c.Video.Encoder, c.Video.BitDepth, c.Video.Chroma = "h265", "nvenc", 10, "422"
		},
		"hdr 8bit": func(c *config.Channel) { c.Video.Codec, c.Video.Encoder, c.Video.HDR = "h265", "x265", "hlg" },
		"bad master": func(c *config.Channel) {
			c.Video.Codec, c.Video.Encoder, c.Video.BitDepth, c.Video.HDR, c.Video.MasterDisplay = "h265", "x265", 10, "pq", "x"
		},
		"rendition bigger": func(c *config.Channel) {
			c.Video.Renditions = []config.Rendition{{Width: 3840, Height: 2160, BitrateKbps: 1000}}
		},
		"ac3 8ch":    func(c *config.Channel) { c.Audio.Codec, c.Audio.Channels, c.Audio.BitrateKbps = "ac3", 8, 448 },
		"track lang": func(c *config.Channel) { c.Audio.Tracks = []config.AudioTrack{{Lang: "english"}} },
		"rist odd port": func(c *config.Channel) {
			c.Outputs = []config.Output{{ID: "r", Type: "rist", Enabled: true, URL: "rist://h:8001"}}
		},
		"rendition on whip": func(c *config.Channel) {
			c.Video.Renditions = []config.Rendition{{Width: 640, Height: 360, BitrateKbps: 800}}
			c.Outputs = []config.Output{{ID: "w", Type: "whip", Enabled: true, URL: "https://x/w", Rendition: 1}}
		},
		"rtmp with mp2": func(c *config.Channel) {
			c.Audio.Codec, c.Audio.BitrateKbps = "mp2", 192
			c.Outputs = []config.Output{{ID: "r", Type: "rtmp", Enabled: true, URL: "rtmp://h/a/b"}}
		},
		"scte pid clash": func(c *config.Channel) { c.SCTE35 = &config.SCTE35Options{Enabled: true, PID: 256} },
		"ladder w/o renditions": func(c *config.Channel) {
			c.Outputs = []config.Output{{ID: "h", Type: "hls", Enabled: true, URL: "http://x/m.m3u8", HLS: &config.HLSOptions{Ladder: true}}}
		},
	}
	for name, mut := range bad {
		c := ch(nil)
		mut(&c)
		c.ApplyDefaults()
		if errs := c.Validate(); len(errs) == 0 {
			t.Errorf("%s: accepted", name)
		}
	}
}
