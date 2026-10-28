package compliance

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

func report(t *testing.T, cfg *config.Config) map[string]ComplianceControl {
	t.Helper()
	_, g, dir := testutil.Store(t)
	if cfg.DataDir == "" {
		cfg.DataDir = dir
	}
	a := audit.New(g, os.Getenv, testutil.Log())
	a.Init(context.Background())
	testutil.Exec(t, g, `CREATE TABLE IF NOT EXISTS ip_rules (id INTEGER PRIMARY KEY, cidr TEXT, action TEXT)`)
	testutil.Exec(t, g, `INSERT INTO ip_rules (cidr, action) VALUES ('1.2.3.4/32','block'), ('5.6.7.8/32','allow'), ('9.9.9.9/32','block')`)
	r := New(cfg, g, a).Report(context.Background())
	out := map[string]ComplianceControl{}
	sum := 0
	for _, c := range r.Controls {
		out[c.ID] = c
	}
	sum = r.Summary.Active + r.Summary.Partial + r.Summary.Off + r.Summary.Unknown
	if len(r.Controls) != 10 || sum != 10 || r.CheckedAt == "" {
		t.Fatalf("%+v", r)
	}
	return out
}

func TestReport(t *testing.T) {
	for _, k := range []string{"STREAMHUB_IP_ACCESS_MODE", "STREAMHUB_AUTOBAN_ENABLED", "STREAMHUB_PUBLIC_REGISTRATION", "STREAMHUB_ALLOW_SIGNUP", "METRICS_TOKEN", "BACKUP_S3_BUCKET", "BACKUP_LOCAL_DIR", "STREAMHUB_DOMAIN"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	t.Setenv(authz.EnforceEnv, "log")
	c := report(t, &config.Config{LogRetentionDays: 30})
	want := map[string]string{"authz_enforce": "partial", "tls": "off", "ip_filtering": "off", "auto_ban": "off", "audit_log": "active",
		"backups": "off", "http_hardening": "active", "metrics_protected": "active", "public_registration": "active", "log_retention": "active"}
	for id, st := range want {
		if c[id].State != st {
			t.Errorf("%s = %s (%s)", id, c[id].State, c[id].Detail)
		}
	}
	if c["ip_filtering"].Detail != "mode=off; rules: 1 allow / 2 block" || c["audit_log"].ISO != "8.15, 8.16" {
		t.Fatalf("%+v", c["ip_filtering"])
	}

	t.Setenv(authz.EnforceEnv, "on")
	t.Setenv("STREAMHUB_IP_ACCESS_MODE", "enforce")
	t.Setenv("STREAMHUB_AUTOBAN_ENABLED", "1")
	t.Setenv("STREAMHUB_PUBLIC_REGISTRATION", "yes")
	t.Setenv("BACKUP_S3_BUCKET", "b")
	c = report(t, &config.Config{PublicBaseURL: "https://x.io", LogRetentionDays: 0})
	for id, st := range map[string]string{"authz_enforce": "active", "tls": "active", "ip_filtering": "active", "auto_ban": "active", "public_registration": "off", "backups": "partial", "log_retention": "partial"} {
		if c[id].State != st {
			t.Errorf("%s = %s", id, c[id].State)
		}
	}
	if c["auto_ban"].Detail != "enabled: ban after 10 offenses within 300s" {
		t.Fatal(c["auto_ban"].Detail)
	}

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "b.tar.gz"), []byte("x"), 0o644)
	t.Setenv("BACKUP_LOCAL_DIR", dir)
	if c = report(t, &config.Config{}); c["backups"].State != "active" {
		t.Fatalf("%+v", c["backups"])
	}
	old := time.Now().Add(-72 * time.Hour)
	os.Chtimes(filepath.Join(dir, "b.tar.gz"), old, old)
	if c = report(t, &config.Config{}); c["backups"].State != "partial" {
		t.Fatalf("%+v", c["backups"])
	}
}
