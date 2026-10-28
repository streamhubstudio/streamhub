package apps

import (
	"context"
	"fmt"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of config-presets.ts (G4): declarative partial configs deep-merged
// over config.yaml. Presets never touch credentials or identity
// (PresetProtectedKeys are stripped before merging). Deactivating reverts
// every leaf a preset sets to the FACTORY default (PresetDefaultConfig) and
// deletes leaves with no default (the forward-looking distribution/hls
// blocks) — not the literal pre-apply value; the config backup taken at
// apply time is the way back to that.

// ConfigPreset is one built-in preset.
type ConfigPreset struct {
	Name        string
	Title       string
	Description string
	UseCase     string
	Sets        []string
	Patch       *y.Map
}

// ConfigPresetInfo is GET /apps/:app/presets.
type ConfigPresetInfo struct {
	Name        string   `json:"name"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	UseCase     string   `json:"useCase"`
	Sets        []string `json:"sets"`
	Applied     bool     `json:"applied"`
}

// ApplyPresetResult is the apply/deactivate response.
type ApplyPresetResult struct {
	Preset   string   `json:"preset"`
	Applied  bool     `json:"applied"`
	Reloaded bool     `json:"reloaded"`
	Changed  bool     `json:"changed"`
	Diff     string   `json:"diff"`
	Warnings []string `json:"warnings"`
}

// PresetProtectedKeys are never overwritten by a preset.
var PresetProtectedKeys = []string{"s3", "callbacks", "name", "display_name", "room_prefix"}

func rendition(h, kbps float64) *y.Map { return obj("height", h, "bitrate_kbps", kbps) }
func layer(name string, h float64) *y.Map {
	return obj("name", name, "height", h)
}

// ConfigPresets returns the catalogue (fresh values on every call: patches
// are merged into config trees that get mutated).
func ConfigPresets() []ConfigPreset {
	ladder1080 := func() []any { return []any{rendition(1080, 5000), rendition(720, 2800), rendition(480, 1400)} }
	ladderHLS := func() []any { return []any{rendition(720, 2800), rendition(480, 1400), rendition(360, 800)} }
	return []ConfigPreset{
		{
			Name:  "low-latency",
			Title: "Baja latencia (WebRTC-first)",
			Description: "Reproducción interactiva sub-segundo: passthrough puro (sin re-encode), " +
				"simulcast ON, distribución por edges. Ideal CCTV, subastas, 1:1. El " +
				"playout delay bajo se aplica desde el SDK/player, no desde el yaml " +
				"(ver LATENCY-TUNING L3).",
			UseCase: "CCTV, monitoreo, subastas, telemedicina/soporte, live-shopping interactivo",
			Sets: []string{
				"transcoding.enabled = false (passthrough puro, sin re-encode en el server)",
				"webrtc.adaptive = true (simulcast ON — es MEJOR para latencia, LATENCY-TUNING)",
				"rtmp.transcode = false (ingress passthrough)",
				"features.adaptive_player = true",
				"distribution.mode = edge (WebRTC-first, sin indirección de CDN)",
				"hls: segmentos cortos (2s / list 3) por si se usa HLS puntual",
			},
			Patch: obj(
				"transcoding", obj("enabled", false),
				"webrtc", obj("adaptive", true),
				"rtmp", obj("transcode", false),
				"features", obj("adaptive_player", true),
				"distribution", obj("mode", "edge"),
				"hls", obj("segment_seconds", 2.0, "list_size", 3.0),
			),
		},
		{
			Name:  "high-quality-recording",
			Title: "Grabación de alta calidad",
			Description: "Transcoding ON con ladder, grabación H.264 (opcional h264+vp8) y VOD " +
				"adaptativo (HLS master + renditions). Prioriza calidad y compatibilidad " +
				"del archivo sobre latencia.",
			UseCase: "Eventos grabados, clases, VOD premium, archivo/QC",
			Sets: []string{
				"transcoding.enabled = true (re-encode server-side)",
				"transcoding.encoding = h264 (cambiar a h264+vp8 para alternativa WebM/VP8)",
				"transcoding.vod_adaptive = true (HLS VOD adaptativo por grabación)",
				"transcoding.vod_renditions = 1080/720/480 (ladder explícito)",
				"recording.enabled = true, mode = room-composite",
				"rtmp.transcode = true, webrtc.adaptive = true (+ layers 1080/720/480)",
			},
			Patch: obj(
				"transcoding", obj("enabled", true, "encoding", "h264", "vod_adaptive", true, "vod_renditions", ladder1080()),
				"recording", obj("enabled", true, "mode", "room-composite"),
				"rtmp", obj("transcode", true),
				"webrtc", obj("adaptive", true, "layers", []any{layer("high", 1080), layer("med", 720), layer("low", 480)}),
				"features", obj("adaptive_player", true),
			),
		},
		{
			Name:  "mass-audience-HLS",
			Title: "Audiencia masiva (HLS + CDN)",
			Description: "HLS con segmentos/list optimizados detrás de un CDN (distribution.mode " +
				"cdn) + ladder transcodificado, para miles/cientos de miles de " +
				"espectadores. Latencia 6–15s a cambio de escala barata y cacheable " +
				"(ver DISTRIBUTION-CDN-P2P).",
			UseCase: "Eventos masivos, streams públicos, radio/audio 24/7, webinars grandes",
			Sets: []string{
				"transcoding.enabled = true + vod_adaptive = true (ladder 720/480/360)",
				"webrtc.adaptive = true, features.adaptive_player = true",
				"recording.enabled = true",
				"distribution.mode = cdn (+ cdn.base_url a completar con el dominio del CDN)",
				"hls: segment_seconds = 4, list_size = 10 (ventana optimizada del m3u8)",
			},
			Patch: obj(
				"transcoding", obj("enabled", true, "encoding", "h264", "vod_adaptive", true, "vod_renditions", ladderHLS()),
				"webrtc", obj("adaptive", true),
				"features", obj("adaptive_player", true),
				"recording", obj("enabled", true),
				"distribution", obj("mode", "cdn", "cdn", obj("base_url", "", "vod_base_url", "", "provider", "bunny")),
				"hls", obj("segment_seconds", 4.0, "list_size", 10.0),
			),
		},
		{
			Name:  "rtmp-passthrough",
			Title: "RTMP passthrough (remux, sin transcode)",
			Description: "Ingesta RTMP H.264/AAC servida como HLS por REMUX puro (`ffmpeg -c copy`), " +
				"sin pasar por LiveKit: CPU casi nula, sin GPU (estilo AntMedia). MUTUAMENTE " +
				"EXCLUYENTE con transcoding/adaptive — este preset apaga todo re-encode. La " +
				"fuente DEBE ser H.264/AAC (sin red de seguridad de transcode) y no hay " +
				"WebRTC/sub-segundo, ABR, grabación ni features de sala. Requiere " +
				"STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on en el server.",
			UseCase: "Relay RTMP→HLS barato y masivo, cámaras/encoders H.264/AAC ya conformes",
			Sets: []string{
				"rtmp.passthrough = true (remux directo a HLS, sin re-encode)",
				"rtmp.transcode = false, transcoding.enabled = false (sin transcode)",
				"webrtc.adaptive = false, features.adaptive_player = false (sin ABR/WebRTC)",
				"recording.enabled = false (sin egress/VOD para passthrough)",
			},
			Patch: obj(
				"rtmp", obj("passthrough", true, "transcode", false),
				"transcoding", obj("enabled", false, "vod_adaptive", false),
				"webrtc", obj("adaptive", false),
				"recording", obj("enabled", false),
				"features", obj("adaptive_player", false),
			),
		},
	}
}

// FindPreset looks a preset up by id.
func FindPreset(name string) *ConfigPreset {
	for _, p := range ConfigPresets() {
		if p.Name == name {
			return &p
		}
	}
	return nil
}

// PresetDefaultConfig mirrors defaultDisk for the blocks a preset can touch
// (kept in sync by a test against a fresh app). distribution/hls have no
// factory default on purpose.
func PresetDefaultConfig() *y.Map {
	d := defaultDisk("x", "x", "x")
	rec := y.MapAt(d, "recording").Clone()
	for _, k := range []string{"filename_template", "snapshot_template", "retention_days"} {
		rec.Delete(k)
	}
	return obj(
		"recording", rec,
		"webrtc", d.Get("webrtc"),
		"rtmp", d.Get("rtmp"),
		"transcoding", d.Get("transcoding"),
		"features", d.Get("features"),
	)
}

// DeepMerge merges patch into base into a NEW object: plain objects merge
// recursively, arrays and scalars replace wholesale, Undefined is ignored.
func DeepMerge(base, patch *y.Map) *y.Map {
	out := base.Clone()
	for _, k := range patch.Keys() {
		val := patch.Get(k)
		if y.IsUndefined(val) {
			continue
		}
		pv, isObj := val.(*y.Map)
		cur, curObj := out.Get(k).(*y.Map)
		switch {
		case isObj && curObj:
			out.Set(k, DeepMerge(cur, pv))
		case isObj:
			out.Set(k, DeepMerge(y.NewMap(), pv))
		default:
			out.Set(k, val)
		}
	}
	return out
}

// StripProtected removes the credential/identity keys from a patch.
func StripProtected(patch *y.Map) *y.Map {
	clean := y.NewMap()
	for _, k := range patch.Keys() {
		protected := false
		for _, p := range PresetProtectedKeys {
			protected = protected || k == p
		}
		if !protected {
			clean.Set(k, patch.Get(k))
		}
	}
	return clean
}

// ApplyPresetPatch is DeepMerge(current, StripProtected(patch)).
func ApplyPresetPatch(current, patch *y.Map) *y.Map {
	return DeepMerge(current, StripProtected(patch))
}

func getAtPath(v any, path []string) (any, bool) {
	cur := v
	for _, k := range path {
		m, ok := cur.(*y.Map)
		if !ok || m == nil {
			return nil, false
		}
		val, ok := m.Lookup(k)
		if !ok {
			return nil, false
		}
		cur = val
	}
	return cur, true
}

// deepEqual is structural equality; arrays are order-sensitive.
func deepEqual(a, b any) bool {
	switch x := a.(type) {
	case []any:
		yb, ok := b.([]any)
		if !ok || len(x) != len(yb) {
			return false
		}
		for i := range x {
			if !deepEqual(x[i], yb[i]) {
				return false
			}
		}
		return true
	case *y.Map:
		yb, ok := b.(*y.Map)
		if !ok || x.Len() != yb.Len() {
			return false
		}
		for _, k := range x.Keys() {
			if !deepEqual(x.Get(k), yb.Get(k)) {
				return false
			}
		}
		return true
	}
	if _, ok := b.([]any); ok {
		return false
	}
	if _, ok := b.(*y.Map); ok {
		return false
	}
	return jsStrictEqual(a, b)
}

// jsStrictEqual is `===` for scalars (NaN !== NaN; Dates compare by identity,
// which two distinct loads never share).
func jsStrictEqual(a, b any) bool {
	switch a.(type) {
	case nil, bool, float64, string:
		return a == b
	}
	if y.IsUndefined(a) {
		return y.IsUndefined(b)
	}
	return false
}

// walkLeaves visits every non-object leaf of patch (arrays are leaves).
func walkLeaves(patch *y.Map, visit func(path []string, v any), prefix []string) {
	for _, k := range patch.Keys() {
		path := append(append([]string(nil), prefix...), k)
		if m, ok := patch.Get(k).(*y.Map); ok {
			walkLeaves(m, visit, path)
		} else {
			visit(path, patch.Get(k))
		}
	}
}

// IsPresetApplied: every leaf the preset sets is present with the same value.
func IsPresetApplied(current, patch *y.Map) bool {
	applied := true
	walkLeaves(patch, func(path []string, expected any) {
		if !applied {
			return
		}
		v, ok := getAtPath(current, path)
		if !ok || !deepEqual(v, expected) {
			applied = false
		}
	}, nil)
	return applied
}

// BuildDeactivatePatch maps every leaf of patch to its factory default;
// leaves without one come back as unset paths.
func BuildDeactivatePatch(patch, defaults *y.Map) (*y.Map, [][]string) {
	out := y.NewMap()
	var unset [][]string
	walkLeaves(patch, func(path []string, _ any) {
		v, ok := getAtPath(defaults, path)
		if !ok {
			unset = append(unset, path)
			return
		}
		cur := out
		for _, k := range path[:len(path)-1] {
			next, ok := cur.Get(k).(*y.Map)
			if !ok {
				next = y.NewMap()
				cur.Set(k, next)
			}
			cur = next
		}
		cur.Set(path[len(path)-1], v)
	}, nil)
	return out, unset
}

// DeleteAtPath deletes the leaf at path (in place) and prunes ancestors
// left empty.
func DeleteAtPath(m *y.Map, path []string) {
	if len(path) == 0 {
		return
	}
	stack := []*y.Map{m}
	cur := m
	for _, k := range path[:len(path)-1] {
		next, ok := cur.Get(k).(*y.Map)
		if !ok {
			return
		}
		cur = next
		stack = append(stack, cur)
	}
	cur.Delete(path[len(path)-1])
	for i := len(stack) - 1; i >= 1; i-- {
		if stack[i].Len() > 0 {
			break
		}
		stack[i-1].Delete(path[i-1])
	}
}

// --- service --------------------------------------------------------------

// ListConfigPresets lists the presets, each flagged applied against the
// parsed config.yaml (an unparseable file reads as none applied).
func (s *Service) ListConfigPresets(ctx context.Context, name string) ([]ConfigPresetInfo, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	parsed := y.NewMap()
	if raw, err := s.GetRawConfig(ctx, name); err == nil {
		if loaded, err := y.Load(raw); err == nil {
			if m, ok := loaded.(*y.Map); ok && m != nil {
				parsed = m
			}
		}
	}
	out := []ConfigPresetInfo{}
	for _, p := range ConfigPresets() {
		out = append(out, ConfigPresetInfo{
			Name: p.Name, Title: p.Title, Description: p.Description, UseCase: p.UseCase, Sets: p.Sets,
			Applied: IsPresetApplied(parsed, p.Patch),
		})
	}
	return out, nil
}

// ApplyConfigPreset deep-merges a preset over config.yaml and writes it
// through the safe raw-editor path (validate + backup + reload).
func (s *Service) ApplyConfigPreset(ctx context.Context, name, preset string) (*ApplyPresetResult, error) {
	return s.presetOp(ctx, name, preset, "applying", true)
}

// DeactivateConfigPreset reverts every key the preset sets to its factory
// default (deleting forward-looking keys) through the same path.
func (s *Service) DeactivateConfigPreset(ctx context.Context, name, preset string) (*ApplyPresetResult, error) {
	return s.presetOp(ctx, name, preset, "deactivating", false)
}

func (s *Service) presetOp(ctx context.Context, name, presetName, verb string, apply bool) (*ApplyPresetResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	preset := FindPreset(presetName)
	if preset == nil {
		return nil, httpx.NotFound(fmt.Sprintf(`preset "%s" not found`, presetName))
	}
	currentRaw, err := s.readRaw(name)
	if err != nil {
		return nil, err
	}
	loaded, err := y.Load(currentRaw)
	if err != nil {
		return nil, httpx.BadRequest(fmt.Sprintf("current config.yaml is not parseable; fix it before %s a preset: %s", verb, err))
	}
	current, ok := loaded.(*y.Map)
	if !ok || current == nil {
		return nil, httpx.BadRequest("current config.yaml is not a YAML mapping")
	}
	var merged *y.Map
	if apply {
		merged = ApplyPresetPatch(current, preset.Patch)
	} else {
		revert, unset := BuildDeactivatePatch(preset.Patch, PresetDefaultConfig())
		merged = ApplyPresetPatch(current, revert)
		for _, p := range unset {
			DeleteAtPath(merged, p)
		}
	}
	mergedYaml := y.Dump(merged, configLineWidth)
	diff := unifiedDiff(currentRaw, mergedYaml)
	reload, err := s.putRawLocked(ctx, name, mergedYaml)
	if err != nil {
		return nil, err
	}
	if apply {
		s.log.Info(fmt.Sprintf(`applied preset "%s" to app "%s"`, preset.Name, name))
	} else {
		s.log.Info(fmt.Sprintf(`deactivated preset "%s" on app "%s"`, preset.Name, name))
	}
	return &ApplyPresetResult{
		Preset: preset.Name, Applied: apply, Reloaded: reload.Reloaded,
		Changed: diff != "", Diff: diff, Warnings: reload.Warnings,
	}, nil
}
