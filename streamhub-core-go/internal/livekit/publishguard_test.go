package livekit

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"
)

// AntMedia-matrix quick wins (3.4.0): allowedPublisherCIDR on the publish
// token mint, maxBitrateAccept on LiveKit ingresses (reactive cut).

func TestMintTokenAllowedPublisherCIDR(t *testing.T) {
	h := newHarness(t)
	from := func(ip string, body map[string]any) resp {
		return h.do("POST", "/apps/live/tokens", body, "X-Forwarded-For", ip)
	}
	// off by default: any source mints a publisher token
	expect(t, from("8.8.8.8", map[string]any{"room": "ch1", "identity": "cam"}), 201)

	h.apps.cfgs["live"].Features.AllowedPublisherCidr = []string{"203.0.113.0/24", "2001:db8::/32"}
	h.q.calls = nil
	r := from("8.8.8.8", map[string]any{"room": "ch1", "identity": "cam"})
	expect(t, r, 403)
	if !strings.Contains(r.message(), "not allowed from 8.8.8.8") || len(h.q.calls) != 0 {
		t.Fatalf("refusal %q (quotas touched: %v)", r.message(), h.q.calls)
	}
	if !h.logs.has("livekit", "publisher token refused") {
		t.Fatal("refusal not logged")
	}
	expect(t, from("203.0.113.40", map[string]any{"room": "ch1", "identity": "cam"}), 201)
	expect(t, from("2001:db8::9", map[string]any{"room": "ch1", "identity": "cam", "canPublish": true}), 201)
	// only publish-capable tokens are gated: viewers/recorders come from anywhere
	expect(t, from("8.8.8.8", map[string]any{"room": "ch1", "identity": "v", "canPublish": false}), 201)
	expect(t, from("8.8.8.8", map[string]any{"room": "ch1", "recorder": true}), 201)
	expect(t, h.do("GET", "/apps/live/play-token/ch1", nil, "X-Forwarded-For", "8.8.8.8"), 200)

	// a typo'd list fails closed
	h.apps.cfgs["live"].Features.AllowedPublisherCidr = []string{"203.0.113.0/33"}
	expect(t, from("203.0.113.40", map[string]any{"room": "ch1", "identity": "cam"}), 403)
}

// ingressJSON is one ListIngress item / webhook ingressInfo.
func ingressJSON(id, room, identity, status string, video, audio uint32, startedAt int64) string {
	info := &livekit.IngressInfo{
		IngressId: id, RoomName: room, ParticipantIdentity: identity, InputType: livekit.IngressInput_RTMP_INPUT,
		State: &livekit.IngressState{
			Status:    livekit.IngressState_Status(livekit.IngressState_Status_value[status]),
			Video:     &livekit.InputVideoState{AverageBitrate: video},
			Audio:     &livekit.InputAudioState{AverageBitrate: audio},
			StartedAt: startedAt,
		},
	}
	b, _ := protojson.Marshal(info)
	return string(b)
}

func TestIngressBitrate(t *testing.T) {
	parse := func(s string) *livekit.IngressInfo {
		i := &livekit.IngressInfo{}
		if err := protojson.Unmarshal([]byte(s), i); err != nil {
			t.Fatal(err)
		}
		return i
	}
	if got := IngressBitrate(parse(ingressJSON("I", "r", "p", "ENDPOINT_PUBLISHING", 5_000_000, 128_000, 1))); got != 5_128_000 {
		t.Fatalf("video+audio = %d", got)
	}
	if got := IngressBitrate(parse(ingressJSON("I", "r", "p", "ENDPOINT_BUFFERING", 9_000_000, 0, 1))); got != 0 {
		t.Fatalf("not publishing must read 0, got %d", got)
	}
	if IngressBitrate(nil) != 0 || IngressBitrate(&livekit.IngressInfo{}) != 0 {
		t.Fatal("empty state must read 0")
	}
}

