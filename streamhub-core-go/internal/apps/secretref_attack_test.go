package apps

import (
	"os"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// Security 3.3.3 (C3): a config.yaml *_env ref is never trusted. These
// scenarios write a legacy yaml straight to disk (the raw editor rejects
// it since 3.3.3) naming app B's refs and a platform env var.

const foreignRefsYAML = "name: app-a\nroom_prefix: app-a\n" +
	"s3:\n  bucket: a-bucket\n  access_key_env: APP_APP_B_S3_KEY\n  secret_key_env: APP_APP_B_S3_SECRET\n" +
	"mqtt:\n  password_env: APP_APP_B_MQTT_PASSWORD\n" +
	"smtp:\n  pass_env: STREAMHUB_JWT_SECRET\n" +
	"features:\n  drm:\n    key_server_token_env: STREAMHUB_JWT_SECRET\n"

func seedTwoApps(t *testing.T) (*Service, *harness) {
	t.Helper()
	s, h := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "app-a"})
	mustCreate(t, s, contracts.CreateAppInput{Name: "app-b"})
	if _, err := s.SetS3(bg, "app-b", SetS3Input{Key: "B-KEY-VALUE", Secret: "B-SECRET-VALUE"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetMqtt(bg, "app-b", SetMqttInput{Password: "B-MQTT-VALUE"}); err != nil {
		t.Fatal(err)
	}
	h.env["STREAMHUB_JWT_SECRET"] = "platform-jwt-secret"
	if err := os.WriteFile(s.configPath("app-a"), []byte(foreignRefsYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	s.invalidate("app-a")
	return s, h
}

func TestLegacyForeignSecretRefsResolveDerived(t *testing.T) {
	s, _ := seedTwoApps(t)
	cfg, err := s.GetConfig(bg, "app-a")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.S3.AccessKey != "" || cfg.S3.SecretKey != "" || cfg.Mqtt.Password != "" {
		t.Errorf("INVARIANT: app-a resolved app-b's credentials: %+v / %q", cfg.S3, cfg.Mqtt.Password)
	}
	if cfg.Smtp.Pass != "" {
		t.Errorf("INVARIANT: a yaml ref resolved a platform env var (smtp.pass = %q)", cfg.Smtp.Pass)
	}
	if got := cfg.Features.Drm.KeyServerTokenEnv; got != "APP_APP_A_DRM_TOKEN" {
		t.Errorf("drm token ref = %q, want the derived APP_APP_A_DRM_TOKEN", got)
	}
	m, _ := s.GetS3(bg, "app-a")
	if m.HasKey || m.HasSecret || m.AccessKeyEnv != "APP_APP_A_S3_KEY" || m.SecretKeyEnv != "APP_APP_A_S3_SECRET" {
		t.Errorf("masked s3 = %+v", m)
	}
	if mq, _ := s.GetMqtt(bg, "app-a"); mq.HasPassword || mq.PasswordEnv != "APP_APP_A_MQTT_PASSWORD" {
		t.Errorf("masked mqtt = %+v", mq)
	}
	if sm, _ := s.GetSmtp(bg, "app-a"); sm.HasPass || sm.PassEnv != "APP_APP_A_SMTP_PASS" {
		t.Errorf("masked smtp = %+v", sm)
	}
}

func TestSetterNeverWritesAnotherAppsSecrets(t *testing.T) {
	s, h := seedTwoApps(t)
	if _, err := s.SetS3(bg, "app-a", SetS3Input{Key: "A-KEY-VALUE", Secret: "A-SECRET-VALUE"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.configPath("app-a"), []byte(foreignRefsYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	s.invalidate("app-a")
	if _, err := s.SetMqtt(bg, "app-a", SetMqttInput{Password: "A-MQTT-VALUE"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.configPath("app-a"), []byte(foreignRefsYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	s.invalidate("app-a")
	if _, err := s.UpdateConfig(bg, "app-a", contracts.AppConfigPatch{S3: &contracts.S3Patch{AccessKey: "A-KEY-2"}}); err != nil {
		t.Fatal(err)
	}

	stored := h.secrets.ReadFresh()
	for ref, want := range map[string]string{
		"APP_APP_B_S3_KEY": "B-KEY-VALUE", "APP_APP_B_S3_SECRET": "B-SECRET-VALUE", "APP_APP_B_MQTT_PASSWORD": "B-MQTT-VALUE",
		"APP_APP_A_S3_KEY": "A-KEY-2", "APP_APP_A_S3_SECRET": "A-SECRET-VALUE", "APP_APP_A_MQTT_PASSWORD": "A-MQTT-VALUE",
	} {
		if stored[ref] != want {
			t.Errorf("INVARIANT: secrets.json[%s] = %q, want %q", ref, stored[ref], want)
		}
	}
	if _, ok := stored["STREAMHUB_JWT_SECRET"]; ok {
		t.Error("INVARIANT: a setter wrote a platform-named key")
	}
	if b, _ := s.GetConfig(bg, "app-b"); b.S3.AccessKey != "B-KEY-VALUE" || b.Mqtt.Password != "B-MQTT-VALUE" {
		t.Errorf("app-b credentials changed: %+v", b.S3)
	}
	raw, _ := readYAML(t, s, "app-a")
	if strings.Contains(raw, "APP_APP_B_") || strings.Contains(raw, "STREAMHUB_JWT_SECRET") {
		t.Errorf("a structured save kept the foreign refs:\n%s", raw)
	}
}
