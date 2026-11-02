package playback

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

type fakeApps struct {
	dir   string
	cfgs  map[string]*contracts.AppConfig
	calls int
	fail  bool
}

func (f *fakeApps) GetConfig(_ context.Context, name string) (*contracts.AppConfig, error) {
	f.calls++
	if f.fail {
		return nil, errors.New("db locked")
	}
	c, ok := f.cfgs[name]
	if !ok {
		return nil, httpx.NotFound(`app "` + name + `" not found`)
	}
	return c, nil
}

func (f *fakeApps) AppDir(name string) string { return filepath.Join(f.dir, name) }

func appCfg(public bool, mod func(*contracts.AppConfig)) *contracts.AppConfig {
	c := &contracts.AppConfig{}
	c.Features.PublicPlayback = public
	if mod != nil {
		mod(c)
	}
	return c
}

// rtFunc is an in-process http.RoundTripper (no network).
type rtFunc func(*http.Request) (*http.Response, error)

func (f rtFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type gfix struct {
	g    *Guard
	apps *fakeApps
	now  time.Time
}

func newGuard(t *testing.T, geo CountryLookup, cfgs map[string]*contracts.AppConfig) *gfix {
	t.Helper()
	dir := t.TempDir()
	for name := range cfgs {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	apps := &fakeApps{dir: dir, cfgs: cfgs}
	g := New(Options{Apps: apps, Secret: "jwt-master", Geo: geo, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	f := &gfix{g: g, apps: apps, now: time.Unix(1_800_000_000, 0)}
	g.now = func() time.Time { return f.now }
	g.resolve = func(context.Context, string) ([]string, error) { return []string{"93.184.216.34"}, nil }
	g.client = &http.Client{Transport: rtFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("unexpected webhook call")
		return nil, nil
	})}
	return f
}

func hlsReq(target, xff string) *http.Request {
	r := httptest.NewRequest("GET", target, nil)
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	return r
}

func TestAuthorizeHLS(t *testing.T) {
	f := newGuard(t, geoIPs, map[string]*contracts.AppConfig{
		"pub":  appCfg(true, nil),
		"priv": appCfg(false, func(c *contracts.AppConfig) { c.Features.HlsTokenTTLSeconds = 600 }),
		"geo":  appCfg(true, func(c *contracts.AppConfig) { c.Features.Geo = &contracts.GeoFeatures{Allow: []string{"AR"}} }),
	})
	g := f.g
	if d := g.AuthorizeHLS(hlsReq("/hls/pub/r/index.m3u8", ""), "pub", "r"); !d.Allowed() || d.Private {
		t.Fatalf("public: %+v", d)
	}
	if d := g.AuthorizeHLS(hlsReq("/hls/nope/r/index.m3u8", ""), "nope", "r"); !d.Allowed() {
		t.Fatalf("unknown app falls through to the 404: %+v", d)
	}
	if f.apps.calls > 1 {
		t.Fatalf("an unknown app must not reach the registry (%d calls)", f.apps.calls)
	}

	d := g.AuthorizeHLS(hlsReq("/hls/priv/r/index.m3u8", ""), "priv", "r")
	if d.Status != 403 || d.Message != msgHLSToken {
		t.Fatalf("private without token: %+v", d)
	}
	grant, err := g.MintHLS(context.Background(), "priv", "r")
	if err != nil || !grant.Required || grant.TTLSeconds != 600 || grant.Exp != f.now.Unix()+600 {
		t.Fatalf("mint: %+v %v", grant, err)
	}
	d = g.AuthorizeHLS(hlsReq("/hls/priv/r/seg.ts?st="+grant.Token, ""), "priv", "r")
	if !d.Allowed() || !d.Private || d.Token != grant.Token {
		t.Fatalf("private with token: %+v", d)
	}
	if d := g.AuthorizeHLS(hlsReq("/hls/priv/other/seg.ts?st="+grant.Token, ""), "priv", "other"); d.Status != 403 {
		t.Fatalf("token reused on another room: %+v", d)
	}
	if d := g.AuthorizeHLS(hlsReq("/hls/pub/r/seg.ts?st="+grant.Token, ""), "pub", "r"); !d.Allowed() || d.Private {
		t.Fatalf("a public app ignores st: %+v", d)
	}
	f.now = f.now.Add(601 * time.Second)
	if d := g.AuthorizeHLS(hlsReq("/hls/priv/r/seg.ts?st="+grant.Token, ""), "priv", "r"); d.Status != 403 || d.Message != msgHLSExpired {
		t.Fatalf("expired: %+v", d)
	}

	// Geo on /hls: the client IP is the right-most X-Forwarded-For entry.
	if d := g.AuthorizeHLS(hlsReq("/hls/geo/r/x.ts", "1.2.3.4, 190.1.1.1"), "geo", "r"); !d.Allowed() {
		t.Fatalf("geo allowed: %+v", d)
	}
	if d := g.AuthorizeHLS(hlsReq("/hls/geo/r/x.ts", "190.1.1.1, 8.8.8.8"), "geo", "r"); d.Status != 403 || d.Code != "geo_blocked" {
		t.Fatalf("geo blocked: %+v", d)
	}
}

func TestAuthorizeHLSFailsClosedAndCaches(t *testing.T) {
	f := newGuard(t, nil, map[string]*contracts.AppConfig{"priv": appCfg(false, nil)})
	before := f.apps.calls
	for i := 0; i < 5; i++ {
		f.g.AuthorizeHLS(hlsReq("/hls/priv/r/i.m3u8", ""), "priv", "r")
	}
	if f.apps.calls-before != 1 {
		t.Fatalf("policy not cached: %d config reads", f.apps.calls-before)
	}
	f.now = f.now.Add(policyTTL + time.Second)
	f.apps.fail = true
	if d := f.g.AuthorizeHLS(hlsReq("/hls/priv/r/i.m3u8", ""), "priv", "r"); d.Status != 403 || d.Message != msgHLSConfig {
		t.Fatalf("unreadable config must deny: %+v", d)
	}
}

func TestMintHLS(t *testing.T) {
	f := newGuard(t, nil, map[string]*contracts.AppConfig{"pub": appCfg(true, nil), "priv": appCfg(false, nil)})
	if g, err := f.g.MintHLS(context.Background(), "pub", "r"); err != nil || g.Required || g.Token != "" {
		t.Fatalf("public: %+v %v", g, err)
	}
	g, err := f.g.MintHLS(context.Background(), "priv", "r")
	if err != nil || g.TTLSeconds != DefaultTTL || VerifyHLS(DeriveKey("jwt-master"), "priv", "r", g.Token, f.now) != TokenOK {
		t.Fatalf("private: %+v %v", g, err)
	}
	if f.g.HLSTokenFor(context.Background(), "pub", "r") != "" || f.g.HLSTokenFor(context.Background(), "priv", "r") == "" {
		t.Fatal("HLSTokenFor")
	}
	// No server secret: a private app cannot mint (and verifies nothing).
	f.g.key = DeriveKey("")
	if _, err := f.g.MintHLS(context.Background(), "priv", "r"); err == nil || !strings.Contains(err.Error(), "STREAMHUB_JWT_SECRET") {
		t.Fatalf("no secret: %v", err)
	}
	if _, err := f.g.MintHLS(context.Background(), "nope", "r"); err == nil {
		t.Fatal("unknown app must not mint")
	}
}

func TestCheckPlaybackGeoAndWebhook(t *testing.T) {
	f := newGuard(t, geoIPs, map[string]*contracts.AppConfig{
		"geo": appCfg(true, func(c *contracts.AppConfig) { c.Features.Geo = &contracts.GeoFeatures{Deny: []string{"US"}} }),
		"hook": appCfg(true, func(c *contracts.AppConfig) {
			c.Features.PlayAuth = &contracts.PlayAuthFeatures{WebhookURL: "https://auth.example.com/play", TimeoutMs: 500}
			c.Callbacks.Secret = "cb-secret"
		}),
		"open": appCfg(true, func(c *contracts.AppConfig) {
			c.Features.PlayAuth = &contracts.PlayAuthFeatures{WebhookURL: "https://auth.example.com/play", TimeoutMs: 500, FailOpen: true}
		}),
		"lan": appCfg(true, func(c *contracts.AppConfig) {
			c.Features.PlayAuth = &contracts.PlayAuthFeatures{WebhookURL: "http://10.0.0.5/play", TimeoutMs: 500}
		}),
	})
	ctx := context.Background()
	req := func(xff string) *http.Request {
		r := hlsReq("/api/v1/apps/x/play-token/r", xff)
		r.Header.Set("User-Agent", "UA/1")
		r.Header.Set("Referer", "https://site.example/")
		return r
	}
	if err := f.g.CheckPlayback(ctx, PlaybackRequest{App: "geo", Room: "r", Mode: "viewer", Req: req("8.8.8.8")}); err == nil ||
		err.Error() != msgGeoBlocked {
		t.Fatalf("geo deny: %v", err)
	}
	if err := f.g.CheckPlayback(ctx, PlaybackRequest{App: "geo", Room: "r", Mode: "viewer", Req: req("190.1.1.1")}); err != nil {
		t.Fatalf("geo pass: %v", err)
	}

	var got PlayAuthRequest
	var sig string
	status := 200
	f.g.client = &http.Client{Transport: rtFunc(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		sig = r.Header.Get("X-StreamHub-Signature")
		m := hmac.New(sha256.New, []byte("cb-secret"))
		m.Write(body)
		if sig != "" && sig != "sha256="+hex.EncodeToString(m.Sum(nil)) {
			t.Errorf("bad signature %q", sig)
		}
		if r.Header.Get("X-StreamHub-Event") != PlayAuthEvent || r.URL.String() != "https://auth.example.com/play" {
			t.Errorf("headers/url %v %s", r.Header, r.URL)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
	})}
	in := PlaybackRequest{App: "hook", Room: "r", Mode: "hls", Token: "viewer-cred", Req: req("190.1.1.1")}
	if err := f.g.CheckPlayback(ctx, in); err != nil {
		t.Fatalf("webhook 200: %v", err)
	}
	if got.App != "hook" || got.Room != "r" || got.Mode != "hls" || got.Token != "viewer-cred" || got.IP != "190.1.1.1" ||
		got.Country != "AR" || got.UserAgent != "UA/1" || got.Referer != "https://site.example/" || sig == "" {
		t.Fatalf("webhook body %+v sig=%q", got, sig)
	}
	for _, s := range []int{403, 302, 500} {
		status = s
		if err := f.g.CheckPlayback(ctx, in); err == nil || err.Error() != msgPlayAuthNok {
			t.Fatalf("webhook %d must deny: %v", s, err)
		}
	}
	// Transport failure: fail closed, unless fail_open.
	f.g.client = &http.Client{Transport: rtFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection refused")
	})}
	if err := f.g.CheckPlayback(ctx, in); err == nil {
		t.Fatal("webhook down must deny")
	}
	if err := f.g.CheckPlayback(ctx, PlaybackRequest{App: "open", Room: "r", Mode: "viewer", Req: req("190.1.1.1")}); err != nil {
		t.Fatalf("fail_open: %v", err)
	}
	// SSRF guard: a private webhook target is never dialled (the transport
	// above would fail the test differently — it must not even be reached).
	f.g.client = &http.Client{Transport: rtFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("private webhook target dialled")
		return nil, nil
	})}
	if err := f.g.CheckPlayback(ctx, PlaybackRequest{App: "lan", Room: "r", Mode: "viewer", Req: req("190.1.1.1")}); err == nil {
		t.Fatal("private webhook target must deny")
	}
}

