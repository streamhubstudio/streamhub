package apps

import (
	"regexp"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/timezone"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Request DTOs (apps/dto/*.dto.ts) under Nest's ValidationPipe
// ({transform, whitelist}): rules are listed in the order class-validator
// reports them (a property's decorators run bottom-up).

// CreateAppDto is POST /apps.
type CreateAppDto struct {
	Name        string
	DisplayName string
	RoomPrefix  string
}

var createSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`)

func parseCreateApp(raw []byte) (*CreateAppDto, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, err
	}
	b.Field("name").Matches(createSlug, "name must be a lowercase slug (a-z, 0-9, hyphen)").IsString()
	b.Optional("displayName").MaxLength(100).IsString()
	b.Optional("roomPrefix").MaxLength(40).IsString()
	if err := b.Err(); err != nil {
		return nil, err
	}
	return &CreateAppDto{Name: b.String("name"), DisplayName: b.String("displayName"), RoomPrefix: b.String("roomPrefix")}, nil
}

var roomPrefixSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

const timezoneMessage = "timezone must be empty (server default) or a valid IANA zone name (e.g. America/Argentina/Buenos_Aires)"

// patchFields are the camelCase AppConfig keys a PATCH touched, in the
// controller's toConfigPatch order (audited by NAME only).
type configPatch struct {
	patch  contracts.AppConfigPatch
	fields []string
}

// parseUpdateAppConfig validates UpdateAppConfigDto and maps the flat DTO
// into a structured patch (toConfigPatch).
func parseUpdateAppConfig(raw []byte) (*configPatch, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, err
	}
	b.Optional("displayName").MaxLength(100).IsString()
	b.Optional("roomPrefix").Matches(roomPrefixSlug, "roomPrefix must be a lowercase slug (a-z, 0-9, hyphen)").IsString()
	tz := b.Optional("timezone")
	tzStr, isStr := b.Raw("timezone").(string)
	tz.Check(isStr && timezone.IsValid(y.Trim(tzStr)), timezoneMessage).MaxLength(64).IsString()
	b.Optional("recordingEnabled").IsBoolean()
	b.Optional("splitMinutes").IsInNumbers([]float64{0, 15, 30, 60, 90, 120}, "splitMinutes must be one of 0,15,30,60,90,120")
	b.Optional("snapshotSeconds").IsInNumbers([]float64{0, 1, 30, 60, 120, 360}, "snapshotSeconds must be one of 0,1,30,60,120,360")
	b.Optional("filenameTemplate").MaxLength(256).IsString()
	b.Optional("snapshotTemplate").MaxLength(256).IsString()
	b.Optional("retentionDays").IsInNumbers([]float64{0, 7, 30, 90, 180, 360}, "retentionDays must be one of 0,7,30,90,180,360")
	b.Optional("rtmpPassthrough").IsBoolean()
	b.Optional("transcodeMaxHeight").IsInNumbers([]float64{360, 480, 720, 1080}, "transcodeMaxHeight must be one of 360,480,720,1080")
	b.Optional("callbackUrl").MaxLength(2048).IsString()
	b.Optional("callbackSecret").MaxLength(256).IsString()
	b.Nested("features", func(f *validate.Body) {
		for _, k := range featureFlags {
			f.Optional(k).IsBoolean()
		}
	})
	b.Optional("variables").IsObject()
	if err := b.Err(); err != nil {
		return nil, err
	}

	out := &configPatch{}
	p := &out.patch
	touch := func(field string) { out.fields = append(out.fields, field) }
	if v := b.StringPtr("displayName"); v != nil {
		p.DisplayName = v
		touch("displayName")
	}
	if v := b.StringPtr("roomPrefix"); v != nil {
		p.RoomPrefix = v
		touch("roomPrefix")
	}
	if v := b.StringPtr("timezone"); v != nil {
		t := y.Trim(*v)
		p.Timezone = &t
		touch("timezone")
	}
	rec := contracts.RecordingPatch{
		Enabled: b.Bool("recordingEnabled"), SplitMinutes: b.Float("splitMinutes"),
		SnapshotSeconds: b.Float("snapshotSeconds"), FilenameTemplate: b.StringPtr("filenameTemplate"),
		SnapshotTemplate: b.StringPtr("snapshotTemplate"), RetentionDays: b.Float("retentionDays"),
	}
	if rec.Enabled != nil || rec.SplitMinutes != nil || rec.SnapshotSeconds != nil ||
		rec.FilenameTemplate != nil || rec.SnapshotTemplate != nil || rec.RetentionDays != nil {
		p.Recording = &rec
		touch("recording")
	}
	if v := b.Bool("rtmpPassthrough"); v != nil {
		p.Rtmp = &contracts.RtmpPatch{Passthrough: v}
		touch("rtmp")
	}
	if v := b.Float("transcodeMaxHeight"); v != nil {
		p.Webrtc = &contracts.WebrtcPatch{TranscodeMaxHeight: v}
		touch("webrtc")
	}
	if url, secret := b.StringPtr("callbackUrl"), b.StringPtr("callbackSecret"); url != nil || secret != nil {
		p.Callbacks = &contracts.CallbacksPatch{URL: url, Secret: secret}
		touch("callbacks")
	}
	if f, ok := b.Raw("features").(map[string]any); ok {
		fb := func(k string) *bool { v, ok := f[k].(bool); return ptrIf(v, ok) }
		p.Features = &contracts.FeaturesPatch{
			RtmpPassword: fb("rtmpPassword"), ViewerCounter: fb("viewerCounter"), Chat: fb("chat"),
			Reactions: fb("reactions"), HiddenQc: fb("hiddenQc"), AdaptivePlayer: fb("adaptivePlayer"),
			PublicPlayback: fb("publicPlayback"),
		}
		touch("features")
	} else if _, isArr := b.Raw("features").([]any); isArr {
		p.Features = &contracts.FeaturesPatch{}
		touch("features")
	}
	if b.Has("variables") {
		vars := orderedVariables(raw)
		p.Variables = &vars
		touch("variables")
	}
	return out, nil
}

var featureFlags = []string{"rtmpPassword", "viewerCounter", "chat", "reactions", "hiddenQc", "adaptivePlayer", "publicPlayback"}

func ptrIf[T any](v T, ok bool) *T {
	if !ok {
		return nil
	}
	return &v
}

// orderedVariables re-reads `variables` with JS property order (JSON.parse
// keeps it; a Go map would not).
func orderedVariables(raw []byte) []contracts.Var {
	parsed, err := y.ParseJSON(raw)
	if err != nil {
		return nil
	}
	m, _ := prop(parsed, "variables").(*y.Map)
	out := []contracts.Var{}
	if m == nil {
		return out
	}
	for _, k := range m.Keys() {
		out = append(out, contracts.Var{Key: k, Value: m.Get(k)})
	}
	return out
}

// parseRawConfig is PutRawConfigDto.
func parseRawConfig(raw []byte) (string, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return "", err
	}
	b.Field("yaml").MaxLength(100_000).IsString()
	if err := b.Err(); err != nil {
		return "", err
	}
	return b.String("yaml"), nil
}

// setS3Dto is SetS3Dto (+ the audit fields).
type setS3Dto struct {
	in       SetS3Input
	bucket   *string
	endpoint *string
}

func parseSetS3(raw []byte) (*setS3Dto, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, err
	}
	b.Optional("provider").IsIn("aws", "wasabi", "minio")
	b.Optional("bucket").MaxLength(255).IsString()
	b.Optional("region").MaxLength(64).IsString()
	b.Optional("endpoint").MaxLength(255).IsString()
	b.Optional("forcePathStyle").IsBoolean()
	b.Optional("prefix").MaxLength(255).IsString()
	b.Optional("public_url").MaxLength(255).IsString()
	b.Optional("key").MaxLength(512).IsString()
	b.Optional("secret").MaxLength(512).IsString()
	b.Optional("confirmPublic").IsBoolean()
	if err := b.Err(); err != nil {
		return nil, err
	}
	confirm := b.Bool("confirmPublic")
	return &setS3Dto{
		in: SetS3Input{
			Provider: b.StringPtr("provider"), Bucket: b.StringPtr("bucket"), Region: b.StringPtr("region"),
			Endpoint: b.StringPtr("endpoint"), ForcePathStyle: b.Bool("forcePathStyle"), Prefix: b.StringPtr("prefix"),
			PublicURL: b.StringPtr("public_url"), Key: b.String("key"), Secret: b.String("secret"),
			ConfirmPublic: confirm != nil && *confirm,
		},
		bucket: b.StringPtr("bucket"), endpoint: b.StringPtr("endpoint"),
	}, nil
}

var logLevels = []string{"trace", "debug", "info", "warn", "error", "fatal"}

func parseSetMqtt(raw []byte) (*SetMqttInput, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, err
	}
	b.Optional("enabled").IsBoolean()
	b.Optional("url").MaxLength(512).IsString()
	b.Optional("username").MaxLength(255).IsString()
	b.Optional("password").MaxLength(512).IsString()
	b.Optional("topicPrefix").MaxLength(255).IsString()
	b.Optional("qos").IsInNumbers([]float64{0, 1, 2}, "").IsInt()
	b.Optional("tls").IsBoolean()
	b.Optional("events").EachMaxLength(128).EachIsString().IsArray()
	b.Nested("logs", func(l *validate.Body) {
		l.Optional("enabled").IsBoolean()
		l.Optional("level").IsIn(logLevels...)
	})
	b.Nested("latencyAlert", func(l *validate.Body) {
		l.Optional("enabled").IsBoolean()
		l.Optional("thresholdMs").Min(1).IsNumber()
		l.Optional("cooldownSeconds").Min(0).IsNumber()
		l.Optional("intervalSeconds").Min(2).IsNumber()
	})
	if err := b.Err(); err != nil {
		return nil, err
	}
	in := &SetMqttInput{
		Enabled: b.Bool("enabled"), URL: b.StringPtr("url"), Username: b.StringPtr("username"),
		Password: b.String("password"), TopicPrefix: b.StringPtr("topicPrefix"), Qos: b.Float("qos"),
		TLS: b.Bool("tls"), Events: b.Strings("events"),
	}
	if l, ok := b.Raw("logs").(map[string]any); ok {
		lv, _ := l["level"].(string)
		en, enOK := l["enabled"].(bool)
		in.Logs = &contracts.MqttLogsPatch{Enabled: ptrIf(en, enOK), Level: ptrIf(lv, lv != "")}
	}
	if l, ok := b.Raw("latencyAlert").(map[string]any); ok {
		num := func(k string) *float64 { f, ok := l[k].(float64); return ptrIf(f, ok) }
		en, enOK := l["enabled"].(bool)
		in.LatencyAlert = &contracts.LatencyAlertPatch{
			Enabled: ptrIf(en, enOK), ThresholdMs: num("thresholdMs"),
			CooldownSeconds: num("cooldownSeconds"), IntervalSeconds: num("intervalSeconds"),
		}
	}
	return in, nil
}

func parseSetSmtp(raw []byte) (*SetSmtpInput, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, err
	}
	b.Optional("enabled").IsBoolean()
	b.Optional("host").MaxLength(255).IsString()
	b.Optional("port").Max(65535).Min(1).IsInt()
	b.Optional("user").MaxLength(255).IsString()
	b.Optional("pass").MaxLength(512).IsString()
	b.Optional("from").MaxLength(255).IsString()
	if err := b.Err(); err != nil {
		return nil, err
	}
	return &SetSmtpInput{
		Enabled: b.Bool("enabled"), Host: b.StringPtr("host"), Port: b.Float("port"),
		User: b.StringPtr("user"), From: b.StringPtr("from"), Pass: b.String("pass"),
	}, nil
}
