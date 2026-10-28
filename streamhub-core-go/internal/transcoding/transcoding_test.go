package transcoding

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/system"
)

// transcoding.service.spec invariants.

type fakeApps struct {
	cfg     *contracts.AppConfig
	patches []contracts.AppConfigPatch
	rawErr  error
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Get(context.Context, string) (*contracts.AppRecord, error) { return nil, nil }
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(_ context.Context, n string) (*contracts.AppConfig, error) {
	if f.rawErr != nil {
		return nil, f.rawErr
	}
	if f.cfg == nil {
		return nil, httpx.NotFound(`app "` + n + `" not found`)
	}
	return f.cfg, nil
}
func (f *fakeApps) UpdateConfig(_ context.Context, _ string, p contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	f.patches = append(f.patches, p)
	return f.cfg, nil
}
func (f *fakeApps) AppDir(string) string { return "" }

type fakeHw struct{ mode string }

func (h *fakeHw) GetMode(string) system.HwaccelMode { return h.mode }
func (h *fakeHw) SetMode(_ string, m system.HwaccelMode) (system.HwaccelMode, error) {
	h.mode = m
	return m, nil
}
func (h *fakeHw) Resolve(context.Context, string) system.HwaccelDecision {
	return system.HwaccelDecision{Requested: h.mode, Effective: "cpu", Type: "none", Reason: "no GPU"}
}

func base() *contracts.AppConfig {
	c := &contracts.AppConfig{Name: "live"}
	c.Webrtc.Layers = []contracts.WebrtcLayer{{Name: "high", Height: 720}}
	c.Webrtc.TranscodeMaxHeight = 720
	c.Rtmp.Enabled, c.Rtmp.Transcode = true, true
	return c
}

func TestConfigView(t *testing.T) {
	ctx := context.Background()
	apps := &fakeApps{cfg: base()}
	s := New(apps, nil, &fakeHw{mode: "auto"})
	v, err := s.GetConfigView(ctx, "live")
	if err != nil {
		t.Fatal(err)
	}
	tc := v.Transcoding
	if tc.Enabled || tc.Encoding != "h264" || tc.VodAdaptive || len(tc.VodRenditions) != 0 || tc.VodRenditions == nil ||
		tc.Hwaccel != "auto" || tc.HwaccelResolved.Effective != "cpu" || v.Variables == nil {
		t.Fatalf("%+v", v)
	}
	apps.cfg.Timezone = "America/Argentina/Buenos_Aires"
	apps.cfg.Webrtc.Layers = nil
	v, _ = s.GetConfigView(ctx, "live")
	if v.Timezone != "America/Argentina/Buenos_Aires" || !reflect.DeepEqual(v.Layers, DefaultLayers()) {
		t.Fatal(v.Timezone, v.Layers)
	}
	// unknown app: the apps 404 passes through; a raw error is a 404 too
	apps.cfg = nil
	if _, err := s.GetConfigView(ctx, "x"); err == nil || err.Error() != `app "x" not found` {
		t.Fatal(err)
	}
	apps.rawErr = errors.New("disk")
	if _, err := s.LayersForApp(ctx, "x"); err == nil || err.Error() != `App "x" not found` {
		t.Fatal(err)
	}
}

func patch(t *testing.T, s *Service, body string) {
	t.Helper()
	b := validate.MustParse(body)
	patchRules(b)
	if err := b.Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateConfig(context.Background(), "live", b); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateConfigMapping(t *testing.T) {
	apps := &fakeApps{cfg: base()}
	hw := &fakeHw{mode: "auto"}
	s := New(apps, nil, hw)
	patch(t, s, `{"transcodingEnabled":true,"encoding":"h264+vp8","vodAdaptive":true,"vodRenditions":[{"height":720,"bitrateKbps":2800}]}`)
	p := apps.patches[0].Transcoding
	if p == nil || !*p.Enabled || *p.Encoding != "h264+vp8" || !*p.VodAdaptive || len(p.VodRenditions) != 1 || apps.patches[0].Webrtc != nil {
		t.Fatalf("%+v", apps.patches[0])
	}
	// a partial patch keeps the other transcoding fields from the current config
	apps.cfg.Transcoding = contracts.TranscodingConfig{Enabled: true, Encoding: "h264+vp8", VodAdaptive: true, VodRenditions: []contracts.VodRendition{{Height: 360, BitrateKbps: 800}}}
	patch(t, s, `{"encoding":"h264"}`)
	p = apps.patches[1].Transcoding
	if !*p.Enabled || *p.Encoding != "h264" || !*p.VodAdaptive || p.VodRenditions[0].Height != 360 {
		t.Fatalf("%+v", p)
	}
	// no related field → no transcoding block; ladder/rtmp/features/hwaccel mapping
	patch(t, s, `{"adaptive":true,"rtmpTranscode":false,"features":{"chat":true},"hwaccel":"cpu"}`)
	q := apps.patches[2]
	if q.Transcoding != nil || !*q.Webrtc.Adaptive || q.Webrtc.Layers[0].Height != 720 || *q.Webrtc.TranscodeMaxHeight != 720 ||
		!*q.Rtmp.Enabled || *q.Rtmp.Transcode || q.Rtmp.Passthrough != nil || !*q.Features.Chat || q.Features.Reactions != nil || hw.mode != "cpu" {
		t.Fatalf("%+v", q)
	}
	patch(t, s, `{"layers":[]}`)
	if l := apps.patches[3].Webrtc.Layers; l == nil || len(l) != 0 {
		t.Fatal("empty ladder must replace", l)
	}
	patch(t, s, `{}`)
	if (apps.patches[4] != contracts.AppConfigPatch{}) {
		t.Fatal("empty body patched something")
	}
}

func TestShouldTranscodeIngress(t *testing.T) {
	apps := &fakeApps{cfg: base()}
	s := New(apps, nil, nil)
	for _, c := range []struct {
		enabled, transcode, want bool
	}{{false, true, false}, {true, true, true}, {true, false, false}} {
		apps.cfg.Transcoding.Enabled, apps.cfg.Rtmp.Transcode = c.enabled, c.transcode
		if got, _ := s.ShouldTranscodeIngress(context.Background(), "live"); got != c.want {
			t.Errorf("%+v → %v", c, got)
		}
	}
}

func TestPatchValidation(t *testing.T) {
	for body, want := range map[string][]string{
		`{"layers":[{"name":"High!","height":0},5,{"name":"ok","height":4321.5}]}`: {
			"layers.0.name must be a short lowercase slug (a-z, 0-9, _ , -)", "layers.0.height must not be less than 1",
			"layers.each value in nested property layers must be either object or array",
			"layers.2.height must not be greater than 4320", "layers.2.height must be an integer number"},
		`{"layers":"x","vodRenditions":7}`: {
			"layers must contain no more than 8 elements", "layers must be an array", "each value in nested property layers must be either object or array",
			"vodRenditions must contain no more than 8 elements", "vodRenditions must be an array", "each value in nested property vodRenditions must be either object or array"},
		`{"layers":[{"name":"a","height":1},{"name":"a","height":1},{"name":"a","height":1},{"name":"a","height":1},{"name":"a","height":1},{"name":"a","height":1},{"name":"a","height":1},{"name":"a","height":1},{"name":"a","height":1}]}`: {
			"layers must contain no more than 8 elements"},
		`{"features":"on"}`: {"nested property features must be either object or array"},
	} {
		b := validate.MustParse(body)
		patchRules(b)
		if got := b.Messages(); !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\n got  %q\n want %q", body, got, want)
		}
	}
}
