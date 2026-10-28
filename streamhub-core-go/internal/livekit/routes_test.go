package livekit

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// ---------------------------------------------------------------------------
// livekit.controller.spec + livekit.playback.spec — tokens & playback (P0-3)
// ---------------------------------------------------------------------------

func video(t *testing.T, tok string) map[string]any {
	t.Helper()
	v, _ := jwtClaims(t, tok)["video"].(map[string]any)
	return v
}

func TestPublicPlayTokenMintsHiddenSubscribeOnly(t *testing.T) {
	h := newHarness(t)
	r := h.do("GET", "/apps/live/play-token/demo", nil)
	expect(t, r, 200)
	if r.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("missing CORS header")
	}
	d := r.data()
	if d["room"] != "live-demo" || d["mode"] != "viewer" || d["app"] != "live" {
		t.Fatalf("data %v", d)
	}
	c := jwtClaims(t, d["token"].(string))
	if !strings.HasPrefix(c["sub"].(string), "viewer-") || len(c["sub"].(string)) != len("viewer-")+8 {
		t.Fatalf("sub %v", c["sub"])
	}
	v := video(t, d["token"].(string))
	if v["canPublish"] != false || v["canSubscribe"] != true || v["canPublishData"] != false || v["hidden"] != true {
		t.Fatalf("grant %v", v)
	}
	if exp, nbf := c["exp"].(float64), c["nbf"].(float64); exp-nbf != 6*3600 {
		t.Fatalf("ttl %v", exp-nbf)
	}

	// radio listener: same gate, audio-only grant, listener identity
	r = h.do("GET", "/apps/live/radio/demo/listen-token", nil)
	expect(t, r, 200)
	if r.data()["mode"] != "listener" || !strings.HasPrefix(jwtClaims(t, r.data()["token"].(string))["sub"].(string), "listener-") {
		t.Fatalf("listener %v", r.data())
	}
	if _, has := video(t, r.data()["token"].(string))["canPublishSources"]; has {
		t.Fatal("subscribe-only listener must not carry publish sources")
	}
}

func TestPrivatePlaybackRequiresSignedURL(t *testing.T) {
	h := newHarness(t)
	cfg := appCfg("priv")
	cfg.Features.PublicPlayback = false
	h.apps.cfgs["priv"] = cfg

	for _, path := range []string{"/apps/priv/play-token/demo", "/apps/priv/radio/demo/listen-token"} {
		r := h.do("GET", path, nil)
		expect(t, r, 403)
		if r.message() != "playback for this app requires a valid signed URL" || r.Header.Get("Access-Control-Allow-Origin") != "*" {
			t.Fatalf("%s: %s %v", path, r.Raw, r.Header)
		}
	}
	// the authenticated mint round-trips through the gate
	r := h.do("POST", "/apps/priv/play-token/demo/sign", map[string]any{"ttlSeconds": 60})
	expect(t, r, 201)
	d := r.data()
	q := fmt.Sprintf("?exp=%.0f&sig=%s", d["exp"], d["sig"])
	expect(t, h.do("GET", "/apps/priv/play-token/demo"+q, nil), 200)
	expect(t, h.do("GET", "/apps/priv/radio/demo/listen-token"+q, nil), 200)
	// tampered room / extended exp / flipped sig
	expect(t, h.do("GET", "/apps/priv/play-token/other"+q, nil), 403)
	expect(t, h.do("GET", fmt.Sprintf("/apps/priv/play-token/demo?exp=%.0f&sig=%s", d["exp"].(float64)+1, d["sig"]), nil), 403)
	// genuine but expired
	exp := time.Now().Unix() - 10
	r = h.do("GET", fmt.Sprintf("/apps/priv/play-token/demo?exp=%d&sig=%s", exp, SignPlayback("jwt-master", "priv", "demo", exp)), nil)
	expect(t, r, 403)
	if r.message() != "signed playback URL expired" {
		t.Fatal(r.Raw)
	}
}

