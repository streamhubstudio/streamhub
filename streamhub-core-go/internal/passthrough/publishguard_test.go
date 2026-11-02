package passthrough

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/livekit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// features.allowed_publisher_cidr on the MediaMTX auth hook: the encoder's
// `ip` (hook body) is held to the owning app's list, on both planes.

// guardedHooks is newHooks with a PublishGuard over per-app lists.
func guardedHooks(t *testing.T, cidrs map[string][]string) *hookHarness {
	h := newHooks(t, nil)
	guard := &PublishGuard{
		Apps:  func(context.Context) ([]string, error) { return []string{"other", app}, nil },
		CIDRs: func(_ context.Context, a string) []string { return cidrs[a] },
		Keys:  h.keys,
	}
	mux := http.NewServeMux()
	(&Module{Svc: h.svc, Guard: guard}).Register(api.New(mux, "test"))
	h.h = httpx.WithRequest(mux)
	return h
}

func TestHookAuthAllowedPublisherCIDR(t *testing.T) {
	cidrs := map[string][]string{}
	h := guardedHooks(t, cidrs)
	_, ptKey := h.register(t, "ch1", "rtmp", "")
	if _, err := h.keys.Register(bg, "IN_lk", app, "live-ch2", "SK_LK", false); err != nil {
		t.Fatal(err)
	}
	auth := func(path, ip string) int {
		t.Helper()
		code, m := h.do(t, hookReq{path: "auth", body: `{"action":"publish","path":"` + path + `","ip":"` + ip + `"}`})
		if code == 401 && m["message"] != "mediamtx publish denied" {
			t.Fatalf("401 text %v", m)
		}
		return code
	}

	// off: any source, both planes
	if auth("live/"+ptKey, "8.8.8.8") != 200 || auth("live/SK_LK", "8.8.8.8") != 200 {
		t.Fatal("unrestricted app refused a publish")
	}

	cidrs[app] = []string{"203.0.113.0/24"}
	for _, c := range []struct {
		path, ip string
		code     int
	}{
		{"live/" + ptKey, "203.0.113.7", 200}, // passthrough, inside
		{"live/" + ptKey, "8.8.8.8", 401},     // passthrough, outside
		{"live/" + ptKey, "", 401},            // no ip in the hook: fail closed
		{"live/SK_LK", "203.0.113.7", 200},    // LiveKit plane, key owned by the app
		{"live/SK_LK", "8.8.8.8", 401},
		{"live/SK_UNKNOWN", "8.8.8.8", 200},      // no restricted app owns it: LiveKit decides
		{"live/ptk_unknown", "203.0.113.7", 401}, // the key check still runs first
	} {
		if got := auth(c.path, c.ip); got != c.code {
			t.Errorf("%s from %q = %d, want %d", c.path, c.ip, got, c.code)
		}
	}
	// reads are never gated
	if code, _ := h.do(t, hookReq{path: "auth", body: `{"action":"read","path":"live/SK_LK","ip":"8.8.8.8"}`}); code != 200 {
		t.Fatal("read gated")
	}
	if h.sp.count() != 0 {
		t.Fatal("auth hook armed a remux")
	}
}

type failingKeys struct{}

func (failingKeys) FindByStreamKey(context.Context, string, string) (*livekit.IngressAuthRow, error) {
	return nil, errors.New("db down")
}

func TestPublishGuardLookupFailsClosed(t *testing.T) {
	g := &PublishGuard{
		Apps:  func(context.Context) ([]string, error) { return []string{app}, nil },
		CIDRs: func(context.Context, string) []string { return []string{"10.0.0.0/8"} },
		Keys:  failingKeys{},
	}
	if g.Allow(bg, PathClass{Kind: PathLivekit, Key: "SK"}, "10.1.1.1") {
		t.Fatal("a key lookup error on a restricted app must deny")
	}
	var none *PublishGuard
	if !none.Allow(bg, PathClass{Kind: PathLivekit, Key: "SK"}, "") {
		t.Fatal("no guard wired = no restriction")
	}
}
