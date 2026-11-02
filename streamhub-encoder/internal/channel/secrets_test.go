package channel

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/notify"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/pipeline"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/supervisor"
)

var chanSecrets = []string{"inPassphrase-0001", "outPassphrase-0003", "rtmpPass-0004", "streamKey-0005",
	"whipUrlTok-0007", "hlsPass-0009", "sk_shToken-0010"}

func secretTestChannel() config.Channel {
	return config.Channel{ID: "ch1", Enabled: true,
		Input: config.Input{Type: "srt", URI: "srt://:9000?mode=listener&passphrase=inPassphrase-0001"},
		Video: config.Video{Codec: "h264", Encoder: "x264", Width: 1280, Height: 720, FPS: "30", BitrateKbps: 3000},
		Outputs: []config.Output{
			{ID: "srt", Type: "srt", Enabled: true, URL: "srt://10.0.0.1:9000", SRT: &config.SRTOptions{Passphrase: "outPassphrase-0003"}},
			{ID: "rtmp", Type: "rtmp", Enabled: true, URL: "rtmp://pub:rtmpPass-0004@live.example.com/app/streamKey-0005"},
			{ID: "whip", Type: "whip", Enabled: true, URL: "https://whip.example.com/whip/ep?token=whipUrlTok-0007"},
			{ID: "hls", Type: "hls", Enabled: true, URL: "https://hlsUser:hlsPass-0009@cdn.example.com/live/index.m3u8"},
		}}
}

func noSecret(t *testing.T, what string, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	for _, s := range chanSecrets {
		if strings.Contains(string(b), s) {
			t.Errorf("%s leaks %q:\n%s", what, s, b)
		}
	}
}

// The status (engine/output command lines, targets, errors) and the process
// logs exposed by the API never carry a passphrase, URL password or key —
// even when the child process prints them.
func TestStatusAndLogsHideSecrets(t *testing.T) {
	m, st, r, _ := setup(t)
	mustUpdate(t, st, func(c *config.Config) { c.Channels = append(c.Channels, secretTestChannel()) })
	m.SyncAll()
	eventually(t, "engine + outputs", func() bool {
		return r.isAlive("ch1/engine") && r.isAlive("ch1/srt") && r.isAlive("ch1/rtmp") && r.isAlive("ch1/whip") && r.isAlive("ch1/hls")
	})
	// the real argv still carries the secrets (the processes need them)
	if !strings.Contains(strings.Join(r.spec("ch1/srt").Args, " "), "outPassphrase-0003") {
		t.Fatal("srt output lost its passphrase")
	}
	cs, _ := m.ChannelStatusByID("ch1")
	if cs.Engine == nil || len(cs.Engine.Command) == 0 {
		t.Fatalf("no engine command in status: %+v", cs)
	}
	noSecret(t, "ChannelStatusByID", cs)
	noSecret(t, "Status", m.Status())
	for _, o := range cs.Outputs {
		if o.Process == nil || len(o.Process.Command) == 0 {
			t.Fatalf("output %s has no command in status", o.ID)
		}
	}

	// processes echo their URLs/properties in errors (gst, ffmpeg, libsrt)
	m.mu.Lock()
	rt := m.chans["ch1"]
	m.mu.Unlock()
	rt.mu.Lock()
	engine, srtProc, rtmpProc := rt.engine, rt.outs["srt"].proc, rt.outs["rtmp"].proc
	rt.mu.Unlock()
	engine.Logs().Add(`ERROR: from element /GstPipeline:pipeline0/GstURIDecodeBin: Could not open resource for reading: srt://:9000?mode=listener&passphrase=inPassphrase-0001`)
	srtProc.Logs().Add(`Setting pipeline to PLAYING ... srtsink passphrase="outPassphrase-0003" failed`)
	rtmpProc.Logs().Add(`ERROR: Could not connect to rtmp://pub:rtmpPass-0004@live.example.com/app/streamKey-0005`)
	for _, p := range []string{"engine", "srt", "rtmp", "whip", "hls"} {
		lines, ok := m.Logs("ch1", p)
		if !ok {
			t.Fatalf("no logs for %s", p)
		}
		noSecret(t, "Logs("+p+")", lines)
	}
}

type failingResolver struct{}

func (failingResolver) Resolve(ctx context.Context, ch config.Channel, o config.Output) (config.StreamHubOutput, config.Output, error) {
	return config.StreamHubOutput{}, config.Output{}, errors.New(`POST "https://sh.example.com/api/v1/apps/live/ingress?token=sk_shToken-0010": 401 unauthorized`)
}
func (failingResolver) Release(ctx context.Context, o config.Output) error { return nil }

// Alarm messages (GET /alarms, webhook JSON, SNMP varbinds) are built from the
// status: an output error that echoes a secret must reach them scrubbed.
func TestAlarmEventsHideSecrets(t *testing.T) {
	st, err := config.Open(filepath.Join(t.TempDir(), "c.json"))
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var evs []notify.Event
	m := New(Deps{Store: st, Caps: pipeline.StaticCaps{"x264enc": true}, Runner: newRunner(), Resolver: failingResolver{},
		Ports: NewPortPool(47000, 47999), Sup: supervisor.Options{MinBackoff: 10 * time.Millisecond, StopTimeout: 50 * time.Millisecond},
		StartGrace: 2 * time.Second, StallTimeout: time.Hour,
		Notify: func(e notify.Event) { mu.Lock(); evs = append(evs, e); mu.Unlock() }})
	t.Cleanup(m.Shutdown)
	c := testChannel()
	c.Outputs = []config.Output{{ID: "sh", Type: "streamhub", Enabled: true,
		StreamHub: &config.StreamHubOutput{BaseURL: "https://sh.example.com", App: "live", Token: "sk_shToken-0010"}}}
	mustUpdate(t, st, func(cfg *config.Config) { cfg.Channels = append(cfg.Channels, c) })
	m.SyncAll()
	eventually(t, "resolution error visible", func() bool {
		cs, _ := m.ChannelStatusByID("ch1")
		return len(cs.Outputs) == 1 && cs.Outputs[0].State == "error"
	})
	m.mu.Lock()
	rt := m.chans["ch1"]
	m.mu.Unlock()
	now := time.Now().Add(time.Minute) // past the start grace
	m.evaluateAlarms(rt, now)
	m.evaluateAlarms(rt, now.Add(11*time.Second))
	act, hist := m.Alarms()
	mu.Lock()
	defer mu.Unlock()
	if len(evs) == 0 || len(hist) == 0 {
		t.Fatalf("output_down not raised: events=%v history=%v", evs, hist)
	}
	noSecret(t, "alarm events", evs)
	noSecret(t, "alarms", [][]Alarm{act, hist})
	cs, _ := m.ChannelStatusByID("ch1")
	noSecret(t, "status", cs)
}
