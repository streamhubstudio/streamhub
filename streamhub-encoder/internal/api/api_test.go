package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/caps"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/channel"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/scte35"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/streamhub"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/tsbus"
)

type mgr struct {
	mu    sync.Mutex
	st    *config.Store
	syncs []string
}

func (m *mgr) Sync(id string)                    { m.mu.Lock(); m.syncs = append(m.syncs, id); m.mu.Unlock() }
func (m *mgr) SyncAll()                          { m.Sync("*") }
func (m *mgr) RestartEngine(id string) bool      { return id == "live" }
func (m *mgr) RestartOutput(c, o string) bool    { return true }
func (m *mgr) Logs(c, p string) ([]string, bool) { return []string{"line"}, c == "ch1" }
func (m *mgr) Status() []channel.ChannelStatus {
	var out []channel.ChannelStatus
	for _, c := range m.st.Get().Channels {
		s, _ := m.ChannelStatusByID(c.ID)
		out = append(out, s)
	}
	return out
}
func (m *mgr) InsertSCTE35(id string, c scte35.Cue) (uint64, scte35.Cue, error) { return 90000, c, nil }
func (m *mgr) Thumbnail(id string) ([]byte, time.Time, bool) {
	return []byte{0xff, 0xd8}, time.Now(), id == "ch1"
}
func (m *mgr) ResetLoudness(id string) bool { return true }
func (m *mgr) Alarms() (a, h []channel.Alarm) {
	return []channel.Alarm{{ID: "al-1", Type: "black"}}, nil
}
func (m *mgr) AckAlarm(id, by string) bool { return id == "al-1" }

func (m *mgr) ChannelStatusByID(id string) (channel.ChannelStatus, bool) {
	return channel.ChannelStatus{ID: id, State: channel.StateLive, Stats: &tsbus.Stats{FPS: 30, BitrateKbps: 6100},
		Outputs: []channel.OutputStatus{{ID: "o1", Type: "srt", State: "running"}}}, true
}

type pair struct{}

func (pair) State() streamhub.PairState { return streamhub.PairState{State: "unpaired"} }
func (pair) StartPairing(ctx context.Context, u string) (streamhub.PairState, error) {
	return streamhub.PairState{State: "pending", DisplayCode: "K7Q4-M2XP", BaseURL: u}, nil
}
func (pair) Unpair() error { return nil }

func setup(t *testing.T) (*httptest.Server, *config.Store, *mgr) {
	st, err := config.Open(filepath.Join(t.TempDir(), "c.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := &mgr{st: st}
	au, _, err := auth.New(auth.Options{DataDir: t.TempDir(), LegacyToken: "ek_test", MetricsPublic: true, BcryptCost: 4})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = au.Close() })
	s := &Server{Store: st, Manager: m, Caps: func() *caps.Report { return &caps.Report{Elements: map[string]bool{"x264enc": true}} },
		Pairing: pair{}, Version: "t", Auth: au, StartedAt: time.Now(),
		Web: fstest.MapFS{"index.html": {Data: []byte("<html>ui</html>")}}}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv, st, m
}

func do(t *testing.T, srv *httptest.Server, method, path, token, body string) (int, map[string]any, string) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return resp.StatusCode, m, string(raw)
}

const chJSON = `{"id":"ch1","enabled":true,"input":{"type":"test"},"video":{"codec":"h264","width":1280,"height":720,"fps":"30","bitrateKbps":3000}}`

func TestAuth(t *testing.T) {
	srv, _, _ := setup(t)
	if c, _, _ := do(t, srv, "GET", "/api/v1/channels", "", ""); c != 401 {
		t.Fatalf("no token → %d", c)
	}
	if c, _, _ := do(t, srv, "GET", "/api/v1/channels", "wrong", ""); c != 401 {
		t.Fatalf("bad token → %d", c)
	}
	for _, p := range []string{"/api/v1/health", "/api/v1/openapi.json", "/metrics", "/"} {
		if c, _, raw := do(t, srv, "GET", p, "", ""); c != 200 {
			t.Fatalf("%s must be public, got %d %s", p, c, raw)
		}
	}
}

