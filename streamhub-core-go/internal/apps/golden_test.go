package apps

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// TestNodeGolden replays testdata/steps.json — the scenario testdata/gen.js
// ran through the compiled Node AppsService — and requires, per step, the
// SAME config.yaml bytes (js-yaml dump parity), the same resolved AppConfig
// and the same result/error.
//
// Regenerate (historical — needs the retired NestJS core, branch
// legacy/node-2.x / tag 2.24.0): cd streamhub-core && node ../streamhub-core-go/internal/apps/testdata/gen.js
func TestNodeGolden(t *testing.T) {
	stepsRaw, err := os.ReadFile("testdata/steps.json")
	if err != nil {
		t.Fatal(err)
	}
	stepsAny, err := y.ParseJSON(stepsRaw)
	if err != nil {
		t.Fatal(err)
	}
	var results []struct {
		Op       string `json:"op"`
		Result   any    `json:"result"`
		Resolved any    `json:"resolved"`
	}
	resRaw, _ := os.ReadFile("testdata/golden/results.json")
	if err := json.Unmarshal(resRaw, &results); err != nil {
		t.Fatal(err)
	}

	s, _ := newTestService(t)
	ctx := context.Background()
	for i, st := range stepsAny.([]any) {
		step := st.(*y.Map)
		op := step.Get("op").(string)
		args := step.Get("args").([]any)
		app, _ := args[0].(string)
		if m, ok := args[0].(*y.Map); ok {
			app = m.Get("name").(string)
		}
		t.Run(fmt.Sprintf("%02d-%s-%s", i, op, app), func(t *testing.T) {
			got, err := runStep(ctx, s, op, args)
			var gotJSON any
			if err != nil {
				gotJSON = map[string]any{"$error": err.Error()}
			} else {
				gotJSON = roundTrip(t, got)
			}
			want := results[i]
			stripTimestamps(gotJSON)
			stripTimestamps(want.Result)
			if !reflect.DeepEqual(gotJSON, want.Result) {
				t.Errorf("result:\n go:   %s\n node: %s", js(gotJSON), js(want.Result))
			}

			wantYAML, yErr := os.ReadFile(filepath.Join("testdata/golden", fmt.Sprintf("%02d.yaml", i)))
			gotYAML, gErr := os.ReadFile(s.configPath(app))
			if (yErr == nil) != (gErr == nil) {
				t.Fatalf("config.yaml presence differs: node=%v go=%v", yErr, gErr)
			}
			if yErr == nil && string(gotYAML) != string(wantYAML) {
				t.Errorf("config.yaml differs:\n--- go\n%s\n--- node\n%s", gotYAML, wantYAML)
			}

			var resolved any
			if cfg, err := s.GetConfig(ctx, app); err == nil {
				resolved = roundTrip(t, cfg)
			}
			if !reflect.DeepEqual(resolved, want.Resolved) {
				t.Errorf("resolved:\n go:   %s\n node: %s", js(resolved), js(want.Resolved))
			}
		})
	}
}

