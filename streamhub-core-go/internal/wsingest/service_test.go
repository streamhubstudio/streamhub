package wsingest

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

func ingestURL(q string) string { return "/ingest/ws?" + q }

func TestHandshakeAccept(t *testing.T) {
	f := newFixture(t)
	key := f.mint("live-cam1")
	c, _ := f.connect(ingestURL("app=live&room=cam1&key="+key), "", "203.0.113.7")
	r := c.ready()
	if r == nil || r["room"] != "live-cam1" || r["maxFps"] != 15.0 || r["maxFrameBytes"] != 262144.0 ||
		r["maxDataBytes"] != 16384.0 || r["maxDataPerSec"] != 5.0 || r["idleTimeoutSec"] != 30.0 {
		t.Fatalf("ready = %v", r)
	}
	id := "live-cam1/wscam-" + key[len(key)-6:]
	if r["streamId"] != id || f.streams.upserts[0] != id+"|ws-mjpeg" || f.cb.names()[0] != "stream_started" {
		t.Fatalf("%v %v %v", r, f.streams.upserts, f.cb.names())
	}
	// Exact ready bytes (key order).
	if !strings.HasPrefix(c.texts[0], `{"type":"ready","room":"live-cam1","streamId":"`+id+`","maxFps":15,"maxFrameBytes":262144,"maxDataBytes":16384,"maxDataPerSec":5,"idleTimeoutSec":30}`) {
		t.Fatal(c.texts[0])
	}
	if !f.svc.Hub().HasPublisher(testApp, "live-cam1") || f.svc.CountCameras(testApp) != 1 {
		t.Fatal("publisher not registered")
	}

	// Authorization: Bearer header (preferred form) + custom identity.
	key2 := f.mint("live-cam2")
	c2, _ := f.connect(ingestURL("app=live&room=cam2&identity=porton"), "Bearer "+key2, "203.0.113.7")
	if c2.ready()["streamId"] != "live-cam2/porton" {
		t.Fatal(c2.ready())
	}
}

func TestHandshakeRejections(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(f *fixture) string // returns the query
		code   int
		reason string
	}{
		{"missing key", func(f *fixture) string { return "app=live&room=cam1" }, 4401, "invalid_key"},
		{"non-wsk key", func(f *fixture) string { return "app=live&room=cam1&key=sk_abc" }, 4401, "invalid_key"},
		{"unknown wsk key", func(f *fixture) string { return "app=live&room=cam1&key=wsk_nope" }, 4401, "invalid_key"},
		{"bad app slug", func(f *fixture) string { return "app=../x&room=cam1&key=wsk_x" }, 4401, "invalid_app"},
		{"bad room", func(f *fixture) string { return "app=live&room=a%20b&key=wsk_x" }, 4401, "invalid_room"},
		{"unknown app", func(f *fixture) string { return "app=ghost&room=cam1&key=" + f.mint("live-cam1") }, 4401, "unknown_app"},
		{"room mismatch", func(f *fixture) string { return "app=live&room=other&key=" + f.mint("live-cam1") }, 4401, "room_mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			c, ended := f.connect(ingestURL(tc.setup(f)), "", "203.0.113.7")
			<-ended
			m := c.messages()[0]
			if c.code() != tc.code || m["type"] != "error" || m["code"] != "4401" || m["message"] != tc.reason || c.closeWhy != tc.reason {
				t.Fatalf("code=%d msg=%v", c.code(), m)
			}
			if len(f.streams.upserts) != 0 {
				t.Fatal("rejected camera registered")
			}
		})
	}
}

