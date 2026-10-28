package livekit

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// ingress-encoding.util.spec
func TestSanitizeTranscodeMaxHeight(t *testing.T) {
	for in, want := range map[float64]int{360: 360, 480: 480, 720: 720, 1080: 1080, 1440: 1080, 240: 360, 600: 720, 540: 480,
		900: 720, 2160: 1080, 1: 360, 0: 720, -5: 720, 720.9: 720} {
		if got := SanitizeTranscodeMaxHeight(in); got != want {
			t.Errorf("%v → %d, want %d", in, got, want)
		}
	}
}

func TestBuildIngressVideoOptions(t *testing.T) {
	for _, c := range []struct {
		h        *float64
		adaptive bool
		want     livekit.IngressVideoEncodingPreset
	}{
		{nil, false, livekit.IngressVideoEncodingPreset_H264_720P_30FPS_1_LAYER},
		{fptr(1080), false, livekit.IngressVideoEncodingPreset_H264_1080P_30FPS_1_LAYER},
		{fptr(480), false, livekit.IngressVideoEncodingPreset_H264_720P_30FPS_1_LAYER},
		{fptr(360), false, livekit.IngressVideoEncodingPreset_H264_720P_30FPS_1_LAYER},
		{nil, true, livekit.IngressVideoEncodingPreset_H264_720P_30FPS_3_LAYERS},
		{fptr(1080), true, livekit.IngressVideoEncodingPreset_H264_1080P_30FPS_3_LAYERS},
	} {
		v := BuildIngressVideoOptions(c.h, c.adaptive)
		if v.GetPreset() != c.want || v.GetSource() != livekit.TrackSource_CAMERA || v.GetOptions() != nil {
			t.Errorf("%v/%v → %v", c.h, c.adaptive, v)
		}
	}
}

// ingress-rtmp-url.util.spec
func TestRtmpURLs(t *testing.T) {
	cfg := RtmpURLConfig{RtmpPublicHost: "ingest.example.com", RtmpsPort: 1936}
	for _, c := range []struct{ got, want string }{
		{BuildRtmpURL("K", cfg), "rtmp://ingest.example.com:1935/live/K"},
		{BuildRtmpURL("K", RtmpURLConfig{}), "rtmp://media.digitalhub.com.ar:1935/live/K"},
		{BuildRtmpURL("", cfg), ""},
		{BuildRtmpsURL("K", cfg), ""},
		{BuildRtmpsURL("K", RtmpURLConfig{RtmpPublicHost: "a", RtmpsEnable: true, RtmpsPort: 443}), "rtmps://a:443/live/K"},
		{BuildRtmpsURL("K", RtmpURLConfig{RtmpPublicHost: "a", RtmpsPublicHost: "s", RtmpsEnable: true, RtmpsPort: 1936}), "rtmps://s:1936/live/K"},
		{BuildRtmpsURL("K", RtmpURLConfig{RtmpsEnable: true, RtmpsPort: 1936}), "rtmps://media.digitalhub.com.ar:1936/live/K"},
		{BuildRtmpsURL("", RtmpURLConfig{RtmpsEnable: true}), ""},
		{BuildPassthroughRtmpURL("ptk", "h", 1937, "live"), "rtmp://h:1937/live/ptk"},
		{BuildPassthroughRtmpURL("ptk", "", 1937, "live"), "rtmp://media.digitalhub.com.ar:1937/live/ptk"},
		{BuildPassthroughRtmpURL("", "h", 1937, "live"), ""},
		{BuildPassthroughSrtURL("ptk", "h", 9000), "srt://h:9000?streamid=ptk"},
		{BuildPassthroughSrtURL("ptk", "", 9000), "srt://media.digitalhub.com.ar:9000?streamid=ptk"},
		{BuildPassthroughSrtURL("", "h", 9000), ""},
	} {
		if c.got != c.want {
			t.Errorf("got %q want %q", c.got, c.want)
		}
	}
}

