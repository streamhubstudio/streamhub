package livekit

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"
)

// webhooks.controller.spec — signature, forwarding, stream lifecycle,
// ingress enforcement, egress routing, resilience, auto-record.

// post signs body like LiveKit (Authorization: <jwt> with sha256 claim).
func (h *harness) post(body string) resp {
	h.t.Helper()
	sum := sha256.Sum256([]byte(body))
	tok, err := lkauth.NewAccessToken("APIkey", "secret-0123456789").
		SetValidFor(time.Minute).SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	if err != nil {
		h.t.Fatal(err)
	}
	return h.do("POST", "/webhooks/livekit", body, "Authorization", tok, "Content-Type", "application/webhook+json")
}

func TestWebhookSignature(t *testing.T) {
	h := newHarness(t)
	r := h.post(`{"event":"room_finished","room":{"name":"live-x"}}`)
	if r.Status != 200 || r.Raw != `{"data":{"received":true}}`+"\n" {
		t.Fatalf("ack %d %q", r.Status, r.Raw)
	}
	h.cb.events = nil
	for _, c := range []struct {
		name string
		hdr  []string
		body string
	}{
		{"unsigned", nil, `{"event":"room_started"}`},
		{"garbage", []string{"Authorization", "nope"}, `{}`},
		{"bearer-prefixed", []string{"Authorization", "Bearer x.y.z"}, ""},
	} {
		r := h.do("POST", "/webhooks/livekit", c.body, c.hdr...)
		if r.Status != 401 || r.message() != "invalid LiveKit webhook signature" {
			t.Fatalf("%s: %d %s", c.name, r.Status, r.Raw)
		}
	}
	// a body whose bytes differ from the signed ones is rejected
	sum := sha256.Sum256([]byte(`{"event":"room_started"}`))
	tok, _ := lkauth.NewAccessToken("APIkey", "secret-0123456789").SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	if r := h.do("POST", "/webhooks/livekit", `{"event": "room_started"}`, "Authorization", tok, "Content-Type", "application/webhook+json"); r.Status != 401 {
		t.Fatal(r.Raw)
	}
	// non-JSON content type: Node verifies "{}" (no parser ran)
	sum = sha256.Sum256([]byte(`{}`))
	tok, _ = lkauth.NewAccessToken("APIkey", "secret-0123456789").SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	if len(h.cb.events) != 0 || len(h.st.upserts) != 0 {
		t.Fatal("rejected webhook routed something")
	}
	if !h.logs.has("livekit-webhook", "webhook signature rejected: ") {
		t.Fatal("rejection not logged")
	}
	if r := h.do("POST", "/webhooks/livekit", `ignored`, "Authorization", tok, "Content-Type", "text/plain"); r.Status != 200 {
		t.Fatal(r.Raw)
	}
}

var forwardedEvents = []string{"room_started", "room_finished", "participant_joined", "participant_left", "track_published",
	"track_unpublished", "ingress_started", "ingress_ended", "egress_started", "egress_updated", "egress_ended"}

func TestWebhookForwarding(t *testing.T) {
	for _, ev := range forwardedEvents {
		h := newHarness(t)
		expect(t, h.post(`{"event":"`+ev+`","room":{"name":"live-x"}}`), 200)
		if got := h.cb.named(ev); len(got) != 1 || got[0].App != "live" || got[0].Payload["room"] != "live-x" {
			t.Fatalf("%s not forwarded verbatim: %v", ev, h.cb.events)
		}
	}
	h := newHarness(t)
	expect(t, h.post(`{"event":"track_muted","room":{"name":"live-x"}}`), 200)
	expect(t, h.post(`{"event":"ingress_updated","ingressInfo":{"roomName":"live-x","ingressId":"I"}}`), 200)
	if len(h.cb.named("track_muted"))+len(h.cb.named("ingress_updated")) != 0 {
		t.Fatal("unmapped event forwarded")
	}
	// no app for the room → no callback at all
	h = newHarness(t)
	expect(t, h.post(`{"event":"room_started","room":{"name":"elsewhere"}}`), 200)
	if len(h.cb.events) != 0 {
		t.Fatal("app-less callback")
	}
	// longest room prefix wins
	h.apps.cfgs["live2"] = appCfg("live-ch")
	expect(t, h.post(`{"event":"room_started","room":{"name":"live-ch-1"}}`), 200)
	if h.cb.events[0].App != "live2" {
		t.Fatalf("prefix match %v", h.cb.events)
	}
}