func runStep(ctx context.Context, s *Service, op string, args []any) (any, error) {
	str := func(i int) string { return args[i].(string) }
	m := func(i int) *y.Map { return args[i].(*y.Map) }
	switch op {
	case "create":
		in := m(0)
		return s.Create(ctx, contracts.CreateAppInput{
			Name: optStr(in, "name"), DisplayName: optStr(in, "displayName"), RoomPrefix: optStr(in, "roomPrefix"),
		})
	case "updateConfig":
		return s.UpdateConfig(ctx, str(0), patchFromJS(m(1)))
	case "setS3":
		in := m(1)
		return s.SetS3(ctx, str(0), SetS3Input{
			Provider: strPtr(in, "provider"), Bucket: strPtr(in, "bucket"), Region: strPtr(in, "region"),
			Endpoint: strPtr(in, "endpoint"), ForcePathStyle: boolPtr(in, "forcePathStyle"), Prefix: strPtr(in, "prefix"),
			PublicURL: strPtr(in, "public_url"), Key: optStr(in, "key"), Secret: optStr(in, "secret"),
			ConfirmPublic: in.Get("confirmPublic") == true,
		})
	case "getS3":
		return s.GetS3(ctx, str(0))
	case "setMqtt":
		in := m(1)
		mi := SetMqttInput{
			Enabled: boolPtr(in, "enabled"), URL: strPtr(in, "url"), Username: strPtr(in, "username"),
			Password: optStr(in, "password"), TopicPrefix: strPtr(in, "topicPrefix"), Qos: numPtr(in, "qos"),
			TLS: boolPtr(in, "tls"), Events: strList(in.Get("events")),
		}
		if l := y.MapAt(in, "logs"); l != nil {
			mi.Logs = &contracts.MqttLogsPatch{Enabled: boolPtr(l, "enabled"), Level: strPtr(l, "level")}
		}
		if l := y.MapAt(in, "latencyAlert"); l != nil {
			mi.LatencyAlert = latencyPatch(l)
		}
		return s.SetMqtt(ctx, str(0), mi)
	case "getMqtt":
		return s.GetMqtt(ctx, str(0))
	case "setSmtp":
		in := m(1)
		return s.SetSmtp(ctx, str(0), SetSmtpInput{
			Enabled: boolPtr(in, "enabled"), Host: strPtr(in, "host"), Port: numPtr(in, "port"),
			User: strPtr(in, "user"), From: strPtr(in, "from"), Pass: optStr(in, "pass"),
		})
	case "getSmtp":
		return s.GetSmtp(ctx, str(0))
	case "putRawConfig":
		return s.PutRawConfig(ctx, str(0), str(1))
	case "applyConfigPreset":
		return s.ApplyConfigPreset(ctx, str(0), str(1))
	case "deactivateConfigPreset":
		return s.DeactivateConfigPreset(ctx, str(0), str(1))
	case "listConfigPresets":
		return s.ListConfigPresets(ctx, str(0))
	case "dryRunRawConfig":
		return s.DryRunRawConfig(ctx, str(0), str(1))
	case "reload":
		return s.Reload(ctx, str(0))
	}
	return nil, fmt.Errorf("unknown op %s", op)
}

