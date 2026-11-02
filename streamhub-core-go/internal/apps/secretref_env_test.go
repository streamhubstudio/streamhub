package apps

import (
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// Security 3.3.3 (C3): app credentials come from data/secrets.json only.
// The one exception is a platform-tenant app, which may fall back to an
// env var named exactly like its own derived ref.
func TestSecretsNeverFromEnvForTenantApps(t *testing.T) {
	s, h := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "ten-a", TenantID: "tnt_x"})
	mustCreate(t, s, contracts.CreateAppInput{Name: "plat"})
	for _, app := range []string{"ten-a", "plat"} {
		for _, f := range secretFields {
			h.env[SecretRef(app, f.kind)] = "env-" + app + "-" + string(f.kind)
		}
	}

	ten, _ := s.GetConfig(bg, "ten-a")
	if ten.S3.AccessKey != "" || ten.S3.SecretKey != "" || ten.Mqtt.Password != "" || ten.Smtp.Pass != "" {
		t.Errorf("INVARIANT: a tenant app resolved credentials from the process env: %+v %q %q", ten.S3, ten.Mqtt.Password, ten.Smtp.Pass)
	}
	if m, _ := s.GetS3(bg, "ten-a"); m.HasKey || m.Configured {
		t.Errorf("masked view reports env creds: %+v", m)
	}

	// Platform app: env fallback for its own derived refs…
	plat, _ := s.GetConfig(bg, "plat")
	if plat.S3.AccessKey != "env-plat-S3_KEY" || plat.Smtp.Pass != "env-plat-SMTP_PASS" || plat.Mqtt.Password != "env-plat-MQTT_PASSWORD" {
		t.Errorf("platform env fallback: %+v %q", plat.S3, plat.Smtp.Pass)
	}
	// …but secrets.json (what PUT /apps/:app/s3 writes) wins.
	if _, err := s.SetS3(bg, "plat", SetS3Input{Key: "stored-key"}); err != nil {
		t.Fatal(err)
	}
	if plat, _ = s.GetConfig(bg, "plat"); plat.S3.AccessKey != "stored-key" || plat.S3.SecretKey != "env-plat-S3_SECRET" {
		t.Errorf("secrets.json must win over env: %+v", plat.S3)
	}
	// Moving the app off the platform tenant closes the fallback.
	if _, err := s.global.Exec(`UPDATE apps SET tenant_id = 'tnt_x' WHERE name = 'plat'`); err != nil {
		t.Fatal(err)
	}
	if plat, _ = s.GetConfig(bg, "plat"); plat.Smtp.Pass != "" || plat.S3.AccessKey != "stored-key" {
		t.Errorf("non-platform app read env: %+v %q", plat.S3, plat.Smtp.Pass)
	}
}