func TestHandshakeForbidden(t *testing.T) {
	t.Run("ws ingest disabled", func(t *testing.T) {
		f := newFixture(t)
		f.apps.cfg.Features.WsIngest.Enabled = false
		c, ended := f.connect(ingestURL("app=live&room=cam1&key="+f.mint("live-cam1")), "", "1.2.3.4")
		<-ended
		if c.code() != 4403 || c.messages()[0]["message"] != "ws_ingest_disabled" {
			t.Fatal(c.messages())
		}
	})
	t.Run("quota exceeded", func(t *testing.T) {
		f := newFixture(t)
		f.quotas.err = httpx.Nest(429, "quota")
		c, ended := f.connect(ingestURL("app=live&room=cam1&key="+f.mint("live-cam1")), "", "1.2.3.4")
		<-ended
		if c.code() != 4403 || c.messages()[0]["message"] != "quota_exceeded" {
			t.Fatal(c.messages())
		}
	})
	t.Run("max cameras", func(t *testing.T) {
		f := newFixture(t)
		f.apps.cfg.Features.WsIngest.MaxCameras = 1
		f.connect(ingestURL("app=live&room=cam1&key="+f.mint("live-cam1")), "", "1.2.3.4")
		c, ended := f.connect(ingestURL("app=live&room=cam2&key="+f.mint("live-cam2")), "", "1.2.3.4")
		<-ended
		if c.code() != 4403 || c.messages()[0]["message"] != "max_cameras" {
			t.Fatal(c.messages())
		}
	})
	t.Run("rate limit per IP", func(t *testing.T) {
		f := newFixture(t)
		var last *fakeConn
		for i := 0; i < 61; i++ {
			last, _ = f.connect(ingestURL("app=live&room=cam1"), "", "198.51.100.9")
		}
		if last.code() != 4429 {
			t.Fatal(last.code())
		}
		// Another IP is unaffected; the window resets after a minute.
		if c, _ := f.connect(ingestURL("app=live&room=cam1"), "", "198.51.100.10"); c.messages()[0]["message"] != "invalid_key" {
			t.Fatal(c.messages())
		}
		f.clock.add(time.Minute)
		if c, _ := f.connect(ingestURL("app=live&room=cam1"), "", "198.51.100.9"); c.code() != 4401 {
			t.Fatal(c.code())
		}
	})
}

func TestDuplicateKeyTakeover(t *testing.T) {
	f := newFixture(t)
	key := f.mint("live-cam1")
	old, oldEnded := f.connect(ingestURL("app=live&room=cam1&key="+key), "", "1.2.3.4")
	nw, _ := f.connect(ingestURL("app=live&room=cam1&key="+key), "", "1.2.3.4")
	<-oldEnded
	if old.code() != CloseReplaced || nw.ready() == nil || nw.code() != 0 {
		t.Fatalf("old=%d new=%d", old.code(), nw.code())
	}
	if f.streams.endCount() != 0 || !f.svc.Hub().HasPublisher(testApp, "live-cam1") || f.svc.CountCameras(testApp) != 1 {
		t.Fatal("takeover ended the shared stream")
	}
}

func TestFramesAndLimits(t *testing.T) {
	f := newFixture(t)
	f.apps.cfg.Features.WsIngest.MaxFrameKb = 1
	c, ended := f.connect(ingestURL("app=live&room=cam1&key="+f.mint("live-cam1")), "", "1.2.3.4")
	hub := f.svc.Hub()

	// Valid frames: last frame wins (each after a token refill).
	for i, n := range []int{10, 20} {
		f.clock.add(time.Second)
		c.in <- inMsg{true, jpeg(n)}
		want := n
		waitFor(t, func() bool { fr, _ := hub.LastFrame(testApp, "live-cam1"); return len(fr) == want })
		_ = i
	}
	// fps cap: a burst beyond the bucket is dropped silently.
	f.clock.add(time.Second)
	for i := 0; i < 40; i++ {
		c.in <- inMsg{true, jpeg(30)}
	}
	waitFor(t, func() bool { info := hub.Info(testApp, "live-cam1"); return info.Frames == 17 })
	if c.code() != 0 {
		t.Fatal("fps overflow must not close")
	}
	// Non-JPEG garbage: dropped; the 5th in a row closes 1003.
	for i := 0; i < 5; i++ {
		c.in <- inMsg{true, []byte("garbage!")}
	}
	<-ended
	if c.code() != 1003 {
		t.Fatal(c.code())
	}

	// Oversized frame → error + 4413.
	c2, ended2 := f.connect(ingestURL("app=live&room=cam2&key="+f.mint("live-cam2")), "", "1.2.3.4")
	c2.in <- inMsg{true, jpeg(1025)}
	<-ended2
	msgs := c2.messages()
	if c2.code() != 4413 || msgs[len(msgs)-1]["code"] != "frame_too_large" || msgs[len(msgs)-1]["message"] != "max 1024 bytes" {
		t.Fatal(msgs)
	}
}

