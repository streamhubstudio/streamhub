package apps

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// Security 3.3.3 (C3): the raw editor / PATCH reject a ref the server did
// not derive, and the boot pass rewrites legacy yamls.

func TestRawConfigRejectsForeignSecretRefs(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "app-a"})
	mustCreate(t, s, contracts.CreateAppInput{Name: "app-b"})
	if raw, _ := s.GetRawConfig(bg, "app-a"); !strings.Contains(raw, "APP_APP_A_S3_KEY") {
		t.Fatalf("scaffold writes the derived refs:\n%s", raw)
	}
	base := "name: app-a\nroom_prefix: app-a\n"
	for _, tc := range []struct{ yaml, msg string }{
		{base + "smtp:\n  pass_env: STREAMHUB_JWT_SECRET\n", "use PUT /apps/:app/smtp"},
		{base + "s3:\n  access_key_env: APP_APP_B_S3_KEY\n", "use PUT /apps/:app/s3"},
		{base + "s3:\n  secret_key_env: LIVEKIT_API_SECRET\n", "use PUT /apps/:app/s3"},
		{base + "mqtt:\n  password_env: APP_APP_B_MQTT_PASSWORD\n", "use PUT /apps/:app/mqtt"},
		{base + "mqtt:\n  password_env: 5\n", "use PUT /apps/:app/mqtt"},
		{base + "features:\n  drm:\n    key_server_token_env: STREAMHUB_JWT_SECRET\n", `"APP_APP_A_DRM_TOKEN"`},
	} {
		before, _ := s.GetRawConfig(bg, "app-a")
		_, err := s.PutRawConfig(bg, "app-a", tc.yaml)
		wantStatus(t, err, http.StatusBadRequest)
		if !strings.Contains(err.Error(), "secret refs are managed by the server") || !strings.Contains(err.Error(), tc.msg) {
			t.Errorf("%q → %v", tc.yaml, err)
		}
		if after, _ := s.GetRawConfig(bg, "app-a"); after != before {
			t.Fatalf("INVARIANT: rejected %q touched the file", tc.yaml)
		}
		if res, _ := s.DryRunRawConfig(bg, "app-a", tc.yaml); res.Valid {
			t.Errorf("dry-run accepted %q", tc.yaml)
		}
	}
	// The derived refs, an empty DRM ref and omitted refs are fine.
	for _, ok := range []string{
		base + "s3:\n  access_key_env: APP_APP_A_S3_KEY\n  secret_key_env: APP_APP_A_S3_SECRET\nmqtt:\n  password_env: APP_APP_A_MQTT_PASSWORD\n" +
			"smtp:\n  pass_env: APP_APP_A_SMTP_PASS\nfeatures:\n  drm:\n    key_server_token_env: APP_APP_A_DRM_TOKEN\n",
		base + "features:\n  drm:\n    key_server_token_env: ''\n",
		base + "s3:\n  bucket: b\n",
	} {
		if _, err := s.PutRawConfig(bg, "app-a", ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	raw, _ := s.GetRawConfig(bg, "app-a")
	if _, err := s.PutRawConfig(bg, "app-a", raw); err != nil {
		t.Errorf("GET raw → PUT raw round-trip: %v", err)
	}

	// PATCH /config carries the DRM ref: same rule.
	drm := func(ref string) contracts.AppConfigPatch {
		return contracts.AppConfigPatch{Features: &contracts.FeaturesPatch{Drm: &contracts.DrmFeatures{Enabled: true, Provider: "external", KeyServerTokenEnv: ref}}}
	}
	_, err := s.UpdateConfig(bg, "app-a", drm("STREAMHUB_JWT_SECRET"))
	wantStatus(t, err, http.StatusBadRequest)
	_, err = s.Create(bg, contracts.CreateAppInput{Name: "app-c", Config: ptr(drm("APP_APP_B_DRM_TOKEN"))})
	wantStatus(t, err, http.StatusBadRequest)
	if cfg, err := s.UpdateConfig(bg, "app-a", drm("APP_APP_A_DRM_TOKEN")); err != nil || cfg.Features.Drm.KeyServerTokenEnv != "APP_APP_A_DRM_TOKEN" {
		t.Errorf("derived DRM ref: %v", err)
	}
}

func TestBootMigratesSecretRefs(t *testing.T) {
	s, h := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "a--b"}) // legacy slug A_B, derived A__B
	mustCreate(t, s, contracts.CreateAppInput{Name: "app-c"})
	mustCreate(t, s, contracts.CreateAppInput{Name: "plain"})
	legacy := "name: a--b\nroom_prefix: a--b\n# operator comment\n" +
		"s3:\n  bucket: lb\n  access_key_env: APP_A_B_S3_KEY\n  secret_key_env: APP_A_B_S3_SECRET\n" +
		"smtp:\n  pass_env: APP_A_B_SMTP_PASS\n"
	foreign := "name: app-c\nroom_prefix: app-c\ns3:\n  access_key_env: APP_PLAIN_S3_KEY\nmqtt:\n  password_env: STREAMHUB_JWT_SECRET\n" +
		"features:\n  drm:\n    enabled: true\n    key_server_token_env: STREAMHUB_JWT_SECRET\n"
	for app, yaml := range map[string]string{"a--b": legacy, "app-c": foreign} {
		if err := os.WriteFile(s.configPath(app), []byte(yaml), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.secrets.SetMany([][2]string{
		{"APP_A_B_S3_KEY", "legacy-key"}, {"APP_A_B_S3_SECRET", "legacy-secret"}, {"APP_A_B_SMTP_PASS", "legacy-pass"},
		{"APP_PLAIN_S3_KEY", "plain-key"},
	}); err != nil {
		t.Fatal(err)
	}
	plainBefore, _ := s.GetRawConfig(bg, "plain")

	s.Init(bg)

	stored := h.secrets.ReadFresh()
	for ref, want := range map[string]string{
		"APP_A__B_S3_KEY": "legacy-key", "APP_A__B_S3_SECRET": "legacy-secret", "APP_A__B_SMTP_PASS": "legacy-pass",
		"APP_PLAIN_S3_KEY": "plain-key",
	} {
		if stored[ref] != want {
			t.Errorf("secrets.json[%s] = %q, want %q", ref, stored[ref], want)
		}
	}
	for _, gone := range []string{"APP_A_B_S3_KEY", "APP_A_B_S3_SECRET", "APP_A_B_SMTP_PASS"} {
		if _, ok := stored[gone]; ok {
			t.Errorf("INVARIANT: unowned legacy key %s left behind (a future app \"a-b\" would inherit it)", gone)
		}
	}
	if _, ok := stored["APP_APP_C_S3_KEY"]; ok {
		t.Error("INVARIANT: a foreign ref's value was copied")
	}
	rawAB, _ := s.GetRawConfig(bg, "a--b")
	rawC, _ := s.GetRawConfig(bg, "app-c")
	if !strings.Contains(rawAB, "access_key_env: APP_A__B_S3_KEY") || !strings.Contains(rawAB, "pass_env: APP_A__B_SMTP_PASS") || !strings.Contains(rawAB, "bucket: lb") {
		t.Errorf("a--b not rewritten:\n%s", rawAB)
	}
	if strings.Contains(rawC, "APP_PLAIN_") || strings.Contains(rawC, "STREAMHUB_JWT_SECRET") || !strings.Contains(rawC, "key_server_token_env: APP_APP_C_DRM_TOKEN") {
		t.Errorf("app-c not rewritten:\n%s", rawC)
	}
	if after, _ := s.GetRawConfig(bg, "plain"); after != plainBefore {
		t.Error("an already-derived yaml must not be touched")
	}
	if cfg, _ := s.GetConfig(bg, "a--b"); cfg.S3.AccessKey != "legacy-key" || cfg.Smtp.Pass != "legacy-pass" {
		t.Errorf("a--b lost its credentials: %+v", cfg.S3)
	}
	backups := func(app string) int {
		m, _ := filepath.Glob(filepath.Join(s.AppDir(app), backupPrefix+"*"))
		return len(m)
	}
	if backups("a--b") != 1 || backups("app-c") != 1 || backups("plain") != 0 {
		t.Errorf("backups: a--b=%d app-c=%d plain=%d", backups("a--b"), backups("app-c"), backups("plain"))
	}

	// Idempotent: a second boot changes nothing.
	s.Init(bg)
	if again, _ := s.GetRawConfig(bg, "a--b"); again != rawAB || backups("a--b") != 1 {
		t.Error("second migration pass rewrote the yaml")
	}
	if again := h.secrets.ReadFresh(); len(again) != len(stored) {
		t.Errorf("second pass changed secrets.json: %v", again)
	}
}