func TestChannelCRUDAndValidation(t *testing.T) {
	srv, st, m := setup(t)
	c, body, raw := do(t, srv, "POST", "/api/v1/channels", "ek_test", chJSON)
	if c != 201 {
		t.Fatalf("create %d %s", c, raw)
	}
	if body["config"].(map[string]any)["video"].(map[string]any)["gop"].(float64) != 60 {
		t.Fatalf("defaults not applied: %s", raw)
	}
	if c, _, _ := do(t, srv, "POST", "/api/v1/channels", "ek_test", chJSON); c != 409 {
		t.Fatalf("duplicate → %d", c)
	}
	// validation → 422 with field locations
	c, body, raw = do(t, srv, "POST", "/api/v1/channels", "ek_test", `{"id":"bad","input":{"type":"test"},"video":{"codec":"h264","width":1281,"height":720,"fps":"12","bitrateKbps":3000}}`)
	if c != 422 || !strings.Contains(raw, "video.width") || !strings.Contains(raw, "video.fps") {
		t.Fatalf("validation %d %s", c, raw)
	}
	// unknown fields are rejected (typos must not silently do nothing)
	if c, _, raw := do(t, srv, "POST", "/api/v1/channels", "ek_test", `{"id":"x","bitrat":1}`); c != 400 || !strings.Contains(raw, "unknown field") {
		t.Fatalf("unknown field %d %s", c, raw)
	}
	// PATCH merge
	c, _, raw = do(t, srv, "PATCH", "/api/v1/channels/ch1", "ek_test", `{"video":{"bitrateKbps":4500},"overlay":{"timecode":true}}`)
	if c != 200 {
		t.Fatalf("patch %d %s", c, raw)
	}
	got := st.Get().Channels[0]
	if got.Video.BitrateKbps != 4500 || got.Video.Width != 1280 || !got.Overlay.Timecode {
		t.Fatalf("patch result %+v", got)
	}
	// output via preset, with warnings for a mismatch
	c, body, raw = do(t, srv, "POST", "/api/v1/channels/ch1/outputs", "ek_test", `{"preset":"mediamtx-srt","params":{"host":"mtx","path":"cam1"},"id":"mtx"}`)
	if c != 201 || body["output"] != "mtx" {
		t.Fatalf("preset output %d %s", c, raw)
	}
	o, _ := st.Get().Channels[0].FindOutputCfg("mtx")
	if o.SRT.StreamID != "publish:cam1" {
		t.Fatalf("%+v", o.SRT)
	}
	// streamhub output token is redacted on read and kept on PUT round trip
	c, _, raw = do(t, srv, "POST", "/api/v1/channels/ch1/outputs", "ek_test", `{"id":"sh","type":"streamhub","enabled":true,"streamhub":{"baseUrl":"https://sh","app":"live","token":"sk_secret"}}`)
	if c != 201 {
		t.Fatalf("streamhub output %d %s", c, raw)
	}
	_, _, raw = do(t, srv, "GET", "/api/v1/channels/ch1", "ek_test", "")
	if strings.Contains(raw, "sk_secret") || !strings.Contains(raw, config.Redacted) {
		t.Fatalf("token leaked: %s", raw)
	}
	var view ChannelView
	_ = json.Unmarshal([]byte(raw), &view)
	b, _ := json.Marshal(view.Config)
	if c, _, raw := do(t, srv, "PUT", "/api/v1/channels/ch1", "ek_test", string(b)); c != 200 {
		t.Fatalf("put %d %s", c, raw)
	}
	if o, _ := st.Get().Channels[0].FindOutputCfg("sh"); o.StreamHub.Token != "sk_secret" {
		t.Fatalf("token lost on round trip: %+v", o.StreamHub)
	}
	// managed outputs cannot be added by operators
	if c, _, _ := do(t, srv, "POST", "/api/v1/channels/ch1/outputs", "ek_test", `{"id":"x","type":"udp","url":"udp://239.0.0.1:5000","managedBy":"streamhub"}`); c != 400 {
		t.Fatalf("managedBy accepted: %d", c)
	}
	// delete output, then channel
	if c, _, _ := do(t, srv, "DELETE", "/api/v1/channels/ch1/outputs/mtx", "ek_test", ""); c != 204 {
		t.Fatalf("delete output %d", c)
	}
	if c, _, _ := do(t, srv, "DELETE", "/api/v1/channels/ch1/outputs/mtx", "ek_test", ""); c != 404 {
		t.Fatalf("delete missing output %d", c)
	}
	if c, _, _ := do(t, srv, "POST", "/api/v1/channels/ch1/stop", "ek_test", ""); c != 200 || st.Get().Channels[0].Enabled {
		t.Fatal("stop")
	}
	if c, _, _ := do(t, srv, "DELETE", "/api/v1/channels/ch1", "ek_test", ""); c != 204 || len(st.Get().Channels) != 0 {
		t.Fatal("delete channel")
	}
	if len(m.syncs) < 6 {
		t.Fatalf("manager not synced after mutations: %v", m.syncs)
	}
}