func TestStatsAndMalformedText(t *testing.T) {
	f := newFixture(t)
	key := f.mint("live-cam1")
	c, _ := f.connect(ingestURL("app=live&room=cam1&key="+key), "", "1.2.3.4")
	id := "live-cam1/wscam-" + key[len(key)-6:]
	// The row only exists when streams.upsert writes it; seed it here.
	adb, _ := f.svc.d.AppDB(bg, testApp)
	_, _ = adb.Exec("INSERT INTO streams (app_id, stream_id, type, room, participant, status) VALUES (1, ?, 'ws-mjpeg', 'live-cam1', 'x', 'active')", id)
	c.in <- inMsg{false, []byte("not json")}
	c.in <- inMsg{false, []byte(`[1,2]`)}
	c.in <- inMsg{false, []byte(`{"type":"stats","rssi":-60,"live":false,"heap":1.5}`)}
	var got string
	waitFor(t, func() bool {
		var s *string
		_ = adb.QueryRow("SELECT last_stats_json FROM streams WHERE stream_id = ?", id).Scan(&s)
		if s != nil {
			got = *s
		}
		return s != nil
	})
	want := `{"rssi":-60,"live":true,"heap":1.5,"framesReceived":0,"framesDroppedFps":0,"viewers":0,"ts":"2027-01-15T08:00:00.000Z"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	if c.code() != 0 {
		t.Fatal("text messages must never close")
	}
}

func TestDataFrames(t *testing.T) {
	f := newFixture(t)
	c, _ := f.connect(ingestURL("app=live&room=cam1&identity=dev1&key="+f.mint("live-cam1")), "", "1.2.3.4")
	send := func(s string) { c.in <- inMsg{false, []byte(s)} }
	countData := func() int {
		n := 0
		for _, e := range f.cb.names() {
			if e == "iot.data" {
				n++
			}
		}
		return n
	}
	send(`{"type":"data","topic":"env/temp","data":{"z":1,"a":{"b":[1]}}}`)
	waitFor(t, func() bool { return countData() == 1 })
	f.cb.mu.Lock()
	ev := f.cb.events[len(f.cb.events)-1]
	f.cb.mu.Unlock()
	enc, _ := y.Stringify(mustMap(ev.payload))
	if enc != `{"topic":"env/temp","deviceId":"dev1","data":{"z":1,"a":{"b":[1]}},"source":"ws"}` {
		t.Fatal(enc)
	}
	// Invalid topic / non-object data / too deep → dropped.
	send(`{"type":"data","topic":"-bad","data":{}}`)
	send(`{"type":"data","topic":"ok","data":[1]}`)
	send(`{"type":"data","topic":"ok","data":{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}}`)
	// Oversized raw frame.
	send(`{"type":"data","topic":"ok","data":{"x":"` + strings.Repeat("a", 17000) + `"}}`)
	// Rate cap: 4 tokens left this second → 4 of 10 pass.
	for i := 0; i < 10; i++ {
		send(`{"type":"data","topic":"ok","data":{}}`)
	}
	waitFor(t, func() bool { return countData() == 5 })
	time.Sleep(50 * time.Millisecond)
	if countData() != 5 || c.code() != 0 {
		t.Fatalf("data events = %d", countData())
	}
}

// mustMap converts a dispatched payload to a JS object via its JSON.
func mustMap(p any) *y.Map {
	s, _ := y.Stringify(p)
	v, _ := y.ParseJSON([]byte(s))
	return v.(*y.Map)
}

func TestLifecycle(t *testing.T) {
	t.Run("idle → 4408 + end + stream_ended", func(t *testing.T) {
		f := newFixture(t)
		f.svc.idleCheck = 10 * time.Millisecond
		c, ended := f.connect(ingestURL("app=live&room=cam1&key="+f.mint("live-cam1")), "", "1.2.3.4")
		f.clock.add(31 * time.Second)
		<-ended
		if c.code() != CloseIdle || f.streams.endCount() != 1 || f.svc.Hub().HasPublisher(testApp, "live-cam1") {
			t.Fatal(c.code())
		}
		names := f.cb.names()
		if names[len(names)-1] != "stream_ended" {
			t.Fatal(names)
		}
	})
	t.Run("frames keep it alive", func(t *testing.T) {
		f := newFixture(t)
		f.svc.idleCheck = 10 * time.Millisecond
		c, _ := f.connect(ingestURL("app=live&room=cam1&key="+f.mint("live-cam1")), "", "1.2.3.4")
		f.clock.add(20 * time.Second)
		c.in <- inMsg{true, jpeg(8)}
		waitFor(t, func() bool { fr, _ := f.svc.Hub().LastFrame(testApp, "live-cam1"); return fr != nil })
		f.clock.add(20 * time.Second)
		time.Sleep(50 * time.Millisecond)
		if c.code() != 0 {
			t.Fatal("closed despite frames")
		}
	})
	t.Run("two lost pongs → terminated", func(t *testing.T) {
		f := newFixture(t)
		f.svc.pingInterval = 10 * time.Millisecond
		c, ended := f.connect(ingestURL("app=live&room=cam1&key="+f.mint("live-cam1")), "", "1.2.3.4")
		c.mu.Lock()
		c.pongs = false
		c.mu.Unlock()
		<-ended
		if !c.terminated {
			t.Fatal("not terminated")
		}
	})
	t.Run("disconnect → end + publisher cleared", func(t *testing.T) {
		f := newFixture(t)
		c, ended := f.connect(ingestURL("app=live&room=cam1&key="+f.mint("live-cam1")), "", "1.2.3.4")
		c.Terminate()
		<-ended
		if f.streams.endCount() != 1 || f.svc.Hub().HasPublisher(testApp, "live-cam1") || f.svc.CountCameras(testApp) != 0 {
			t.Fatal("not cleaned up")
		}
	})
}

func TestBootCleanup(t *testing.T) {
	f := newFixture(t)
	adb, _ := f.svc.d.AppDB(bg, testApp)
	for _, r := range [][2]string{{"a/ws", "ws-mjpeg"}, {"b/rtmp", "rtmp"}} {
		_, _ = adb.Exec("INSERT INTO streams (app_id, stream_id, type, room, participant, status) VALUES (1, ?, ?, 'r', 'p', 'active')", r[0], r[1])
	}
	f.svc.Start(bg)
	status := func(id string) (s string) {
		_ = adb.QueryRow("SELECT status FROM streams WHERE stream_id = ?", id).Scan(&s)
		return
	}
	if status("a/ws") != "ended" || status("b/rtmp") != "active" {
		t.Fatal(status("a/ws"), status("b/rtmp"))
	}
}

func TestViewersAndPlayback(t *testing.T) {
	f := newFixture(t)
	f.svc.d.Hub.Publish(testApp, "live-cam1", jpeg(5), 1)
	v := newFakeConn()
	done := make(chan struct{})
	go func() { f.svc.HandleViewer(bg, v, UpgradeInfo{URL: "/live/ws?app=live&room=cam1"}); close(done) }()
	<-v.sent // the last frame arrives immediately
	f.svc.d.Hub.Publish(testApp, "live-cam1", jpeg(6), 2)
	<-v.sent
	if len(v.bins) != 2 || len(v.bins[1]) != 6 || f.svc.d.Hub.ViewerCount(testApp, "live-cam1") != 1 {
		t.Fatal(len(v.bins))
	}
	v.Terminate()
	<-done
	if f.svc.d.Hub.ViewerCount(testApp, "live-cam1") != 0 {
		t.Fatal("viewer not unsubscribed")
	}

	reject := func(url string) (int, string) {
		c := newFakeConn()
		f.svc.HandleViewer(bg, c, UpgradeInfo{URL: url})
		return c.code(), c.closeWhy
	}
	if code, why := reject("/live/ws?app=ghost&room=cam1"); code != 4401 || why != "unknown_app" {
		t.Fatal(code, why)
	}
	if code, why := reject("/live/ws?app=live"); code != 4401 || why != "invalid_params" {
		t.Fatal(code, why)
	}
	f.apps.cfg.Features.PublicPlayback = false
	if code, why := reject("/live/ws?app=live&room=cam1"); code != 4401 || why != "playback_unauthorized" {
		t.Fatal(code, why)
	}
}

func TestPlaybackAllowedToken(t *testing.T) {
	f := newFixture(t)
	cfg := defaultCfg()
	cfg.Features.PublicPlayback = false
	now := f.clock.now()
	tok := func(key, secret string, video map[string]any, exp time.Time) string {
		return signJWT(t, key, secret, map[string]any{"iss": key, "exp": exp.Unix(), "nbf": now.Unix() - 10, "sub": "v", "video": video})
	}
	secret := f.svc.d.LivekitSecret
	good := map[string]any{"room": "live-cam1", "roomJoin": true, "canSubscribe": true}
	cases := []struct {
		name  string
		token string
		want  bool
	}{
		{"valid subscribe token", tok("devkey", secret, good, now.Add(time.Hour)), true},
		{"grant without explicit flags", tok("devkey", secret, map[string]any{"room": "live-cam1"}, now.Add(time.Hour)), true},
		{"other room", tok("devkey", secret, map[string]any{"room": "live-cam2", "roomJoin": true}, now.Add(time.Hour)), false},
		{"canSubscribe false", tok("devkey", secret, map[string]any{"room": "live-cam1", "canSubscribe": false}, now.Add(time.Hour)), false},
		{"expired", tok("devkey", secret, good, now.Add(-time.Second)), false},
		{"wrong issuer", tok("other", secret, good, now.Add(time.Hour)), false},
		{"wrong secret", tok("devkey", "nope", good, now.Add(time.Hour)), false},
		{"no token", "", false},
		{"garbage", "a.b.c", false},
	}
	for _, tc := range cases {
		if got := f.svc.PlaybackAllowed(&cfg, "live-cam1", tc.token); got != tc.want {
			t.Errorf("%s: got %v", tc.name, got)
		}
	}
	if !f.svc.PlaybackAllowed(nil, "x", "") || !f.svc.PlaybackAllowed(&[]contracts.AppConfig{defaultCfg()}[0], "x", "") {
		t.Fatal("public playback must pass")
	}
}

func TestProvisioningAndLiveInfo(t *testing.T) {
	f := newFixture(t)
	f.svc.d.PublicBaseURL = "https://x.example/"
	p, err := f.svc.Provision(bg, testApp, "cam1", "")
	if err != nil || !strings.HasPrefix(p.ID, "wsi_") || !strings.HasPrefix(p.StreamKey, "wsk_") || p.Room != "live-cam1" ||
		p.Identity != "wscam-"+p.StreamKey[len(p.StreamKey)-6:] || p.WsURL != "wss://x.example/ingest/ws?app=live&room=cam1" ||
		p.ViewerWsURL != "wss://x.example/live/ws?app=live&room=cam1" || p.MjpegURL != "https://x.example/live/live/live-cam1/mjpeg" ||
		p.FrameURL != "https://x.example/live/live/live-cam1/frame.jpg" || p.PlayerURL != "https://x.example/play/live/live-cam1" ||
		p.EmbedURL != "https://x.example/embed/live/live-cam1" {
		t.Fatalf("%+v %v", p, err)
	}
	_, err = f.svc.Provision(bg, "ghost", "cam1", "")
	wantHTTP(t, err, 404, "app 'ghost' not found")

	info, _ := f.svc.LiveInfo(bg, testApp, "cam1")
	if info.Active || info.Type != nil || info.Room != "live-cam1" {
		t.Fatalf("%+v", info)
	}
	c, ended := f.connect(ingestURL("app=live&room=cam1&key="+p.StreamKey), "", "1.2.3.4")
	keys, _ := f.svc.ListKeys(bg, testApp)
	if len(keys) != 1 || !keys[0].Active || keys[0].Identity == "" {
		t.Fatalf("%+v", keys)
	}
	info, _ = f.svc.LiveInfo(bg, testApp, "cam1")
	if !info.Active || *info.Type != "ws-mjpeg" || info.WsURL != "wss://x.example/live/ws?app=live&room=cam1" {
		t.Fatalf("%+v", info)
	}
	// Revoke closes the live camera (4401) and the key stops authenticating.
	if err := f.svc.Revoke(bg, testApp, p.ID); err != nil {
		t.Fatal(err)
	}
	<-ended
	if c.code() != CloseUnauthorized {
		t.Fatal(c.code())
	}
	wantHTTP(t, f.svc.Revoke(bg, testApp, p.ID), 404, "ws-ingest key '"+p.ID+"' not found")
	c2, ended2 := f.connect(ingestURL("app=live&room=cam1&key="+p.StreamKey), "", "1.2.3.5")
	<-ended2
	if c2.closeWhy != "invalid_key" {
		t.Fatal(c2.closeWhy)
	}
	f.apps.cfg.Features.PublicPlayback = false
	_, err = f.svc.LiveInfo(bg, testApp, "cam1")
	wantHTTP(t, err, 404, "public playback is disabled for this app")
}

func wantHTTP(t *testing.T, err error, status int, msg string) {
	t.Helper()
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != status || he.Error() != msg {
		t.Fatalf("want %d %q, got %v", status, msg, err)
	}
}
