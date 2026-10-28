package apps

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// DTO validation: the ValidationPipe message lists, as Node returns them
// (vectors captured from the Node oracle, test/parity/golden/apps.json),
// plus update-app-config.timezone.spec.ts and set-smtp.dto.spec.ts.

func messages(t *testing.T, err error) []string {
	t.Helper()
	var he *httpx.Error
	if !errors.As(err, &he) {
		if err != nil {
			t.Fatalf("not an httpx error: %v", err)
		}
		return nil
	}
	m, _ := he.Body.(httpx.NestBody).Message.([]string)
	return m
}

func TestDtoMessages(t *testing.T) {
	cases := []struct {
		name  string
		parse func([]byte) error
		body  string
		want  []string
	}{
		{"create wrong types", func(b []byte) error { _, err := parseCreateApp(b); return err },
			`{"name":5,"displayName":3,"roomPrefix":["x"]}`,
			[]string{"name must be a lowercase slug (a-z, 0-9, hyphen)", "name must be a string", "displayName must be shorter than or equal to 100 characters", "displayName must be a string", "roomPrefix must be shorter than or equal to 40 characters", "roomPrefix must be a string"}},
		{"create empty", func(b []byte) error { _, err := parseCreateApp(b); return err }, `{}`,
			[]string{"name must be a lowercase slug (a-z, 0-9, hyphen)", "name must be a string"}},
		{"patch invalid", func(b []byte) error { _, err := parseUpdateAppConfig(b); return err },
			`{"displayName":7,"roomPrefix":"Bad Prefix","timezone":"Not/AZone","recordingEnabled":"yes","splitMinutes":7,"snapshotSeconds":"60","filenameTemplate":5,"retentionDays":31,"rtmpPassthrough":1,"transcodeMaxHeight":2000,"callbackUrl":["x"],"callbackSecret":"` + strings.Repeat("s", 257) + `","features":{"chat":"yes","publicPlayback":1,"unknown":true},"variables":[1]}`,
			[]string{"displayName must be shorter than or equal to 100 characters", "displayName must be a string", "roomPrefix must be a lowercase slug (a-z, 0-9, hyphen)", "timezone must be empty (server default) or a valid IANA zone name (e.g. America/Argentina/Buenos_Aires)", "recordingEnabled must be a boolean value", "splitMinutes must be one of 0,15,30,60,90,120", "snapshotSeconds must be one of 0,1,30,60,120,360", "filenameTemplate must be shorter than or equal to 256 characters", "filenameTemplate must be a string", "retentionDays must be one of 0,7,30,90,180,360", "rtmpPassthrough must be a boolean value", "transcodeMaxHeight must be one of 360,480,720,1080", "callbackUrl must be shorter than or equal to 2048 characters", "callbackUrl must be a string", "callbackSecret must be shorter than or equal to 256 characters", "features.chat must be a boolean value", "features.publicPlayback must be a boolean value", "variables must be an object"}},
		{"timezone number", func(b []byte) error { _, err := parseUpdateAppConfig(b); return err }, `{"timezone":12345}`,
			[]string{timezoneMessage, "timezone must be shorter than or equal to 64 characters", "timezone must be a string"}},
		{"features not object", func(b []byte) error { _, err := parseUpdateAppConfig(b); return err }, `{"features":"on"}`,
			[]string{"nested property features must be either object or array"}},
		{"raw missing", func(b []byte) error { _, err := parseRawConfig(b); return err }, `{}`,
			[]string{"yaml must be shorter than or equal to 100000 characters", "yaml must be a string"}},
		{"s3 invalid", func(b []byte) error { _, err := parseSetS3(b); return err },
			`{"provider":"gcs","bucket":5,"region":"` + strings.Repeat("r", 65) + `","forcePathStyle":"no","key":["k"],"confirmPublic":"y"}`,
			[]string{"provider must be one of the following values: aws, wasabi, minio", "bucket must be shorter than or equal to 255 characters", "bucket must be a string", "region must be shorter than or equal to 64 characters", "forcePathStyle must be a boolean value", "key must be shorter than or equal to 512 characters", "key must be a string", "confirmPublic must be a boolean value"}},
		{"mqtt invalid", func(b []byte) error { _, err := parseSetMqtt(b); return err },
			`{"enabled":"y","qos":3,"events":["a",5,"` + strings.Repeat("x", 129) + `"],"logs":{"level":"verbose","enabled":1},"latencyAlert":{"thresholdMs":0,"intervalSeconds":1,"cooldownSeconds":"5"}}`,
			[]string{"enabled must be a boolean value", "qos must be one of the following values: 0, 1, 2", "each value in events must be shorter than or equal to 128 characters", "each value in events must be a string", "logs.enabled must be a boolean value", "logs.level must be one of the following values: trace, debug, info, warn, error, fatal", "latencyAlert.thresholdMs must not be less than 1", "latencyAlert.cooldownSeconds must not be less than 0", "latencyAlert.cooldownSeconds must be a number conforming to the specified constraints", "latencyAlert.intervalSeconds must not be less than 2"}},
		{"mqtt shapes", func(b []byte) error { _, err := parseSetMqtt(b); return err }, `{"qos":1.5,"events":"all","logs":"x"}`,
			[]string{"qos must be one of the following values: 0, 1, 2", "qos must be an integer number", "events must be an array", "nested property logs must be either object or array"}},
		{"smtp invalid", func(b []byte) error { _, err := parseSetSmtp(b); return err }, `{"port":0,"host":"` + strings.Repeat("h", 256) + `","pass":5,"enabled":"true"}`,
			[]string{"enabled must be a boolean value", "host must be shorter than or equal to 255 characters", "port must not be less than 1", "pass must be shorter than or equal to 512 characters", "pass must be a string"}},
		{"smtp port float", func(b []byte) error { _, err := parseSetSmtp(b); return err }, `{"port":587.5}`, []string{"port must be an integer number"}},
		{"smtp port high", func(b []byte) error { _, err := parseSetSmtp(b); return err }, `{"port":70000}`, []string{"port must not be greater than 65535"}},
		{"smtp empty ok", func(b []byte) error { _, err := parseSetSmtp(b); return err }, `{}`, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := messages(t, tc.parse([]byte(tc.body))); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("messages:\n got  %q\n want %q", got, tc.want)
			}
		})
	}
}

