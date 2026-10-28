// Package transcoding is the port of src/modules/transcoding: the per-app
// adaptive/transcoding config view (GET/PATCH /apps/:app/config) and the
// effective WebRTC rendition ladder (GET /apps/:app/transcoding/layers).
package transcoding

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/system"
)

// HwAccel is the per-app GPU preference store (system.HwAccel).
type HwAccel interface {
	GetMode(app string) system.HwaccelMode
	SetMode(app string, mode system.HwaccelMode) (system.HwaccelMode, error)
	Resolve(ctx context.Context, app string) system.HwaccelDecision
}

// Logs is logs.Service.Write.
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Service is the TranscodingService port.
type Service struct {
	apps contracts.AppsService
	logs Logs
	hw   HwAccel
}

// New builds the service.
func New(apps contracts.AppsService, logs Logs, hw HwAccel) *Service {
	return &Service{apps: apps, logs: logs, hw: hw}
}

func (s *Service) write(level, msg string, meta any) {
	if s.logs != nil {
		s.logs.Write(level, "transcoding", msg, meta, nil)
	}
}

// DefaultLayers is the default WebRTC ladder (720/480/240).
func DefaultLayers() []contracts.WebrtcLayer {
	return []contracts.WebrtcLayer{{Name: "high", Height: 720}, {Name: "med", Height: 480}, {Name: "low", Height: 240}}
}

type errorMeta struct {
	Error string `json:"error"`
}

// resolveConfig: HTTP errors pass through, anything else is a 404.
func (s *Service) resolveConfig(ctx context.Context, app string) (*contracts.AppConfig, error) {
	cfg, err := s.apps.GetConfig(ctx, app)
	if err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return nil, err
		}
		s.write("warn", fmt.Sprintf(`could not load config for app "%s"`, app), errorMeta{err.Error()})
		return nil, httpx.NotFound(fmt.Sprintf(`App "%s" not found`, app))
	}
	return cfg, nil
}

// LayersForApp is the effective ladder (default when empty).
func (s *Service) LayersForApp(ctx context.Context, app string) ([]contracts.WebrtcLayer, error) {
	cfg, err := s.resolveConfig(ctx, app)
	if err != nil {
		return nil, err
	}
	if len(cfg.Webrtc.Layers) > 0 {
		return cfg.Webrtc.Layers, nil
	}
	return DefaultLayers(), nil
}

// ConfigView is GET /apps/:app/config.
type TranscodingConfigView struct {
	App      string                  `json:"app"`
	Adaptive bool                    `json:"adaptive"`
	Layers   []contracts.WebrtcLayer `json:"layers"`
	Rtmp     struct {
		Enabled     bool `json:"enabled"`
		Transcode   bool `json:"transcode"`
		Passthrough bool `json:"passthrough"`
	} `json:"rtmp"`
	Timezone  string                `json:"timezone"`
	Features  contracts.AppFeatures `json:"features"`
	Recording struct {
		Enabled          bool    `json:"enabled"`
		SplitMinutes     float64 `json:"splitMinutes"`
		SnapshotSeconds  float64 `json:"snapshotSeconds"`
		FilenameTemplate string  `json:"filenameTemplate"`
		SnapshotTemplate string  `json:"snapshotTemplate"`
		RetentionDays    float64 `json:"retentionDays"`
	} `json:"recording"`
	Variables   map[string]string `json:"variables"`
	Transcoding struct {
		Enabled         bool                     `json:"enabled"`
		Encoding        string                   `json:"encoding"`
		VodAdaptive     bool                     `json:"vodAdaptive"`
		VodRenditions   []contracts.VodRendition `json:"vodRenditions"`
		Hwaccel         system.HwaccelMode       `json:"hwaccel"`
		HwaccelResolved system.HwaccelDecision   `json:"hwaccelResolved"`
	} `json:"transcoding"`
}

func orZero(f float64) float64 {
	if f != f { // NaN → 0 (Number(x) || 0)
		return 0
	}
	return f
}