func TestSignPlaybackURLShape(t *testing.T) {
	h := newHarness(t)
	t.Setenv("PUBLIC_BASE_URL", "https://sh.example.com//")
	r := h.do("POST", "/apps/live/play-token/my%20room/sign", nil)
	expect(t, r, 201)
	d := r.data()
	if d["ttlSeconds"] != float64(300) || d["room"] != "my room" {
		t.Fatalf("data %v", d)
	}
	q := fmt.Sprintf("exp=%.0f&sig=%s", d["exp"], d["sig"])
	if d["embedUrl"] != "https://sh.example.com/embed/live/my%20room?"+q ||
		d["playUrl"] != "https://sh.example.com/play/live/my%20room?"+q ||
		d["tokenUrl"] != "https://sh.example.com/api/v1/apps/live/play-token/my%20room?"+q {
		t.Fatalf("urls %v", d)
	}
	iframe := d["iframe"].(string)
	if !strings.Contains(iframe, `src="`+d["embedUrl"].(string)+`"`) || strings.Contains(iframe, "sk_") || strings.Count(iframe, ".") > 8 {
		t.Fatalf("iframe %s", iframe)
	}
	for _, c := range []struct {
		in   *float64
		want int64
	}{{nil, 300}, {fptr(5), 30}, {fptr(10_000_000), 86400}, {fptr(119.9), 119}, {fptr(-1), 300}} {
		if got := ClampPlaybackTTL(c.in); got != c.want {
			t.Errorf("clamp %v = %d", c.in, got)
		}
	}
	r = h.do("POST", "/apps/live/play-token/demo/sign", map[string]any{"ttlSeconds": 10})
	expect(t, r, 400)
}

func TestMintTokenRoute(t *testing.T) {
	h := newHarness(t)
	// hidden is gated by features.hiddenQc; a hidden/recorder token is subscribe-only
	r := h.do("POST", "/apps/live/tokens", map[string]any{"room": "ch1", "identity": "qc", "hidden": true, "recorder": true})
	expect(t, r, 201)
	d := r.data()
	v := video(t, d["token"].(string))
	if d["hidden"] != false || v["hidden"] != false || v["roomRecord"] != true || v["canPublish"] != false || d["room"] != "live-ch1" {
		t.Fatalf("hidden gate: %v %v", d, v)
	}
	if len(h.q.calls) != 0 {
		t.Fatalf("subscribe-only token counted against quotas: %v", h.q.calls)
	}
	h.apps.cfgs["live"].Features.HiddenQc = true
	r = h.do("POST", "/apps/live/tokens", map[string]any{"hidden": true})
	if d := r.data(); d["hidden"] != true || d["room"] != "live" || d["identity"] != nil {
		t.Fatalf("hidden allowed: %v", d)
	}
	if c := jwtClaims(t, r.data()["token"].(string)); !strings.HasPrefix(c["sub"].(string), "anon-") {
		t.Fatalf("anon identity %v", c["sub"])
	}
	// a publisher token hits both quotas; audioOnly limits sources
	h.apps.cfgs["live"].Quotas = &contracts.AppQuotasConfig{MaxConcurrentStreams: 3}
	r = h.do("POST", "/apps/live/tokens", map[string]any{"room": "live-x", "identity": "", "audioOnly": true, "ttl": "30m"})
	expect(t, r, 201)
	if strings.Join(h.q.calls, ",") != "tenant,app:live" || r.data()["identity"] != "" || r.data()["audioOnly"] != true {
		t.Fatalf("quotas %v data %v", h.q.calls, r.data())
	}
	if v := video(t, r.data()["token"].(string)); fmt.Sprint(v["canPublishSources"]) != "[microphone]" || v["room"] != "live-x" {
		t.Fatalf("grant %v", v)
	}
	// adaptive player: simulcast hint merged into metadata
	h.apps.cfgs["live"].Features.AdaptivePlayer = true
	h.apps.cfgs["live"].Webrtc.Layers = []contracts.WebrtcLayer{{Name: "q", Height: 180}}
	r = h.do("POST", "/apps/live/tokens", map[string]any{"metadata": `{"role":"host"}`})
	c := jwtClaims(t, r.data()["token"].(string))
	if c["metadata"] != `{"role":"host","streamhub":{"simulcast":{"adaptiveStream":true,"simulcast":true,"layers":[{"name":"q","height":180}]}}}` || r.data()["adaptive"] != true {
		t.Fatalf("metadata %v", c["metadata"])
	}
	// player URLs
	if r.data()["playUrl"] != "/play/live/live" || !strings.Contains(r.data()["iframe"].(string), `src="/embed/live/live"`) {
		t.Fatalf("player %v", r.data())
	}
}

// ---------------------------------------------------------------------------
// ingress: create (QW-1, backup, passwords, passthrough), list, get, delete
// ---------------------------------------------------------------------------

const ingressResp = `{"ingressId":"IN_%d","url":"rtmp://10.0.0.5:1935/x","streamKey":"SK_%d","roomName":"live-ch1"}`

func (h *harness) ingressSeq() {
	n := 0
	h.lk.on = func(method string, _ any) (string, bool) {
		if method != "CreateIngress" {
			return "", false
		}
		n++
		return fmt.Sprintf(ingressResp, n, n), true
	}
}

