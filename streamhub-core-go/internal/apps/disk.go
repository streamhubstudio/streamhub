package apps

import (
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// The on-disk config.yaml (snake_case, secret REFS only — SPEC §7) is kept as
// a JS-semantics object tree (yamljs.Map), exactly as the Node core holds the
// parsed YAML: whatever an operator wrote survives a structured save and is
// dumped back in the same key order js-yaml would produce.

// obj builds a *Map from ordered key/value pairs.
func obj(kv ...any) *y.Map {
	m := y.NewMap()
	for i := 0; i+1 < len(kv); i += 2 {
		m.Set(kv[i].(string), kv[i+1])
	}
	return m
}

// prop is `v?.[k]` for the value model (non-objects read as undefined).
func prop(v any, k string) any {
	if m, ok := v.(*y.Map); ok && m != nil {
		return m.Get(k)
	}
	return y.Undefined
}

// sub returns disk[k] as a map; after mergeDisk / defaultDisk every known
// block is one, so a missing block is replaced by an empty map.
func sub(m *y.Map, k string) *y.Map {
	if s := y.MapAt(m, k); s != nil {
		return s
	}
	s := y.NewMap()
	m.Set(k, s)
	return s
}

var nonEnvChars = regexp.MustCompile(`[^A-Z0-9]+`)

// envSlug is name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').
func envSlug(name string) string { return nonEnvChars.ReplaceAllString(strings.ToUpper(name), "_") }

// defaultDisk is defaultDiskConfig(): the scaffold of a new app.
func defaultDisk(name, displayName, roomPrefix string) *y.Map {
	slug := envSlug(name)
	return obj(
		"name", name,
		"display_name", displayName,
		"room_prefix", roomPrefix,
		"timezone", "",
		"recording", obj(
			"enabled", true,
			"mode", "room-composite",
			"layout", "grid",
			"local_dir", "recordings",
			"delete_local_after_upload", true,
			"split_minutes", 0.0,
			"snapshot_seconds", 0.0,
			"filename_template", "",
			"snapshot_template", "",
			"retention_days", 0.0,
		),
		"s3", obj(
			"provider", "wasabi",
			"bucket", "",
			"region", "us-east-1",
			"endpoint", "https://s3.us-east-1.wasabisys.com",
			"force_path_style", false,
			"prefix", "streamhub/"+name,
			"public_url", "",
			"access_key_env", "APP_"+slug+"_S3_KEY",
			"secret_key_env", "APP_"+slug+"_S3_SECRET",
		),
		"webrtc", obj(
			"adaptive", true,
			"layers", []any{
				obj("name", "high", "height", 720.0),
				obj("name", "med", "height", 480.0),
				obj("name", "low", "height", 240.0),
			},
			"transcode_max_height", float64(DefaultTranscodeMaxHeight),
		),
		"rtmp", obj("enabled", true, "transcode", true, "passthrough", false),
		"transcoding", obj("enabled", false, "encoding", "h264", "vod_adaptive", false, "vod_renditions", []any{}),
		"callbacks", obj("url", "", "secret", ""),
		"mqtt", obj(
			"enabled", false,
			"url", "",
			"username", "",
			"password_env", "APP_"+slug+"_MQTT_PASSWORD",
			"topic_prefix", "streamhub/"+name,
			"qos", 0.0,
			"tls", false,
			"events", []any{"all"},
			"logs", obj("enabled", false, "level", "info"),
		),
		"latency_alert", obj("enabled", false, "threshold_ms", 1000.0, "cooldown_seconds", 60.0, "interval_seconds", 10.0),
		"smtp", obj(
			"enabled", false,
			"host", "",
			"port", 587.0,
			"user", "",
			"from", "",
			"pass_env", "APP_"+slug+"_SMTP_PASS",
		),
		"features", obj(
			"rtmp_password", false,
			"viewer_counter", true,
			"chat", false,
			"reactions", false,
			"hidden_qc", true,
			"adaptive_player", true,
			"public_playback", true,
			"linear", obj(
				"persistent_room", false,
				"room_empty_timeout_seconds", 86400.0,
				"always_on_hls", false,
				"dvr", false,
				"dvr_window_seconds", 3600.0,
			),
		),
		"variables", y.NewMap(),
	)
}

// knownKeys are the keys of mergeDisk's `merged` literal plus what the JS
// `in` operator also finds on Object.prototype — none of them is carried as
// an "extra" block.
var knownKeys = map[string]bool{
	"name": true, "display_name": true, "room_prefix": true, "timezone": true, "recording": true,
	"s3": true, "webrtc": true, "rtmp": true, "quotas": true, "transcoding": true, "callbacks": true,
	"mqtt": true, "latency_alert": true, "smtp": true, "features": true, "variables": true,
	"constructor": true, "__defineGetter__": true, "__defineSetter__": true, "hasOwnProperty": true,
	"__lookupGetter__": true, "__lookupSetter__": true, "isPrototypeOf": true, "propertyIsEnumerable": true,
	"toString": true, "valueOf": true, "__proto__": true, "toLocaleString": true,
}

// spreadOver is `{ ...base, ...(over ?? {}) }`.
func spreadOver(base, over any) *y.Map {
	return y.Assign(y.Spread(base), y.Coalesce(over, y.NewMap()))
}

// mergeDisk overlays the parsed YAML on a fresh default (missing fields
// tolerated), keeping operator-authored unknown top-level blocks first.
func mergeDisk(base *y.Map, over any) *y.Map {
	baseWebrtc := y.MapAt(base, "webrtc")
	overWebrtc := prop(over, "webrtc")
	layers := prop(overWebrtc, "layers")
	if _, ok := layers.([]any); !ok {
		layers = baseWebrtc.Get("layers")
	}

	merged := obj(
		"name", y.Coalesce(prop(over, "name"), base.Get("name")),
		"display_name", y.Coalesce(prop(over, "display_name"), base.Get("display_name")),
		"room_prefix", y.Coalesce(prop(over, "room_prefix"), base.Get("room_prefix")),
		"timezone", y.Coalesce(prop(over, "timezone"), base.Get("timezone")),
		"recording", spreadOver(base.Get("recording"), prop(over, "recording")),
		"s3", spreadOver(base.Get("s3"), prop(over, "s3")),
		"webrtc", obj(
			"adaptive", y.Coalesce(prop(overWebrtc, "adaptive"), baseWebrtc.Get("adaptive")),
			"layers", layers,
			"transcode_max_height", float64(SanitizeTranscodeMaxHeight(
				y.Coalesce(prop(overWebrtc, "transcode_max_height"), baseWebrtc.Get("transcode_max_height")))),
		),
		"rtmp", spreadOver(base.Get("rtmp"), prop(over, "rtmp")),
	)
	if q := y.Coalesce(prop(over, "quotas"), base.Get("quotas")); !y.IsUndefined(q) && q != nil {
		merged.Set("quotas", q)
	}
	if t := prop(over, "transcoding"); y.Truthy(t) {
		merged.Set("transcoding", spreadOver(base.Get("transcoding"), t))
	} else {
		tr := y.Spread(base.Get("transcoding"))
		// Back-compat: a yaml predating the block mirrors rtmp.transcode.
		tr.Set("enabled", y.Coalesce(prop(prop(over, "rtmp"), "transcode"), prop(base.Get("rtmp"), "transcode")) == true)
		merged.Set("transcoding", tr)
	}
	merged.Set("callbacks", spreadOver(base.Get("callbacks"), prop(over, "callbacks")))

	baseMqtt := y.MapAt(base, "mqtt")
	overMqtt := prop(over, "mqtt")
	mqtt := spreadOver(baseMqtt, overMqtt)
	if ev, ok := prop(overMqtt, "events").([]any); ok && len(ev) > 0 {
		mqtt.Set("events", ev)
	} else {
		mqtt.Set("events", baseMqtt.Get("events"))
	}
	mqtt.Set("logs", spreadOver(baseMqtt.Get("logs"), prop(overMqtt, "logs")))
	merged.Set("mqtt", mqtt)

	merged.Set("latency_alert", spreadOver(base.Get("latency_alert"), prop(over, "latency_alert")))
	merged.Set("smtp", spreadOver(base.Get("smtp"), prop(over, "smtp")))

	baseFeatures := y.MapAt(base, "features")
	features := spreadOver(baseFeatures, prop(over, "features"))
	features.Set("linear", spreadOver(baseFeatures.Get("linear"), prop(prop(over, "features"), "linear")))
	merged.Set("features", features)

	if v := prop(over, "variables"); y.Truthy(v) && y.IsObject(v) {
		merged.Set("variables", v)
	} else {
		merged.Set("variables", base.Get("variables"))
	}

	out := y.NewMap()
	extras := y.Spread(over)
	for _, k := range extras.Keys() {
		if !knownKeys[k] {
			out.Set(k, extras.Get(k))
		}
	}
	return y.Assign(out, merged)
}

// applyResolvedPatch applies a camelCase AppConfig patch onto the snake_case
// disk tree. Secret values go to secrets.json via writeSecret, never the yaml.
func (s *Service) applyResolvedPatch(disk *y.Map, patch *contracts.AppConfigPatch) {
	if patch == nil {
		return
	}
	if patch.DisplayName != nil {
		disk.Set("display_name", *patch.DisplayName)
	}
	if patch.RoomPrefix != nil {
		disk.Set("room_prefix", strings.ToLower(*patch.RoomPrefix))
	}
	if patch.Timezone != nil {
		disk.Set("timezone", resolveTimezone(*patch.Timezone))
	}
	if patch.Variables != nil {
		// Whole-map REPLACE; sanitized again on resolve.
		disk.Set("variables", varsToMap(resolveVariables(varsFromPatch(*patch.Variables))))
	}
	if r := patch.Recording; r != nil {
		rec := sub(disk, "recording")
		setBool(rec, "enabled", r.Enabled)
		setStr(rec, "mode", r.Mode)
		setStr(rec, "layout", r.Layout)
		setStr(rec, "local_dir", r.LocalDir)
		setBool(rec, "delete_local_after_upload", r.DeleteLocalAfterUpload)
		setNum(rec, "split_minutes", r.SplitMinutes)
		setNum(rec, "snapshot_seconds", r.SnapshotSeconds)
		setStr(rec, "filename_template", r.FilenameTemplate)
		setStr(rec, "snapshot_template", r.SnapshotTemplate)
		if r.RetentionDays != nil {
			rec.Set("retention_days", resolveRetentionDays(*r.RetentionDays))
		}
	}
	if p := patch.S3; p != nil {
		s3 := sub(disk, "s3")
		setStr(s3, "provider", p.Provider)
		setStr(s3, "bucket", p.Bucket)
		setStr(s3, "region", p.Region)
		setStr(s3, "endpoint", p.Endpoint)
		setBool(s3, "force_path_style", p.ForcePathStyle)
		setStr(s3, "prefix", p.Prefix)
		if p.PublicURL != nil {
			s3.Set("public_url", trimTrailingSlashes(*p.PublicURL))
		}
		if p.AccessKey != "" {
			s.writeSecret(s3.Get("access_key_env"), p.AccessKey)
		}
		if p.SecretKey != "" {
			s.writeSecret(s3.Get("secret_key_env"), p.SecretKey)
		}
	}
	if p := patch.Webrtc; p != nil {
		w := sub(disk, "webrtc")
		setBool(w, "adaptive", p.Adaptive)
		if p.Layers != nil {
			layers := make([]any, 0, len(p.Layers))
			for _, l := range p.Layers {
				layers = append(layers, obj("name", l.Name, "height", l.Height))
			}
			w.Set("layers", layers)
		}
		// Adaptive delivery needs ≥1 rendition: an empty ladder turns it off.
		if l, ok := w.Get("layers").([]any); ok && len(l) == 0 {
			w.Set("adaptive", false)
		}
		if p.TranscodeMaxHeight != nil {
			w.Set("transcode_max_height", float64(SanitizeTranscodeMaxHeight(*p.TranscodeMaxHeight)))
		}
	}
	if p := patch.Rtmp; p != nil {
		r := sub(disk, "rtmp")
		setBool(r, "enabled", p.Enabled)
		setBool(r, "transcode", p.Transcode)
		setBool(r, "passthrough", p.Passthrough)
	}
	if p := patch.Transcoding; p != nil {
		t := sub(disk, "transcoding")
		setBool(t, "enabled", p.Enabled)
		setStr(t, "encoding", p.Encoding)
		setBool(t, "vod_adaptive", p.VodAdaptive)
		if p.VodRenditions != nil {
			list := make([]any, 0, len(p.VodRenditions))
			for _, r := range p.VodRenditions {
				list = append(list, obj("height", r.Height, "bitrate_kbps", r.BitrateKbps))
			}
			t.Set("vod_renditions", list)
		}
	}
	if p := patch.Callbacks; p != nil {
		c := sub(disk, "callbacks")
		setStr(c, "url", p.URL)
		setStr(c, "secret", p.Secret)
	}
	if p := patch.Mqtt; p != nil {
		m := sub(disk, "mqtt")
		setBool(m, "enabled", p.Enabled)
		if p.URL != nil {
			m.Set("url", y.Trim(*p.URL))
		}
		setStr(m, "username", p.Username)
		if p.TopicPrefix != nil {
			m.Set("topic_prefix", y.Trim(*p.TopicPrefix))
		}
		if p.Qos != nil {
			m.Set("qos", float64(*p.Qos))
		}
		setBool(m, "tls", p.TLS)
		if p.Events != nil {
			m.Set("events", stringsToAny(p.Events))
		}
		if p.Logs != nil {
			logs := sub(m, "logs")
			setBool(logs, "enabled", p.Logs.Enabled)
			setStr(logs, "level", p.Logs.Level)
		}
		if p.Password != "" {
			s.writeSecret(m.Get("password_env"), p.Password)
		}
	}
	if p := patch.LatencyAlert; p != nil {
		la := sub(disk, "latency_alert")
		setBool(la, "enabled", p.Enabled)
		setNum(la, "threshold_ms", p.ThresholdMs)
		setNum(la, "cooldown_seconds", p.CooldownSeconds)
		setNum(la, "interval_seconds", p.IntervalSeconds)
	}
	if f := patch.Features; f != nil {
		feat := sub(disk, "features")
		setBool(feat, "rtmp_password", f.RtmpPassword)
		setBool(feat, "viewer_counter", f.ViewerCounter)
		setBool(feat, "chat", f.Chat)
		setBool(feat, "reactions", f.Reactions)
		setBool(feat, "hidden_qc", f.HiddenQc)
		setBool(feat, "adaptive_player", f.AdaptivePlayer)
		setBool(feat, "public_playback", f.PublicPlayback)
		if w := f.WsIngest; w != nil {
			ws := y.NewMap()
			setBool(ws, "enabled", w.Enabled)
			setNum(ws, "max_cameras", w.MaxCameras)
			setNum(ws, "max_fps", w.MaxFps)
			setNum(ws, "max_frame_kb", w.MaxFrameKb)
			setNum(ws, "max_data_bytes", w.MaxDataBytes)
			setNum(ws, "max_data_per_sec", w.MaxDataPerSec)
			feat.Set("ws_ingest", ws)
		}
		if f.Drm != nil {
			// Sanitized through the resolver so garbage never reaches the yaml.
			feat.Set("drm", DrmFeaturesToDisk(ResolveDrmFeatures(DrmFeaturesToDisk(*f.Drm))))
		}
	}

	// Mutual exclusion (both directions), on the final merged state:
	// passthrough wins when explicitly requested; any transcode-like opt-in
	// turns passthrough off.
	wantsPassthrough := patch.Rtmp != nil && isTrue(patch.Rtmp.Passthrough)
	wantsTranscodeLike := patch.Rtmp != nil && isTrue(patch.Rtmp.Transcode) ||
		patch.Transcoding != nil && isTrue(patch.Transcoding.Enabled) ||
		patch.Webrtc != nil && isTrue(patch.Webrtc.Adaptive)
	if wantsPassthrough {
		sub(disk, "rtmp").Set("transcode", false)
		sub(disk, "transcoding").Set("enabled", false)
		sub(disk, "webrtc").Set("adaptive", false)
	} else if wantsTranscodeLike && y.Truthy(sub(disk, "rtmp").Get("passthrough")) {
		sub(disk, "rtmp").Set("passthrough", false)
	}
}

func isTrue(b *bool) bool { return b != nil && *b }

func setStr(m *y.Map, k string, v *string) {
	if v != nil {
		m.Set(k, *v)
	}
}

func setBool(m *y.Map, k string, v *bool) {
	if v != nil {
		m.Set(k, *v)
	}
}

func setNum(m *y.Map, k string, v *float64) {
	if v != nil {
		m.Set(k, *v)
	}
}

func stringsToAny(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}
