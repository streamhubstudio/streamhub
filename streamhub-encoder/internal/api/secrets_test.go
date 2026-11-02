package api

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

// Secrets planted in secretChJSON / secretNotifyJSON / the youtube preset.
var apiSecrets = []string{"inPassphrase-0001", "camPass-0002", "outPassphrase-0003", "rtmpPass-0004", "streamKey-0005",
	"ytKey-0006", "whipUrlTok-0007", "whipBearer-0008", "hlsPass-0009", "sk_shToken-0010",
	"hookUrlTok-0012", "hookSecret-0013", "snmpAuth-0014", "snmpPriv-0015", "community-0016"}

const secretChJSON = `{"id":"ch1","enabled":true,
 "input":{"type":"srt","uri":"srt://:9000?mode=listener&passphrase=inPassphrase-0001"},
 "backup":{"type":"rtsp","uri":"rtsp://admin:camPass-0002@10.0.0.9/stream"},
 "video":{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000},
 "outputs":[
  {"id":"srt","type":"srt","enabled":true,"url":"srt://10.0.0.1:9000","srt":{"passphrase":"outPassphrase-0003","streamId":"publish:cam1"}},
  {"id":"rtmp","type":"rtmp","enabled":true,"url":"rtmp://pub:rtmpPass-0004@live.example.com/app/streamKey-0005"},
  {"id":"whip","type":"whip","enabled":true,"url":"https://whip.example.com/whip/ep?token=whipUrlTok-0007","whip":{"bearerToken":"whipBearer-0008"}},
  {"id":"hls","type":"hls","enabled":true,"url":"https://hlsUser:hlsPass-0009@cdn.example.com/live/index.m3u8"},
  {"id":"sh","type":"streamhub","enabled":true,"streamhub":{"baseUrl":"https://sh.example.com","app":"live","token":"sk_shToken-0010"}}]}`

const secretNotifyJSON = `{"webhooks":[{"url":"https://hooks.example.com/x?token=hookUrlTok-0012","secret":"hookSecret-0013"}],
 "snmp":[{"address":"10.0.0.2:162","version":"3","user":"nms","authPass":"snmpAuth-0014","privPass":"snmpPriv-0015"},
         {"address":"10.0.0.3:162","version":"2c","community":"community-0016"}]}`

func noLeak(t *testing.T, what, raw string) {
	t.Helper()
	for _, s := range apiSecrets {
		if strings.Contains(raw, s) {
			t.Errorf("%s leaks %q:\n%s", what, s, raw)
		}
	}
}

func mustDo(t *testing.T, code int, what string, got int, raw string) {
	t.Helper()
	if got != code {
		t.Fatalf("%s: %d %s", what, got, raw)
	}
}

// No read path of the API returns a secret: channel config (list, get,
// create/patch/put answers, outputs add), the pipeline dry run, the backup
// export and the notify targets.
func TestAPINeverReturnsSecrets(t *testing.T) {
	srv, _, _ := setup(t)
	c, _, raw := do(t, srv, "POST", "/api/v1/channels", "ek_test", secretChJSON)
	mustDo(t, 201, "create", c, raw)
	noLeak(t, "POST /channels", raw)
	c, _, raw = do(t, srv, "POST", "/api/v1/channels/ch1/outputs", "ek_test", `{"preset":"youtube-rtmp","params":{"key":"ytKey-0006"},"id":"yt"}`)
	mustDo(t, 201, "preset output", c, raw)
	noLeak(t, "POST /outputs", raw)
	c, _, raw = do(t, srv, "PUT", "/api/v1/notify", "ek_test", secretNotifyJSON)
	mustDo(t, 200, "notify put", c, raw)
	noLeak(t, "PUT /notify", raw)
	for _, p := range []string{"/api/v1/channels", "/api/v1/channels/ch1", "/api/v1/channels/ch1/pipeline",
		"/api/v1/config/backup", "/api/v1/notify"} {
		c, _, raw := do(t, srv, "GET", p, "ek_test", "")
		mustDo(t, 200, p, c, raw)
		noLeak(t, "GET "+p, raw)
	}
	// the dry run still shows the real pipeline shape
	_, _, raw = do(t, srv, "GET", "/api/v1/channels/ch1/pipeline", "ek_test", "")
	for _, want := range []string{"srtsink", "passphrase=", "rtmp2sink", "live.example.com/app/", "whip-push", "-method"} {
		if !strings.Contains(raw, want) {
			t.Errorf("dry run lost %q: %s", want, raw)
		}
	}
	c, _, raw = do(t, srv, "PATCH", "/api/v1/channels/ch1", "ek_test", `{"name":"SDI 1"}`)
	mustDo(t, 200, "patch", c, raw)
	noLeak(t, "PATCH /channels/ch1", raw)
}