func TestWebhookEventData(t *testing.T) {
	h := newHarness(t)
	expect(t, h.post(`{"event":"track_published","id":"EV","createdAt":"1700000000","room":{"name":"live-r"},
	 "participant":{"identity":"u","name":"N","sid":"PA","permission":{"hidden":false}},
	 "track":{"sid":"TR","type":"VIDEO","source":"CAMERA","muted":true},"unknown":{"x":1}}`), 200)
	got := h.cb.named("track_published")[0].Payload
	if fmt.Sprint(got) != "map[createdAt:1.7e+09 eventId:EV participant:map[hidden:false identity:u name:N sid:PA] room:live-r track:map[muted:true sid:TR source:1 type:1]]" {
		t.Fatalf("data %v", got)
	}
	expect(t, h.post(`{"event":"egress_ended","egressInfo":{"egressId":"E","status":"EGRESS_COMPLETE","roomName":"live-r"},"room":{"name":"live-r"}}`), 200)
	if eg := h.cb.named("egress_ended")[0].Payload["egress"]; fmt.Sprint(eg) != "map[egressId:E roomName:live-r status:3]" {
		t.Fatalf("egress %v", eg)
	}
}

func TestWebhookStreamLifecycle(t *testing.T) {
	h := newHarness(t)
	// a joined subscriber is NOT a stream
	expect(t, h.post(`{"event":"participant_joined","room":{"name":"live-r"},"participant":{"identity":"viewer"}}`), 200)
	if len(h.st.upserts) != 0 || len(h.cb.named("stream_started")) != 0 || len(h.cb.named("participant_joined")) != 1 {
		t.Fatal("participant_joined created a stream")
	}
	// a publisher is: webrtc, canonical key, stream_started + raw event
	expect(t, h.post(`{"event":"track_published","room":{"name":"live-r"},"participant":{"identity":"u1"}}`), 200)
	if h.st.upserts[0] != "live|live-r/u1|webrtc|live-r|u1" {
		t.Fatal(h.st.upserts)
	}
	if s := h.cb.named("stream_started"); len(s) != 1 || fmt.Sprint(s[0].Payload) != "map[participant:u1 room:live-r streamId:live-r/u1 type:webrtc]" {
		t.Fatal(h.cb.events)
	}
	// an INGRESS-kind publisher is an rtmp stream
	expect(t, h.post(`{"event":"track_published","room":{"name":"live-r"},"participant":{"identity":"ing","kind":"INGRESS"}}`), 200)
	if h.st.upserts[1] != "live|live-r/ing|rtmp|live-r|ing" {
		t.Fatal(h.st.upserts)
	}
	// hidden QC: no business, raw event still forwarded
	n := len(h.cb.events)
	expect(t, h.post(`{"event":"track_published","room":{"name":"live-r"},"participant":{"identity":"qc","permission":{"hidden":true}}}`), 200)
	if len(h.st.upserts) != 2 || len(h.cb.events) != n+1 || h.cb.events[n].Event != "track_published" {
		t.Fatal("hidden publisher handled")
	}
	// unpublish / leave end the stream
	for _, ev := range []string{"track_unpublished", "participant_left"} {
		expect(t, h.post(`{"event":"`+ev+`","room":{"name":"live-r"},"participant":{"identity":"u1"}}`), 200)
	}
	if fmt.Sprint(h.st.ended) != "[live|live-r/u1 live|live-r/u1]" || len(h.cb.named("stream_ended")) != 2 {
		t.Fatal(h.st.ended, h.cb.events)
	}
	if p := h.cb.named("stream_ended")[0].Payload; fmt.Sprint(p) != "map[participant:u1 room:live-r streamId:live-r/u1]" {
		t.Fatal(p)
	}
}