func TestPersistentRoomPrecreate(t *testing.T) {
	h := newHarness(t)
	h.ingressSeq()
	cfg := h.apps.cfgs["live"]
	cfg.Features.Linear = &contracts.LinearChannelFeatures{PersistentRoom: true, RoomEmptyTimeoutSeconds: 7200}
	expect(t, h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "rtmp", "room": "ch1"}), 201)
	if h.lk.requests[0].Method != "CreateRoom" || string(h.lk.requests[0].Data) != `{"name":"live-ch1","emptyTimeout":7200}` ||
		h.lk.requests[1].Method != "CreateIngress" {
		t.Fatalf("order %v", h.lk.requests)
	}
	// fallback 24h; a createRoom hiccup never blocks the ingress
	cfg.Features.Linear.RoomEmptyTimeoutSeconds = 0
	h.lk.requests = nil
	inner := h.lk.on
	h.lk.on = func(m string, r any) (string, bool) {
		if m == "CreateRoom" {
			return "!error:boom", true
		}
		return inner(m, r)
	}
	expect(t, h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "rtmp", "room": "ch1"}), 201)
	if string(h.lk.requests[0].Data) != `{"name":"live-ch1","emptyTimeout":86400}` {
		t.Fatal(string(h.lk.requests[0].Data))
	}
	// persistentRoom:false / no linear block → no pre-create
	for _, lin := range []*contracts.LinearChannelFeatures{{PersistentRoom: false}, nil} {
		cfg.Features.Linear = lin
		h.lk.requests = nil
		expect(t, h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "rtmp"}), 201)
		if h.lk.count("CreateRoom") != 0 {
			t.Fatal("pre-created a normal room")
		}
	}
}

func TestIngressPrimaryBackup(t *testing.T) {
	h := newHarness(t)
	h.ingressSeq()
	r := h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "rtmp", "room": "ch1", "backup": true, "participantName": "Cam"})
	expect(t, r, 201)
	d := r.data()
	if h.lk.count("CreateIngress") != 2 {
		t.Fatal("expected two ingresses")
	}
	p, b := generic(t, h.lk.requests[0].Data).(map[string]any), generic(t, h.lk.requests[1].Data).(map[string]any)
	if p["roomName"] != "live-ch1" || b["roomName"] != "live-ch1" || p["participantIdentity"] != "ingress-live" ||
		b["participantIdentity"] != "ingress-live-backup" || b["participantName"] != "Cam (backup)" {
		t.Fatalf("requests %v %v", p, b)
	}
	if d["role"] != "primary" || d["hasBackup"] != true || d["backupIngressId"] != "IN_2" || d["backup_stream_key"] != "SK_2" ||
		d["rtmp_url"] != "rtmp://rtmp.example.com:1935/live/SK_1" || d["backup_rtmp_url"] != "rtmp://rtmp.example.com:1935/live/SK_2" ||
		d["url"] != "rtmp://rtmp.example.com:1935/x" || d["requires_password"] != false || d["stream_password"] != nil ||
		d["player_url"] != "/play/live/live-ch1" {
		t.Fatalf("data %v", d)
	}
	if _, has := d["rtmps_url"]; has {
		t.Fatal("rtmps_url without RTMPS")
	}
	ctx := t.Context()
	for _, id := range []string{"IN_1", "IN_2"} {
		if ok, _ := h.m.Auth.IsAuthorized(ctx, "live", id); !ok {
			t.Fatalf("%s not authorized", id)
		}
	}
	if l, _ := h.m.Backup.GetLinkFor(ctx, "live", "IN_2"); l == nil || l.PrimaryIngressID != "IN_1" || l.Room != "live-ch1" {
		t.Fatalf("link %v", l)
	}

	// GET: role + sibling key on the primary, role on the backup
	h.lk.on = func(m string, _ any) (string, bool) {
		return `{"items":[{"ingressId":"IN_1","streamKey":"SK_1","roomName":"live-ch1"},{"ingressId":"IN_2","streamKey":"SK_2","roomName":"live-ch1"}]}`, true
	}
	g := h.do("GET", "/apps/live/ingress/IN_1", nil).data()
	if g["role"] != "primary" || g["pairedIngressId"] != "IN_2" || g["backupStreamKey"] != "SK_2" {
		t.Fatalf("get %v", g)
	}
	g = h.do("GET", "/apps/live/ingress/IN_2", nil).data()
	if g["role"] != "backup" || g["pairedIngressId"] != "IN_1" || g["backupStreamKey"] != nil {
		t.Fatalf("get backup %v", g)
	}
	expect(t, h.do("GET", "/apps/live/ingress/IN_9", nil), 404)

	// DELETE the backup: only unlinks; DELETE the primary: cascades
	h.lk.on, h.lk.requests = nil, nil
	r = h.do("DELETE", "/apps/live/ingress/IN_2", nil)
	if r.data()["deleted"] != true || r.data()["backupIngressId"] != nil || h.lk.count("DeleteIngress") != 1 {
		t.Fatalf("delete backup %v", r.Raw)
	}
	if l, _ := h.m.Backup.GetLinkFor(ctx, "live", "IN_1"); l != nil {
		t.Fatal("pair not unlinked")
	}
	if a, _ := h.m.Auth.Get(ctx, "live", "IN_1"); a == nil {
		t.Fatal("primary auth row lost")
	}
}