// playback-url.util.spec
func TestVerifyPlayback(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	exp := now.Unix() + 60
	sig := SignPlayback("m", "app", "room", exp)
	e := itoa
	for _, c := range []struct {
		master, app, room, exp, sig string
		want                        PlaybackVerdict
	}{
		{"m", "app", "room", e(exp), sig, PlaybackOK},
		{"m", "app", "room", e(exp), strings.ToUpper(sig), PlaybackOK},
		{"m", "app", "other", e(exp), sig, PlaybackInvalid},
		{"m", "other", "room", e(exp), sig, PlaybackInvalid},
		{"m", "app", "room", e(exp + 1), sig, PlaybackInvalid},
		{"m", "app", "room", e(exp), sig[:63] + "0", PlaybackInvalid},
		{"m", "app", "room", e(exp), sig[:62], PlaybackInvalid},
		{"m", "app", "room", e(exp), "zz" + sig[2:], PlaybackInvalid},
		{"m", "app", "room", "", sig, PlaybackInvalid},
		{"m", "app", "room", "1e9", sig, PlaybackInvalid},
		{"m", "app", "room", e(exp), "", PlaybackInvalid},
		{"", "app", "room", e(exp), sig, PlaybackInvalid},
	} {
		if got := VerifyPlayback(c.master, c.app, c.room, c.exp, c.sig, now); got != c.want {
			t.Errorf("%+v → %s", c, got)
		}
	}
	past := now.Unix() - 1
	if got := VerifyPlayback("m", "app", "room", itoa(past), SignPlayback("m", "app", "room", past), now); got != PlaybackExpired {
		t.Fatal(got)
	}
	if string(PlaybackSecretFor("m", "a")) == string(PlaybackSecretFor("m", "b")) {
		t.Fatal("per-app secrets collide")
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// ingress-url.guard.spec
func TestAssertSafePullURL(t *testing.T) {
	resolveTo := func(addrs ...string) func(context.Context, string) ([]string, error) {
		return func(context.Context, string) ([]string, error) { return addrs, nil }
	}
	fail := func(context.Context, string) ([]string, error) { return nil, errors.New("ENOTFOUND") }
	ctx := context.Background()
	for _, c := range []struct {
		url     string
		resolve func(context.Context, string) ([]string, error)
		want    string
	}{
		{"rtsp://93.184.216.34/live", nil, ""},
		{"srt://93.184.216.34:9000", nil, ""},
		{"http://cams.example.com/x", resolveTo("93.184.216.34"), ""},
		{"srt://relay.example.com:9000", resolveTo("8.8.8.8"), ""},
		{"file:///etc/passwd", nil, "ingress pull url scheme 'file' is not allowed (allowed: http, https, rtsp, rtsps, rtmp, rtmps, srt)"},
		{"gopher://x/", nil, "ingress pull url scheme 'gopher' is not allowed (allowed: http, https, rtsp, rtsps, rtmp, rtmps, srt)"},
		{"not a url", nil, "invalid ingress pull url: 'not a url'"},
		{"http://", nil, "invalid ingress pull url: 'http://'"},
		{"http://127.0.0.1/", nil, "ingress pull url points at a private/loopback/link-local address"},
		{"rtsp://10.1.2.3/x", nil, "ingress pull url points at a private/loopback/link-local address"},
		{"http://169.254.169.254/latest/meta-data", nil, "ingress pull url points at a private/loopback/link-local address"},
		{"http://[::1]/", nil, "ingress pull url points at a private/loopback/link-local address"},
		{"http://0.0.0.0/", nil, "ingress pull url points at a private/loopback/link-local address"},
		{"srt://127.0.0.1:9000", nil, "ingress pull url points at a private/loopback/link-local address"},
		{"http://meta.evil/", resolveTo("169.254.169.254"), "ingress pull url resolves to a private/loopback/link-local address"},
		{"http://lan.evil/", resolveTo("8.8.8.8", "192.168.1.5"), "ingress pull url resolves to a private/loopback/link-local address"},
		{"http://nx.example/", fail, "ingress pull url host 'nx.example' does not resolve"},
		{"http://empty.example/", resolveTo(), "ingress pull url host 'empty.example' does not resolve"},
	} {
		r := c.resolve
		if r == nil {
			r = func(context.Context, string) ([]string, error) { t.Fatalf("%s dialed DNS", c.url); return nil, nil }
		}
		err := AssertSafePullURL(ctx, c.url, r)
		got := ""
		if err != nil {
			he, ok := errorsAs(err)
			if !ok || he.Status != 400 {
				t.Fatalf("%s: %v", c.url, err)
			}
			got = he.Error()
		}
		if got != c.want {
			t.Errorf("%s: got %q want %q", c.url, got, c.want)
		}
	}
}

func TestJoseSecs(t *testing.T) {
	for in, want := range map[string]int64{"6h": 21600, "30m": 1800, "90s": 90, "1.5 hours": 5400, "2d": 172800, "1w": 604800,
		"1y": 31557600, "+5m": 300, "-5m": -300, "5m ago": -300, "5m from now": 300, "10 SECONDS": 10} {
		if got, err := joseSecs(in); err != nil || got != want {
			t.Errorf("%q → %d %v", in, got, err)
		}
	}
	for _, bad := range []string{"3600", "6 parsecs", "-1h ago", "", "h"} {
		if _, err := joseSecs(bad); err == nil || err.Error() != "Invalid time period format" {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestTsToISO(t *testing.T) {
	for in, want := range map[int64]string{1_700_000_000: "2023-11-14T22:13:20.000Z", 1_700_000_000_123: "2023-11-14T22:13:20.123Z",
		1_700_000_000_123_456: "2023-11-14T22:13:20.123Z", 1_700_000_000_123_456_789: "2023-11-14T22:13:20.123Z"} {
		if got := tsToISO(in); got == nil || *got != want {
			t.Errorf("%d → %v", in, got)
		}
	}
	if tsToISO(0) != nil || tsToISO(-1) != nil {
		t.Fatal("non-positive must be null")
	}
}

// ingress-backup.service.spec + ingress-auth store
func TestIngressStores(t *testing.T) {
	store, _, _ := testutil.Store(t)
	ctx := context.Background()
	b := NewIngressBackup(store.App)
	if err := b.Link(ctx, "a1", "P", "B", "a1-r"); err != nil {
		t.Fatal(err)
	}
	if r, _ := b.GetRoleInfo(ctx, "a1", "P"); r != (IngressRoleInfo{"primary", "B", "P", "B"}) {
		t.Fatal(r)
	}
	if r, _ := b.GetRoleInfo(ctx, "a1", "B"); r != (IngressRoleInfo{"backup", "P", "P", "B"}) {
		t.Fatal(r)
	}
	if r, _ := b.GetRoleInfo(ctx, "a1", "X"); r.Role != "" {
		t.Fatal(r)
	}
	if l, _ := b.GetLinkFor(ctx, "a1", "B"); l == nil || l.CreatedAt == nil || l.App != "a1" {
		t.Fatal(l)
	}
	_ = b.Link(ctx, "a1", "P", "B2", "a1-r") // re-link swaps the backup
	if l, _ := b.GetByPrimary(ctx, "a1", "P"); l.BackupIngressID != "B2" {
		t.Fatal(l)
	}
	if l, _ := b.GetByBackup(ctx, "a1", "B"); l != nil {
		t.Fatal("old backup still linked")
	}
	if l, _ := b.GetLinkFor(ctx, "a2", "P"); l != nil {
		t.Fatal("pairing leaked across apps")
	}
	_ = b.Remove(ctx, "a1", "B2")
	if l, _ := b.GetLinkFor(ctx, "a1", "P"); l != nil {
		t.Fatal("not removed")
	}

	a := NewIngressAuth(store.App)
	pw, _ := a.Register(ctx, "IN", "a1", "a1-r", "SK", true)
	row, _ := a.Get(ctx, "a1", "IN")
	if !row.RequiresPassword || *row.StreamKey != "SK" || row.ValidatedAt != nil || row.SourceURL != nil || len(pw) != 16 {
		t.Fatal(row, pw)
	}
	bad := "nope"
	if ok, _ := a.Validate(ctx, "a1", "IN", &bad); ok {
		t.Fatal("wrong password")
	}
	if ok, _ := a.Validate(ctx, "a1", "IN", nil); ok {
		t.Fatal("no password")
	}
	if ok, _ := a.Validate(ctx, "a1", "IN", &pw); !ok {
		t.Fatal("right password")
	}
	if row, _ = a.Get(ctx, "a1", "IN"); row.ValidatedAt == nil {
		t.Fatal("not marked")
	}
	// re-register resets validation; no-password rows always pass
	_, _ = a.Register(ctx, "IN", "a1", "a1-r", "", false)
	if row, _ = a.Get(ctx, "a1", "IN"); row.ValidatedAt != nil || row.StreamKey != nil || row.RequiresPassword {
		t.Fatal(row)
	}
	if ok, _ := a.IsAuthorized(ctx, "a1", "ghost"); !ok {
		t.Fatal("untracked ingress must be authorized")
	}
	if ok, _ := a.Validate(ctx, "a1", "ghost", &pw); ok {
		t.Fatal("unknown ingress validated")
	}
	id, key, _ := a.RegisterWsIngest(ctx, "a1", "a1-cam")
	if !strings.HasPrefix(id, "wsi_") || len(id) != 16 || !strings.HasPrefix(key, "wsk_") || len(key) != 36 {
		t.Fatal(id, key)
	}
	if r, _ := a.FindByStreamKey(ctx, "a1", key); r == nil || r.IngressID != id || r.CreatedAt == nil {
		t.Fatal(r)
	}
	pid, pkey, _ := a.RegisterPassthrough(ctx, "a1", "a1-r", "mpegts", "udp://@239.1.1.1:5000")
	sid, _, _ := a.RegisterPassthrough(ctx, "a1", "a1-r", "srt", "")
	rid, _, _ := a.RegisterPassthrough(ctx, "a1", "a1-r", "", "")
	if !strings.HasPrefix(pid, "pti_mpegts_") || !strings.HasPrefix(sid, "pti_srt_") || !strings.HasPrefix(pkey, "ptk_") ||
		PassthroughTransportOf(pid) != "mpegts" || PassthroughTransportOf(sid) != "srt" || PassthroughTransportOf(rid) != "rtmp" || !IsPassthroughID(rid) {
		t.Fatal(pid, sid, rid)
	}
	pts, _ := a.ListPassthrough(ctx, "a1")
	ws, _ := a.ListWsIngest(ctx, "a1")
	if len(pts) != 3 || len(ws) != 1 {
		t.Fatal(len(pts), len(ws))
	}
	for _, r := range pts {
		if r.IngressID == pid && (r.SourceURL == nil || *r.SourceURL != "udp://@239.1.1.1:5000") {
			t.Fatal(r)
		}
	}
	_ = a.Remove(ctx, "a1", id)
	if r, _ := a.FindByStreamKey(ctx, "a1", key); r != nil {
		t.Fatal("not removed")
	}
}

// livekit.service.moderation.spec — guard: SDK failure → 503, logged
func TestServiceGuard(t *testing.T) {
	f := &fakeLK{on: func(string, any) (string, bool) { return "!error:twirp error unavailable", true }}
	logs := &fakeLogs{}
	s := NewService(testConfig("livekit"), f.clients(), nil, Optional{Logs: func() Logs { return logs }}, nil)
	ctx := context.Background()
	calls := map[string]func() error{
		"listParticipants":   func() error { _, err := s.ListParticipantsDetailed(ctx, "r"); return err },
		"getParticipant":     func() error { _, err := s.GetParticipant(ctx, "r", "u"); return err },
		"mutePublishedTrack": func() error { _, err := s.MutePublishedTrack(ctx, "r", "u", "t", true); return err },
		"updateParticipant":  func() error { _, err := s.UpdateParticipant(ctx, "r", "u", UpdateParticipantOptions{}); return err },
		"updateSubscriptions": func() error {
			return s.UpdateSubscriptions(ctx, "r", "u", nil, true)
		},
		"updateRoomMetadata": func() error { _, err := s.UpdateRoomMetadata(ctx, "r", "m"); return err },
		"listRooms":          func() error { _, err := s.GetRoom(ctx, "r"); return err },
		"listIngress":        func() error { _, err := s.ListIngress(ctx, ""); return err },
		"listHlsEgress":      func() error { _, err := s.ListHlsEgress(ctx, "p"); return err },
		"listStreamEgress":   func() error { _, err := s.ListStreamEgress(ctx, "p"); return err },
	}
	for op, fn := range calls {
		err := fn()
		he, ok := errorsAs(err)
		if !ok || he.Status != 503 || he.Error() != "LiveKit "+op+" failed: twirp error unavailable" {
			t.Errorf("%s: %v", op, err)
		}
		if !logs.has("livekit", op+" failed: twirp error unavailable") {
			t.Errorf("%s not logged", op)
		}
	}
	if s.IsReachable(ctx) || !logs.has("livekit", "isReachable: ") {
		t.Fatal("reachable on failure")
	}
	// no credentials: the Node SDK's own error, before any I/O
	c := NewClients("ws://127.0.0.1:1", "", "")
	if _, err := c.Room.ListRooms(ctx, &livekit.ListRoomsRequest{}); err == nil || err.Error() != "api-key and api-secret must be set" {
		t.Fatal(err)
	}
	// tokens need credentials too
	cfg := testConfig("livekit")
	cfg.LivekitAPISecret = ""
	if _, err := NewService(cfg, f.clients(), nil, Optional{}, nil).MintToken(MintTokenOptions{Room: "r"}); err == nil ||
		err.Error() != "LiveKit API credentials not configured" {
		t.Fatal(err)
	}
	if HTTPURL("wss://lk.example.com") != "https://lk.example.com" || HTTPURL("ws://h:7880") != "http://h:7880" || HTTPURL("") != "http://127.0.0.1:7880" {
		t.Fatal("http url")
	}
}

// livekit.service.trackegress.spec — the egress is never started when no
// track qualifies; livekit.service.ingress.spec — rejected options retry
// once without opinions, while an option-less request fails as is.
func TestServiceEgressAndFallback(t *testing.T) {
	ctx := context.Background()
	f := &fakeLK{responses: []string{`{"identity":"u","tracks":[{"sid":"V","type":"VIDEO"}]}`}}
	_, err := newTestService(testConfig("livekit"), f).StartTrackCompositeEgress(ctx, TrackCompositeInput{RoomName: "r", ParticipantIdentity: "u", AudioOnly: true})
	if err == nil || err.Error() != "LiveKit startTrackCompositeEgress failed: participant 'u' publishes no audio track" || f.count("StartTrackCompositeEgress") != 0 {
		t.Fatal(err)
	}
	f = &fakeLK{responses: []string{"!error:invalid", `{"ingressId":"I"}`}}
	if _, err := newTestService(testConfig("livekit"), f).CreateIngress(ctx, CreateIngressInput{InputType: "rtmp", ParticipantIdentity: "p"}); err == nil || f.count("CreateIngress") != 1 {
		t.Fatal("legacy profile retried", err)
	}
	f = &fakeLK{responses: []string{"!error:invalid", `{"ingressId":"I"}`}}
	if info, err := newTestService(testConfig("efficient"), f).CreateIngress(ctx, CreateIngressInput{InputType: "rtmp", RoomName: "r", ParticipantIdentity: "p"}); err != nil ||
		info.IngressID != "I" || f.count("CreateIngress") != 2 || strings.Contains(string(f.requests[1].Data), "video") {
		t.Fatal(info, err)
	}
	// an ingress without an explicit identity gets ingress-<uuid>
	f = &fakeLK{}
	req, _ := newTestService(testConfig("livekit"), f).BuildCreateIngressRequest(ctx, CreateIngressInput{InputType: "rtmp"})
	if !strings.HasPrefix(req.ParticipantIdentity, "ingress-") || len(req.ParticipantIdentity) != len("ingress-")+36 {
		t.Fatal(req.ParticipantIdentity)
	}
	// a URL pull without url is a 503, a private url a 400 — before LiveKit
	s := newTestService(testConfig("livekit"), f)
	if _, err := s.CreateIngress(ctx, CreateIngressInput{InputType: "url"}); err == nil || err.Error() != `createIngress: url is required for inputType "url"` {
		t.Fatal(err)
	}
	if _, err := s.CreateIngress(ctx, CreateIngressInput{InputType: "url", URL: "rtsp://192.168.0.2/"}); err == nil || f.count("CreateIngress") != 0 {
		t.Fatal(err)
	}
}

func TestStats(t *testing.T) {
	store, g, dir := testutil.Store(t)
	ctx := context.Background()
	testutil.Exec(t, g, `INSERT INTO apps (name, display_name, livekit_room_prefix) VALUES ('s1', 'S1', 's1')`)
	h, _ := store.App(ctx, "s1")
	testutil.Exec(t, h, `INSERT INTO streams (app_id, stream_id, type, status, room) VALUES (1, 'a', 'webrtc', 'active', 'r'), (1, 'b', 'webrtc', 'ended', 'r')`)
	cfg := testConfig("livekit")
	cfg.DataDir = dir
	f := &fakeLK{on: func(m string, _ any) (string, bool) {
		switch m {
		case "ListRooms":
			return `{"rooms":[{"name":"a"},{"name":"b"}]}`, true
		case "ListEgress":
			return `{"items":[{"status":"EGRESS_ACTIVE"},{"status":"EGRESS_COMPLETE"},{"status":"EGRESS_STARTING"}]}`, true
		case "ListIngress":
			return `{"items":[{"state":{"status":"ENDPOINT_PUBLISHING"}},{}]}`, true
		}
		return "", false
	}}
	st := newStatsSource(cfg, store, *f.clients(), testutil.Log()).Stats(ctx)
	if !st.LivekitReachable || st.Counts.Rooms != 2 || st.Counts.Apps != 1 || st.Counts.ActiveStreams != 1 ||
		st.Egress != (EndpointStatus{true, 2, 3}) || st.Ingress != (EndpointStatus{true, 1, 2}) || len(st.CPU.LoadAvg) != 3 || st.CPU.Cores < 1 {
		t.Fatalf("%+v", st)
	}
	// unconfigured LiveKit: no calls, unreachable
	cfg.LivekitAPIKey = ""
	f.requests = nil
	st = newStatsSource(cfg, store, *f.clients(), testutil.Log()).Stats(ctx)
	if st.LivekitReachable || st.Egress.Reachable || st.Ingress.Reachable || len(f.requests) != 0 {
		t.Fatalf("%+v", st)
	}
}
