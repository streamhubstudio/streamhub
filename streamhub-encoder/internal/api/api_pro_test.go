package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestProRoutes(t *testing.T) {
	srv, _, _ := setup(t)
	do(t, srv, "POST", "/api/v1/channels", "ek_test", chJSON)
	if c, body, raw := do(t, srv, "POST", "/api/v1/channels/ch1/scte35", "ek_test", `{"outOfNetwork":true,"durationMs":30000}`); c != 200 || body["scheduledPts"].(float64) != 90000 {
		t.Fatalf("scte35 %d %s", c, raw)
	}
	if c, _, raw := do(t, srv, "POST", "/api/v1/channels/ch1/scte35", "ek_test", `{"bogus":1}`); c != 400 {
		t.Fatalf("unknown cue field must be rejected: %d %s", c, raw)
	}
	if c, _, raw := do(t, srv, "GET", "/api/v1/alarms", "ek_test", ""); c != 200 || !strings.Contains(raw, "al-1") {
		t.Fatalf("alarms %d %s", c, raw)
	}
	if c, _, _ := do(t, srv, "POST", "/api/v1/alarms/al-1/ack", "ek_test", ""); c != 200 {
		t.Fatalf("ack %d", c)
	}
	if c, _, _ := do(t, srv, "POST", "/api/v1/alarms/nope/ack", "ek_test", ""); c != 404 {
		t.Fatalf("ack unknown %d", c)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/channels/ch1/thumbnail.jpg", nil)
	req.Header.Set("Authorization", "Bearer ek_test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("thumbnail %v %v", err, resp)
	}
	resp.Body.Close()
	if c, _, _ := do(t, srv, "GET", "/api/v1/channels/ch1/thumbnail.jpg", "", ""); c != 401 {
		t.Fatalf("thumbnail must need auth, got %d", c)
	}
	if c, _, raw := do(t, srv, "PUT", "/api/v1/notify", "ek_test", `{"webhooks":[{"url":"http://127.0.0.1:1/x"}],"snmp":[]}`); c != 200 {
		t.Fatalf("notify put %d %s", c, raw)
	}
	if c, _, raw := do(t, srv, "GET", "/api/v1/notify", "ek_test", ""); c != 200 || !strings.Contains(raw, "127.0.0.1:1") {
		t.Fatalf("notify get %d %s", c, raw)
	}
	if c, _, raw := do(t, srv, "GET", "/api/v1/system/time", "ek_test", ""); c != 200 || !strings.Contains(raw, "synchronized") {
		t.Fatalf("time %d %s", c, raw)
	}
}
