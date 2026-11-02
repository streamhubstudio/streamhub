package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func base() Channel {
	c := Channel{ID: "ch1", Enabled: true, Input: Input{Type: InTest}, Video: Video{Codec: "h264", Width: 1280, Height: 720, FPS: "30", BitrateKbps: 3000}}
	c.ApplyDefaults()
	return c
}

func TestDefaults(t *testing.T) {
	c := Channel{ID: "x", Input: Input{Type: InFile, URI: "/media/a.mp4"}, Outputs: []Output{{ID: "s", Type: OutSRT, URL: "srt://:9000"}, {ID: "h", Type: OutStreamHub, StreamHub: &StreamHubOutput{BaseURL: "https://sh/"}}}}
	c.ApplyDefaults()
	if c.Video.Codec != "h264" || c.Video.Width != 1920 || c.Video.FPS != "30" || c.Video.GOP != 60 || c.Video.Profile != "high" {
		t.Fatalf("video defaults: %+v", c.Video)
	}
	if c.Input.URI != "file:///media/a.mp4" || c.Input.TimeoutMs != 2000 {
		t.Fatalf("input defaults: %+v", c.Input)
	}
	if c.Audio.Channels != 2 || c.Audio.BitrateKbps != 128 || c.Audio.SampleRate != 48000 {
		t.Fatalf("audio defaults: %+v", c.Audio)
	}
	if c.Mux.VideoPID != 256 || c.Mux.AudioPID != 257 || c.Mux.PCRIntervalMs != 20 {
		t.Fatalf("mux defaults: %+v", c.Mux)
	}
	if c.Outputs[0].SRT.Mode != "listener" || c.Outputs[0].SRT.LatencyMs != 200 {
		t.Fatalf("srt defaults: %+v", c.Outputs[0].SRT)
	}
	if sh := c.Outputs[1].StreamHub; sh.Protocol != "rtmp" || sh.Room != "x" || sh.BaseURL != "https://sh" {
		t.Fatalf("streamhub defaults: %+v", sh)
	}
	// idempotent
	b1, _ := json.Marshal(c)
	c.ApplyDefaults()
	b2, _ := json.Marshal(c)
	if string(b1) != string(b2) {
		t.Fatal("ApplyDefaults is not idempotent")
	}
}

