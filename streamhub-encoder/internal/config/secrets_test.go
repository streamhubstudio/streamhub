package config

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/notify"
)

// secretValues are the credentials planted by secretChannel/secretConfig:
// none of them may appear in anything the API, the UI or a webhook shows.
var secretValues = []string{
	"inPassphrase-0001", "camPass-0002", "outPassphrase-0003", "rtmpPass-0004", "streamKey-0005",
	"ytKey-0006", "whipUrlTok-0007", "whipBearer-0008", "hlsPass-0009", "sk_shToken-0010", "shKey-0011",
	"hookUrlTok-0012", "hookSecret-0013", "snmpAuth-0014", "snmpPriv-0015", "community-0016", "dk_device-0017",
}

// secretChannel carries every kind of secret a channel can hold.
func secretChannel() Channel {
	c := Channel{ID: "ch1", Enabled: true,
		Input:  Input{Type: InSRT, URI: "srt://:9000?mode=listener&passphrase=inPassphrase-0001"},
		Backup: &Input{Type: InRTSP, URI: "rtsp://admin:camPass-0002@10.0.0.9/stream"},
		Video:  Video{Codec: CodecH264, Encoder: EncX264, Width: 1280, Height: 720, FPS: "30", BitrateKbps: 3000},
		Outputs: []Output{
			{ID: "srt", Type: OutSRT, Enabled: true, URL: "srt://10.0.0.1:9000", SRT: &SRTOptions{Passphrase: "outPassphrase-0003", StreamID: "publish:cam1"}},
			{ID: "rtmp", Type: OutRTMP, Enabled: true, URL: "rtmp://pub:rtmpPass-0004@live.example.com/app/streamKey-0005"},
			{ID: "yt", Type: OutRTMP, Enabled: true, URL: "rtmps://a.rtmps.youtube.com:443/live2/ytKey-0006"},
			{ID: "whip", Type: OutWHIP, Enabled: true, URL: "https://whip.example.com/whip/ep?token=whipUrlTok-0007", WHIP: &WHIPOptions{BearerToken: "whipBearer-0008"}},
			{ID: "hls", Type: OutHLS, Enabled: true, URL: "https://hlsUser:hlsPass-0009@cdn.example.com/live/index.m3u8"},
			{ID: "sh", Type: OutStreamHub, Enabled: true, StreamHub: &StreamHubOutput{BaseURL: "https://sh.example.com", App: "live", Token: "sk_shToken-0010",
				IngressID: "IN_1", StreamKey: "shKey-0011", ResolvedURL: "rtmp://sh.example.com:1935/live/shKey-0011"}},
			{ID: "udp", Type: OutUDP, Enabled: true, URL: "udp://239.1.1.1:5000"},
		}}
	c.ApplyDefaults()
	return c
}

func secretConfig() Config {
	n := NotifyConfig{
		Webhooks: []notify.Webhook{{URL: "https://hooks.example.com/x?token=hookUrlTok-0012", Secret: "hookSecret-0013"}},
		SNMP: []notify.SNMPTarget{
			{Address: "10.0.0.2:162", Version: "3", User: "nms", AuthPass: "snmpAuth-0014", PrivPass: "snmpPriv-0015"},
			{Address: "10.0.0.3:162", Version: "2c", Community: "community-0016"},
		}}
	return Config{Version: SchemaVersion, Channels: []Channel{secretChannel()},
		StreamHub: StreamHub{BaseURL: "https://sh.example.com", Credential: "dk_device-0017"},
		Settings:  Settings{Notify: &n}}
}

func assertNoSecret(t *testing.T, what string, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	s := string(b)
	if str, ok := v.(string); ok {
		s = str
	}
	for _, sec := range secretValues {
		if strings.Contains(s, sec) {
			t.Errorf("%s leaks %q:\n%s", what, sec, s)
		}
	}
}

