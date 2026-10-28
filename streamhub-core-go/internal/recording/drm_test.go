package recording

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

const (
	drmKeyID  = "0123456789abcdef0123456789abcdef"
	drmSecret = "deadbeefdeadbeefdeadbeefdeadbeef"
)

// ---------------------------------------------------------------------------
// vod-transcode.service.spec — DRM wiring
// ---------------------------------------------------------------------------

func drmCfg(c *contracts.AppConfig) {
	c.Transcoding = contracts.TranscodingConfig{Enabled: true, Encoding: "h264+vp8", VodAdaptive: true,
		VodRenditions: []contracts.VodRendition{{Height: 720, BitrateKbps: 2800}}}
	c.Features.Drm = &contracts.DrmFeatures{Enabled: true, Provider: "external", Systems: []string{"widevine", "playready", "fairplay"},
		Scheme: "cbcs", KeyServerURL: "https://keys.example/speke", LicenseUrls: contracts.DrmLicenseUrls{Widevine: "https://lic.example/wv"}}
}

func encryptDecision() DrmDecision {
	return DrmDecision{Mode: DrmEncrypt, Ctx: &DrmPackagingContext{
		Scheme: "cbcs", Systems: []string{"widevine", "playready", "fairplay"},
		Keys:        DrmContentKeys{AssetID: "rec-1", Keys: []DrmContentKey{{KeyID: drmKeyID, Key: drmSecret}}},
		KeyArgs:     []string{"--enable_raw_key_encryption"},
		LicenseURLs: LicenseURLs{{"widevine", "https://lic.example/wv"}},
		HlsKeyURI:   "skd://rec-1",
	}}
}

func TestDrmFailClosedSkip(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(drmCfg)
	h.svc.decide = func(context.Context, *contracts.AppConfig, string) DrmDecision {
		return DrmDecision{Mode: DrmSkip, Reason: "no packager"}
	}
	id, src := h.seed("rec-1")
	h.process(id, src, false)
	v, _ := h.vods.FindByID(context.Background(), tcApp, id)
	if len(h.s3.uploads) != 0 || len(h.variants(id)) != 0 || h.run.count("-hls_segment_filename") != 0 || h.run.count("libvpx") != 0 ||
		h.meta(id)["drmError"] != "no packager" || v.Status != "ready" || !h.logs.has("drm packaging skipped (fail-closed)") ||
		len(h.dispatched("vod_variants_ready")) != 0 {
		t.Fatal(h.logs.msgs)
	}
}

func TestDrmFailOpenDegradesToClear(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(drmCfg)
	h.svc.decide = func(context.Context, *contracts.AppConfig, string) DrmDecision {
		return DrmDecision{Mode: DrmClearDegraded, Reason: "no keys"}
	}
	id, src := h.seed("rec-1")
	h.process(id, src, false)
	keys := strings.Join(h.s3.keys(), " ")
	for _, k := range []string{"hls/rec-1/720p/index.m3u8", "hls/rec-1/master.m3u8", "rec-1.webm"} {
		if !strings.Contains(keys, k) {
			t.Fatal(keys)
		}
	}
	if h.run.count("--hls_master_playlist_output") != 0 || !h.logs.has("drm degraded to clear packaging (fail_open)") {
		t.Fatal(h.logs.msgs)
	}
}

func shakaTree(outDir string) {
	_ = os.MkdirAll(outDir, 0o755)
	for _, f := range []string{"master.m3u8", "720p.m3u8", "720p.mp4", "audio.m3u8", "audio.mp4"} {
		_ = os.WriteFile(filepath.Join(outDir, f), []byte("drm-"+f), 0o644)
	}
}

