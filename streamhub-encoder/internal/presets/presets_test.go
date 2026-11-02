package presets

import (
	"strings"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/pipeline"
)

func channelFor(codec string) config.Channel {
	c := config.Channel{ID: "ch1", Input: config.Input{Type: "test"}, Video: config.Video{Codec: codec, Width: 1920, Height: 1080, FPS: "30", BitrateKbps: 6000, LowLatency: true}}
	c.ApplyDefaults()
	return c
}

// Every profile is a valid channel encode and builds an engine.
func TestProfilesAreValid(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range Profiles {
		if seen[p.ID] {
			t.Fatalf("duplicate profile %s", p.ID)
		}
		seen[p.ID] = true
		c := channelFor("h264")
		c.Input.Interlaced = p.Video.Interlaced
		ApplyProfile(&c, p)
		c.ApplyDefaults()
		if errs := c.Validate(); len(errs) > 0 {
			t.Errorf("%s: %v", p.ID, errs)
			continue
		}
		if _, err := pipeline.BuildEngine(c, 1, pipeline.AllCaps{}); err != nil {
			t.Errorf("%s: %v", p.ID, err)
		}
	}
}

// Every destination instantiates into a valid output with sample params and
// builds a process (streamhub ones validate only: they resolve at runtime).
func TestDestinationsInstantiate(t *testing.T) {
	sample := map[string]string{"host": "203.0.113.10", "stream": "cam1", "key": "abcd-1234", "path": "live/cam1", "url": "", "group": "239.5.5.5",
		"baseUrl": "https://streamhub.example.com", "app": "live", "token": "sk_test", "passphrase": "0123456789ab"}
	seen := map[string]bool{}
	for _, d := range Destinations {
		if seen[d.ID] {
			t.Fatalf("duplicate destination %s", d.ID)
		}
		seen[d.ID] = true
		params := map[string]string{}
		for k, v := range sample {
			params[k] = v
		}
		switch d.Type {
		case "rtmp":
			params["url"] = "rtmps://ingest.example.com:443/app/key"
		case "whip":
			params["url"] = "https://sfu.example.com/whip/ep"
		case "hls":
			params["url"] = "https://cdn.example.com/ch1/index.m3u8"
		}
		o, err := Instantiate(d, params, "o1")
		if err != nil {
			t.Errorf("%s: %v", d.ID, err)
			continue
		}
		codec := d.Codecs[0]
		c := channelFor(codec)
		o.ApplyDefaults(c.ID)
		if errs := o.Validate(&c); len(errs) > 0 {
			t.Errorf("%s → %+v: %v", d.ID, o, errs)
			continue
		}
		if w := Check(d, c); len(w) > 0 {
			t.Errorf("%s: unexpected warnings %v", d.ID, w)
		}
		if o.Type == "streamhub" {
			continue
		}
		if _, err := pipeline.BuildOutput(c, o, 1, time.Now()); err != nil {
			t.Errorf("%s: %v", d.ID, err)
		}
	}
}

func TestInstantiateRendersTemplates(t *testing.T) {
	d, _ := FindDestination("mediamtx-srt")
	o, err := Instantiate(d, map[string]string{"host": "mtx", "path": "cam/1"}, "x")
	if err != nil {
		t.Fatal(err)
	}
	if o.URL != "srt://mtx:8890" || o.SRT.StreamID != "publish:cam/1" || o.SRT.Passphrase != "" {
		t.Fatalf("%+v %+v", o, o.SRT)
	}
	if _, err := Instantiate(d, map[string]string{"path": "x"}, "x"); err == nil {
		t.Fatal("missing required host accepted")
	}
	if _, err := Instantiate(d, map[string]string{"host": `m" ! x`}, "x"); err == nil {
		t.Fatal("unsafe param accepted")
	}
	d, _ = FindDestination("nginx-rtmp")
	if w := Check(d, channelFor("h265")); len(w) == 0 || !strings.Contains(w[0], "h265") {
		t.Fatalf("nginx-rtmp must warn on HEVC: %v", w)
	}
}

func TestApplyProfileKeepsBackendAndMapping(t *testing.T) {
	c := channelFor("h264")
	c.Video.Encoder, c.Video.GPU = "nvenc", 1
	p, _ := FindProfile("hevc-1080p50-8m")
	ApplyProfile(&c, p)
	if c.Video.Encoder != "nvenc" || c.Video.GPU != 1 || c.Video.Codec != "h265" {
		t.Fatalf("%+v", c.Video)
	}
	c.Video.Encoder = "x264"
	ApplyProfile(&c, p) // x264 cannot do h265 → profile's auto wins
	if c.Video.Encoder != "auto" {
		t.Fatalf("x264 kept for HEVC: %+v", c.Video)
	}
}