func TestIngressDeletePrimaryCascades(t *testing.T) {
	h := newHarness(t)
	h.ingressSeq()
	expect(t, h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "rtmp", "backup": true}), 201)
	h.lk.on, h.lk.requests = nil, nil
	r := h.do("DELETE", "/apps/live/ingress/IN_1", nil)
	if r.data()["backupIngressId"] != "IN_2" || h.lk.count("DeleteIngress") != 2 {
		t.Fatalf("cascade %v", r.Raw)
	}
	ctx := t.Context()
	for _, id := range []string{"IN_1", "IN_2"} {
		if a, _ := h.m.Auth.Get(ctx, "live", id); a != nil {
			t.Fatalf("%s auth row left", id)
		}
	}
	if l, _ := h.m.Backup.GetLinkFor(ctx, "live", "IN_2"); l != nil {
		t.Fatal("link left")
	}
}

func TestIngressPasswordPerKey(t *testing.T) {
	h := newHarness(t)
	h.ingressSeq()
	h.apps.cfgs["live"].Features.RtmpPassword = true
	d := h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "rtmp", "backup": true}).data()
	p1, p2 := d["stream_password"].(string), d["backup_stream_password"].(string)
	if d["requires_password"] != true || len(p1) != 16 || len(p2) != 16 || p1 == p2 {
		t.Fatalf("passwords %v", d)
	}
	ctx := t.Context()
	if ok, _ := h.m.Auth.IsAuthorized(ctx, "live", "IN_1"); ok {
		t.Fatal("unvalidated passworded ingress authorized")
	}
	r := h.do("POST", "/apps/live/ingress/IN_1/validate", map[string]any{"password": p2})
	if r.Status != 201 || r.data()["valid"] != false {
		t.Fatalf("cross-key password accepted %s", r.Raw)
	}
	if r := h.do("POST", "/apps/live/ingress/IN_1/validate", map[string]any{"password": p1}); r.data()["valid"] != true {
		t.Fatal(r.Raw)
	}
	if ok, _ := h.m.Auth.IsAuthorized(ctx, "live", "IN_1"); !ok {
		t.Fatal("validated ingress not authorized")
	}
	if ok, _ := h.m.Auth.IsAuthorized(ctx, "live", "IN_2"); ok {
		t.Fatal("backup authorized by the primary's validation")
	}
	expect(t, h.do("POST", "/apps/live/ingress/IN_9/validate", map[string]any{"password": "x"}), 404)
	// whip: no auth row, no rtmp fields
	d = h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "whip", "backup": true}).data()
	if d["role"] != nil || d["rtmp_url"] != nil || d["hasBackup"] != false || d["requires_password"] != false {
		t.Fatalf("whip %v", d)
	}
}