// Every secret of a channel is hidden by RedactChannel: SRT passphrases
// (input URI and output), URL credentials, RTMP stream keys, WHIP bearer and
// URL tokens, StreamHub token and resolved key.
func TestRedactChannelHidesEverySecret(t *testing.T) {
	fixture := secretChannel()
	if errs := fixture.Validate(); len(errs) > 0 {
		t.Fatalf("fixture invalid: %v", errs)
	}
	ch := secretChannel()
	RedactChannel(&ch)
	assertNoSecret(t, "RedactChannel", ch)
	// non-secret parts stay readable for the operator
	b, _ := json.Marshal(ch)
	for _, keep := range []string{"live.example.com/app/", "srt://10.0.0.1:9000", "publish:cam1", "udp://239.1.1.1:5000", "cdn.example.com/live/index.m3u8", "mode=listener"} {
		if !strings.Contains(string(b), keep) {
			t.Errorf("RedactChannel hid non-secret %q:\n%s", keep, b)
		}
	}
}

// The whole-config redaction (backup export) also covers notify targets and
// the device credential.
func TestRedactConfigHidesEverySecret(t *testing.T) {
	c := secretConfig()
	r := Redact(c)
	assertNoSecret(t, "Redact", r)
	if !reflect.DeepEqual(c, secretConfig()) {
		t.Fatal("Redact mutated its input")
	}
}

// GET → edit → PUT: placeholders come back and must restore the stored values.
func TestKeepSecretsRestoresEveryPlaceholder(t *testing.T) {
	prev := secretChannel()
	next := secretChannel() // what a GET shows (and the UI sends back)
	next.Input.URI = "srt://:9000?mode=listener&passphrase=***"
	next.Backup.URI = "rtsp://admin:***@10.0.0.9/stream"
	next.Outputs[0].SRT.Passphrase = Redacted
	next.Outputs[1].URL = "rtmp://pub:***@live.example.com/app/***"
	next.Outputs[2].URL = "rtmps://a.rtmps.youtube.com:443/live2/***"
	next.Outputs[3].URL, next.Outputs[3].WHIP.BearerToken = "https://whip.example.com/whip/ep?token=***", Redacted
	next.Outputs[4].URL = "https://hlsUser:***@cdn.example.com/live/index.m3u8"
	sh := next.Outputs[5].StreamHub
	sh.Token, sh.StreamKey, sh.ResolvedURL = Redacted, Redacted, "rtmp://sh.example.com:1935/live/***"
	KeepSecrets(&prev, &next)
	if !reflect.DeepEqual(prev, next) {
		a, _ := json.Marshal(prev)
		b, _ := json.Marshal(next)
		t.Fatalf("round trip lost secrets:\nwant %s\ngot  %s", a, b)
	}
	// A changed (non-placeholder) secret wins over the stored one.
	next.Outputs[0].SRT.Passphrase = "brand-new-passphrase"
	next.Outputs[1].URL = "rtmp://live.example.com/app/new-key"
	KeepSecrets(&prev, &next)
	if next.Outputs[0].SRT.Passphrase != "brand-new-passphrase" || next.Outputs[1].URL != "rtmp://live.example.com/app/new-key" {
		t.Fatalf("explicit new secrets overwritten: %+v %s", next.Outputs[0].SRT, next.Outputs[1].URL)
	}
}

// A placeholder that has no stored value behind it (restore on another box,
// new output id) must be rejected instead of being used as the secret.
func TestPlaceholderWithoutStoredSecretIsRejected(t *testing.T) {
	for name, mut := range map[string]func(c *Channel){
		"srt passphrase": func(c *Channel) { c.Outputs[0].SRT.Passphrase = Redacted },
		"rtmp key":       func(c *Channel) { c.Outputs[1].URL = "rtmp://live.example.com/app/" + Redacted },
		"url password": func(c *Channel) {
			c.Outputs[4].URL = "https://hlsUser:" + Redacted + "@cdn.example.com/live/index.m3u8"
		},
		"input uri":   func(c *Channel) { c.Input.URI = "srt://:9000?mode=listener&passphrase=" + Redacted },
		"whip bearer": func(c *Channel) { c.Outputs[3].WHIP.BearerToken = Redacted },
		"streamhub":   func(c *Channel) { c.Outputs[5].StreamHub.Token = Redacted },
	} {
		c := secretChannel()
		mut(&c)
		errs := c.Validate()
		if !strings.Contains(errs.Error(), "re-enter") {
			t.Errorf("%s: placeholder accepted as a secret: %v", name, errs)
		}
	}
}