func TestCheckPublishGeo(t *testing.T) {
	f := newGuard(t, geoIPs, map[string]*contracts.AppConfig{
		"pub": appCfg(true, func(c *contracts.AppConfig) {
			c.Features.Geo = &contracts.GeoFeatures{Allow: []string{"AR"}, Publish: true}
		}),
		"play": appCfg(true, func(c *contracts.AppConfig) { c.Features.Geo = &contracts.GeoFeatures{Allow: []string{"AR"}} }),
	})
	ctx := context.Background()
	if err := f.g.CheckPublish(ctx, "pub", "8.8.8.8"); err == nil || err.Error() != msgPublishGeo {
		t.Fatalf("publish geo deny: %v", err)
	}
	for _, c := range [][2]string{{"pub", "190.1.1.1"}, {"pub", "127.0.0.1"}, {"play", "8.8.8.8"}, {"nope", "8.8.8.8"}} {
		if err := f.g.CheckPublish(ctx, c[0], c[1]); err != nil {
			t.Errorf("%v: %v", c, err)
		}
	}
}

func TestEdgeCacheable(t *testing.T) {
	cfgs := map[string]*contracts.AppConfig{
		"pub":  appCfg(true, nil),
		"priv": appCfg(false, nil),
		"geo":  appCfg(true, func(c *contracts.AppConfig) { c.Features.Geo = &contracts.GeoFeatures{Deny: []string{"US"}} }),
	}
	ctx := context.Background()
	f := newGuard(t, geoIPs, cfgs)
	for app, want := range map[string]bool{"pub": true, "priv": false, "geo": false, "nope": false} {
		if got := f.g.EdgeCacheable(ctx, app); got != want {
			t.Errorf("%s → %v, want %v", app, got, want)
		}
	}
	// geo rules without a loaded base enforce nothing → cacheable
	if !newGuard(t, nil, cfgs).g.EdgeCacheable(ctx, "geo") {
		t.Error("geo without a base must be cacheable")
	}
	// an unreadable config is not
	f.now = f.now.Add(policyTTL + time.Second)
	f.apps.fail = true
	if f.g.EdgeCacheable(ctx, "pub") {
		t.Error("unreadable config must not be cacheable")
	}
}
