package devices

import (
	"context"
	"net/http"
	"slices"
	"testing"
)

// INVARIANT (E6): linking a channel mints its ingress via the ingress
// service, pushes a new config (rev bumped) carrying the publish URL + key,
// re-linking replaces (and tears down) the old ingress, unlinking and
// revoking delete it, and the stream listing can name the source device.
func TestLinkChannelPushesConfigAndOwnsTheIngress(t *testing.T) {
	h := newHarness(t, true)
	id, cred := h.pair("alpha")
	c, _, err := h.dial(cred)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	writeFrame(t, c, map[string]any{"type": "hello"})
	first := readFrame(t, c)
	if len(first["channels"].([]any)) != 0 {
		t.Fatalf("fresh device has channels: %v", first)
	}

	base := "/api/v1/apps/alpha/devices/" + id + "/channels/"
	r := h.do(http.MethodPut, base+"1", "owner-a", "", map[string]any{"room": "truck2", "protocol": "rtmp", "name": "SDI 1"})
	if r.code != http.StatusOK || r.data()["ingressId"] != "IN_1" || r.data()["room"] != "alpha-truck2" ||
		r.data()["publishUrl"] != "rtmp://media.example.com:1935/live/key1" {
		t.Fatalf("link: %d %s", r.code, r.raw)
	}
	cfg := readFrame(t, c)
	chans := cfg["channels"].([]any)
	if cfg["type"] != "config" || cfg["rev"].(float64) <= first["rev"].(float64) || len(chans) != 1 {
		t.Fatalf("pushed config: %v", cfg)
	}
	ch := chans[0].(map[string]any)
	if ch["id"] != "1" || ch["protocol"] != "rtmp" || ch["streamKey"] != "key1" || ch["publishUrl"] != "rtmp://media.example.com:1935/live/key1" {
		t.Fatalf("config channel: %v", ch)
	}

	// re-link as SRT: new ingress, the old one is torn down
	r = h.do(http.MethodPut, base+"1", "owner-a", "", map[string]any{"room": "truck2", "protocol": "srt"})
	if r.code != http.StatusOK || r.data()["ingressId"] != "IN_2" || r.data()["protocol"] != "srt" {
		t.Fatalf("relink: %d %s", r.code, r.raw)
	}
	if got := h.ing.deletedIDs(); !slices.Equal(got, []string{"IN_1"}) {
		t.Fatalf("old ingress not dropped: %v", got)
	}
	if cfg := readFrame(t, c); cfg["channels"].([]any)[0].(map[string]any)["publishUrl"] != "srt://media.example.com:8890?streamid=publish:alpha/key2" {
		t.Fatalf("relinked config: %v", cfg)
	}

	src := h.svc.SourceDevices(context.Background(), "alpha")
	if sd, ok := src["alpha-truck2"]; !ok || sd.DeviceID != id || sd.Channel != "1" || sd.Name != "Cam truck" {
		t.Fatalf("source devices: %v", src)
	}
	if len(h.svc.SourceDevices(context.Background(), "beta")) != 0 {
		t.Fatal("beta sees alpha's channel")
	}

	// a second channel, then unlink it
	if r := h.do(http.MethodPut, base+"2", "owner-a", "", map[string]any{"room": "truck2b", "protocol": "rtmp"}); r.code != http.StatusOK {
		t.Fatalf("link 2: %d %s", r.code, r.raw)
	}
	readFrame(t, c)
	if r := h.do(http.MethodDelete, base+"2", "owner-a", "", nil); r.code != http.StatusOK || r.data()["ingressId"] != "IN_3" {
		t.Fatalf("unlink: %d %s", r.code, r.raw)
	}
	if cfg := readFrame(t, c); len(cfg["channels"].([]any)) != 1 {
		t.Fatalf("config after unlink: %v", cfg)
	}
	if r := h.do(http.MethodDelete, base+"2", "owner-a", "", nil); r.code != http.StatusNotFound {
		t.Fatalf("unlink twice: %d", r.code)
	}
	if l := h.do(http.MethodGet, "/api/v1/apps/alpha/devices/"+id+"/channels", "owner-a", "", nil); len(l.body["data"].([]any)) != 1 {
		t.Fatalf("list channels: %s", l.raw)
	}

	// revoke tears the remaining ingress down too
	if r := h.do(http.MethodDelete, "/api/v1/apps/alpha/devices/"+id, "owner-a", "", nil); r.code != http.StatusOK {
		t.Fatalf("revoke: %d", r.code)
	}
	if got := h.ing.deletedIDs(); !slices.Equal(got, []string{"IN_1", "IN_3", "IN_2"}) {
		t.Fatalf("ingresses after revoke: %v", got)
	}
	if len(h.svc.SourceDevices(context.Background(), "alpha")) != 0 {
		t.Fatal("revoked device still sources a room")
	}
}

// SECURITY: another app can't link (mint ingress) on a device it doesn't
// own, and the body / channel id are validated.
func TestLinkChannelCrossAppAndValidation(t *testing.T) {
	h := newHarness(t, true)
	id, _ := h.pair("alpha")
	if r := h.do(http.MethodPut, "/api/v1/apps/beta/devices/"+id+"/channels/1", "owner-b", "", map[string]any{"room": "x", "protocol": "rtmp"}); r.code != http.StatusNotFound {
		t.Fatalf("cross-app link: %d %s", r.code, r.raw)
	}
	if len(h.ing.created) != 0 {
		t.Fatalf("cross-app link minted an ingress: %v", h.ing.created)
	}
	base := "/api/v1/apps/alpha/devices/" + id + "/channels/"
	for path, body := range map[string]map[string]any{
		base + "1":     {"room": "x", "protocol": "whip"},
		base + "2":     {"protocol": "rtmp"},
		base + "a%20b": {"room": "x", "protocol": "rtmp"},
	} {
		if r := h.do(http.MethodPut, path, "owner-a", "", body); r.code != http.StatusBadRequest {
			t.Errorf("PUT %s %v: %d %s", path, body, r.code, r.raw)
		}
	}
}