func TestDrmEncrypt(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(drmCfg)
	h.svc.decide = func(context.Context, *contracts.AppConfig, string) DrmDecision { return encryptDecision() }
	var job ShakaHlsJob
	h.svc.packager = func(_ context.Context, j ShakaHlsJob) bool { job = j; shakaTree(j.OutDir); return true }
	id, src := h.seed("rec-1")
	h.process(id, src, false)

	if job.AudioSourcePath != src || strings.Join(job.KeyArgs, " ") != "--enable_raw_key_encryption" || len(job.Renditions) != 1 ||
		!strings.HasSuffix(job.Renditions[0].MP4, "drm-mezz/720p.mp4") || h.run.count("+faststart") != 1 {
		t.Fatal(job)
	}
	keys := strings.Join(h.s3.keys(), " ")
	for _, k := range []string{"hls/rec-1/master.m3u8", "hls/rec-1/720p.m3u8", "hls/rec-1/720p.mp4", "hls/rec-1/audio.m3u8", "hls/rec-1/audio.mp4"} {
		if !strings.Contains(keys, k) {
			t.Fatal(keys)
		}
	}
	if strings.Contains(keys, ".ts") || strings.Contains(keys, ".webm") || h.run.count("libvpx") != 0 ||
		h.s3.find("hls/rec-1/720p.mp4").ContentType != "video/mp4" {
		t.Fatal(keys)
	}
	rows := h.variants(id)
	if shape(rows) != "master/hls-drm/null,rendition/hls-cmaf-cbcs/720" {
		t.Fatal(shape(rows))
	}
	if *rows[0].ExtraJSON != `{"scheme":"cbcs","systems":["widevine","playready","fairplay"],"keyIds":["`+drmKeyID+
		`"],"licenseUrls":{"widevine":"https://lic.example/wv"},"hlsKeyUri":"skd://rec-1","audioKeys":["hls/rec-1/audio.m3u8","hls/rec-1/audio.mp4"]}` ||
		*rows[1].ExtraJSON != `{"segmentKeys":["hls/rec-1/720p.mp4"],"drm":true}` || *rows[1].SizeBytes != 20 {
		t.Fatal(*rows[0].ExtraJSON, *rows[1].ExtraJSON)
	}
	for _, r := range rows {
		if r.ExtraJSON != nil && strings.Contains(*r.ExtraJSON, drmSecret) {
			t.Fatal("content key persisted")
		}
	}
	m := h.meta(id)
	if m["hlsMasterKey"] != "hls/rec-1/master.m3u8" || m["drm"].(map[string]any)["scheme"] != "cbcs" {
		t.Fatal(m)
	}
	v, _ := h.vods.FindByID(context.Background(), tcApp, id)
	ev := h.dispatched("vod_variants_ready")
	if strings.Contains(*v.MetatagsJSON, drmSecret) || len(ev) != 1 || strings.Contains(ev[0].Body, drmSecret) ||
		!strings.Contains(ev[0].Body, `"webmKey":null,"drm":{"scheme":"cbcs"`) || !strings.Contains(ev[0].Body, `"keyIds":["`+drmKeyID+`"]`) {
		t.Fatal(ev)
	}
	for _, l := range h.logs.msgs {
		if strings.Contains(l, drmSecret) {
			t.Fatal("content key logged")
		}
	}
}

func TestDrmEncryptPackagerFailureHasNoClearFallback(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(drmCfg)
	h.svc.decide = func(context.Context, *contracts.AppConfig, string) DrmDecision { return encryptDecision() }
	h.svc.packager = func(context.Context, ShakaHlsJob) bool { return false }
	id, src := h.seed("rec-1")
	h.process(id, src, false)
	v, _ := h.vods.FindByID(context.Background(), tcApp, id)
	if len(h.s3.uploads) != 0 || len(h.variants(id)) != 0 || h.run.count("-hls_segment_filename") != 0 ||
		h.meta(id)["drmError"] != "shaka-packager run failed" || v.Status != "ready" {
		t.Fatal(h.meta(id))
	}
}

func TestDrmAbsentStaysClear(t *testing.T) {
	h := newTcHarness(t)
	h.apps.cfg = tcConfig(func(c *contracts.AppConfig) {
		c.Transcoding = contracts.TranscodingConfig{Enabled: true, VodAdaptive: true, Encoding: "h264",
			VodRenditions: []contracts.VodRendition{{Height: 720, BitrateKbps: 2800}}}
	})
	id, src := h.seed("rec-1")
	h.process(id, src, false)
	if h.run.count("--version") != 0 || h.run.count("--hls_master_playlist_output") != 0 || h.s3.find("hls/rec-1/master.m3u8") == nil || len(h.variants(id)) == 0 {
		t.Fatal(h.run.calls)
	}
}

// ---------------------------------------------------------------------------
// drm.service — the guard chain
// ---------------------------------------------------------------------------

type drmSecretsFake map[string]string

func (s drmSecretsFake) Get(ref string) (string, bool) { v, ok := s[ref]; return v, ok }