// Writing back what a GET returned (placeholders included) never overwrites
// the stored secrets: PUT/PATCH of a channel, PUT of one output, PUT /notify.
func TestPlaceholderRoundTripKeepsStoredSecrets(t *testing.T) {
	srv, st, _ := setup(t)
	do(t, srv, "POST", "/api/v1/channels", "ek_test", secretChJSON)
	do(t, srv, "PUT", "/api/v1/notify", "ek_test", secretNotifyJSON)
	want := st.Get()

	// literal placeholders, as the UI sends them back
	put := strings.NewReplacer("inPassphrase-0001", config.Redacted, "camPass-0002", config.Redacted, "outPassphrase-0003", config.Redacted,
		"rtmpPass-0004", config.Redacted, "streamKey-0005", config.Redacted, "whipUrlTok-0007", config.Redacted,
		"whipBearer-0008", config.Redacted, "hlsPass-0009", config.Redacted, "sk_shToken-0010", config.Redacted).Replace(secretChJSON)
	c, _, raw := do(t, srv, "PUT", "/api/v1/channels/ch1", "ek_test", put)
	mustDo(t, 200, "put channel with placeholders", c, raw)
	c, _, raw = do(t, srv, "PATCH", "/api/v1/channels/ch1", "ek_test", `{"outputs":[
	 {"id":"srt","type":"srt","enabled":true,"url":"srt://10.0.0.1:9000","srt":{"passphrase":"***","streamId":"publish:cam1"}},
	 {"id":"rtmp","type":"rtmp","enabled":true,"url":"rtmp://pub:***@live.example.com/app/***"},
	 {"id":"whip","type":"whip","enabled":true,"url":"https://whip.example.com/whip/ep?token=***","whip":{"bearerToken":"***"}},
	 {"id":"hls","type":"hls","enabled":true,"url":"https://hlsUser:***@cdn.example.com/live/index.m3u8"},
	 {"id":"sh","type":"streamhub","enabled":true,"streamhub":{"baseUrl":"https://sh.example.com","app":"live","token":"***"}}]}`)
	mustDo(t, 200, "patch outputs with placeholders", c, raw)
	c, _, raw = do(t, srv, "PUT", "/api/v1/channels/ch1/outputs/srt", "ek_test",
		`{"type":"srt","enabled":true,"url":"srt://10.0.0.1:9000","srt":{"passphrase":"***","streamId":"publish:cam1"}}`)
	mustDo(t, 200, "put output with placeholder", c, raw)
	// GET → PUT of the redacted view
	_, _, raw = do(t, srv, "GET", "/api/v1/channels/ch1", "ek_test", "")
	var view ChannelView
	_ = json.Unmarshal([]byte(raw), &view)
	b, _ := json.Marshal(view.Config)
	c, _, raw = do(t, srv, "PUT", "/api/v1/channels/ch1", "ek_test", string(b))
	mustDo(t, 200, "GET→PUT", c, raw)
	_, body, _ := do(t, srv, "GET", "/api/v1/notify", "ek_test", "")
	nb, _ := json.Marshal(body["config"])
	c, _, raw = do(t, srv, "PUT", "/api/v1/notify", "ek_test", string(nb))
	mustDo(t, 200, "notify GET→PUT", c, raw)

	got := st.Get()
	if !reflect.DeepEqual(want.Channels[0].Outputs, got.Channels[0].Outputs) || !reflect.DeepEqual(want.Channels[0].Input, got.Channels[0].Input) ||
		!reflect.DeepEqual(want.Channels[0].Backup, got.Channels[0].Backup) {
		a, _ := json.Marshal(want.Channels[0])
		b, _ := json.Marshal(got.Channels[0])
		t.Fatalf("stored channel secrets changed:\nwant %s\ngot  %s", a, b)
	}
	if !reflect.DeepEqual(want.Settings.Notify, got.Settings.Notify) {
		a, _ := json.Marshal(want.Settings.Notify)
		b, _ := json.Marshal(got.Settings.Notify)
		t.Fatalf("stored notify secrets changed:\nwant %s\ngot  %s", a, b)
	}
}

// The backup export carries placeholders: restoring it on the same box keeps
// the stored secrets; on a box that does not have them the import is refused
// with the fields to re-enter (never stored as "***").
func TestBackupHasNoSecretsAndRestoreAsksForThem(t *testing.T) {
	srv, st, _ := setup(t)
	do(t, srv, "POST", "/api/v1/channels", "ek_test", secretChJSON)
	do(t, srv, "PUT", "/api/v1/notify", "ek_test", secretNotifyJSON)
	want := st.Get()
	_, _, exported := do(t, srv, "GET", "/api/v1/config/backup", "ek_test", "")
	noLeak(t, "backup", exported)
	c, _, raw := do(t, srv, "PUT", "/api/v1/config/backup", "ek_test", exported)
	mustDo(t, 200, "restore on the same box", c, raw)
	got := st.Get()
	if !reflect.DeepEqual(want.Channels, got.Channels) || !reflect.DeepEqual(want.Settings, got.Settings) {
		t.Fatal("restore on the same box lost secrets")
	}

	srv2, st2, _ := setup(t)
	c, _, raw = do(t, srv2, "PUT", "/api/v1/config/backup", "ek_test", exported)
	if c != 422 || !strings.Contains(raw, "re-enter") || !strings.Contains(raw, "outputs[0].srt.passphrase") ||
		!strings.Contains(raw, "settings.notify.webhooks[0].secret") {
		t.Fatalf("restore without stored secrets must ask for them: %d %s", c, raw)
	}
	if len(st2.Get().Channels) != 0 {
		t.Fatal("refused restore modified the config")
	}
}