func (s *Service) toView(ctx context.Context, app string, cfg *contracts.AppConfig) *TranscodingConfigView {
	v := &TranscodingConfigView{App: app, Adaptive: cfg.Webrtc.Adaptive, Layers: cfg.Webrtc.Layers, Timezone: cfg.Timezone, Features: cfg.Features}
	if len(v.Layers) == 0 {
		v.Layers = DefaultLayers()
	}
	v.Rtmp.Enabled, v.Rtmp.Transcode, v.Rtmp.Passthrough = cfg.Rtmp.Enabled, cfg.Rtmp.Transcode, cfg.Rtmp.Passthrough
	r := cfg.Recording
	v.Recording.Enabled = r.Enabled
	v.Recording.SplitMinutes, v.Recording.SnapshotSeconds = orZero(r.SplitMinutes), orZero(r.SnapshotSeconds)
	v.Recording.FilenameTemplate, v.Recording.SnapshotTemplate = r.FilenameTemplate, r.SnapshotTemplate
	v.Recording.RetentionDays = orZero(r.RetentionDays)
	v.Variables = cfg.Variables
	if v.Variables == nil {
		v.Variables = map[string]string{}
	}
	t := cfg.Transcoding
	v.Transcoding.Enabled, v.Transcoding.Encoding, v.Transcoding.VodAdaptive = t.Enabled, t.Encoding, t.VodAdaptive
	if v.Transcoding.Encoding == "" {
		v.Transcoding.Encoding = "h264"
	}
	v.Transcoding.VodRenditions = t.VodRenditions
	if v.Transcoding.VodRenditions == nil {
		v.Transcoding.VodRenditions = []contracts.VodRendition{}
	}
	if s.hw != nil {
		v.Transcoding.Hwaccel = s.hw.GetMode(app)
		v.Transcoding.HwaccelResolved = s.hw.Resolve(ctx, app)
	}
	return v
}

// GetConfigView is GET /apps/:app/config.
func (s *Service) GetConfigView(ctx context.Context, app string) (*TranscodingConfigView, error) {
	cfg, err := s.resolveConfig(ctx, app)
	if err != nil {
		return nil, err
	}
	return s.toView(ctx, app, cfg), nil
}

var layerName = regexp.MustCompile(`^[a-z0-9_-]{1,20}$`)

// featureFlags are AppFeaturesDto's booleans.
var featureFlags = []string{"rtmpPassword", "viewerCounter", "chat", "reactions", "hiddenQc", "adaptivePlayer", "publicPlayback"}

// nestedArray is @IsOptional @IsArray @ArrayMaxSize(8)
// @ValidateNested({each: true}) @Type(...).
func nestedArray(b *validate.Body, name string, each func(*validate.Body)) {
	b.NestedWith(name, true, func(r *validate.Rule) {
		arr, ok := b.Raw(name).([]any)
		r.Check(ok && len(arr) <= 8, name+" must contain no more than 8 elements").IsArray()
	}, each)
}

func patchRules(b *validate.Body) {
	b.Optional("adaptive").IsBoolean()
	nestedArray(b, "layers", func(l *validate.Body) {
		l.Field("name").Matches(layerName, "name must be a short lowercase slug (a-z, 0-9, _ , -)").IsString()
		l.Field("height").Max(4320).Min(1).IsInt()
	})
	b.Optional("rtmpTranscode").IsBoolean()
	b.Nested("features", func(f *validate.Body) {
		for _, k := range featureFlags {
			f.Optional(k).IsBoolean()
		}
	})
	b.Optional("hwaccel").IsIn("auto", "gpu", "cpu")
	b.Optional("transcodingEnabled").IsBoolean()
	b.Optional("encoding").IsIn("h264", "h264+vp8")
	b.Optional("vodAdaptive").IsBoolean()
	nestedArray(b, "vodRenditions", func(r *validate.Body) {
		r.Field("height").Max(4320).Min(144).IsInt()
		r.Field("bitrateKbps").Max(50000).Min(100).IsInt()
	})
}

type updatedMeta struct {
	Adaptive      bool `json:"adaptive"`
	Layers        int  `json:"layers"`
	RtmpTranscode bool `json:"rtmpTranscode"`
}

