package camgw

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testCam() *Camera {
	c := &Camera{RTSP: "rtsp://u:p@10.0.0.5/ch0", RTSPSub: "rtsp://u:p@10.0.0.5/ch1", SegmentMin: 30}
	c.Device.ID = "tvabc"
	c.Stream.Enabled, c.Stream.URL, c.Stream.Key, c.Stream.Source = "true", "rtmp://media/live/", "KEY", "1"
	c.MQTT.BaseTopic = "tv/123/%device"
	return c
}

func TestTopicAndPushURL(t *testing.T) {
	c := testCam()
	if got := c.TopicBase(); got != "tv/123/tvabc" {
		t.Fatalf("topic base = %q", got)
	}
	if got := c.PushURL(); got != "rtmp://media/live/KEY" {
		t.Fatalf("push url = %q", got)
	}
}

func TestPipelineArgs(t *testing.T) {
	c := testCam()
	p := NewPipeline("ffmpeg", c, "/data", t.Logf, func(string, string, string) {})
	p.resolve = func(u string) string { return u } // no DNS in unit tests
	p.probe = func(string) string { return "aac" } // no RTSP in unit tests
	join := func(w Want) string { return strings.Join(p.args(w), " ") }

	if p.args(Want{}) != nil {
		t.Fatal("no outputs must mean no ffmpeg")
	}
	s := join(Want{Stream: true, Source: 1})
	if !strings.Contains(s, "-i rtsp://u:p@10.0.0.5/ch1") || !strings.HasSuffix(s, "-f flv rtmp://media/live/KEY") {
		t.Fatalf("stream-only args: %s", s)
	}
	if !strings.Contains(s, "-c:v copy") {
		t.Fatalf("video must be stream-copied: %s", s)
	}
	b := join(Want{Stream: true, Record: true, Source: 0})
	if !strings.Contains(b, "-i rtsp://u:p@10.0.0.5/ch0") || !strings.Contains(b, "-f tee [f=flv:onfail=ignore]rtmp://media/live/KEY|[f=segment:segment_time=1800") {
		t.Fatalf("tee args: %s", b)
	}
	if !strings.Contains(b, filepath.Join("/data", "tvabc", "%Y-%m-%d_%H-%M-%S.mp4")) {
		t.Fatalf("segment path: %s", b)
	}
	c.RTSPSub = ""
	if w := p.Set(func(w *Want) { w.Source = 1 }); w.Source != 0 {
		t.Fatal("no sub stream: source must stay 0")
	}
}

func TestRedactURL(t *testing.T) {
	in := "rtsp://thingino:s3cret@10.0.0.5:554/ch0: 401 and rtmp://h:1935/live/STREAMKEY failed"
	out := redactURL(in)
	if strings.Contains(out, "s3cret") || strings.Contains(out, "STREAMKEY") {
		t.Fatalf("leaked: %s", out)
	}
	if !strings.Contains(out, "rtsp://***@10.0.0.5:554/ch0") || !strings.Contains(out, "rtmp://h:1935/live/***") {
		t.Fatalf("over-redacted: %s", out)
	}
}

func TestLoadCredentialsFile(t *testing.T) {
	dir := t.TempDir()
	cred := `{"device":{"id":"tvxyz","name":"Front"},"stream":{"enabled":"true","url":"rtmp://a/live","key":"k","source":"1"},
	 "mqtt":{"enabled":"true","host":"mqtt.example","port":"8883","tls":"true","username":"cam-tvxyz","password":"pw","base_topic":"tv/1/%device"},
	 "upload.webhook":{"url":"https://cloud/api/devices/tvxyz/snapshot","token":"t"}}`
	_ = os.WriteFile(filepath.Join(dir, "front.json"), []byte(cred), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "agent.json"), []byte(`{"id":"gw","data_dir":"/rec","cameras":[{"rtsp":"rtsp://x/1","record":true,"credentials":"front.json"}]}`), 0o600)
	c, err := Load(filepath.Join(dir, "agent.json"))
	if err != nil {
		t.Fatal(err)
	}
	cam := c.Cameras[0]
	if cam.Device.ID != "tvxyz" || cam.Name != "Front" || cam.MQTT.Username != "cam-tvxyz" || cam.Webhook.Token != "t" || cam.SegmentMin != 30 {
		t.Fatalf("credentials not merged: %+v", cam)
	}
	if c.DiskHighPct != 90 || c.DiskLowPct != 85 || c.StateInterval != 30 {
		t.Fatalf("defaults: %+v", c)
	}
	_ = os.WriteFile(filepath.Join(dir, "bad.json"), []byte(`{"cameras":[{"rtsp":"rtsp://x","device":{"id":"a"}},{"rtsp":"rtsp://y","device":{"id":"a"}}]}`), 0o600)
	if _, err := Load(filepath.Join(dir, "bad.json")); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate device must fail: %v", err)
	}
}

