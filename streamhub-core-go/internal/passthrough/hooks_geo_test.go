package passthrough

import (
	"context"
	"net/http"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

type fakePublishGeo struct{ asked []string }

func (g *fakePublishGeo) CheckPublish(_ context.Context, app, ip string) error {
	g.asked = append(g.asked, app+"|"+ip)
	if ip == "8.8.8.8" {
		return httpx.Forbidden("publishing is not available from your region")
	}
	return nil
}

// G2: with features.geo publish:true the auth hook also checks the publisher
// IP MediaMTX reports — only for an otherwise authorized passthrough key.
func TestHookAuthPublishGeo(t *testing.T) {
	h := newHooks(t, nil)
	geo := &fakePublishGeo{}
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	(&Module{Svc: h.svc, Geo: geo}).Register(a)
	h.h = httpx.WithRequest(mux)
	_, key := h.register(t, "ch1", "rtmp", "")

	code, m := h.do(t, hookReq{path: "auth", body: `{"action":"publish","path":"live/` + key + `","ip":"8.8.8.8"}`})
	if code != 401 || m["message"] != "mediamtx publish denied: publishing is not available from your region" {
		t.Fatalf("geo deny: %d %v", code, m)
	}
	if code, _ := h.do(t, hookReq{path: "auth", body: `{"action":"publish","path":"live/` + key + `","ip":"190.1.1.1"}`}); code != 200 {
		t.Fatalf("geo pass: %d", code)
	}
	if code, _ := h.do(t, hookReq{path: "auth", body: `{"action":"publish","path":"live/` + key + `"}`}); code != 200 {
		t.Fatalf("no ip: %d", code)
	}
	// Never asked for an unauthorized key, a read or the LiveKit plane.
	for _, body := range []string{`{"action":"publish","path":"live/ptk_unknown","ip":"8.8.8.8"}`,
		`{"action":"read","path":"live/` + key + `","ip":"8.8.8.8"}`, `{"action":"publish","path":"live/sk_x","ip":"8.8.8.8"}`} {
		h.do(t, hookReq{path: "auth", body: body})
	}
	if len(geo.asked) != 2 || geo.asked[0] != "live|8.8.8.8" {
		t.Fatalf("asked %v", geo.asked)
	}
}