func TestWebhookIngress(t *testing.T) {
	h := newHarness(t)
	expect(t, h.post(`{"event":"ingress_started","ingressInfo":{"ingressId":"IN","roomName":"live-r","participantIdentity":"ingress-live","inputType":"WHIP_INPUT"}}`), 200)
	if h.st.upserts[0] != "live|live-r/ingress-live|whip|live-r|ingress-live" {
		t.Fatal(h.st.upserts)
	}
	if p := h.cb.named("stream_started")[0].Payload; fmt.Sprint(p) != "map[ingressId:IN room:live-r streamId:live-r/ingress-live type:whip]" {
		t.Fatal(p)
	}
	// identity unknown: keyed by ingressId, no upsert
	expect(t, h.post(`{"event":"ingress_ended","ingressInfo":{"ingressId":"IN2","roomName":"live-r"}}`), 200)
	if p := h.cb.named("stream_ended")[0].Payload; fmt.Sprint(p) != "map[ingressId:IN2 room:live-r streamId:IN2]" {
		t.Fatal(p)
	}
	// passworded, unvalidated RTMP ingress → terminated + stream_ended(unauthorized)
	ctx := t.Context()
	if _, err := h.m.Auth.Register(ctx, "IN3", "live", "live-r", "SK", true); err != nil {
		t.Fatal(err)
	}
	h.cb.events = nil
	expect(t, h.post(`{"event":"ingress_started","ingressInfo":{"ingressId":"IN3","roomName":"live-r","participantIdentity":"p","inputType":"RTMP_INPUT"}}`), 200)
	if h.lk.count("DeleteIngress") != 1 || len(h.cb.named("stream_started")) != 0 ||
		fmt.Sprint(h.cb.named("stream_ended")[0].Payload) != "map[reason:unauthorized_rtmp_password room:live-r streamId:IN3]" {
		t.Fatal(h.cb.events)
	}
	if a, _ := h.m.Auth.Get(ctx, "live", "IN3"); a != nil {
		t.Fatal("auth row kept")
	}
	// a LiveKit failure on the kill is logged and the ingress proceeds
	_, _ = h.m.Auth.Register(ctx, "IN4", "live", "live-r", "SK", true)
	h.lk.on = func(string, any) (string, bool) { return "!error:down", true }
	h.cb.events = nil
	expect(t, h.post(`{"event":"ingress_started","ingressInfo":{"ingressId":"IN4","roomName":"live-r","participantIdentity":"p"}}`), 200)
	if len(h.cb.named("stream_started")) != 1 || !h.logs.has("livekit-webhook", "ingress auth enforcement failed: ServiceUnavailableException: LiveKit deleteIngress failed: down") {
		t.Fatal(h.cb.events, h.logs.lines)
	}
}

func TestWebhookEgressAndResilience(t *testing.T) {
	h := newHarness(t)
	expect(t, h.post(`{"event":"egress_ended","room":{"name":"live-r"},"egressInfo":{"egressId":"EG","status":"EGRESS_COMPLETE","roomName":"live-r"}}`), 200)
	if fmt.Sprint(h.rec.egress) != "[EG|EGRESS_COMPLETE]" || len(h.cb.named("egress_ended")) != 1 {
		t.Fatal(h.rec.egress, h.cb.events)
	}
	// downstream failures never fail the ack
	h.st.fail, h.cb.fail = true, true
	expect(t, h.post(`{"event":"track_published","room":{"name":"live-r"},"participant":{"identity":"u"}}`), 200)
	if !h.logs.has("livekit-webhook", "streams.upsert failed: ") || !h.logs.has("livekit-webhook", "callbacks.dispatch failed: ") {
		t.Fatal(h.logs.lines)
	}
}

func TestWebhookAutoRecord(t *testing.T) {
	h := newHarness(t)
	write := func(yaml string) {
		dir := h.apps.AppDir("live")
		_ = os.MkdirAll(dir, 0o755)
		if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(yaml), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	started := `{"event":"room_started","room":{"name":"live-r"}}`
	write("name: live\nfeatures:\n  auto_record: true\n")
	expect(t, h.post(started), 200)
	if fmt.Sprint(h.rec.started) != "[live|live-r]" || !h.logs.has("livekit-webhook", "auto-record started on room_started") {
		t.Fatal(h.rec.started)
	}
	for _, y := range []string{"features:\n  auto_record: false\n", "name: live\n", "features:\n  auto_record: 'true'\n", "features: [1]\n", ": bad"} {
		h.rec.started = nil
		write(y)
		expect(t, h.post(started), 200)
		if len(h.rec.started) != 0 {
			t.Fatalf("recorded with %q", y)
		}
	}
	write("features:\n  auto_record: true\n")
	h.rec.started = nil
	expect(t, h.post(`{"event":"room_started","room":{"name":"nowhere"}}`), 200)
	for _, ev := range []string{"room_finished", "participant_joined", "track_published"} {
		expect(t, h.post(`{"event":"`+ev+`","room":{"name":"live-r"}}`), 200)
	}
	if len(h.rec.started) != 0 {
		t.Fatal("recorded off room_started / without app")
	}
	h.rec.startErr = fmt.Errorf("recording is disabled for this app")
	if r := h.post(started); r.Status != 200 || !h.logs.has("livekit-webhook", "auto-record failed: recording is disabled") {
		t.Fatal(r.Raw)
	}
}