func TestSweepBitrateCutsAboveCap(t *testing.T) {
	h := newHarness(t)
	h.apps.cfgs["other"] = appCfg("other")
	ctx := t.Context()

	// no app with a cap: the sweep never calls LiveKit
	h.m.SweepBitrate(ctx)
	if n := h.lk.count("ListIngress"); n != 0 {
		t.Fatalf("uncapped sweep listed ingresses %d times", n)
	}

	h.apps.cfgs["live"].Features.MaxBitrateAccept = 4_000_000
	list := `{"items":[` + strings.Join([]string{
		ingressJSON("HOT", "live-ch1", "ingress-live", "ENDPOINT_PUBLISHING", 6_000_000, 128_000, 100), // over the cap → cut
		ingressJSON("OK", "live-ch2", "ingress-live", "ENDPOINT_PUBLISHING", 3_800_000, 128_000, 100),  // under (3.928M)
		ingressJSON("IDLE", "live-ch3", "ingress-live", "ENDPOINT_INACTIVE", 9_000_000, 0, 100),        // not publishing
		ingressJSON("ELSE", "other-ch1", "ingress-other", "ENDPOINT_PUBLISHING", 20_000_000, 0, 100),   // uncapped app
		ingressJSON("NOAPP", "nobody-ch1", "ingress-x", "ENDPOINT_PUBLISHING", 20_000_000, 0, 100),     // no app
	}, ",") + `]}`
	h.lk.on = func(method string, _ any) (string, bool) {
		if method == "ListIngress" {
			return list, true
		}
		return "", false
	}
	h.m.SweepBitrate(ctx)
	if n := h.lk.count("RemoveParticipant"); n != 1 {
		t.Fatalf("RemoveParticipant calls = %d (want 1: only HOT)", n)
	}
	var kicked map[string]any
	for _, r := range h.lk.requests {
		if r.Method == "RemoveParticipant" {
			_ = json.Unmarshal(r.Data, &kicked)
		}
	}
	if kicked["room"] != "live-ch1" || kicked["identity"] != "ingress-live" {
		t.Fatalf("kicked %v", kicked)
	}
	if h.lk.count("DeleteIngress") != 0 {
		t.Fatal("INVARIANT: the cut keeps the stream key (no DeleteIngress)")
	}
	ended := h.cb.named("stream_ended")
	if len(ended) != 1 || fmt.Sprint(ended[0].Payload) !=
		"map[bitrate:6.128e+06 ingressId:HOT maxBitrateAccept:4e+06 reason:max_bitrate_exceeded room:live-ch1 streamId:live-ch1/ingress-live]" {
		t.Fatalf("stream_ended = %v", h.cb.events)
	}
	if !h.logs.has("livekit-webhook", "cut ingress publishing above maxBitrateAccept") {
		t.Fatal("cut not logged")
	}

	// the same session (stale state still listed) is not cut/reported twice…
	h.m.SweepBitrate(ctx)
	if n := h.lk.count("RemoveParticipant"); n != 1 || len(h.cb.named("stream_ended")) != 1 {
		t.Fatalf("stale session re-cut: kicks=%d", n)
	}
	// …but a reconnect (new session) still above the cap is cut again
	list = `{"items":[` + ingressJSON("HOT", "live-ch1", "ingress-live", "ENDPOINT_PUBLISHING", 6_000_000, 0, 200) + `]}`
	h.m.SweepBitrate(ctx)
	if n := h.lk.count("RemoveParticipant"); n != 2 {
		t.Fatalf("reconnected session not re-checked: kicks=%d", n)
	}
	// and the same session again once the cooldown has passed
	h.m.now = func() time.Time { return time.Now().Add(bitrateCutCooldown + time.Second) }
	h.m.SweepBitrate(ctx)
	if n := h.lk.count("RemoveParticipant"); n != 3 {
		t.Fatalf("post-cooldown session not re-cut: kicks=%d", n)
	}
}

func TestSweepBitrateKickFailureIsRetried(t *testing.T) {
	h := newHarness(t)
	h.apps.cfgs["live"].Features.MaxBitrateAccept = 1_000_000
	list := `{"items":[` + ingressJSON("HOT", "live-ch1", "ingress-live", "ENDPOINT_PUBLISHING", 2_000_000, 0, 1) + `]}`
	fail := true
	h.lk.on = func(method string, _ any) (string, bool) {
		switch method {
		case "ListIngress":
			return list, true
		case "RemoveParticipant":
			if fail {
				return "!error:down", true
			}
		}
		return "", false
	}
	h.m.SweepBitrate(t.Context())
	if len(h.cb.named("stream_ended")) != 0 || !h.logs.has("livekit-webhook", "maxBitrateAccept enforcement failed") {
		t.Fatalf("failed kick reported as a cut: %v", h.cb.events)
	}
	fail = false
	h.m.SweepBitrate(t.Context())
	if h.lk.count("RemoveParticipant") != 2 || len(h.cb.named("stream_ended")) != 1 {
		t.Fatal("a failed kick must not burn the session's cooldown")
	}
}

func TestWebhookIngressStartedOverCap(t *testing.T) {
	h := newHarness(t)
	h.apps.cfgs["live"].Features.MaxBitrateAccept = 2_000_000
	// not measured yet at start (the common case): business as usual
	expect(t, h.post(`{"event":"ingress_started","ingressInfo":`+ingressJSON("A", "live-r", "ingress-live", "ENDPOINT_BUFFERING", 0, 0, 1)+`}`), 200)
	if len(h.cb.named("stream_started")) != 1 || h.lk.count("RemoveParticipant") != 0 {
		t.Fatalf("unmeasured start: %v", h.cb.events)
	}
	// a state already above the cap is cut before stream_started
	h.cb.events = nil
	expect(t, h.post(`{"event":"ingress_started","ingressInfo":`+ingressJSON("B", "live-r", "ingress-live", "ENDPOINT_PUBLISHING", 3_000_000, 0, 1)+`}`), 200)
	if h.lk.count("RemoveParticipant") != 1 || len(h.cb.named("stream_started")) != 0 || len(h.cb.named("stream_ended")) != 1 {
		t.Fatalf("over-cap start: %v", h.cb.events)
	}
	if len(h.st.upserts) != 1 {
		t.Fatalf("a cut ingress must not be upserted as live: %v", h.st.upserts)
	}
}
