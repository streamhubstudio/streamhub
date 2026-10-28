package apps

import (
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/timezone"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Resolution of the on-disk tree into the cross-module AppConfig: every
// field defaulted and sanitized exactly like AppsService.toResolvedConfig.

// TranscodeHeights are the allowed ingress transcode caps (ingress-encoding.util.ts).
var TranscodeHeights = []int{360, 480, 720, 1080}

// DefaultTranscodeMaxHeight is the cap when unset/invalid.
const DefaultTranscodeMaxHeight = 720

// SanitizeTranscodeMaxHeight snaps a raw value to a tier: garbage /
// non-positive → 720, out-of-set → the nearest tier (ties keep 720).
func SanitizeTranscodeMaxHeight(v any) int {
	n := math.Floor(y.ToNumber(v))
	for _, h := range TranscodeHeights {
		if n == float64(h) {
			return h
		}
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return DefaultTranscodeMaxHeight
	}
	best := DefaultTranscodeMaxHeight
	for _, h := range TranscodeHeights {
		if math.Abs(float64(h)-n) < math.Abs(float64(best)-n) {
			best = h
		}
	}
	return best
}

// str renders a raw value where Node passes it through as a string field.
func str(v any) string {
	if y.IsNullish(v) {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return y.ToString(v)
}

// orEmpty is `v || ”`.
func orEmpty(v any) string {
	if !y.Truthy(v) {
		return ""
	}
	return str(v)
}

// boolOf renders a raw value where Node passes it through as a boolean.
func boolOf(v any) bool { return y.Truthy(v) }

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

var retentionAllowed = map[float64]bool{0: true, 7: true, 30: true, 90: true, 180: true, 360: true}

// resolveRetentionDays clamps to an allowed window (garbage → 0/off).
func resolveRetentionDays(v any) float64 {
	n := orZero(y.ToNumber(y.Coalesce(v, 0.0)))
	if retentionAllowed[n] {
		return n
	}
	return 0
}

// orZero is `n || 0`.
func orZero(n float64) float64 {
	if math.IsNaN(n) {
		return 0
	}
	return n + 0 // -0 → 0
}

// resolveTimezone trims and drops an invalid IANA name (→ ” = host time).
func resolveTimezone(v any) string {
	tz := ""
	if s, ok := v.(string); ok {
		tz = y.Trim(s)
	}
	if timezone.IsValid(tz) {
		return tz
	}
	return ""
}

var variableKey = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)

// resolveVariables keeps usable keys ([A-Za-z0-9_]{1,64}) with String(v)
// capped at 512 UTF-16 units; anything else resolves to {}.
func resolveVariables(v any) *y.Map {
	out := y.NewMap()
	m, ok := v.(*y.Map)
	if !ok || m == nil {
		return out
	}
	for _, k := range m.Keys() {
		val := m.Get(k)
		if !variableKey.MatchString(k) || y.IsNullish(val) {
			continue
		}
		out.Set(k, jsx.UTF16Slice(y.ToString(val), 512))
	}
	return out
}

func varsFromPatch(vars []contracts.Var) *y.Map {
	m := y.NewMap()
	for _, v := range vars {
		m.Set(v.Key, v.Value)
	}
	return m
}

func varsToMap(m *y.Map) *y.Map { return m }

func stringMap(m *y.Map) map[string]string {
	out := make(map[string]string, m.Len())
	for _, k := range m.Keys() {
		out[k], _ = m.Get(k).(string)
	}
	return out
}

func resolveLinear(d any) *contracts.LinearChannelFeatures {
	posInt := func(v any, fallback float64) float64 {
		n := math.Floor(y.ToNumber(v))
		if finite(n) && n > 0 {
			return n
		}
		return fallback
	}
	return &contracts.LinearChannelFeatures{
		PersistentRoom:          prop(d, "persistent_room") == true,
		RoomEmptyTimeoutSeconds: posInt(prop(d, "room_empty_timeout_seconds"), 86400),
		AlwaysOnHls:             prop(d, "always_on_hls") == true,
		Dvr:                     prop(d, "dvr") == true,
		DvrWindowSeconds:        posInt(prop(d, "dvr_window_seconds"), 3600),
	}
}

func resolveWsIngest(d any) *contracts.WsIngestFeatures {
	num := func(v any, fallback float64) float64 {
		n := y.ToNumber(v)
		if finite(n) && n >= 0 {
			return n
		}
		return fallback
	}
	or := func(n, fallback float64) float64 {
		if n == 0 {
			return fallback
		}
		return n
	}
	return &contracts.WsIngestFeatures{
		Enabled:       prop(d, "enabled") != false,
		MaxCameras:    num(prop(d, "max_cameras"), 0),
		MaxFps:        or(num(prop(d, "max_fps"), 15), 15),
		MaxFrameKb:    or(num(prop(d, "max_frame_kb"), 256), 256),
		MaxDataBytes:  or(num(prop(d, "max_data_bytes"), 16*1024), 16*1024),
		MaxDataPerSec: or(num(prop(d, "max_data_per_sec"), 5), 5),
	}
}

func resolveTranscoding(t any) contracts.TranscodingConfig {
	encoding := "h264"
	raw := prop(t, "encoding")
	if !y.Truthy(raw) {
		raw = "h264"
	}
	if strings.ToLower(y.ToString(raw)) == "h264+vp8" {
		encoding = "h264+vp8"
	}
	renditions := []contracts.VodRendition{}
	seen := map[float64]bool{}
	if list, ok := prop(t, "vod_renditions").([]any); ok {
		for _, r := range list {
			h := math.Floor(y.ToNumber(prop(r, "height")))
			b := math.Floor(y.ToNumber(prop(r, "bitrate_kbps")))
			if !finite(h) || h < 144 || h > 4320 || !finite(b) || b <= 0 || seen[h] {
				continue
			}
			seen[h] = true
			renditions = append(renditions, contracts.VodRendition{Height: h, BitrateKbps: b})
		}
	}
	sort.SliceStable(renditions, func(i, j int) bool { return renditions[i].Height > renditions[j].Height })
	return contracts.TranscodingConfig{
		Enabled: boolOf(prop(t, "enabled")), Encoding: encoding,
		VodAdaptive: boolOf(prop(t, "vod_adaptive")), VodRenditions: renditions,
	}
}

var mqttLogLevels = map[string]bool{"trace": true, "debug": true, "info": true, "warn": true, "error": true, "fatal": true}

func (s *Service) resolveMqtt(disk *y.Map) contracts.MqttConfig {
	m := disk.Get("mqtt")
	qos := 0
	if q := prop(m, "qos"); q == 1.0 || q == 2.0 {
		qos = int(q.(float64))
	}
	events := []string{}
	if list, ok := prop(m, "events").([]any); ok && len(list) > 0 {
		for _, e := range list {
			if t := y.Trim(y.ToString(e)); t != "" {
				events = append(events, t)
			}
		}
	}
	if len(events) == 0 {
		events = []string{"all"}
	}
	logs := prop(m, "logs")
	level := "info"
	if l := y.ToString(prop(logs, "level")); mqttLogLevels[l] {
		level = l
	}
	topic := y.Trim(orEmpty(prop(m, "topic_prefix")))
	if topic == "" {
		topic = "streamhub/" + str(disk.Get("name"))
	}
	return contracts.MqttConfig{
		Enabled:     boolOf(prop(m, "enabled")),
		URL:         y.Trim(orEmpty(prop(m, "url"))),
		Username:    orEmpty(prop(m, "username")),
		Password:    s.resolveSecret(prop(m, "password_env")),
		TopicPrefix: topic,
		Qos:         qos,
		TLS:         boolOf(prop(m, "tls")),
		Events:      events,
		Logs:        contracts.MqttLogsConfig{Enabled: boolOf(prop(logs, "enabled")), Level: level},
	}
}

func (s *Service) resolveSmtp(disk *y.Map) contracts.SmtpConfig {
	sm := disk.Get("smtp")
	port := y.ToNumber(prop(sm, "port"))
	if !(finite(port) && port == math.Trunc(port) && port > 0 && port < 65536) {
		port = 587
	}
	return contracts.SmtpConfig{
		Enabled: boolOf(prop(sm, "enabled")),
		Host:    y.Trim(orEmpty(prop(sm, "host"))),
		Port:    port,
		User:    orEmpty(prop(sm, "user")),
		From:    orEmpty(prop(sm, "from")),
		Pass:    s.resolveSecret(orEmpty(prop(sm, "pass_env"))),
	}
}

func resolveLatencyAlert(d any) contracts.LatencyAlertConfig {
	num := func(v any, fallback, min float64) float64 {
		n := y.ToNumber(v)
		if finite(n) && n >= min {
			return n
		}
		return fallback
	}
	return contracts.LatencyAlertConfig{
		Enabled:         boolOf(prop(d, "enabled")),
		ThresholdMs:     num(prop(d, "threshold_ms"), 1000, 1),
		CooldownSeconds: num(prop(d, "cooldown_seconds"), 60, 0),
		IntervalSeconds: num(prop(d, "interval_seconds"), 10, 2),
	}
}

func resolveQuotas(d any) *contracts.AppQuotasConfig {
	if !y.Truthy(d) || !y.IsObject(d) {
		return nil
	}
	lim := func(v any) float64 {
		n := y.ToNumber(v)
		if finite(n) && n > 0 {
			return math.Floor(n)
		}
		return -1
	}
	return &contracts.AppQuotasConfig{
		MaxConcurrentStreams: lim(prop(d, "max_concurrent_streams")),
		MaxViewersPerStream:  lim(prop(d, "max_viewers_per_stream")),
	}
}

func layersOf(v any) []contracts.WebrtcLayer {
	out := []contracts.WebrtcLayer{}
	list, _ := v.([]any)
	for _, l := range list {
		h, _ := prop(l, "height").(float64)
		out = append(out, contracts.WebrtcLayer{Name: str(prop(l, "name")), Height: h})
	}
	return out
}

// toResolved resolves the disk tree into AppConfig (credentials resolved).
func (s *Service) toResolved(disk *y.Map) *contracts.AppConfig {
	rec := disk.Get("recording")
	s3 := disk.Get("s3")
	webrtc := disk.Get("webrtc")
	rtmp := disk.Get("rtmp")
	cb := disk.Get("callbacks")
	f := disk.Get("features")
	return &contracts.AppConfig{
		Name:        str(disk.Get("name")),
		DisplayName: str(disk.Get("display_name")),
		RoomPrefix:  str(disk.Get("room_prefix")),
		Timezone:    resolveTimezone(disk.Get("timezone")),
		Recording: contracts.RecordingConfig{
			Enabled:                boolOf(prop(rec, "enabled")),
			Mode:                   str(prop(rec, "mode")),
			Layout:                 str(prop(rec, "layout")),
			LocalDir:               str(prop(rec, "local_dir")),
			DeleteLocalAfterUpload: boolOf(prop(rec, "delete_local_after_upload")),
			SplitMinutes:           orZero(y.ToNumber(y.Coalesce(prop(rec, "split_minutes"), 0.0))),
			SnapshotSeconds:        orZero(y.ToNumber(y.Coalesce(prop(rec, "snapshot_seconds"), 0.0))),
			FilenameTemplate:       y.ToString(y.Coalesce(prop(rec, "filename_template"), "")),
			SnapshotTemplate:       y.ToString(y.Coalesce(prop(rec, "snapshot_template"), "")),
			RetentionDays:          resolveRetentionDays(prop(rec, "retention_days")),
		},
		S3: contracts.S3Config{
			Provider:       str(prop(s3, "provider")),
			Bucket:         str(prop(s3, "bucket")),
			Region:         str(prop(s3, "region")),
			Endpoint:       orEmpty(prop(s3, "endpoint")),
			ForcePathStyle: boolOf(prop(s3, "force_path_style")),
			Prefix:         str(prop(s3, "prefix")),
			PublicURL:      orEmpty(prop(s3, "public_url")),
			AccessKey:      s.resolveSecret(prop(s3, "access_key_env")),
			SecretKey:      s.resolveSecret(prop(s3, "secret_key_env")),
		},
		Webrtc: contracts.WebrtcConfig{
			Adaptive:           boolOf(prop(webrtc, "adaptive")),
			Layers:             layersOf(prop(webrtc, "layers")),
			TranscodeMaxHeight: SanitizeTranscodeMaxHeight(prop(webrtc, "transcode_max_height")),
		},
		Rtmp: contracts.RtmpConfig{
			Enabled:     boolOf(prop(rtmp, "enabled")),
			Transcode:   boolOf(prop(rtmp, "transcode")),
			Passthrough: prop(rtmp, "passthrough") == true,
		},
		Transcoding:  resolveTranscoding(disk.Get("transcoding")),
		Callbacks:    contracts.CallbacksConfig{URL: str(prop(cb, "url")), Secret: str(prop(cb, "secret"))},
		Mqtt:         s.resolveMqtt(disk),
		Smtp:         s.resolveSmtp(disk),
		LatencyAlert: resolveLatencyAlert(disk.Get("latency_alert")),
		Quotas:       resolveQuotas(disk.Get("quotas")),
		Features: contracts.AppFeatures{
			RtmpPassword:   boolOf(prop(f, "rtmp_password")),
			ViewerCounter:  boolOf(prop(f, "viewer_counter")),
			Chat:           boolOf(prop(f, "chat")),
			Reactions:      boolOf(prop(f, "reactions")),
			HiddenQc:       boolOf(prop(f, "hidden_qc")),
			AdaptivePlayer: boolOf(prop(f, "adaptive_player")),
			PublicPlayback: prop(f, "public_playback") != false,
			WsIngest:       resolveWsIngest(prop(f, "ws_ingest")),
			Drm:            ptr(ResolveDrmFeatures(prop(f, "drm"))),
			Linear:         resolveLinear(prop(f, "linear")),
		},
		Variables: stringMap(resolveVariables(disk.Get("variables"))),
	}
}

func ptr[T any](v T) *T { return &v }

// --- features.drm (recording/drm/drm-config.ts) ------------------------------

// DrmSystems are every DRM system StreamHub can signal for.
var DrmSystems = []string{"widevine", "playready", "fairplay"}

// ResolveDrmFeatures resolves the on-disk features.drm block (any shape)
// with every field defaulted: disabled, provider none, cbcs, fail-closed.
func ResolveDrmFeatures(d any) contracts.DrmFeatures {
	if !y.IsObject(d) {
		d = y.NewMap()
	}
	trim := func(v any) string {
		if s, ok := v.(string); ok {
			return y.Trim(s)
		}
		return ""
	}
	provider := "none"
	if strings.ToLower(trim(prop(d, "provider"))) == "external" {
		provider = "external"
	}
	scheme := "cbcs"
	if strings.ToLower(trim(prop(d, "scheme"))) == "cenc" {
		scheme = "cenc"
	}
	systems := []string{}
	seen := map[string]bool{}
	if list, ok := prop(d, "systems").([]any); ok {
		for _, e := range list {
			s := strings.ToLower(trim(e))
			known := false
			for _, k := range DrmSystems {
				known = known || s == k
			}
			if known && !seen[s] {
				seen[s] = true
				systems = append(systems, s)
			}
		}
	}
	if len(systems) == 0 {
		systems = append([]string(nil), DrmSystems...)
	}
	urls := prop(d, "license_urls")
	return contracts.DrmFeatures{
		Enabled:           prop(d, "enabled") == true,
		Provider:          provider,
		Systems:           systems,
		Scheme:            scheme,
		KeyServerURL:      trim(prop(d, "key_server_url")),
		KeyServerTokenEnv: trim(prop(d, "key_server_token_env")),
		LicenseUrls: contracts.DrmLicenseUrls{
			Widevine: trim(prop(urls, "widevine")), Playready: trim(prop(urls, "playready")), Fairplay: trim(prop(urls, "fairplay")),
		},
		FairplayCertURL: trim(prop(d, "fairplay_cert_url")),
		FailOpen:        prop(d, "fail_open") == true,
	}
}

// DrmFeaturesToDisk serializes a resolved block to the snake_case shape.
func DrmFeaturesToDisk(f contracts.DrmFeatures) *y.Map {
	return obj(
		"enabled", f.Enabled,
		"provider", f.Provider,
		"systems", stringsToAny(f.Systems),
		"scheme", f.Scheme,
		"key_server_url", f.KeyServerURL,
		"key_server_token_env", f.KeyServerTokenEnv,
		"license_urls", obj("widevine", f.LicenseUrls.Widevine, "playready", f.LicenseUrls.Playready, "fairplay", f.LicenseUrls.Fairplay),
		"fairplay_cert_url", f.FairplayCertURL,
		"fail_open", f.FailOpen,
	)
}