func TestDrmDecide(t *testing.T) {
	ResetShakaAvailabilityCache()
	defer ResetShakaAvailabilityCache()
	cfg := tcConfig(drmCfg)
	cfg.Features.Drm.KeyServerTokenEnv = "KS_TOKEN"
	ctx := context.Background()
	var gotAuth string
	client := &http.Client{Transport: drmTransport(func(r *http.Request) (*http.Response, error) {
		gotAuth = r.Header.Get("authorization")
		return drmJSON(200, `{"keys":[{"key_id":"`+drmKeyID+`","key":"`+drmSecret+`"}],"hls_key_uri":"skd://k"}`), nil
	})}
	run := &tcRunner{}
	s := NewDrmService(drmSecretsFake{"KS_TOKEN": "tok-1"}, run, nil)
	s.Client = client

	// disabled → clear (no probe, no dial)
	off := tcConfig(nil)
	if d := s.Decide(ctx, off, "a"); d.Mode != DrmClear || len(run.calls) != 0 {
		t.Fatal(d)
	}
	// provider not configured
	nk := tcConfig(drmCfg)
	nk.Features.Drm.KeyServerURL = ""
	if d := s.Decide(ctx, nk, "a"); d.Mode != DrmSkip || d.Reason != `drm provider "external" is not configured (set features.drm.provider=external + key_server_url)` {
		t.Fatal(d)
	}
	nk.Features.Drm.FailOpen = true
	if d := s.Decide(ctx, nk, "a"); d.Mode != DrmClearDegraded {
		t.Fatal(d)
	}
	// packager missing (probe fails, cached)
	failRun := &probeRunner{err: errors.New("ENOENT")}
	s2 := NewDrmService(nil, failRun, nil)
	s2.Client = client
	if d := s2.Decide(ctx, cfg, "a"); d.Mode != DrmSkip || d.Reason != "shaka-packager binary not found (install it in the core image or set SHAKA_PACKAGER_BIN)" {
		t.Fatal(d)
	}
	s2.Decide(ctx, cfg, "a")
	if failRun.n != 1 {
		t.Fatal("probe not cached", failRun.n)
	}
	ResetShakaAvailabilityCache()
	// encrypt with the bearer token, license URLs in systems order
	d := s.Decide(ctx, cfg, "rec-1")
	if d.Mode != DrmEncrypt || gotAuth != "Bearer tok-1" || d.Ctx.HlsKeyURI != "skd://k" || d.Ctx.Keys.Keys[0].Key != drmSecret ||
		strings.Join(d.Ctx.KeyArgs, " ") != "--enable_raw_key_encryption --protection_scheme cbcs --clear_lead 0 --keys label=:key_id="+drmKeyID+":key="+drmSecret+" --hls_key_uri skd://k" {
		t.Fatal(d.Ctx)
	}
	if b, _ := json.Marshal(d.Ctx.LicenseURLs); string(b) != `{"widevine":"https://lic.example/wv"}` {
		t.Fatal(string(b))
	}
	// key server returns nothing
	s.Client = &http.Client{Transport: drmTransport(func(*http.Request) (*http.Response, error) { return drmJSON(200, `{"keys":[]}`), nil })}
	if d := s.Decide(ctx, cfg, "a"); d.Mode != DrmSkip || d.Reason != "key server returned no content keys" {
		t.Fatal(d)
	}
}

type probeRunner struct {
	err error
	n   int
}

func (p *probeRunner) Run(context.Context, string, []string, time.Duration) ([]byte, error) {
	p.n++
	return nil, p.err
}

// ---------------------------------------------------------------------------
// drm-provider.spec / external-drm.provider
// ---------------------------------------------------------------------------

type drmTransport func(*http.Request) (*http.Response, error)