func TestExpired(t *testing.T) {
	if expired(map[string]any{"exp": 30.0, "ts": "2020-01-01T00:00:00Z"}) != true {
		t.Fatal("old command must be expired")
	}
	if expired(map[string]any{"exp": 0.0, "ts": "2020-01-01T00:00:00Z"}) {
		t.Fatal("no exp: never expired")
	}
}

func TestResolveURLHostKeepsIPsAndCredentials(t *testing.T) {
	for _, u := range []string{"rtsp://u:p@10.0.0.5:554/ch0", "rtmp://203.0.113.7:1935/live/k", "not a url"} {
		if got := resolveURLHost(u); got != u {
			t.Fatalf("%q changed to %q", u, got)
		}
	}
}

func TestConfigImportPersistsWebhookAndChecksRev(t *testing.T) {
	dir := t.TempDir()
	cam := testCam()
	cfg := &Config{Dir: dir, FFmpeg: "ffmpeg", StateInterval: 30, Cameras: []Camera{*cam}}
	d := NewDevice(cfg, &cfg.Cameras[0], t.Logf)
	rev, err := d.applyConfig(map[string]any{"upload": map[string]any{"webhook": map[string]any{"url": "https://c/x", "token": "T2"}}}, nil)
	if err != nil || rev != 2 || d.cam.Webhook.Token != "T2" {
		t.Fatalf("import: rev=%d err=%v token=%q", rev, err, d.cam.Webhook.Token)
	}
	if _, err := d.applyConfig(map[string]any{"a": 1.0}, 1.0); !errors.Is(err, errConflict) {
		t.Fatalf("stale if_rev must conflict: %v", err)
	}
	// A restarted gateway keeps the rotated token and the revision.
	cfg2 := &Config{Dir: dir, FFmpeg: "ffmpeg", StateInterval: 30, Cameras: []Camera{*testCam()}}
	d2 := NewDevice(cfg2, &cfg2.Cameras[0], t.Logf)
	if d2.cam.Webhook.Token != "T2" || d2.configRev != 2 {
		t.Fatalf("overlay not reloaded: token=%q rev=%d", d2.cam.Webhook.Token, d2.configRev)
	}
	if got := d2.config()["upload"].(map[string]any)["webhook"].(map[string]any)["token"]; got != "********" {
		t.Fatalf("config/get leaks the token: %v", got)
	}
}

func TestAudioArgs(t *testing.T) {
	c := testCam()
	p := NewPipeline("ffmpeg", c, "", t.Logf, func(string, string, string) {})
	codec := "aac"
	p.probe = func(string) string { return codec }
	if got := strings.Join(p.audioArgs("a"), " "); got != "-map 0:a:0? -c:a copy" {
		t.Fatalf("aac source must be copied: %s", got)
	}
	codec = "pcm_alaw"
	if got := strings.Join(p.audioArgs("b"), " "); !strings.Contains(got, "-c:a aac") {
		t.Fatalf("G.711 must be re-encoded: %s", got)
	}
	codec = "none"
	if got := strings.Join(p.audioArgs("c"), " "); got != "-an" {
		t.Fatalf("no audio track: %s", got)
	}
	codec = "pcm_alaw" // cached per source: "a" stays a copy
	if got := strings.Join(p.audioArgs("a"), " "); got != "-map 0:a:0? -c:a copy" {
		t.Fatalf("probe result must be cached: %s", got)
	}
	c.Audio = "off"
	if got := strings.Join(p.audioArgs("a"), " "); got != "-an" {
		t.Fatalf("audio off: %s", got)
	}
}