func TestIngressPassthrough(t *testing.T) {
	h := newHarness(t)
	h.ptOn = true
	r := h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "rtmp", "mode": "passthrough", "room": "ch1"})
	expect(t, r, 201)
	d := r.data()
	if h.lk.count("CreateIngress") != 0 || d["mode"] != "passthrough" || d["rtmp_url"] != "rtmp://h:1937/live/ptk_1" ||
		d["inputType"] != "rtmp" || d["stream_key"] != "ptk_1" || d["srt_url"] != nil || h.pt.created[0] != "live|live-ch1|rtmp|" {
		t.Fatalf("passthrough %v %v", d, h.pt.created)
	}
	// default from the app's rtmp.passthrough: an srt body without a mode
	// still fails the DTO over HTTP, but the controller (direct callers,
	// as in the Node spec) lands it on the plane
	h.apps.cfgs["live"].Rtmp.Passthrough = true
	if r := h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "srt"}); r.Status != 400 {
		t.Fatal(r.Raw)
	}
	res, err := h.m.CreateIngressRoute(t.Context(), "live", validate.MustParse(`{"inputType":"srt"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	d = structMap(t, res)
	if d["srt_url"] != "srt://h:9000?streamid=ptk_1" || d["rtmp_url"] != nil || h.pt.created[1] != "live|live|srt|" {
		t.Fatalf("srt %v", d)
	}
	// mpegts: validated pull source
	d = h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "mpegts", "mode": "passthrough", "url": " udp://@239.1.1.1:5000 "}).data()
	if d["source_url"] != "udp://@239.1.1.1:5000?fifo_size=1" {
		t.Fatalf("mpegts %v", d)
	}
	for body, msg := range map[string]string{
		`{"inputType":"rtmp","enableTranscoding":true}`:                       "passthrough (remux) cannot be combined with transcoding — pick one mode",
		`{"inputType":"whip"}`:                                                "passthrough ingress requires inputType=rtmp, inputType=srt or inputType=mpegts",
		`{"inputType":"mpegts","mode":"passthrough"}`:                         "inputType 'mpegts' requires `url` — a udp://@GROUP:PORT source",
		`{"inputType":"mpegts","mode":"passthrough","url":"udp://239.1.1.1"}`: "EOF",
	} {
		r := h.do("POST", "/apps/live/ingress", body)
		if r.Status != 400 || r.message() != msg {
			t.Errorf("%s: %s", body, r.Raw)
		}
	}
	// srt with an explicit transcode mode never reaches LiveKit
	if r := h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "srt", "mode": "transcode"}); r.Status != 400 {
		t.Fatal(r.Raw)
	}
	// DELETE of a pti_ id goes through the plane, never LiveKit
	for _, id := range []string{"pti_abc", "pti_srt_abc"} {
		r := h.do("DELETE", "/apps/live/ingress/"+id, nil)
		if r.data()["mode"] != "passthrough" || r.data()["deleted"] != true || h.lk.count("DeleteIngress") != 0 {
			t.Fatalf("delete %s: %s", id, r.Raw)
		}
	}
	// plane unavailable → 503 / deleted:false
	h.ptOn = false
	if r := h.do("POST", "/apps/live/ingress", map[string]any{"inputType": "rtmp", "mode": "passthrough"}); r.Status != 503 ||
		r.message() != "RTMP/SRT/MPEG-TS passthrough plane is unavailable" {
		t.Fatal(r.Raw)
	}
	if r := h.do("DELETE", "/apps/live/ingress/pti_x", nil); r.data()["deleted"] != false {
		t.Fatal(r.Raw)
	}
}

const ingressList = `{"items":[
 {"ingressId":"IN_a","name":"Cam A","streamKey":"KA","roomName":"live-ch1","inputType":"RTMP_INPUT","state":{"status":"ENDPOINT_PUBLISHING","video":{"averageBitrate":1000,"width":640,"height":360}}},
 {"ingressId":"IN_b","streamKey":"KB","roomName":"live","inputType":"WHIP_INPUT"},
 {"ingressId":"IN_c","streamKey":"KC","roomName":"live-ch2"},
 {"ingressId":"IN_x","streamKey":"KX","roomName":"other-ch1"},
 {"ingressId":"IN_y","streamKey":"KY","roomName":"livex"}]}`

func TestIngressListPaginated(t *testing.T) {
	h := newHarness(t)
	h.lk.on = func(m string, _ any) (string, bool) {
		if m == "ListRooms" {
			return `{"rooms":[{"name":"live-ch1","numParticipants":4},{"name":"live","numParticipants":0}]}`, true
		}
		return ingressList, true
	}
	r := h.do("GET", "/apps/live/ingress", nil)
	expect(t, r, 200)
	data := r.Body["data"].([]any)
	if r.Body["total"] != float64(3) || r.Body["limit"] != float64(50) || r.Body["offset"] != float64(0) || len(data) != 3 {
		t.Fatalf("isolation %s", r.Raw)
	}
	row := data[0].(map[string]any)
	if row["room"] != "live-ch1" || row["stream_key"] != "KA" || row["rtmp_url"] != "rtmp://rtmp.example.com:1935/live/KA" ||
		row["viewers"] != float64(3) || row["status"] != "publishing" || row["bitrate"] != float64(1000) ||
		row["requires_password"] != false || row["inputType"] != "rtmp" || row["startedAt"] != nil {
		t.Fatalf("row %v", row)
	}
	if v := data[1].(map[string]any)["viewers"]; v != float64(0) {
		t.Fatalf("viewers clamp %v", v)
	}
	if v, has := data[2].(map[string]any)["viewers"]; !has || v != nil {
		t.Fatalf("unknown viewers must be null: %v", data[2])
	}
	if h.lk.count("ListRooms") != 1 {
		t.Fatal("one listRooms call per page")
	}
	// paging keeps the filtered total; clamps out-of-range values
	r = h.do("GET", "/apps/live/ingress?limit=1&offset=1", nil)
	if r.Body["total"] != float64(3) || len(r.Body["data"].([]any)) != 1 || r.Body["data"].([]any)[0].(map[string]any)["ingressId"] != "IN_b" {
		t.Fatal(r.Raw)
	}
	r = h.do("GET", "/apps/live/ingress?limit=0&offset=-5", nil)
	if r.Body["limit"] != float64(1) || r.Body["offset"] != float64(0) {
		t.Fatal(r.Raw)
	}
	if r = h.do("GET", "/apps/live/ingress?limit=9999", nil); r.Body["limit"] != float64(500) {
		t.Fatal(r.Raw)
	}
	// filters: bare room gets the prefix; q is a case-insensitive substring
	if r = h.do("GET", "/apps/live/ingress?room=ch1", nil); r.Body["total"] != float64(1) {
		t.Fatal(r.Raw)
	}
	if r = h.do("GET", "/apps/live/ingress?q=CAM%20a", nil); r.Body["total"] != float64(1) {
		t.Fatal(r.Raw)
	}
	// LiveKit rooms hiccup → viewers null, listing still served
	h.lk.on = func(m string, _ any) (string, bool) {
		if m == "ListRooms" {
			return "!error:down", true
		}
		return ingressList, true
	}
	r = h.do("GET", "/apps/live/ingress", nil)
	if r.Status != 200 || r.Body["data"].([]any)[0].(map[string]any)["viewers"] != nil {
		t.Fatal(r.Raw)
	}
	// passthrough rows join the first page only
	h.ptOn = true
	h.pt.rows = []PassthroughInfo{{IngressID: "pti_1", Room: "live-ch9", StreamKey: "ptk_1", InputType: "srt", SrtURL: "srt://x", HlsURL: "/hls/x"}}
	r = h.do("GET", "/apps/live/ingress", nil)
	if r.Body["total"] != float64(4) || len(r.Body["data"].([]any)) != 4 {
		t.Fatal(r.Raw)
	}
	if pr := r.Body["data"].([]any)[3].(map[string]any); pr["mode"] != "passthrough" || pr["srt_url"] != "srt://x" || pr["rtmp_url"] != nil {
		t.Fatalf("pt row %v", pr)
	}
	if r = h.do("GET", "/apps/live/ingress?offset=1", nil); len(r.Body["data"].([]any)) != 2 || r.Body["total"] != float64(4) {
		t.Fatal(r.Raw)
	}
}

// ---------------------------------------------------------------------------
// rooms.controller.spec
// ---------------------------------------------------------------------------

func TestRoomsRBACMetadata(t *testing.T) {
	a := api.New(newMux(), "t")
	newHarness(t).m.Register(a)
	want := map[string]string{
		"RoomsController_listRooms": "stream:read", "RoomsController_getRoom": "stream:read",
		"RoomsController_listParticipants": "stream:read", "RoomsController_updateRoomMetadata": "stream:write",
		"RoomsController_kickParticipant": "stream:write", "RoomsController_muteParticipant": "stream:write",
		"RoomsController_updateParticipant": "stream:write", "RoomsController_updateSubscriptions": "stream:write",
		"RoomsController_sendData": "stream:write", "LiveKitController_listIngress": "ingress:read",
		"LiveKitController_getIngress": "ingress:read", "LiveKitController_createIngress": "ingress:create",
		"LiveKitController_validateIngress": "ingress:write", "LiveKitController_deleteIngress": "ingress:delete",
		"LiveKitController_mintToken": "stream:write", "LiveKitController_signPlaybackUrl": "stream:read",
		"LiveKitController_sendData": "stream:write",
	}
	seen := 0
	for _, item := range a.OpenAPI().Paths {
		for _, o := range []*huma.Operation{item.Get, item.Post, item.Patch, item.Delete} {
			if o == nil {
				continue
			}
			p, ok := authz.RequiredBy(o)
			if w, listed := want[o.OperationID]; listed {
				seen++
				if !ok || p.Resource+":"+p.Action != w {
					t.Errorf("%s requires %v, want %s", o.OperationID, p, w)
				}
			} else if ok {
				t.Errorf("%s unexpectedly requires %v", o.OperationID, p)
			}
		}
	}
	if seen != len(want) {
		t.Fatalf("saw %d of %d permissioned operations", seen, len(want))
	}
}

func TestRoomsListAndMetadata(t *testing.T) {
	h := newHarness(t)
	h.lk.on = func(m string, _ any) (string, bool) {
		switch m {
		case "ListRooms":
			return `{"rooms":[{"name":"live","sid":"R0"},{"name":"live-a","sid":"R1","metadata":"x"},{"name":"other","sid":"R2"},{"name":"livex","sid":"R3"}]}`, true
		case "UpdateRoomMetadata":
			return `{"name":"live-demo","sid":"R9","metadata":"{}"}`, true
		}
		return "", false
	}
	r := h.do("GET", "/apps/live/rooms", nil)
	if names := fmt.Sprint(r.Body["data"]); !strings.Contains(names, "R0") || !strings.Contains(names, "R1") ||
		strings.Contains(names, "R2") || strings.Contains(names, "R3") {
		t.Fatalf("isolation %s", r.Raw)
	}
	r = h.do("GET", "/apps/live/rooms/nope", nil)
	if r.Status != 404 || r.message() != "room 'live-nope' is not live" {
		t.Fatal(r.Raw)
	}
	if r = h.do("GET", "/apps/live/rooms/a", nil); r.data()["metadata"] != "x" {
		t.Fatal(r.Raw)
	}
	r = h.do("PATCH", "/apps/live/rooms/demo/metadata", map[string]any{"metadata": "{}"})
	if r.Status != 200 || r.data()["metadata"] != "{}" || !strings.Contains(string(h.lk.requests[len(h.lk.requests)-1].Data), `"room":"live-demo"`) {
		t.Fatal(r.Raw)
	}
}

const participantJSON = `{"identity":"u1","sid":"PA","permission":{"canPublish":true,"canSubscribe":true,"hidden":true},
 "tracks":[{"sid":"TV","type":"VIDEO"},{"sid":"TA","type":"AUDIO"},{"sid":"TA2","type":"AUDIO"}]}`

func TestRoomsModeration(t *testing.T) {
	h := newHarness(t)
	h.lk.on = func(m string, req any) (string, bool) {
		switch m {
		case "GetParticipant", "UpdateParticipant":
			return participantJSON, true
		case "MutePublishedTrack":
			return "", true
		}
		return "", false
	}
	r := h.do("DELETE", "/apps/live/rooms/demo/participants/u1", nil)
	if r.data()["removed"] != true || r.data()["room"] != "live-demo" || len(h.aud.events) != 1 ||
		h.aud.events[0].Action != "moderation.participant_kicked" || *h.aud.events[0].TargetID != "live-demo" ||
		!h.logs.has("livekit-moderation", "participant kicked") {
		t.Fatalf("kick %s %v", r.Raw, h.aud.events)
	}
	// explicit trackSid: exactly that track, no participant lookup
	h.lk.requests = nil
	r = h.do("POST", "/apps/live/rooms/demo/participants/u1/mute", map[string]any{"trackSid": "TX"})
	if r.Status != 201 || h.lk.count("GetParticipant") != 0 || h.lk.count("MutePublishedTrack") != 1 ||
		fmt.Sprint(r.data()["tracks"]) != "[map[muted:true trackSid:TX]]" {
		t.Fatal(r.Raw)
	}
	// kind=audio resolves the audio sids
	h.lk.requests = nil
	r = h.do("POST", "/apps/live/rooms/demo/participants/u1/mute", map[string]any{"kind": "audio", "muted": false})
	if h.lk.count("MutePublishedTrack") != 2 || r.data()["muted"] != false || h.aud.events[1].Action != "moderation.participant_track_s_muted" {
		t.Fatal(r.Raw)
	}
	// kind=all: every track; none → 404
	h.lk.requests = nil
	h.do("POST", "/apps/live/rooms/demo/participants/u1/mute", map[string]any{})
	if h.lk.count("MutePublishedTrack") != 3 {
		t.Fatal("kind=all")
	}
	h.lk.on = func(m string, _ any) (string, bool) { return `{"identity":"u1"}`, true }
	r = h.do("POST", "/apps/live/rooms/demo/participants/u1/mute", map[string]any{"kind": "video", "muted": false})
	if r.Status != 404 || r.message() != "participant 'u1' has no video tracks to unmute" {
		t.Fatal(r.Raw)
	}
	r = h.do("POST", "/apps/live/rooms/demo/participants/u1/mute", map[string]any{})
	if r.message() != "participant 'u1' has no tracks to mute" {
		t.Fatal(r.Raw)
	}
}

func TestRoomsUpdateParticipantMergesGrant(t *testing.T) {
	h := newHarness(t)
	h.lk.on = func(m string, _ any) (string, bool) { return participantJSON, true }
	r := h.do("PATCH", "/apps/live/rooms/demo/participants/u1", map[string]any{"canSubscribe": false, "name": "N"})
	expect(t, r, 200)
	last := generic(t, h.lk.requests[len(h.lk.requests)-1].Data).(map[string]any)
	// canPublish + hidden kept from the current grant, canSubscribe overridden
	if fmt.Sprint(last["permission"]) != "map[canPublish:true hidden:true]" || last["name"] != "N" {
		t.Fatalf("merged %v", last)
	}
	// without permission fields the grant is never read nor sent
	h.lk.requests = nil
	h.do("PATCH", "/apps/live/rooms/demo/participants/u1", map[string]any{"metadata": "m"})
	if h.lk.count("GetParticipant") != 0 || generic(t, h.lk.requests[0].Data).(map[string]any)["permission"] != nil {
		t.Fatal("permission touched")
	}
	// LiveKit hiccup on the lookup → overrides alone form the set
	h.lk.on = func(m string, _ any) (string, bool) {
		if m == "GetParticipant" {
			return "!error:x", true
		}
		return participantJSON, true
	}
	h.lk.requests = nil
	h.do("PATCH", "/apps/live/rooms/demo/participants/u1", map[string]any{"canPublish": true})
	if fmt.Sprint(generic(t, h.lk.requests[1].Data).(map[string]any)["permission"]) != "map[canPublish:true]" {
		t.Fatal(string(h.lk.requests[1].Data))
	}
	// subscriptions forward trackSids + subscribe
	r = h.do("POST", "/apps/live/rooms/demo/participants/u1/subscriptions", map[string]any{"trackSids": []string{"A"}, "subscribe": true})
	if r.Status != 201 || fmt.Sprint(r.data()) != "map[identity:u1 room:live-demo subscribe:true trackSids:[A]]" {
		t.Fatal(r.Raw)
	}
}

func TestDataPush(t *testing.T) {
	h := newHarness(t)
	r := h.do("POST", "/apps/live/rooms/demo/data", map[string]any{"topic": "chat", "message": "hi", "from": ""})
	if r.Status != 201 || fmt.Sprint(r.data()) != "map[room:live-demo sent:true topic:chat]" {
		t.Fatal(r.Raw)
	}
	req := generic(t, h.lk.requests[0].Data).(map[string]any)
	if req["topic"] != "chat" || req["room"] != "live-demo" {
		t.Fatal(req)
	}
	env := map[string]any{}
	payload := decodeB64(t, req["data"].(string))
	if err := jsonUnmarshal(payload, &env); err != nil || env["message"] != "hi" || env["from"] != "" || env["reaction"] != nil ||
		!strings.HasPrefix(payload, `{"topic":"chat","from":"","message":"hi","ts":"`) {
		t.Fatalf("envelope %s", payload)
	}
	if len(h.cb.events) != 0 {
		t.Fatal("rooms data push fires no callback")
	}
	// gates: chat / reactions disabled → 404
	h.apps.cfgs["live"].Features.Chat = false
	if r := h.do("POST", "/apps/live/rooms/demo/data", map[string]any{"topic": "chat"}); r.Status != 404 || r.message() != "chat is disabled for this app" {
		t.Fatal(r.Raw)
	}
	h.apps.cfgs["live"].Features.Reactions = false
	if r := h.do("POST", "/apps/live/streams/s1/data", map[string]any{"topic": "reaction"}); r.message() != "reactions are disabled for this app" {
		t.Fatal(r.Raw)
	}
	// per-stream push: room from the streams module, callback fired
	h.apps.cfgs["live"].Features.Chat = true
	h.st.rooms["s1"] = "live-cam"
	h.lk.requests = nil
	r = h.do("POST", "/apps/live/streams/s1/data", map[string]any{"topic": "chat", "payload": "raw", "reliable": false})
	if r.data()["room"] != "live-cam" || decodeB64(t, generic(t, h.lk.requests[0].Data).(map[string]any)["data"].(string)) != "raw" {
		t.Fatal(r.Raw)
	}
	if ev := h.cb.named("chat_message"); len(ev) != 1 || ev[0].Payload["streamId"] != "s1" || ev[0].Payload["room"] != "live-cam" {
		t.Fatalf("callback %v", h.cb.events)
	}
	// unknown stream id → treated as a room under the prefix
	if r := h.do("POST", "/apps/live/streams/zz/data", map[string]any{"topic": "x"}); r.data()["room"] != "live-zz" {
		t.Fatal(r.Raw)
	}
}