func (f drmTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func drmJSON(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}

func extCfg(mod func(*contracts.DrmFeatures)) contracts.DrmFeatures {
	f := contracts.DrmFeatures{Enabled: true, Provider: "external", Systems: []string{"widevine", "playready", "fairplay"},
		Scheme: "cbcs", KeyServerURL: "https://keys.example/speke"}
	if mod != nil {
		mod(&f)
	}
	return f
}

func TestDrmNoopProvider(t *testing.T) {
	p := NoopDrmProvider{}
	if p.Ready() || p.GetContentKeys(context.Background(), "a") != nil || p.GetLicenseURL("widevine") != "" || len(p.PackagingArgs(DrmContentKeys{}, "cbcs")) != 0 || p.ID() != "none" {
		t.Fatal("noop not inert")
	}
}

func TestDrmExternalProvider(t *testing.T) {
	ctx := context.Background()
	dialed := 0
	never := &http.Client{Transport: drmTransport(func(*http.Request) (*http.Response, error) { dialed++; return nil, errors.New("x") })}
	for _, m := range []func(*contracts.DrmFeatures){
		func(f *contracts.DrmFeatures) { f.Enabled = false },
		func(f *contracts.DrmFeatures) { f.Provider = "none" },
		func(f *contracts.DrmFeatures) { f.KeyServerURL = "" },
	} {
		p := NewExternalDrmProvider(extCfg(m), "", never)
		if p.Ready() || p.GetContentKeys(ctx, "v") != nil {
			t.Fatal("not-ready provider answered")
		}
	}
	if dialed != 0 || !NewExternalDrmProvider(extCfg(nil), "", never).Ready() {
		t.Fatal("dialed while not ready")
	}

	var req *http.Request
	var body string
	respond := func(resp string) *http.Client {
		return &http.Client{Transport: drmTransport(func(r *http.Request) (*http.Response, error) {
			req = r
			b, _ := io.ReadAll(r.Body)
			body = string(b)
			return drmJSON(200, resp), nil
		})}
	}
	p := NewExternalDrmProvider(extCfg(func(f *contracts.DrmFeatures) { f.Systems, f.Scheme = []string{"widevine"}, "cenc" }), "tok-123",
		respond(`{"keys":[{"key_id":"`+drmKeyID+`","key":"`+drmSecret+`"}]}`))
	k := p.GetContentKeys(ctx, "vod-1")
	if b, _ := json.Marshal(k); string(b) != `{"assetId":"vod-1","keys":[{"keyId":"`+drmKeyID+`","key":"`+drmSecret+`"}]}` {
		t.Fatal(string(b))
	}
	if req.Method != "POST" || req.URL.String() != "https://keys.example/speke" || req.Header.Get("authorization") != "Bearer tok-123" ||
		req.Header.Get("content-type") != "application/json" || body != `{"asset_id":"vod-1","systems":["widevine"],"scheme":"cenc"}` {
		t.Fatal(req.Header, body)
	}
	NewExternalDrmProvider(extCfg(nil), "", respond(`{"keys":[{"key_id":"`+drmKeyID+`","key":"`+drmSecret+`"}]}`)).GetContentKeys(ctx, "v")
	if _, has := req.Header["Authorization"]; has {
		t.Fatal("authorization without a token")
	}

	// normalisation: camelCase / 0x / UUID dashes / uppercase
	k = NewExternalDrmProvider(extCfg(nil), "", respond(`{"keys":[{"keyId":"0x`+strings.ToUpper(drmKeyID)+
		`","key":"01234567-89ab-cdef-0123-456789abcdef","iv":"`+strings.ToUpper(drmSecret)+`"}]}`)).GetContentKeys(ctx, "vod-1")
	if k == nil || k.Keys[0] != (DrmContentKey{drmKeyID, drmKeyID, drmSecret}) {
		t.Fatal(k)
	}
	// invalid keys dropped; all invalid → nil
	if NewExternalDrmProvider(extCfg(nil), "", respond(`{"keys":[{"key_id":"short","key":"`+drmSecret+`"},{"key_id":"`+drmKeyID+`","key":"not-hex!"},{"key_id":"`+drmKeyID+`"}]}`)).GetContentKeys(ctx, "v") != nil {
		t.Fatal("invalid keys accepted")
	}
	// pssh + hls_key_uri pass through (unknown systems dropped)
	k = NewExternalDrmProvider(extCfg(nil), "", respond(`{"keys":[{"key_id":"`+drmKeyID+`","key":"`+drmSecret+`"}],
	 "pssh":[{"system":"Widevine","box":"AAAA"},{"system":"verimatrix","box":"BBBB"},{"system":"playready","boxBase64":"CCCC"}],"hls_key_uri":" skd://vod-1 "}`)).GetContentKeys(ctx, "vod-1")
	if b, _ := json.Marshal(k); string(b) != `{"assetId":"vod-1","keys":[{"keyId":"`+drmKeyID+`","key":"`+drmSecret+
		`"}],"pssh":[{"system":"widevine","boxBase64":"AAAA"},{"system":"playready","boxBase64":"CCCC"}],"hlsKeyUri":"skd://vod-1"}` {
		t.Fatal(string(b))
	}
	// non-2xx / malformed JSON / transport error / non-object → nil
	for _, c := range []*http.Client{
		{Transport: drmTransport(func(*http.Request) (*http.Response, error) { return drmJSON(500, `{}`), nil })},
		{Transport: drmTransport(func(*http.Request) (*http.Response, error) { return drmJSON(200, `{bad`), nil })},
		{Transport: drmTransport(func(*http.Request) (*http.Response, error) { return nil, errors.New("ECONNREFUSED") })},
		{Transport: drmTransport(func(*http.Request) (*http.Response, error) { return drmJSON(200, `"nope"`), nil })},
	} {
		if NewExternalDrmProvider(extCfg(nil), "", c).GetContentKeys(ctx, "v") != nil {
			t.Fatal("failure answered keys")
		}
	}
	// license URLs: only enabled systems with a URL
	lp := NewExternalDrmProvider(extCfg(func(f *contracts.DrmFeatures) {
		f.Systems = []string{"widevine", "fairplay"}
		f.LicenseUrls = contracts.DrmLicenseUrls{Widevine: "https://lic.example/wv", Playready: "https://lic.example/pr"}
	}), "", never)
	if lp.GetLicenseURL("widevine") != "https://lic.example/wv" || lp.GetLicenseURL("playready") != "" || lp.GetLicenseURL("fairplay") != "" {
		t.Fatal("license urls")
	}
	if strings.Join(lp.PackagingArgs(DrmContentKeys{AssetID: "v", Keys: []DrmContentKey{{KeyID: drmKeyID, Key: drmSecret}}}, "cbcs"), " ") !=
		"--enable_raw_key_encryption --protection_scheme cbcs --clear_lead 0 --keys label=:key_id="+drmKeyID+":key="+drmSecret {
		t.Fatal("packaging args")
	}
}

// ---------------------------------------------------------------------------
// drm-config.spec / drm-packager.util.spec
// ---------------------------------------------------------------------------

func TestDrmConfigResolve(t *testing.T) {
	def := ResolveDrmFeatures(nil)
	if def.Enabled || def.Provider != "none" || def.Scheme != "cbcs" || strings.Join(def.Systems, ",") != "widevine,playready,fairplay" || def.FailOpen {
		t.Fatal(def)
	}
	parse := func(s string) any { v, _ := yamljs.ParseJSON([]byte(s)); return v }
	if f := ResolveDrmFeatures(parse(`{"enabled":"true","fail_open":1}`)); f.Enabled || f.FailOpen {
		t.Fatal("non-boolean switches enabled")
	}
	if f := ResolveDrmFeatures(parse(`{"provider":"External","systems":["PlayReady","x","playready"],"scheme":"CENC"}`)); f.Provider != "external" ||
		strings.Join(f.Systems, ",") != "playready" || f.Scheme != "cenc" {
		t.Fatal(f)
	}
	if f := ResolveDrmFeatures(parse(`{"systems":[],"license_urls":{"widevine":7}}`)); len(f.Systems) != 3 || f.LicenseUrls.Widevine != "" {
		t.Fatal(f)
	}
	full := extCfg(func(f *contracts.DrmFeatures) { f.FailOpen, f.KeyServerTokenEnv = true, "T" })
	disk := DrmFeaturesToDisk(full)
	s, _ := yamljs.Stringify(disk)
	if !strings.HasPrefix(s, `{"enabled":true,"provider":"external","systems":["widevine","playready","fairplay"],"scheme":"cbcs","key_server_url":`) {
		t.Fatal(s)
	}
	back := ResolveDrmFeatures(parse(s))
	if b1, _ := json.Marshal(back); string(b1) != mustJSON(full) {
		t.Fatal(string(b1))
	}
}

func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestDrmPackagerShellOut(t *testing.T) {
	t.Setenv("SHAKA_PACKAGER_BIN", "")
	if ShakaPackagerBin() != "packager" {
		t.Fatal(ShakaPackagerBin())
	}
	t.Setenv("SHAKA_PACKAGER_BIN", " /opt/shaka/packager ")
	if ShakaPackagerBin() != "/opt/shaka/packager" {
		t.Fatal(ShakaPackagerBin())
	}
	ResetShakaAvailabilityCache()
	defer ResetShakaAvailabilityCache()
	const noBin = "streamhub-definitely-not-a-packager-xyz"
	ctx := context.Background()
	if IsShakaPackagerAvailable(ctx, ExecRunner{}, noBin) || IsShakaPackagerAvailable(ctx, ExecRunner{}, noBin) {
		t.Fatal("missing binary available")
	}
	out := t.TempDir()
	if PackageDrmHls(ctx, ExecRunner{}, ShakaHlsJob{Renditions: []ShakaRendition{{720, "/nope/720p.mp4"}}, AudioSourcePath: "/nope/s.mp4", OutDir: out, Bin: noBin}) {
		t.Fatal("packaged without a binary")
	}
	// success = master.m3u8 exists afterwards
	run := &tcRunner{pkg: shakaTree}
	if !PackageDrmHls(ctx, run, ShakaHlsJob{Renditions: []ShakaRendition{{720, "/w/720p.mp4"}}, AudioSourcePath: "/w/s.mp4", OutDir: filepath.Join(out, "o")}) ||
		run.calls[0][0] != "/opt/shaka/packager" {
		t.Fatal(run.calls)
	}
}