func TestTimezoneDto(t *testing.T) {
	for _, tz := range []string{"", "UTC", "America/Argentina/Buenos_Aires", "Europe/Madrid", "Asia/Tokyo", "Australia/Sydney", " utc ", "US/Eastern", "+05:00"} {
		if _, err := parseUpdateAppConfig([]byte(`{"timezone":"` + tz + `"}`)); err != nil {
			t.Errorf("%q rejected: %v", tz, err)
		}
	}
	for _, tz := range []string{"Not/AZone", "literally anything", "GMT+25", "Mars/Olympus_Mons", strings.Repeat("A", 65)} {
		if _, err := parseUpdateAppConfig([]byte(`{"timezone":"` + tz + `"}`)); err == nil {
			t.Errorf("%q accepted", tz)
		}
	}
	cp, err := parseUpdateAppConfig([]byte(`{"displayName":"Live","roomPrefix":"live","timezone":" Europe/Madrid ","recordingEnabled":true}`))
	if err != nil || *cp.patch.Timezone != "Europe/Madrid" || strings.Join(cp.fields, ",") != "displayName,roomPrefix,timezone,recording" {
		t.Errorf("mapping = %+v, %v", cp, err)
	}
}

func TestToConfigPatch(t *testing.T) {
	cp, err := parseUpdateAppConfig([]byte(`{"variables":{"b":"1","2":"two","a":null},"features":{"chat":true,"wsIngest":{}},"callbackSecret":"s","transcodeMaxHeight":480,"rtmpPassthrough":false,"splitMinutes":15}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(cp.fields, ",") != "recording,rtmp,webrtc,callbacks,features,variables" {
		t.Errorf("fields = %v", cp.fields)
	}
	p := cp.patch
	if *p.Recording.SplitMinutes != 15 || p.Recording.Enabled != nil || *p.Rtmp.Passthrough || *p.Webrtc.TranscodeMaxHeight != 480 ||
		p.Callbacks.URL != nil || *p.Callbacks.Secret != "s" || !*p.Features.Chat || p.Features.WsIngest != nil {
		t.Errorf("patch = %+v", p)
	}
	var keys []string
	for _, v := range *p.Variables {
		keys = append(keys, v.Key)
	}
	if strings.Join(keys, ",") != "2,b,a" {
		t.Errorf("variables keep JS property order: %v", keys)
	}
}