// A placeholder never follows a secret to another destination: changing the
// host while keeping "***" must not send the stored key/token there.
func TestPlaceholderDoesNotFollowANewDestination(t *testing.T) {
	prev := secretChannel()
	next := secretChannel()
	next.Outputs[1].URL = "rtmp://pub:***@evil.example.net/app/***"
	next.Outputs[3].URL, next.Outputs[3].WHIP.BearerToken = "https://evil.example.net/whip/ep?token=***", Redacted
	next.Outputs[0].URL, next.Outputs[0].SRT.Passphrase = "srt://10.6.6.6:9000", Redacted
	next.Outputs[5].StreamHub.BaseURL, next.Outputs[5].StreamHub.Token = "https://evil.example.net", Redacted
	next.Outputs[5].StreamHub.StreamKey, next.Outputs[5].StreamHub.ResolvedURL = Redacted, "rtmp://sh.example.com:1935/live/***"
	KeepSecrets(&prev, &next)
	for _, j := range []int{0, 1, 3, 5} {
		assertNoSecret(t, "KeepSecrets with a new destination", next.Outputs[j])
	}
	errs := next.Validate().Error()
	for _, f := range []string{"outputs[0].srt.passphrase", "outputs[1].url", "outputs[3].url", "outputs[3].whip.bearerToken", "outputs[5].streamhub.token"} {
		if !strings.Contains(errs, f+": is the") {
			t.Errorf("%s: placeholder not rejected: %s", f, errs)
		}
	}
	if s := next.Outputs[5].StreamHub; s.IngressID != "" || s.StreamKey != "" || s.ResolvedURL != "" {
		t.Errorf("stale StreamHub resolution kept: %+v", s)
	}
}

func TestRedactURLAndScrub(t *testing.T) {
	for in, want := range map[string]string{
		"srt://:9000?mode=listener&passphrase=abcdefghij&latency=200": "srt://:9000?mode=listener&passphrase=***&latency=200",
		"rtmp://h:1935/live/key123":                                   "rtmp://h:1935/live/***",
		"rtmps://u:p4ss@h/app/k?x=1":                                  "rtmps://u:***@h/app/***?x=1",
		"rtmp://h/app":                                                "rtmp://h/app",
		"rtmp://h/app/":                                               "rtmp://h/app/",
		"udp://@239.1.1.1:5000":                                       "udp://@239.1.1.1:5000",
		"https://h/hls/index.m3u8?Token=t0k&b=2":                      "https://h/hls/index.m3u8?Token=***&b=2",
		"rtsp://admin@cam/stream":                                     "rtsp://admin@cam/stream",
		"/var/rec/x.ts":                                               "/var/rec/x.ts",
		"":                                                            "",
	} {
		if got := RedactURL(in); got != want {
			t.Errorf("RedactURL(%q) = %q, want %q", in, got, want)
		}
	}
	sec := []string{"supersecret-pass", "ab"}
	for in, want := range map[string]string{
		`srtsink uri="srt://10.0.0.1:9000" passphrase="supersecret-pass" pbkeylen=16`: `srtsink uri="srt://10.0.0.1:9000" passphrase="***" pbkeylen=16`,
		`passphrase=old-replaced-pass streamid=x`:                                     `passphrase=*** streamid=x`,
		`could not connect to rtmp://h/app/ab: refused`:                               `could not connect to rtmp://h/app/***: refused`,
		`-i udp://127.0.0.1:41000?fifo_size=1000000&overrun_nonfatal=1`:               `-i udp://127.0.0.1:41000?fifo_size=1000000&overrun_nonfatal=1`,
		`label ab stays (too short to scrub blindly)`:                                 `label ab stays (too short to scrub blindly)`,
		`error: supersecret-pass rejected`:                                            `error: *** rejected`,
	} {
		if got := Scrub(in, sec); got != want {
			t.Errorf("Scrub(%q) = %q, want %q", in, got, want)
		}
	}
}
