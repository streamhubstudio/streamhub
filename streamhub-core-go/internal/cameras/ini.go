package cameras

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Provisioning (STREAMHUB.md §2): the config.ini the operator drops on the
// microSD root. OpenCam loads it at boot (`ini/*`), connects to the broker
// and publishes `hello`, which links the camera.

// BrokerEndpoint is what the camera dials, derived from a broker URL.
type BrokerEndpoint struct {
	Host string
	Port int
	TLS  bool
	// Note explains a value the camera cannot use as-is ("" = none).
	Note string
}

// ParseBroker derives host/port/tls from mqtt://, mqtts://, tcp://, ssl://,
// tls://, ws:// or wss:// (forceTLS = the app's mqtt.tls flag).
func ParseBroker(raw string, forceTLS bool) (BrokerEndpoint, error) {
	raw = y.Trim(raw)
	if raw == "" {
		return BrokerEndpoint{}, fmt.Errorf("no broker URL")
	}
	if !strings.Contains(raw, "://") {
		raw = "mqtt://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return BrokerEndpoint{}, fmt.Errorf("invalid broker URL")
	}
	ep := BrokerEndpoint{Host: u.Hostname(), TLS: forceTLS}
	switch strings.ToLower(u.Scheme) {
	case "mqtts", "ssl", "tls":
		ep.TLS = true
	case "wss":
		ep.TLS = true
		ep.Note = "the broker URL is WebSocket; OpenCam speaks MQTT over TCP — set brokerPublicUrl in the app config"
	case "ws":
		ep.Note = "the broker URL is WebSocket; OpenCam speaks MQTT over TCP — set brokerPublicUrl in the app config"
	}
	if p := u.Port(); p != "" {
		ep.Port, _ = strconv.Atoi(p)
	} else if ep.TLS {
		ep.Port = 8883
	} else {
		ep.Port = 1883
	}
	return ep, nil
}

func iniBool(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// iniValue keeps a value on one line (no injection of extra keys/sections).
func iniValue(s string) string {
	return strings.NewReplacer("\r", "", "\n", " ").Replace(s)
}

// ConfigIni renders the provisioning config.ini of device.
func (s *Service) ConfigIni(ctx context.Context, app, device string) (string, error) {
	appDir := s.apps.AppDir(app)
	cam, err := s.store.Get(ctx, app, appDir, device)
	if err != nil {
		return "", err
	}
	if cam == nil {
		return "", &NotFoundError{fmt.Sprintf("camera '%s' not found", device)}
	}
	cfg := s.config(ctx, app)
	appCfg, err := s.apps.GetConfig(ctx, app)
	if err != nil {
		return "", err
	}
	mq := appCfg.Mqtt
	brokerURL := cfg.BrokerPublicURL
	if brokerURL == "" {
		brokerURL = mq.URL
	}
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }
	w("; OpenCam provisioning for StreamHub — app %s, camera %s", iniValue(app), device)
	w("; generated %s — copy to the microSD root as config.ini", jsx.ISO(s.now()))
	w("")
	w("[device]")
	w("id = %s", device)
	w("")
	w("[mqtt]")
	ep, perr := ParseBroker(brokerURL, mq.TLS)
	if perr != nil {
		w("; no MQTT broker configured for the app (config.yaml mqtt.url / cameras brokerPublicUrl)")
		w("enabled = 0")
	} else {
		if ep.Note != "" {
			w("; %s", ep.Note)
		}
		user, pass := "", ""
		if cam.MqttUser != nil {
			user = *cam.MqttUser
		}
		if cam.MqttPass != nil {
			pass = *cam.MqttPass
		}
		if cfg.IniAppBrokerCreds {
			user, pass = mq.Username, mq.Password
		} else {
			w("; per-camera credential: create it on the broker with write on %s/%s/{hello,status,state,event,res/#,thumb}", cfg.BaseTopic, device)
			w(";   and read on %s/%s/cmd/# (STREAMHUB.md §12) — StreamHub does not provision the broker yet", cfg.BaseTopic, device)
		}
		w("enabled = 1")
		w("host = %s", iniValue(ep.Host))
		w("port = %d", ep.Port)
		w("tls = %s", iniBool(ep.TLS))
		w("user = %s", iniValue(user))
		w("pass = %s", iniValue(pass))
		w("base_topic = %s/%%device", cfg.BaseTopic)
	}
	w("")
	w("[stream]")
	surl := ""
	if cam.StreamURL != nil {
		surl = *cam.StreamURL
	} else if cfg.RtmpPublicURL != "" {
		surl = cfg.RtmpPublicURL
	}
	key := ""
	if cam.StreamKey != nil {
		key = *cam.StreamKey
	}
	if surl == "" || key == "" {
		w("; create a passthrough RTMP ingress for this camera (POST /apps/%s/ingress) and set its url/key on the camera", iniValue(app))
	}
	w("url = %s", iniValue(surl))
	w("key = %s", iniValue(key))
	w("source = 1")
	w("audio = 1")
	w("autostart = %s", iniBool(surl != "" && key != ""))
	w("")
	w("[streamhub]")
	w("api = 1")
	w("app = %s", iniValue(app))
	return b.String(), nil
}