// UpdateConfig is PATCH /apps/:app/config on a validated body.
func (s *Service) UpdateConfig(ctx context.Context, app string, b *validate.Body) (*TranscodingConfigView, error) {
	cur, err := s.resolveConfig(ctx, app)
	if err != nil {
		return nil, err
	}
	var patch contracts.AppConfigPatch
	if b.Has("adaptive") || b.Has("layers") {
		adaptive := cur.Webrtc.Adaptive
		if v := b.Bool("adaptive"); v != nil {
			adaptive = *v
		}
		layers := append([]contracts.WebrtcLayer{}, cur.Webrtc.Layers...)
		if arr, ok := b.Raw("layers").([]any); ok {
			layers = []contracts.WebrtcLayer{}
			for _, e := range arr {
				m, _ := e.(map[string]any)
				name, _ := m["name"].(string)
				h, _ := m["height"].(float64)
				layers = append(layers, contracts.WebrtcLayer{Name: name, Height: h})
			}
		}
		maxH := float64(cur.Webrtc.TranscodeMaxHeight)
		patch.Webrtc = &contracts.WebrtcPatch{Adaptive: &adaptive, Layers: layers, TranscodeMaxHeight: &maxH}
	}
	if v := b.Bool("rtmpTranscode"); v != nil {
		enabled := cur.Rtmp.Enabled
		patch.Rtmp = &contracts.RtmpPatch{Enabled: &enabled, Transcode: v}
	}
	if b.Has("transcodingEnabled") || b.Has("encoding") || b.Has("vodAdaptive") || b.Has("vodRenditions") {
		t := cur.Transcoding
		enabled, encoding, vod := t.Enabled, t.Encoding, t.VodAdaptive
		if encoding == "" {
			encoding = "h264"
		}
		if v := b.Bool("transcodingEnabled"); v != nil {
			enabled = *v
		}
		if v := b.StringPtr("encoding"); v != nil {
			encoding = *v
		}
		if v := b.Bool("vodAdaptive"); v != nil {
			vod = *v
		}
		rends := append([]contracts.VodRendition{}, t.VodRenditions...)
		if arr, ok := b.Raw("vodRenditions").([]any); ok {
			rends = []contracts.VodRendition{}
			for _, e := range arr {
				m, _ := e.(map[string]any)
				h, _ := m["height"].(float64)
				br, _ := m["bitrateKbps"].(float64)
				rends = append(rends, contracts.VodRendition{Height: h, BitrateKbps: br})
			}
		}
		patch.Transcoding = &contracts.TranscodingPatch{Enabled: &enabled, Encoding: &encoding, VodAdaptive: &vod, VodRenditions: rends}
	}
	if f, ok := b.Raw("features").(map[string]any); ok {
		fb := func(k string) *bool {
			if v, ok := f[k].(bool); ok {
				return &v
			}
			return nil
		}
		patch.Features = &contracts.FeaturesPatch{
			RtmpPassword: fb("rtmpPassword"), ViewerCounter: fb("viewerCounter"), Chat: fb("chat"), Reactions: fb("reactions"),
			HiddenQc: fb("hiddenQc"), AdaptivePlayer: fb("adaptivePlayer"), PublicPlayback: fb("publicPlayback"),
		}
	}
	if v := b.StringPtr("hwaccel"); v != nil && s.hw != nil {
		if _, err := s.hw.SetMode(app, *v); err != nil {
			return nil, err
		}
	}
	merged, err := s.apps.UpdateConfig(ctx, app, patch)
	if err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return nil, err
		}
		s.write("error", fmt.Sprintf(`failed to update config for app "%s"`, app), errorMeta{err.Error()})
		return nil, httpx.NotFound(fmt.Sprintf(`App "%s" not found`, app))
	}
	s.write("info", fmt.Sprintf(`updated config for app "%s"`, app), updatedMeta{merged.Webrtc.Adaptive, len(merged.Webrtc.Layers), merged.Rtmp.Transcode})
	return s.toView(ctx, app, merged), nil
}

// ShouldTranscodeIngress: the master switch AND rtmp.{enabled,transcode}.
func (s *Service) ShouldTranscodeIngress(ctx context.Context, app string) (bool, error) {
	cfg, err := s.resolveConfig(ctx, app)
	if err != nil {
		return false, err
	}
	return cfg.Transcoding.Enabled && cfg.Rtmp.Enabled && cfg.Rtmp.Transcode, nil
}

type appIn struct {
	App string `path:"app"`
}

type appBodyIn struct {
	App     string `path:"app"`
	RawBody []byte
}

func op(id, method, path, summary string) *huma.Operation {
	return &huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"transcoding"}}
}

// Register implements api.Module.
func (s *Service) Register(a huma.API) {
	huma.Register(a, *authz.Require(op("TranscodingController_getConfig", http.MethodGet, "/apps/{app}/config",
		"Get the adaptive/transcoding config for an app."), "config", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[*TranscodingConfigView], error) {
			v, err := s.GetConfigView(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.JSON(v), nil
		})
	huma.Register(a, *authz.Require(op("TranscodingController_patchConfig", http.MethodPatch, "/apps/{app}/config",
		"Patch the adaptive/transcoding config for an app."), "config", "write"),
		func(ctx context.Context, in *appBodyIn) (*api.Out[*TranscodingConfigView], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			patchRules(b)
			if err := b.Err(); err != nil {
				return nil, err
			}
			v, err := s.UpdateConfig(ctx, in.App, b)
			if err != nil {
				return nil, err
			}
			return api.JSON(v), nil
		})
	huma.Register(a, *authz.Require(op("TranscodingController_layers", http.MethodGet, "/apps/{app}/transcoding/layers",
		"Effective WebRTC rendition ladder for an app."), "config", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[[]contracts.WebrtcLayer], error) {
			l, err := s.LayersForApp(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.JSON(l), nil
		})
	if p := a.OpenAPI().Paths[api.Prefix+"/apps/{app}/config"]; p != nil && p.Patch != nil && p.Patch.RequestBody != nil {
		p.Patch.RequestBody.Required = false
	}
}