func TestPipelineDryRunBackupMetricsPairing(t *testing.T) {
	srv, st, _ := setup(t)
	do(t, srv, "POST", "/api/v1/channels", "ek_test", chJSON)
	do(t, srv, "POST", "/api/v1/channels/ch1/outputs", "ek_test", `{"id":"u","type":"udp","enabled":true,"url":"udp://239.1.1.1:5000"}`)
	c, body, raw := do(t, srv, "GET", "/api/v1/channels/ch1/pipeline", "ek_test", "")
	if c != 200 || !strings.Contains(raw, "x264enc") || !strings.Contains(raw, "udpsink") {
		t.Fatalf("dry run %d %s", c, raw)
	}
	_ = body
	// backup round trip
	_, _, exported := do(t, srv, "GET", "/api/v1/config/backup", "ek_test", "")
	do(t, srv, "DELETE", "/api/v1/channels/ch1", "ek_test", "")
	if c, _, raw := do(t, srv, "PUT", "/api/v1/config/backup", "ek_test", exported); c != 200 {
		t.Fatalf("import %d %s", c, raw)
	}
	if len(st.Get().Channels) != 1 || len(st.Get().Channels[0].Outputs) != 1 {
		t.Fatal("backup not restored")
	}
	_, _, metrics := do(t, srv, "GET", "/metrics", "", "")
	for _, want := range []string{`encoder_fps{channel="ch1"} 30`, `encoder_output_up{channel="ch1",output="o1",type="srt"} 1`, "encoderd_build_info"} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("metrics missing %q:\n%s", want, metrics)
		}
	}
	c, body, _ = do(t, srv, "POST", "/api/v1/streamhub/pair", "ek_test", `{"baseUrl":"https://sh.example"}`)
	if c != 200 || body["displayCode"] != "K7Q4-M2XP" {
		t.Fatalf("pair %d %v", c, body)
	}
	if c, _, _ := do(t, srv, "GET", "/api/v1/channels/ch1/logs?proc=engine", "ek_test", ""); c != 200 {
		t.Fatal("logs")
	}
	if c, _, _ := do(t, srv, "POST", "/api/v1/channels/ch1/profile", "ek_test", `{"profile":"hevc-720p50-3m"}`); c != 200 || st.Get().Channels[0].Video.Codec != "h265" {
		t.Fatal("profile")
	}
	if c, _, _ := do(t, srv, "POST", "/api/v1/channels/ch1/profile", "ek_test", `{"profile":"nope"}`); c != 404 {
		t.Fatal("unknown profile")
	}
}

func TestMergePatch(t *testing.T) {
	var base, patch any
	_ = json.Unmarshal([]byte(`{"a":1,"b":{"c":2,"d":3},"e":[1]}`), &base)
	_ = json.Unmarshal([]byte(`{"b":{"c":null,"x":9},"e":[2,3],"f":"n"}`), &patch)
	got, _ := json.Marshal(mergePatch(base, patch))
	if string(got) != `{"a":1,"b":{"d":3,"x":9},"e":[2,3],"f":"n"}` {
		t.Fatal(string(got))
	}
}