// patchFromJS maps a JS Partial<AppConfig> literal onto the Go patch.
func patchFromJS(p *y.Map) contracts.AppConfigPatch {
	out := contracts.AppConfigPatch{
		DisplayName: strPtr(p, "displayName"), RoomPrefix: strPtr(p, "roomPrefix"), Timezone: strPtr(p, "timezone"),
	}
	if v := y.MapAt(p, "variables"); v != nil {
		vars := []contracts.Var{}
		for _, k := range v.Keys() {
			vars = append(vars, contracts.Var{Key: k, Value: v.Get(k)})
		}
		out.Variables = &vars
	}
	if r := y.MapAt(p, "recording"); r != nil {
		out.Recording = &contracts.RecordingPatch{
			Enabled: boolPtr(r, "enabled"), Mode: strPtr(r, "mode"), Layout: strPtr(r, "layout"),
			LocalDir: strPtr(r, "localDir"), DeleteLocalAfterUpload: boolPtr(r, "deleteLocalAfterUpload"),
			SplitMinutes: numPtr(r, "splitMinutes"), SnapshotSeconds: numPtr(r, "snapshotSeconds"),
			FilenameTemplate: strPtr(r, "filenameTemplate"), SnapshotTemplate: strPtr(r, "snapshotTemplate"),
			RetentionDays: numPtr(r, "retentionDays"),
		}
	}
	if w := y.MapAt(p, "webrtc"); w != nil {
		wp := &contracts.WebrtcPatch{Adaptive: boolPtr(w, "adaptive"), TranscodeMaxHeight: numPtr(w, "transcodeMaxHeight")}
		if list, ok := w.Get("layers").([]any); ok {
			wp.Layers = []contracts.WebrtcLayer{}
			for _, l := range list {
				lm := l.(*y.Map)
				wp.Layers = append(wp.Layers, contracts.WebrtcLayer{Name: optStr(lm, "name"), Height: lm.Get("height").(float64)})
			}
		}
		out.Webrtc = wp
	}
	if r := y.MapAt(p, "rtmp"); r != nil {
		out.Rtmp = &contracts.RtmpPatch{Enabled: boolPtr(r, "enabled"), Transcode: boolPtr(r, "transcode"), Passthrough: boolPtr(r, "passthrough")}
	}
	if tr := y.MapAt(p, "transcoding"); tr != nil {
		tp := &contracts.TranscodingPatch{Enabled: boolPtr(tr, "enabled"), Encoding: strPtr(tr, "encoding"), VodAdaptive: boolPtr(tr, "vodAdaptive")}
		if list, ok := tr.Get("vodRenditions").([]any); ok {
			tp.VodRenditions = []contracts.VodRendition{}
			for _, r := range list {
				rm := r.(*y.Map)
				tp.VodRenditions = append(tp.VodRenditions, contracts.VodRendition{Height: rm.Get("height").(float64), BitrateKbps: rm.Get("bitrateKbps").(float64)})
			}
		}
		out.Transcoding = tp
	}
	if c := y.MapAt(p, "callbacks"); c != nil {
		out.Callbacks = &contracts.CallbacksPatch{URL: strPtr(c, "url"), Secret: strPtr(c, "secret")}
	}
	if mq := y.MapAt(p, "mqtt"); mq != nil {
		mp := &contracts.MqttPatch{
			Enabled: boolPtr(mq, "enabled"), URL: strPtr(mq, "url"), Username: strPtr(mq, "username"),
			TopicPrefix: strPtr(mq, "topicPrefix"), TLS: boolPtr(mq, "tls"), Events: strList(mq.Get("events")),
			Password: optStr(mq, "password"),
		}
		if q := numPtr(mq, "qos"); q != nil {
			n := int(*q)
			mp.Qos = &n
		}
		if l := y.MapAt(mq, "logs"); l != nil {
			mp.Logs = &contracts.MqttLogsPatch{Enabled: boolPtr(l, "enabled"), Level: strPtr(l, "level")}
		}
		out.Mqtt = mp
	}
	if l := y.MapAt(p, "latencyAlert"); l != nil {
		out.LatencyAlert = latencyPatch(l)
	}
	if f := y.MapAt(p, "features"); f != nil {
		fp := &contracts.FeaturesPatch{
			RtmpPassword: boolPtr(f, "rtmpPassword"), ViewerCounter: boolPtr(f, "viewerCounter"), Chat: boolPtr(f, "chat"),
			Reactions: boolPtr(f, "reactions"), HiddenQc: boolPtr(f, "hiddenQc"), AdaptivePlayer: boolPtr(f, "adaptivePlayer"),
			PublicPlayback: boolPtr(f, "publicPlayback"),
		}
		if w := y.MapAt(f, "wsIngest"); w != nil {
			fp.WsIngest = &contracts.WsIngestPatch{
				Enabled: boolPtr(w, "enabled"), MaxCameras: numPtr(w, "maxCameras"), MaxFps: numPtr(w, "maxFps"),
				MaxFrameKb: numPtr(w, "maxFrameKb"), MaxDataBytes: numPtr(w, "maxDataBytes"), MaxDataPerSec: numPtr(w, "maxDataPerSec"),
			}
		}
		if d := y.MapAt(f, "drm"); d != nil {
			var drm contracts.DrmFeatures
			b, _ := json.Marshal(d)
			_ = json.Unmarshal(b, &drm)
			fp.Drm = &drm
		}
		out.Features = fp
	}
	return out
}

func latencyPatch(l *y.Map) *contracts.LatencyAlertPatch {
	return &contracts.LatencyAlertPatch{
		Enabled: boolPtr(l, "enabled"), ThresholdMs: numPtr(l, "thresholdMs"),
		CooldownSeconds: numPtr(l, "cooldownSeconds"), IntervalSeconds: numPtr(l, "intervalSeconds"),
	}
}

func optStr(m *y.Map, k string) string { s, _ := m.Get(k).(string); return s }

func strPtr(m *y.Map, k string) *string {
	s, ok := m.Get(k).(string)
	return ptrIf(s, ok)
}

func boolPtr(m *y.Map, k string) *bool {
	b, ok := m.Get(k).(bool)
	return ptrIf(b, ok)
}

func numPtr(m *y.Map, k string) *float64 {
	f, ok := m.Get(k).(float64)
	return ptrIf(f, ok)
}

func strList(v any) []string {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := []string{}
	for _, e := range list {
		s, _ := e.(string)
		out = append(out, s)
	}
	return out
}

func roundTrip(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func stripTimestamps(v any) {
	if m, ok := v.(map[string]any); ok {
		delete(m, "createdAt")
		delete(m, "updatedAt")
	}
}

func js(v any) string { b, _ := json.Marshal(v); return string(b) }