func TestParseFPS(t *testing.T) {
	for in, want := range map[string][2]int{"25": {25, 1}, "29.97": {30000, 1001}, "60000/1001": {60000, 1001}, "50/1": {50, 1}, "23.976": {24000, 1001}} {
		n, d, err := ParseFPS(in)
		if err != nil || n != want[0] || d != want[1] {
			t.Errorf("%s → %d/%d %v", in, n, d, err)
		}
	}
	for _, bad := range []string{"", "0", "15", "120", "abc", "30/0"} {
		if _, _, err := ParseFPS(bad); err == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
}

func TestValidate(t *testing.T) {
	cases := []struct {
		name  string
		mut   func(c *Channel)
		field string // expected failing field ("" = valid)
	}{
		{"ok", func(c *Channel) {}, ""},
		{"bad id", func(c *Channel) { c.ID = "Ch 1" }, "id"},
		{"x265 for h264", func(c *Channel) { c.Video.Encoder = "x265" }, "video.encoder"},
		{"odd width", func(c *Channel) { c.Video.Width = 1281 }, "video.width"},
		{"bitrate", func(c *Channel) { c.Video.BitrateKbps = 50 }, "video.bitrateKbps"},
		{"fps", func(c *Channel) { c.Video.FPS = "12" }, "video.fps"},
		{"baseline bframes", func(c *Channel) { c.Video.Profile = "baseline"; c.Video.BFrames = 2 }, "video.bframes"},
		{"lowlatency forces bframes 0", func(c *Channel) { c.Video.LowLatency = true; c.Video.BFrames = 2 }, ""},
		{"interlaced hevc", func(c *Channel) { c.Video.Codec = "h265"; c.Video.Profile = "main"; c.Video.Interlaced = true }, "video.interlaced"},
		{"audio ch 3", func(c *Channel) { c.Audio.Channels = 3 }, "audio.channels"},
		{"map non decklink", func(c *Channel) { c.Audio.Map = []int{0, 1} }, "audio.map"},
		{"decklink map ok", func(c *Channel) {
			c.Input = Input{Type: InDeckLink, Mode: "1080i50", Connection: "sdi", AudioInputCh: 8, TimeoutMs: 2000}
			c.Audio.Map = []int{6, 7}
		}, ""},
		{"decklink map out of range", func(c *Channel) {
			c.Input = Input{Type: InDeckLink, Mode: "auto", Connection: "auto", AudioInputCh: 2, TimeoutMs: 2000}
			c.Audio.Map = []int{0, 5}
		}, "audio.map[1]"},
		{"overlay quote", func(c *Channel) { c.Overlay.Text = `a"b` }, "overlay.text"},
		{"backup with device", func(c *Channel) { c.Backup = &Input{Type: InUDP, URI: "udp://239.0.0.1:5000", TimeoutMs: 2000} }, "backup"},
		{"srt uri no port", func(c *Channel) { c.Input = Input{Type: InSRT, URI: "srt://host", TimeoutMs: 2000} }, "input.uri"},
		{"file traversal", func(c *Channel) { c.Input = Input{Type: InFile, URI: "file:///media/../etc/x", TimeoutMs: 2000} }, "input.uri"},
		{"mux rate too low", func(c *Channel) { c.Mux.MuxRateKbps = 2000 }, "mux.muxRateKbps"},
		{"pid clash", func(c *Channel) { c.Mux.AudioPID = 256 }, "mux.audioPid"},
		{"srt passphrase short", func(c *Channel) {
			c.Outputs = []Output{{ID: "s", Type: OutSRT, URL: "srt://h:1", SRT: &SRTOptions{Mode: "caller", LatencyMs: 200, Passphrase: "short", PBKeyLen: 16}}}
		}, "outputs[0].srt.passphrase"},
		{"caller without host", func(c *Channel) {
			c.Outputs = []Output{{ID: "s", Type: OutSRT, URL: "srt://:9000", SRT: &SRTOptions{Mode: "caller", LatencyMs: 200}}}
		}, "outputs[0].url"},
		{"whip with bframes", func(c *Channel) {
			c.Video.BFrames = 2
			c.Outputs = []Output{{ID: "w", Type: OutWHIP, URL: "https://x/whip"}}
		}, "outputs[0].type"},
		{"hls not m3u8", func(c *Channel) {
			c.Outputs = []Output{{ID: "h", Type: OutHLS, URL: "http://x/a.ts", HLS: &HLSOptions{SegmentSeconds: 2, ListSize: 6}}}
		}, "outputs[0].url"},
		{"duplicate output", func(c *Channel) {
			c.Outputs = []Output{{ID: "u", Type: OutUDP, URL: "udp://239.1.1.1:5000"}, {ID: "u", Type: OutUDP, URL: "udp://239.1.1.1:5002"}}
		}, "outputs[1].id"},
		{"streamhub hevc", func(c *Channel) {
			c.Video.Codec, c.Video.Profile = "h265", "main"
			c.Outputs = []Output{{ID: "sh", Type: OutStreamHub, StreamHub: &StreamHubOutput{BaseURL: "https://sh", App: "live", Token: "sk_1", Room: "r", Protocol: "rtmp"}}}
		}, "outputs[0].type"},
		{"streamhub no token", func(c *Channel) {
			c.Outputs = []Output{{ID: "sh", Type: OutStreamHub, StreamHub: &StreamHubOutput{BaseURL: "https://sh", App: "live", Room: "r", Protocol: "rtmp"}}}
		}, "outputs[0].streamhub.token"},
		{"file output", func(c *Channel) { c.Outputs = []Output{{ID: "f", Type: OutFile, URL: "/rec/a.ts"}} }, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := base()
			tc.mut(&c)
			c.ApplyDefaults()
			errs := c.Validate()
			if tc.field == "" {
				if len(errs) != 0 {
					t.Fatalf("unexpected errors: %v", errs)
				}
				return
			}
			for _, e := range errs {
				if e.Field == tc.field {
					return
				}
			}
			t.Fatalf("expected error on %s, got %v", tc.field, errs)
		})
	}
}

func TestStorePersistsAtomicallyAndValidates(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "encoderd.json")
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	id := s.Get().Device.ID
	if !strings.HasPrefix(id, "enc-") {
		t.Fatalf("device id %q", id)
	}
	if _, err := s.Update(func(c *Config) error { c.Channels = append(c.Channels, base()); return nil }); err != nil {
		t.Fatal(err)
	}
	// invalid update is rejected and leaves the stored config intact
	_, err = s.Update(func(c *Config) error { c.Channels[0].Video.Width = 3; return nil })
	if err == nil {
		t.Fatal("invalid update accepted")
	}
	if s.Get().Channels[0].Video.Width != 1280 {
		t.Fatal("invalid update leaked into the store")
	}
	s2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := s2.Get(); got.Device.ID != id || len(got.Channels) != 1 {
		t.Fatalf("reopen: %+v", got)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("config must be 0600 (holds secrets), got %v", fi.Mode().Perm())
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".encoderd-") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

func TestRedactAndKeepSecrets(t *testing.T) {
	c := base()
	c.Outputs = []Output{{ID: "sh", Type: OutStreamHub, Enabled: true, StreamHub: &StreamHubOutput{BaseURL: "https://sh", App: "a", Token: "sk_secret", Room: "r", Protocol: "rtmp"}}}
	cfg := Config{Channels: []Channel{c}, StreamHub: StreamHub{Credential: "dk_x"}}
	r := Redact(cfg)
	if r.Channels[0].Outputs[0].StreamHub.Token != Redacted || r.StreamHub.Credential != Redacted {
		t.Fatal("secrets not redacted")
	}
	if cfg.Channels[0].Outputs[0].StreamHub.Token != "sk_secret" {
		t.Fatal("Redact mutated its input")
	}
	next := r.Channels[0]
	KeepSecrets(&c, &next)
	if next.Outputs[0].StreamHub.Token != "sk_secret" {
		t.Fatal("KeepSecrets did not restore the token")
	}
}
