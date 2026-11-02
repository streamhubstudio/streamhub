package streamhub

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
	"time"

	"github.com/coder/websocket"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/channel"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

func env(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "error": nil})
}

// fakeCore mimics the StreamHub REST + device plane used by the encoder.
type fakeCore struct {
	t        *testing.T
	mu       sync.Mutex
	ingress  map[string]map[string]any
	created  []map[string]any
	deleted  []string
	auth     []string
	claimed  bool
	polls    int
	wsHello  chan map[string]any
	wsFrames chan map[string]any
	wsConn   chan *websocket.Conn
	srv      *httptest.Server
}

func newFakeCore(t *testing.T) *fakeCore {
	f := &fakeCore{t: t, ingress: map[string]map[string]any{}, wsHello: make(chan map[string]any, 4),
		wsFrames: make(chan map[string]any, 64), wsConn: make(chan *websocket.Conn, 4)}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/apps/{app}/ingress", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		if r.Header.Get("Authorization") != "Bearer sk_good" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"statusCode":401,"message":"invalid token"}`))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.created = append(f.created, body)
		id := "IN_" + string(rune('a'+len(f.created)))
		key := "key" + id
		res := map[string]any{"ingressId": id, "streamKey": key, "stream_key": key, "roomName": body["room"]}
		if body["inputType"] == "rtmp" {
			res["url"] = "rtmp://sh.example:1935/live"
			res["rtmp_url"] = "rtmp://sh.example:1935/live/" + key
		} else {
			res["url"] = "http://sh.example:8080/w"
		}
		f.ingress[id] = res
		env(w, 201, res)
	})
	mux.HandleFunc("GET /api/v1/apps/{app}/ingress/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if in, ok := f.ingress[r.PathValue("id")]; ok {
			env(w, 200, in)
			return
		}
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"statusCode":404,"message":"ingress not found","error":"Not Found"}`))
	})
	mux.HandleFunc("DELETE /api/v1/apps/{app}/ingress/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.deleted = append(f.deleted, r.PathValue("id"))
		delete(f.ingress, r.PathValue("id"))
		env(w, 200, map[string]any{"deleted": true})
	})
	mux.HandleFunc("POST /api/v1/devices/pair/start", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["serial"] == "" || body["model"] == nil {
			t.Errorf("pair/start body: %v", body)
		}
		env(w, 201, map[string]any{"deviceId": "dev_0123456789abcdef", "code": "K7Q4M2XP", "displayCode": "K7Q4-M2XP",
			"pollToken": "ptok", "expiresAt": "2026-10-29T12:10:00.000Z", "pollInterval": 1})
	})
	mux.HandleFunc("GET /api/v1/devices/pair/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "ptok" {
			w.WriteHeader(404)
			return
		}
		f.mu.Lock()
		f.polls++
		claimed := f.claimed
		f.mu.Unlock()
		if !claimed {
			env(w, 200, map[string]any{"status": "pending", "expiresAt": "2026-10-29T12:10:00.000Z"})
			return
		}
		ws := "ws" + strings.TrimPrefix(f.srv.URL, "http") + "/api/v1/devices/ws"
		env(w, 200, map[string]any{"status": "claimed", "deviceId": "dev_0123456789abcdef", "credential": "dk_dev_0123456789abcdef.s3cret", "wsUrl": ws, "app": "live"})
	})
	mux.HandleFunc("GET /api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Device dk_dev_0123456789abcdef.s3cret" || r.URL.Query().Get("token") != "" {
			w.WriteHeader(401)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		f.wsConn <- c
		ctx := context.Background()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			if m["type"] == "hello" {
				f.wsHello <- m
			} else {
				f.wsFrames <- m
			}
		}
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func TestClientEnvelopeAndErrors(t *testing.T) {
	f := newFakeCore(t)
	c := &Client{BaseURL: f.srv.URL + "/", Token: "sk_bad"}
	_, err := c.CreateIngress(context.Background(), "live", "rtmp", "r", "id", "n")
	var ae *APIError
	if err == nil || !strings.Contains(err.Error(), "invalid token") || !asAPI(err, &ae) || ae.Status != 401 {
		t.Fatalf("want 401 APIError with message, got %v", err)
	}
	c.Token = "sk_good"
	in, err := c.CreateIngress(context.Background(), "live", "rtmp", "r", "id", "n")
	if err != nil || in.RtmpURL == "" || in.Key() == "" {
		t.Fatalf("%+v %v", in, err)
	}
	if _, err := c.GetIngress(context.Background(), "live", "nope"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("404: %v", err)
	}
}

func asAPI(err error, target **APIError) bool {
	e, ok := err.(*APIError)
	if ok {
		*target = e
	}
	return ok
}

func TestResolverCreatesReusesAndRecreates(t *testing.T) {
	f := newFakeCore(t)
	r := &Resolver{DeviceID: "enc-1"}
	ch := config.Channel{ID: "ch1", Name: "Cam 1"}
	o := config.Output{ID: "sh", Type: "streamhub", StreamHub: &config.StreamHubOutput{BaseURL: f.srv.URL, App: "live", Token: "sk_good", Room: "studio", Protocol: "rtmp", DeleteOnRemove: true}}
	res, conc, err := r.Resolve(context.Background(), ch, o)
	if err != nil {
		t.Fatal(err)
	}
	if conc.Type != "rtmp" || !strings.HasPrefix(conc.URL, "rtmp://sh.example:1935/live/key") || res.IngressID == "" {
		t.Fatalf("rtmp resolution: %+v %+v", res, conc)
	}
	if f.created[0]["room"] != "studio" || f.created[0]["participantIdentity"] != "encoder-enc-1-ch1" {
		t.Fatalf("create body: %v", f.created[0])
	}
	// persisted ingress still exists → reused, no new create
	o.StreamHub = &res
	if _, _, err := r.Resolve(context.Background(), ch, o); err != nil || len(f.created) != 1 {
		t.Fatalf("reuse: creates=%d err=%v", len(f.created), err)
	}
	// deleted in the dashboard → recreated
	f.mu.Lock()
	delete(f.ingress, res.IngressID)
	f.mu.Unlock()
	res2, _, err := r.Resolve(context.Background(), ch, o)
	if err != nil || res2.IngressID == res.IngressID || len(f.created) != 2 {
		t.Fatalf("recreate: %+v %v", res2, err)
	}
	o.StreamHub = &res2
	if err := r.Release(context.Background(), o); err != nil || len(f.deleted) != 1 {
		t.Fatalf("release: %v %v", err, f.deleted)
	}
	// WHIP: URL + bearer = stream key
	ow := config.Output{ID: "w", Type: "streamhub", StreamHub: &config.StreamHubOutput{BaseURL: f.srv.URL, App: "live", Token: "sk_good", Room: "studio", Protocol: "whip"}}
	_, cw, err := r.Resolve(context.Background(), ch, ow)
	if err != nil || cw.Type != "whip" || cw.URL != "http://sh.example:8080/w" || cw.WHIP == nil || !strings.HasPrefix(cw.WHIP.BearerToken, "key") {
		t.Fatalf("whip: %+v %v", cw, err)
	}
}

type fakeMgr struct {
	mu       sync.Mutex
	syncs    int
	restarts []string
	status   []channel.ChannelStatus
}

func (m *fakeMgr) Sync(id string) { m.mu.Lock(); m.syncs++; m.mu.Unlock() }
func (m *fakeMgr) SyncAll()       { m.mu.Lock(); m.syncs++; m.mu.Unlock() }
func (m *fakeMgr) RestartEngine(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.restarts = append(m.restarts, id)
	return true
}
func (m *fakeMgr) Status() []channel.ChannelStatus { return m.status }

func read(t *testing.T, ch chan map[string]any, typ string) map[string]any {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-ch:
			if m["type"] == typ {
				return m
			}
		case <-deadline:
			t.Fatalf("no %s frame", typ)
		}
	}
}

func send(t *testing.T, c *websocket.Conn, v any) {
	b, _ := json.Marshal(v)
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
}

func TestPairingLinkConfigCommandsAndRevoke(t *testing.T) {
	f := newFakeCore(t)
	st, err := config.Open(filepath.Join(t.TempDir(), "c.json"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = st.Update(func(c *config.Config) error {
		c.Channels = []config.Channel{
			{ID: "ch1", Name: "SDI 1", Enabled: false, Input: config.Input{Type: "test"}, Video: config.Video{Codec: "h264", Width: 1280, Height: 720, FPS: "25", BitrateKbps: 3000},
				Outputs: []config.Output{{ID: "local", Type: "udp", Enabled: true, URL: "udp://239.1.1.1:5000"}}},
			{ID: "ch2", Enabled: false, Input: config.Input{Type: "test"}, Video: config.Video{Codec: "h265", Width: 1280, Height: 720, FPS: "25", BitrateKbps: 3000}},
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	mgr := &fakeMgr{status: []channel.ChannelStatus{{ID: "ch1", Enabled: true, State: channel.StateLive}, {ID: "ch2", State: channel.StateStopped}}}
	svc := &Service{Store: st, Manager: mgr, Version: "1.2.3", Model: "SH-ENC"}
	svc.Boot()
	if svc.State().State != "unpaired" {
		t.Fatal(svc.State())
	}
	ps, err := svc.StartPairing(context.Background(), f.srv.URL)
	if err != nil || ps.State != "pending" || ps.DisplayCode != "K7Q4-M2XP" {
		t.Fatalf("start: %+v %v", ps, err)
	}
	time.Sleep(1200 * time.Millisecond)
	f.mu.Lock()
	f.claimed = true
	f.mu.Unlock()

	hello := read(t, f.wsHello, "hello")
	conn := <-f.wsConn
	if hello["version"] != "1.2.3" || hello["serial"] != st.Get().Device.ID {
		t.Fatalf("hello: %v", hello)
	}
	chs := hello["capabilities"].(map[string]any)["channels"].([]any)
	if len(chs) != 2 || chs[0].(map[string]any)["id"] != "ch1" {
		t.Fatalf("hello channels: %v", chs)
	}
	if c := st.Get().StreamHub; c.Credential != "dk_dev_0123456789abcdef.s3cret" || c.DeviceID != "dev_0123456789abcdef" {
		t.Fatalf("credential not persisted: %+v", c)
	}
	status := read(t, f.wsFrames, "status")
	if chans := status["channels"].([]any); chans[0].(map[string]any)["state"] != "live" || chans[1].(map[string]any)["state"] != "stopped" {
		t.Fatalf("status: %v", status)
	}
	eventuallyState(t, svc, "connected")

	// config: ch1 → RTMP, ch2 → SRT with streamid
	send(t, conn, map[string]any{"type": "config", "rev": 3, "device": map[string]any{"id": "dev_0123456789abcdef", "name": "Truck", "app": "live"},
		"channels": []any{
			map[string]any{"id": "ch1", "room": "live-truck", "protocol": "rtmp", "publishUrl": "rtmp://media:1935/live/AbC", "streamKey": "AbC", "ingressId": "IN_x"},
			map[string]any{"id": "ch2", "room": "live-hevc", "protocol": "srt", "publishUrl": "srt://media:8890?streamid=publish:live/ptk_1", "streamKey": "ptk_1"},
		}})
	read(t, f.wsFrames, "status") // the immediate post-apply status
	c := st.Get()
	o1, ok := c.Channels[0].FindOutputCfg(ManagedOutputID)
	if !ok || o1.Type != "rtmp" || o1.URL != "rtmp://media:1935/live/AbC" || o1.ManagedBy != "streamhub" {
		t.Fatalf("ch1 managed output: %+v", o1)
	}
	if _, ok := c.Channels[0].FindOutputCfg("local"); !ok {
		t.Fatal("operator output was removed")
	}
	o2, _ := c.Channels[1].FindOutputCfg(ManagedOutputID)
	if o2.Type != "srt" || o2.URL != "srt://media:8890" || o2.SRT.StreamID != "publish:live/ptk_1" || o2.SRT.Mode != "caller" {
		t.Fatalf("ch2 managed output: %+v %+v", o2, o2.SRT)
	}
	if c.StreamHub.ConfigRev != 3 {
		t.Fatalf("rev %d", c.StreamHub.ConfigRev)
	}

	// older rev ignored; newer rev without ch2 unpublishes it
	send(t, conn, map[string]any{"type": "config", "rev": 2, "channels": []any{}})
	send(t, conn, map[string]any{"type": "config", "rev": 4, "channels": []any{
		map[string]any{"id": "ch1", "room": "live-truck", "protocol": "rtmp", "publishUrl": "rtmp://media:1935/live/NEW", "streamKey": "NEW"}}})
	read(t, f.wsFrames, "status")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if st.Get().StreamHub.ConfigRev == 4 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	c = st.Get()
	if o, _ := c.Channels[0].FindOutputCfg(ManagedOutputID); o.URL != "rtmp://media:1935/live/NEW" {
		t.Fatalf("rotated key not applied: %+v", o)
	}
	if _, ok := c.Channels[1].FindOutputCfg(ManagedOutputID); ok {
		t.Fatal("channel absent from config still publishes")
	}

	// commands
	send(t, conn, map[string]any{"type": "command", "id": "c1", "action": "start", "channel": "ch2"})
	r := read(t, f.wsFrames, "command_result")
	if r["id"] != "c1" || r["ok"] != true || !st.Get().Channels[1].Enabled {
		t.Fatalf("start: %v", r)
	}
	send(t, conn, map[string]any{"type": "command", "id": "c2", "action": "apply_preset", "channel": "ch1", "preset": "h264-720p30-3m"})
	r = read(t, f.wsFrames, "command_result")
	if r["ok"] != true || st.Get().Channels[0].Video.BitrateKbps != 3000 || st.Get().Channels[0].Video.FPS != "30" {
		t.Fatalf("apply_preset: %v", r)
	}
	send(t, conn, map[string]any{"type": "command", "id": "c3", "action": "reboot"})
	if r = read(t, f.wsFrames, "command_result"); r["ok"] != false || !strings.Contains(r["message"].(string), "disabled") {
		t.Fatalf("reboot must be refused by default: %v", r)
	}
	send(t, conn, map[string]any{"type": "command", "id": "c4", "action": "dance"})
	if r = read(t, f.wsFrames, "command_result"); r["ok"] != false {
		t.Fatalf("unknown action: %v", r)
	}
	send(t, conn, map[string]any{"type": "command", "id": "c5", "action": "restart", "channel": "ch1"})
	if r = read(t, f.wsFrames, "command_result"); r["ok"] != true || len(mgr.restarts) != 1 {
		t.Fatalf("restart: %v", r)
	}

	// revoke → 4401 → unpaired, credential and managed outputs gone
	_ = conn.Close(4401, "revoked")
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && svc.State().State != "revoked" {
		time.Sleep(20 * time.Millisecond)
	}
	if svc.State().State != "revoked" {
		t.Fatalf("state after revoke: %+v", svc.State())
	}
	c = st.Get()
	if c.StreamHub.Credential != "" {
		t.Fatal("credential kept after revoke")
	}
	if _, ok := c.Channels[0].FindOutputCfg(ManagedOutputID); ok {
		t.Fatal("managed output kept after revoke")
	}
}

func eventuallyState(t *testing.T, s *Service, want string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if s.State().State == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("state %+v, want %s", s.State(), want)
}

func TestPollExpired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = io.WriteString(w, `{"statusCode":404,"message":"unknown or expired pairing","error":"Not Found"}`)
	}))
	defer srv.Close()
	if _, err := PollPairing(context.Background(), nil, srv.URL, "dev_x", "t"); err != ErrPairingExpired {
		t.Fatalf("want ErrPairingExpired, got %v", err)
	}
}

func TestLinkUnauthorizedIsRevoked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }))
	defer srv.Close()
	l := &Link{WSURL: "ws" + strings.TrimPrefix(srv.URL, "http"), Credential: "dk_x", Handler: &Service{}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := l.Run(ctx); err != ErrRevoked {
		t.Fatalf("401 on upgrade must stop the link as revoked, got %v", err)
	}
}

func TestSplitSRTPublish(t *testing.T) {
	u, sid, err := SplitSRTPublish("srt://media.example.com:8890?streamid=publish:live/ptk_abc")
	if err != nil || u != "srt://media.example.com:8890" || sid != "publish:live/ptk_abc" {
		t.Fatal(u, sid, err)
	}
	if _, _, err := SplitSRTPublish("rtmp://x"); err == nil {
		t.Fatal("non-srt accepted")
	}
}
