package apps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of apps.service.spec.ts (+ the passthrough / transcoding / callback /
// mqtt / smtp / config-passthrough specs) against a real migrated DATA_DIR.

var bg = context.Background()

func mustCreate(t *testing.T, s *Service, in contracts.CreateAppInput) *contracts.AppRecord {
	t.Helper()
	rec, err := s.Create(bg, in)
	if err != nil {
		t.Fatalf("create %s: %v", in.Name, err)
	}
	return rec
}

func status(err error) int {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

func wantStatus(t *testing.T, err error, code int) {
	t.Helper()
	if status(err) != code {
		t.Fatalf("want HTTP %d, got %v", code, err)
	}
}

func readYAML(t *testing.T, s *Service, app string) (string, *y.Map) {
	t.Helper()
	b, err := os.ReadFile(s.configPath(app))
	if err != nil {
		t.Fatal(err)
	}
	v, err := y.Load(string(b))
	if err != nil {
		t.Fatal(err)
	}
	m, _ := v.(*y.Map)
	return string(b), m
}

func at(m *y.Map, path ...string) any {
	var cur any = m
	for _, k := range path {
		cur = prop(cur, k)
	}
	return cur
}

func sp(s string) *string   { return &s }
func bp(b bool) *bool       { return &b }
func fp(f float64) *float64 { return &f }

func TestCreate(t *testing.T) {
	s, h := newTestService(t)
	rec := mustCreate(t, s, contracts.CreateAppInput{Name: "myapp", DisplayName: "My App"})
	if rec.Name != "myapp" || rec.DisplayName != "My App" || rec.LivekitRoomPrefix != "myapp" || rec.ID == 0 {
		t.Fatalf("record = %+v", rec)
	}
	for _, d := range []string{"recordings", "snapshots", "samples", "config.yaml", "app.db", "samples/publish.html", "samples/play.html", "samples/embed.html"} {
		if _, err := os.Stat(filepath.Join(s.AppDir("myapp"), d)); err != nil {
			t.Errorf("missing %s: %v", d, err)
		}
	}
	if len(h.samples.calls) != 1 || h.samples.calls[0] != "myapp" {
		t.Errorf("samples hand-off = %v", h.samples.calls)
	}

	tenant := func(name string) string {
		var tn string
		if err := s.global.QueryRow(`SELECT tenant_id FROM apps WHERE name = ?`, name).Scan(&tn); err != nil {
			t.Fatal(err)
		}
		return tn
	}
	if got := tenant("myapp"); got != "platform" {
		t.Errorf("INVARIANT: fresh app homed to platform, got %q", got)
	}
	mustCreate(t, s, contracts.CreateAppInput{Name: "ownedapp", TenantID: "tnt_alice"})
	if got := tenant("ownedapp"); got != "tnt_alice" {
		t.Errorf("owning tenant = %q", got)
	}

	plain := mustCreate(t, s, contracts.CreateAppInput{Name: "plainapp"})
	if plain.DisplayName != "plainapp" || plain.LivekitRoomPrefix != "plainapp" {
		t.Errorf("defaults = %+v", plain)
	}
	cased := mustCreate(t, s, contracts.CreateAppInput{Name: "caseapp", RoomPrefix: "MyRoom"})
	if cased.LivekitRoomPrefix != "myroom" {
		t.Errorf("room prefix not lowercased: %q", cased.LivekitRoomPrefix)
	}
	if _, disk := readYAML(t, s, "caseapp"); at(disk, "room_prefix") != "myroom" {
		t.Errorf("disk room_prefix = %v", at(disk, "room_prefix"))
	}

	raw, disk := readYAML(t, s, "myapp")
	if at(disk, "name") != "myapp" || at(disk, "s3", "access_key_env") != "APP_MYAPP_S3_KEY" || at(disk, "s3", "secret_key_env") != "APP_MYAPP_S3_SECRET" {
		t.Errorf("secret refs wrong:\n%s", raw)
	}
	if !y.IsUndefined(at(disk, "s3", "key")) || !y.IsUndefined(at(disk, "s3", "secret")) {
		t.Error("inline credentials on disk")
	}
}

func TestCreateRejects(t *testing.T) {
	s, _ := newTestService(t)
	for _, name := range []string{"ab", "a b", "-abc", "abc-", "my_app", "", strings.Repeat("a", 33)} {
		_, err := s.Create(bg, contracts.CreateAppInput{Name: name})
		wantStatus(t, err, http.StatusConflict)
	}
	mustCreate(t, s, contracts.CreateAppInput{Name: "dup"})
	_, err := s.Create(bg, contracts.CreateAppInput{Name: "dup"})
	wantStatus(t, err, http.StatusConflict)
	mustCreate(t, s, contracts.CreateAppInput{Name: "dupcase"})
	_, err = s.Create(bg, contracts.CreateAppInput{Name: "DupCase"})
	wantStatus(t, err, http.StatusConflict)
	if err.Error() != `app "dupcase" already exists` {
		t.Errorf("message = %q", err)
	}
}

func TestCreateRollsBackOnFailure(t *testing.T) {
	s, _ := newTestService(t)
	// A file where the app dir should be makes the scaffold fail.
	if err := os.MkdirAll(filepath.Join(s.cfg.DataDir, "apps"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.AppDir("broken"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := s.Create(bg, contracts.CreateAppInput{Name: "broken"})
	wantStatus(t, err, http.StatusInternalServerError)
	if !strings.HasPrefix(err.Error(), `failed creating app "broken": `) {
		t.Errorf("message = %q", err)
	}
	if rec, _ := s.Get(bg, "broken"); rec != nil {
		t.Error("row left behind")
	}
}

func TestGetList(t *testing.T) {
	s, _ := newTestService(t)
	if rec, err := s.Get(bg, "ghost"); rec != nil || err != nil {
		t.Fatalf("get ghost = %v, %v", rec, err)
	}
	for _, n := range []string{"zebra", "alpha", "mango"} {
		mustCreate(t, s, contracts.CreateAppInput{Name: n})
	}
	names := func(p *auth.Principal) string {
		list, err := s.List(bg, p)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, a := range list {
			out = append(out, a.Name)
		}
		return strings.Join(out, ",")
	}
	if got := names(nil); got != "alpha,mango,zebra" {
		t.Errorf("sorted list = %s", got)
	}

	mustCreate(t, s, contracts.CreateAppInput{Name: "alice-a", TenantID: "tnt_alice"})
	mustCreate(t, s, contracts.CreateAppInput{Name: "alice-b", TenantID: "tnt_alice"})
	mustCreate(t, s, contracts.CreateAppInput{Name: "bob-a", TenantID: "tnt_bob"})
	user := func(tn string) *auth.Principal {
		return &auth.Principal{UserID: "u_" + tn, TenantID: tn, Role: auth.RoleOwner, Scope: auth.ScopeUser, Via: auth.ViaUserJWT}
	}
	if got := names(user("tnt_alice")); got != "alice-a,alice-b" {
		t.Errorf("ISOLATION alice = %s", got)
	}
	if got := names(user("tnt_bob")); got != "bob-a" {
		t.Errorf("ISOLATION bob = %s", got)
	}
	if list, _ := s.List(bg, user("tnt_carol")); len(list) != 0 || list == nil {
		t.Errorf("new tenant must see an empty (non-null) list: %v", list)
	}
	super := &auth.Principal{UserID: "admin", TenantID: "platform", Role: auth.RoleSuperadmin, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAdminJWT}
	all := "alice-a,alice-b,alpha,bob-a,mango,zebra"
	if got := names(super); got != all {
		t.Errorf("ADMIN VIEW = %s", got)
	}
	if got := names(nil); got != all {
		t.Errorf("internal caller = %s", got)
	}
}

func TestDelete(t *testing.T) {
	s, h := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "keepvods"})
	if err := s.Delete(bg, "keepvods", contracts.DeleteAppOptions{}); err != nil {
		t.Fatal(err)
	}
	if rec, _ := s.Get(bg, "keepvods"); rec != nil {
		t.Error("row kept")
	}
	if _, err := os.Stat(s.AppDir("keepvods")); err != nil {
		t.Error("files must be preserved by default")
	}
	mustCreate(t, s, contracts.CreateAppInput{Name: "purge"})
	if err := s.Delete(bg, "purge", contracts.DeleteAppOptions{DeleteVods: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.AppDir("purge")); !os.IsNotExist(err) {
		t.Error("deleteVods must purge the app dir")
	}
	if len(h.mqtt.dropped) != 2 {
		t.Errorf("mqtt clients dropped = %v", h.mqtt.dropped)
	}
	wantStatus(t, s.Delete(bg, "nope", contracts.DeleteAppOptions{}), http.StatusNotFound)
}

func TestGetUpdateConfig(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "resolved"})
	cfg, err := s.GetConfig(bg, "resolved")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Name != "resolved" || !cfg.Recording.Enabled || !cfg.Features.ViewerCounter || cfg.Features.Chat || cfg.S3.AccessKey != "" {
		t.Errorf("defaults = %+v", cfg)
	}
	if cfg.Recording.FilenameTemplate != "" || cfg.Recording.RetentionDays != 0 || len(cfg.Variables) != 0 || cfg.Timezone != "" {
		t.Errorf("fresh templates/retention/variables/timezone = %+v", cfg)
	}
	_, err = s.GetConfig(bg, "ghost")
	wantStatus(t, err, http.StatusNotFound)

	cfg, err = s.UpdateConfig(bg, "resolved", contracts.AppConfigPatch{DisplayName: sp("Renamed"), Recording: &contracts.RecordingPatch{Enabled: bp(false)}})
	if err != nil || cfg.DisplayName != "Renamed" || cfg.Recording.Enabled {
		t.Fatalf("update = %+v, %v", cfg, err)
	}
	if rec, _ := s.Get(bg, "resolved"); rec.DisplayName != "Renamed" {
		t.Errorf("registry row not synced: %+v", rec)
	}

	for _, tc := range []struct{ in, want float64 }{{90, 90}, {45, 0}} {
		cfg, _ = s.UpdateConfig(bg, "resolved", contracts.AppConfigPatch{Recording: &contracts.RecordingPatch{RetentionDays: fp(tc.in)}})
		if cfg.Recording.RetentionDays != tc.want {
			t.Errorf("retention %v → %v", tc.in, cfg.Recording.RetentionDays)
		}
	}

	_, _ = s.UpdateConfig(bg, "resolved", contracts.AppConfigPatch{Recording: &contracts.RecordingPatch{
		FilenameTemplate: sp("${app}_${room}_${ts}"), SnapshotTemplate: sp("${room}_snap"),
	}})
	if cfg, _ = s.GetConfig(bg, "resolved"); cfg.Recording.FilenameTemplate != "${app}_${room}_${ts}" || cfg.Recording.SnapshotTemplate != "${room}_snap" {
		t.Errorf("templates not persisted: %+v", cfg.Recording)
	}

	vars := []contracts.Var{{Key: "site", Value: "HQ"}, {Key: "channel", Value: "main"}, {Key: "bad key!", Value: "x"}}
	cfg, _ = s.UpdateConfig(bg, "resolved", contracts.AppConfigPatch{Variables: &vars})
	if len(cfg.Variables) != 2 || cfg.Variables["site"] != "HQ" || cfg.Variables["channel"] != "main" {
		t.Errorf("variables = %v", cfg.Variables)
	}
	vars = []contracts.Var{{Key: "site", Value: "DC"}}
	cfg, _ = s.UpdateConfig(bg, "resolved", contracts.AppConfigPatch{Variables: &vars})
	if len(cfg.Variables) != 1 || cfg.Variables["site"] != "DC" {
		t.Errorf("whole-map replace: %v", cfg.Variables)
	}
}

func TestTimezone(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "tzx"})
	for _, tc := range []struct{ in, want string }{
		{"America/Argentina/Buenos_Aires", "America/Argentina/Buenos_Aires"},
		{"Not/AZone", ""},
		{"Europe/Madrid", "Europe/Madrid"},
		{"", ""},
	} {
		cfg, err := s.UpdateConfig(bg, "tzx", contracts.AppConfigPatch{Timezone: sp(tc.in)})
		if err != nil || cfg.Timezone != tc.want {
			t.Errorf("timezone %q → %q (%v)", tc.in, cfg.Timezone, err)
		}
		if again, _ := s.GetConfig(bg, "tzx"); again.Timezone != tc.want {
			t.Errorf("timezone %q not persisted", tc.in)
		}
	}
}

func TestRawConfig(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})
	raw, err := s.GetRawConfig(bg, "live")
	if file, _ := readYAML(t, s, "live"); err != nil || raw != file || !strings.Contains(raw, "name: live") {
		t.Fatalf("raw = %q, %v", raw, err)
	}
	_, err = s.GetRawConfig(bg, "ghost")
	wantStatus(t, err, http.StatusNotFound)

	next := "name: live\ndisplay_name: Edited\nroom_prefix: live\nrecording:\n  enabled: false\n"
	res, err := s.PutRawConfig(bg, "live", next)
	if err != nil || !res.Reloaded {
		t.Fatalf("put = %+v, %v", res, err)
	}
	if file, _ := readYAML(t, s, "live"); file != next {
		t.Errorf("file not written verbatim: %q", file)
	}
	if res, _ = s.PutRawConfig(bg, "live", "name: live\n"); !strings.Contains(strings.Join(res.Warnings, " "), "room_prefix missing") {
		t.Errorf("warnings = %v", res.Warnings)
	}
	res, _ = s.PutRawConfig(bg, "live", "name: live\nroom_prefix: live\ns3:\n  key: LEAK\n  secret: LEAK\n")
	if !strings.Contains(strings.Join(res.Warnings, " "), "s3.key/s3.secret in the yaml") {
		t.Errorf("warnings = %v", res.Warnings)
	}
	if cfg, _ := s.GetConfig(bg, "live"); cfg.S3.AccessKey != "" || cfg.S3.SecretKey != "" {
		t.Error("inline creds must not resolve")
	}

	before, _ := readYAML(t, s, "live")
	for _, bad := range []string{"foo: [unclosed", "- just\n- a\n- list\n", "name: other\nroom_prefix: live\n", "", "s3: 5\n", "recording: null\n"} {
		_, err := s.PutRawConfig(bg, "live", bad)
		wantStatus(t, err, http.StatusBadRequest)
		if after, _ := readYAML(t, s, "live"); after != before {
			t.Fatalf("INVARIANT: rejected %q touched the file", bad)
		}
	}
	_, err = s.PutRawConfig(bg, "ghost", "name: ghost\n")
	wantStatus(t, err, http.StatusNotFound)

	if err := os.Remove(s.configPath("live")); err != nil {
		t.Fatal(err)
	}
	_, err = s.GetRawConfig(bg, "live")
	wantStatus(t, err, http.StatusNotFound)
	if err.Error() != `config.yaml missing for app "live"` {
		t.Errorf("message = %q", err)
	}
}

func TestValidateRawWarnings(t *testing.T) {
	warnings, err := validateRaw("a", "name: a\nroom_prefix: a\nmqtt:\n  password: x\nsmtp:\n  pass: y\ntimezone: ' Mars/Base '\n")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"mqtt.password in the yaml is ignored; use PUT /apps/:app/mqtt to set the broker password",
		"smtp.pass in the yaml is ignored; use PUT /apps/:app/smtp to set the SMTP password",
		`timezone "Mars/Base" is not a recognized IANA zone; it will be ignored (falls back to the server default) on reload`,
	}
	if strings.Join(warnings, "|") != strings.Join(want, "|") {
		t.Errorf("warnings = %q", warnings)
	}
}

func TestDryRun(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})
	current, _ := s.GetRawConfig(bg, "live")
	res, err := s.DryRunRawConfig(bg, "live", current)
	if err != nil || !res.Valid || res.Error != nil || res.Changed || res.Diff != "" {
		t.Fatalf("same config = %+v, %v", res, err)
	}
	res, _ = s.DryRunRawConfig(bg, "live", "name: live\ndisplay_name: Different\nroom_prefix: live\n")
	if !res.Valid || res.Error != nil || !res.Changed || !strings.Contains(res.Diff, "\n+ ") {
		t.Errorf("changed config = %+v", res)
	}
	res, _ = s.DryRunRawConfig(bg, "live", "just a scalar")
	if res.Valid || res.Error == nil || *res.Error == "" {
		t.Errorf("invalid config = %+v", res)
	}
	if after, _ := s.GetRawConfig(bg, "live"); after != current {
		t.Error("INVARIANT: a dry-run never writes")
	}
	_, err = s.DryRunRawConfig(bg, "ghost", "name: ghost\n")
	wantStatus(t, err, http.StatusNotFound)
}

func TestUnifiedDiff(t *testing.T) {
	for _, tc := range []struct{ a, b, want string }{
		{"", "", ""},
		{"x\ny", "x\ny", ""},
		{"a\nb\nc", "a\nB\nc", "  a\n- b\n+ B\n  c"},
		{"", "a", "+ a"},
		{"a\n", "", "- a\n- "},
	} {
		if got := unifiedDiff(tc.a, tc.b); got != tc.want {
			t.Errorf("diff(%q,%q) = %q, want %q", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestBackupsAndRevert(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})
	tick := time.Date(2026, 6, 30, 18, 45, 0, 123e6, time.UTC)
	now = func() time.Time { tick = tick.Add(time.Millisecond); return tick }
	t.Cleanup(func() { now = time.Now })

	v0, _ := s.GetRawConfig(bg, "live")
	v1 := "name: live\ndisplay_name: V1\nroom_prefix: live\n"
	if _, err := s.PutRawConfig(bg, "live", v1); err != nil {
		t.Fatal(err)
	}
	backups, _ := s.ListConfigBackups(bg, "live")
	if len(backups) != 1 || backups[0].TS != "20260630T184500124Z" || backups[0].File != "config.yaml.bak.20260630T184500124Z" || backups[0].SizeBytes != int64(len(v0)) {
		t.Fatalf("backups = %+v", backups)
	}
	if got, _ := s.ReadConfigBackup(bg, "live", backups[0].TS); got != v0 {
		t.Error("backup must be verbatim")
	}
	_, err := s.ReadConfigBackup(bg, "live", "bad id!")
	wantStatus(t, err, http.StatusBadRequest)
	_, err = s.ReadConfigBackup(bg, "live", "20990101T000000000Z")
	wantStatus(t, err, http.StatusNotFound)

	res, err := s.RevertConfigBackup(bg, "live", backups[0].TS)
	if err != nil || !res.Reloaded {
		t.Fatalf("revert = %+v, %v", res, err)
	}
	if got, _ := s.GetRawConfig(bg, "live"); got != v0 {
		t.Error("INVARIANT: revert restores verbatim")
	}
	after, _ := s.ListConfigBackups(bg, "live")
	if len(after) != 2 || after[0].TS <= after[1].TS {
		t.Fatalf("newest first: %+v", after)
	}
	if got, _ := s.ReadConfigBackup(bg, "live", after[0].TS); got != v1 {
		t.Error("revert must back up the current config (reversible)")
	}
	_, err = s.RevertConfigBackup(bg, "live", "bad id!")
	wantStatus(t, err, http.StatusBadRequest)
	_, err = s.RevertConfigBackup(bg, "live", "20990101T000000000Z")
	wantStatus(t, err, http.StatusNotFound)

	// INVARIANT: never more than 20 backups (oldest pruned).
	for i := 1; i <= 25; i++ {
		_ = os.WriteFile(filepath.Join(s.AppDir("live"), fmt.Sprintf("config.yaml.bak.%04d", i)), []byte("x"), 0o644)
	}
	if _, err := s.PutRawConfig(bg, "live", v1); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.ListConfigBackups(bg, "live"); len(list) != 20 {
		t.Errorf("kept %d backups", len(list))
	}
}

func TestReload(t *testing.T) {
	s, h := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})
	if _, err := s.GetConfig(bg, "live"); err != nil { // warm the cache
		t.Fatal(err)
	}
	// An external edit is picked up (cache keyed by mtime + size).
	if err := os.WriteFile(s.configPath("live"), []byte("name: live\ndisplay_name: Synced\nroom_prefix: newprefix\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := s.Reload(bg, "live")
	if err != nil || !res.Reloaded {
		t.Fatalf("reload = %+v, %v", res, err)
	}
	if rec, _ := s.Get(bg, "live"); rec.DisplayName != "Synced" || rec.LivekitRoomPrefix != "newprefix" {
		t.Errorf("registry not re-synced: %+v", rec)
	}
	if h.mqtt.dropped[len(h.mqtt.dropped)-1] != "live" {
		t.Error("reload must drop the MQTT client")
	}
	// Secrets cache re-init: a value written behind the store's back shows up.
	_ = h.secrets.Set("X", "1")
	_ = os.WriteFile(h.secrets.Path(), []byte(`{"X":"2"}`), 0o600)
	if _, err := s.Reload(bg, "live"); err != nil {
		t.Fatal(err)
	}
	if v, _ := h.secrets.Get("X"); v != "2" {
		t.Error("INVARIANT: reload invalidates the secrets cache")
	}

	_ = os.Remove(s.configPath("live"))
	res, _ = s.Reload(bg, "live")
	if res.Reloaded || !strings.Contains(strings.Join(res.Warnings, " "), "config re-read failed") {
		t.Errorf("missing config = %+v", res)
	}
	_, err = s.Reload(bg, "ghost")
	wantStatus(t, err, http.StatusNotFound)
}

func TestConfigCache(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "cache"})
	a, _ := s.readDisk("cache")
	a.Set("display_name", "mutated by a caller")
	b, _ := s.readDisk("cache")
	if b.Get("display_name") != "cache" {
		t.Fatal("cache must hand out copies")
	}
	// Same size, different content and mtime → re-read.
	raw, _ := os.ReadFile(s.configPath("cache"))
	edited := strings.Replace(string(raw), "display_name: cache", "display_name: CACHE", 1)
	future := time.Now().Add(2 * time.Second)
	_ = os.WriteFile(s.configPath("cache"), []byte(edited), 0o644)
	_ = os.Chtimes(s.configPath("cache"), future, future)
	if c, _ := s.readDisk("cache"); c.Get("display_name") != "CACHE" {
		t.Error("external edit not picked up")
	}
}

func TestSetS3(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})
	m, _ := s.GetS3(bg, "live")
	if m.Configured || m.HasKey || m.HasSecret || m.PublicVods || m.PublicWarning != nil {
		t.Errorf("fresh = %+v", m)
	}
	m, _ = s.SetS3(bg, "live", SetS3Input{Bucket: sp("my-bucket"), Region: sp("eu-west-1")})
	if _, disk := readYAML(t, s, "live"); m.Bucket != "my-bucket" || at(disk, "s3", "bucket") != "my-bucket" || at(disk, "s3", "region") != "eu-west-1" {
		t.Errorf("block not persisted: %+v", m)
	}
	if _, disk := readYAML(t, s, "live"); !strings.Contains(at(disk, "s3", "endpoint").(string), "wasabisys.com") {
		t.Fatal("scaffold endpoint is Wasabi")
	}
	_, _ = s.SetS3(bg, "live", SetS3Input{Provider: sp("aws"), Bucket: sp("aws-bucket")})
	if _, disk := readYAML(t, s, "live"); at(disk, "s3", "provider") != "aws" || at(disk, "s3", "endpoint") != "" {
		t.Error("aws without endpoint must clear the Wasabi endpoint")
	}
	_, _ = s.SetS3(bg, "live", SetS3Input{Provider: sp("aws"), Endpoint: sp("https://minio.internal:9000")})
	if _, disk := readYAML(t, s, "live"); at(disk, "s3", "endpoint") != "https://minio.internal:9000" {
		t.Error("explicit endpoint wins")
	}

	m, _ = s.SetS3(bg, "live", SetS3Input{Key: "AKIAEXAMPLEKEY", Secret: "SUPERSECRETVALUE"})
	if !m.Configured || !m.HasKey || !m.HasSecret || m.Key != "AK***EY" || m.Secret != "SU***UE" {
		t.Errorf("masked = %+v", m)
	}
	if raw, _ := readYAML(t, s, "live"); strings.Contains(raw, "AKIAEXAMPLEKEY") || strings.Contains(raw, "SUPERSECRETVALUE") {
		t.Error("INVARIANT: credentials never in the yaml")
	}
	if cfg, _ := s.GetConfig(bg, "live"); cfg.S3.AccessKey != "AKIAEXAMPLEKEY" || cfg.S3.SecretKey != "SUPERSECRETVALUE" {
		t.Errorf("resolved creds = %+v", cfg.S3)
	}

	_, err := s.SetS3(bg, "live", SetS3Input{PublicURL: sp("https://cdn.example.com")})
	wantStatus(t, err, http.StatusBadRequest)
	m, _ = s.SetS3(bg, "live", SetS3Input{PublicURL: sp("https://cdn.example.com/"), ConfirmPublic: true})
	if !m.PublicVods || m.PublicWarning == nil || m.PublicURL != "https://cdn.example.com" {
		t.Errorf("public = %+v", m)
	}
	m, err = s.SetS3(bg, "live", SetS3Input{PublicURL: sp("")})
	if err != nil || m.PublicVods || m.PublicURL != "" {
		t.Errorf("clearing needs no confirmation: %+v, %v", m, err)
	}
	_, err = s.GetS3(bg, "ghost")
	wantStatus(t, err, http.StatusNotFound)
}

func TestMask(t *testing.T) {
	for in, want := range map[string]string{"": "", "abc": "****", "abcd": "****", "abcde": "ab***de", "😀😀😀": "😀***😀", "😀abc😀": "😀***😀", "ab😀": "****"} {
		if got := mask(in); got != want {
			t.Errorf("mask(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMqttConfig(t *testing.T) {
	s, h := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})
	cfg, _ := s.GetConfig(bg, "live")
	if cfg.Mqtt.Enabled || cfg.Mqtt.TopicPrefix != "streamhub/live" || strings.Join(cfg.Mqtt.Events, ",") != "all" || cfg.Mqtt.Qos != 0 || cfg.Mqtt.Logs.Level != "info" {
		t.Errorf("defaults = %+v", cfg.Mqtt)
	}
	m, err := s.SetMqtt(bg, "live", SetMqttInput{Enabled: bp(true), URL: sp(" mqtt://broker:1883 "), Password: "broker-secret", Events: []string{" a ", ""}})
	if err != nil || m.Password != "br***et" || !m.HasPassword || !m.Configured || m.URL != "mqtt://broker:1883" || strings.Join(m.Events, ",") != "a" {
		t.Fatalf("set = %+v, %v", m, err)
	}
	if raw, disk := readYAML(t, s, "live"); strings.Contains(raw, "broker-secret") || at(disk, "mqtt", "url") != "mqtt://broker:1883" {
		t.Error("password must go ONLY to secrets.json")
	}
	if cfg, _ := s.GetConfig(bg, "live"); cfg.Mqtt.Password != "broker-secret" {
		t.Error("getConfig resolves the same password")
	}
	if got, _ := s.GetMqtt(bg, "live"); got.Password != "br***et" {
		t.Error("getMqtt masks")
	}
	m, _ = s.SetMqtt(bg, "live", SetMqttInput{Qos: fp(1)})
	if !m.HasPassword {
		t.Error("omitting the password keeps the stored one")
	}
	if h.mqtt.dropped[len(h.mqtt.dropped)-1] != "live" {
		t.Error("setMqtt drops the live client")
	}
	_, _ = s.UpdateConfig(bg, "live", contracts.AppConfigPatch{Mqtt: &contracts.MqttPatch{Password: "via-update"}})
	if raw, _ := readYAML(t, s, "live"); strings.Contains(raw, "via-update") {
		t.Error("updateConfig must route the password to secrets.json")
	}
	if cfg, _ := s.GetConfig(bg, "live"); cfg.Mqtt.Password != "via-update" {
		t.Error("updateConfig password not stored")
	}

	m, _ = s.SetMqtt(bg, "live", SetMqttInput{Qos: fp(7), Events: []string{}, Logs: &contracts.MqttLogsPatch{Level: sp("loud")}})
	if m.Qos != 0 || strings.Join(m.Events, ",") != "all" || m.Logs.Level != "info" {
		t.Errorf("junk sanitized = %+v", m)
	}
	res, _ := s.PutRawConfig(bg, "live", "name: live\nroom_prefix: live\nmqtt:\n  password: inline\n")
	if !strings.Contains(strings.Join(res.Warnings, " "), "mqtt.password in the yaml is ignored") {
		t.Errorf("warnings = %v", res.Warnings)
	}
	if cfg, _ := s.GetConfig(bg, "live"); cfg.Mqtt.Password != "via-update" {
		t.Error("inline mqtt.password must be ignored")
	}
	_, err = s.GetMqtt(bg, "ghost")
	wantStatus(t, err, http.StatusNotFound)
	_, err = s.SetMqtt(bg, "ghost", SetMqttInput{})
	wantStatus(t, err, http.StatusNotFound)
}

func TestSmtpConfig(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})
	cfg, _ := s.GetConfig(bg, "live")
	if cfg.Smtp.Enabled || cfg.Smtp.Port != 587 || cfg.Smtp.Host != "" || cfg.Smtp.User != "" || cfg.Smtp.From != "" {
		t.Errorf("defaults = %+v", cfg.Smtp)
	}
	m, _ := s.SetSmtp(bg, "live", SetSmtpInput{Enabled: bp(true), Host: sp(" smtp.example.com "), Port: fp(465), Pass: "smtp-secret"})
	if m.Host != "smtp.example.com" || m.Port != 465 || m.Pass != "sm***et" || !m.Configured || m.PassEnv != "APP_LIVE_SMTP_PASS" {
		t.Errorf("set = %+v", m)
	}
	if raw, _ := readYAML(t, s, "live"); strings.Contains(raw, "smtp-secret") {
		t.Error("password only in secrets.json")
	}
	if cfg, _ := s.GetConfig(bg, "live"); cfg.Smtp.Pass != "smtp-secret" {
		t.Error("getConfig resolves the same password")
	}
	if m, _ = s.SetSmtp(bg, "live", SetSmtpInput{Port: fp(0)}); m.Port != 587 || !m.HasPass {
		t.Errorf("invalid port → 587, pass kept: %+v", m)
	}
	res, _ := s.PutRawConfig(bg, "live", "name: live\nroom_prefix: live\nsmtp:\n  pass: inline\n")
	if !strings.Contains(strings.Join(res.Warnings, " "), "smtp.pass in the yaml is ignored") {
		t.Errorf("warnings = %v", res.Warnings)
	}
	_, err := s.GetSmtp(bg, "ghost")
	wantStatus(t, err, http.StatusNotFound)
}

func TestPassthroughMutualExclusion(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "ptx"})
	if cfg, _ := s.GetConfig(bg, "ptx"); cfg.Rtmp.Passthrough {
		t.Fatal("new app: passthrough off")
	}
	cfg, _ := s.UpdateConfig(bg, "ptx", contracts.AppConfigPatch{Rtmp: &contracts.RtmpPatch{Passthrough: bp(true)}})
	if !cfg.Rtmp.Passthrough || cfg.Rtmp.Transcode || cfg.Transcoding.Enabled || cfg.Webrtc.Adaptive {
		t.Errorf("passthrough forces the rest off: %+v %+v %+v", cfg.Rtmp, cfg.Transcoding, cfg.Webrtc)
	}
	for name, patch := range map[string]contracts.AppConfigPatch{
		"transcoding.enabled": {Transcoding: &contracts.TranscodingPatch{Enabled: bp(true)}},
		"rtmp.transcode":      {Rtmp: &contracts.RtmpPatch{Transcode: bp(true)}},
		"webrtc.adaptive":     {Webrtc: &contracts.WebrtcPatch{Adaptive: bp(true)}},
	} {
		_, _ = s.UpdateConfig(bg, "ptx", contracts.AppConfigPatch{Rtmp: &contracts.RtmpPatch{Passthrough: bp(true)}})
		if cfg, _ := s.UpdateConfig(bg, "ptx", patch); cfg.Rtmp.Passthrough {
			t.Errorf("%s must force passthrough off", name)
		}
	}
	cfg, _ = s.UpdateConfig(bg, "ptx", contracts.AppConfigPatch{
		Rtmp: &contracts.RtmpPatch{Passthrough: bp(true), Transcode: bp(true)}, Webrtc: &contracts.WebrtcPatch{Adaptive: bp(true)},
	})
	if !cfg.Rtmp.Passthrough || cfg.Rtmp.Transcode || cfg.Webrtc.Adaptive {
		t.Errorf("passthrough wins a contradictory patch: %+v", cfg.Rtmp)
	}
}

func TestTranscodingBlock(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "tcx"})
	cfg, _ := s.GetConfig(bg, "tcx")
	if cfg.Transcoding.Enabled || cfg.Transcoding.Encoding != "h264" || cfg.Webrtc.TranscodeMaxHeight != 720 {
		t.Errorf("INVARIANT: new app passthrough by default, cap 720: %+v", cfg)
	}
	if _, disk := readYAML(t, s, "tcx"); at(disk, "transcoding", "enabled") != false || at(disk, "webrtc", "transcode_max_height") != 720.0 {
		t.Error("snake_case block persisted")
	}
	cfg, _ = s.UpdateConfig(bg, "tcx", contracts.AppConfigPatch{Transcoding: &contracts.TranscodingPatch{
		Enabled: bp(true), Encoding: sp("h264+vp8"), VodAdaptive: bp(true),
		VodRenditions: []contracts.VodRendition{{Height: 480, BitrateKbps: 1400}, {Height: 1080, BitrateKbps: 5000}},
	}})
	if !cfg.Transcoding.Enabled || cfg.Transcoding.Encoding != "h264+vp8" || cfg.Transcoding.VodRenditions[0].Height != 1080 {
		t.Errorf("round-trip = %+v", cfg.Transcoding)
	}
	cfg, _ = s.UpdateConfig(bg, "tcx", contracts.AppConfigPatch{Webrtc: &contracts.WebrtcPatch{Adaptive: bp(true), Layers: []contracts.WebrtcLayer{}}})
	if cfg.Webrtc.Adaptive || len(cfg.Webrtc.Layers) != 0 {
		t.Errorf("an empty ladder turns adaptive off: %+v", cfg.Webrtc)
	}
	cfg, _ = s.UpdateConfig(bg, "tcx", contracts.AppConfigPatch{Webrtc: &contracts.WebrtcPatch{TranscodeMaxHeight: fp(1080)}})
	if cfg.Webrtc.TranscodeMaxHeight != 1080 {
		t.Error("cap round-trip")
	}

	for _, tc := range []struct {
		yaml string
		want bool
	}{{"name: tcx\nrtmp:\n  transcode: true\n", true}, {"name: tcx\nrtmp:\n  transcode: false\n", false}} {
		_ = os.WriteFile(s.configPath("tcx"), []byte(tc.yaml), 0o644)
		s.invalidate("tcx")
		if cfg, _ := s.GetConfig(bg, "tcx"); cfg.Transcoding.Enabled != tc.want || cfg.Webrtc.TranscodeMaxHeight != 720 {
			t.Errorf("legacy yaml %q → transcoding %v", tc.yaml, cfg.Transcoding.Enabled)
		}
	}
	_ = os.WriteFile(s.configPath("tcx"), []byte("name: tcx\ntranscoding:\n  encoding: av1\n  vod_renditions:\n    - {height: 100, bitrate_kbps: 1}\n    - {height: 720, bitrate_kbps: 0}\n    - {height: 360, bitrate_kbps: 800}\n    - {height: 360, bitrate_kbps: 9}\n    - {height: 1080, bitrate_kbps: 4000}\nwebrtc:\n  transcode_max_height: 1440\n"), 0o644)
	s.invalidate("tcx")
	cfg, _ = s.GetConfig(bg, "tcx")
	if cfg.Transcoding.Encoding != "h264" || len(cfg.Transcoding.VodRenditions) != 2 || cfg.Transcoding.VodRenditions[0].Height != 1080 || cfg.Webrtc.TranscodeMaxHeight != 1080 {
		t.Errorf("sanitized = %+v / %d", cfg.Transcoding, cfg.Webrtc.TranscodeMaxHeight)
	}
}

func TestSanitizeTranscodeMaxHeight(t *testing.T) {
	for in, want := range map[any]int{720.0: 720, 1440.0: 1080, 240.0: 360, "abc": 720, -5.0: 720, nil: 720, "480": 480, 600.0: 720, 599.0: 480, 1080.9: 1080} {
		if got := SanitizeTranscodeMaxHeight(in); got != want {
			t.Errorf("sanitize(%v) = %d, want %d", in, got, want)
		}
	}
}

func TestCallbackURLGuard(t *testing.T) {
	s, h := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "cbx"})
	for _, u := range []string{"http://10.0.0.5/x", "http://127.0.0.1/x", "http://169.254.169.254/latest"} {
		_, err := s.UpdateConfig(bg, "cbx", contracts.AppConfigPatch{Callbacks: &contracts.CallbacksPatch{URL: sp(u)}})
		wantStatus(t, err, http.StatusBadRequest)
	}
	if cfg, _ := s.GetConfig(bg, "cbx"); cfg.Callbacks.URL != "" {
		t.Fatal("rejected URL must not land on disk")
	}
	for _, u := range []string{"https://hooks.example.com/x", ""} {
		if _, err := s.UpdateConfig(bg, "cbx", contracts.AppConfigPatch{Callbacks: &contracts.CallbacksPatch{URL: sp(u)}}); err != nil {
			t.Errorf("%q: %v", u, err)
		}
	}
	h.env["STREAMHUB_CALLBACK_ALLOW_HOSTS"] = "10.0.0.5"
	if _, err := s.UpdateConfig(bg, "cbx", contracts.AppConfigPatch{Callbacks: &contracts.CallbacksPatch{URL: sp("http://10.0.0.5/x")}}); err != nil {
		t.Errorf("allowlisted host: %v", err)
	}
	delete(h.env, "STREAMHUB_CALLBACK_ALLOW_HOSTS")

	before, _ := s.GetRawConfig(bg, "cbx")
	_, err := s.PutRawConfig(bg, "cbx", "name: cbx\ncallbacks:\n  url: http://192.168.1.1/x\n")
	wantStatus(t, err, http.StatusBadRequest)
	if after, _ := s.GetRawConfig(bg, "cbx"); after != before {
		t.Error("rejected raw config touched the file")
	}
	if _, err := s.PutRawConfig(bg, "cbx", "name: cbx\ncallbacks:\n  url: https://hooks.example.com/x\n"); err != nil {
		t.Error(err)
	}
	res, _ := s.DryRunRawConfig(bg, "cbx", "name: cbx\ncallbacks:\n  url: http://10.1.1.1/x\n")
	if res.Valid || res.Error == nil {
		t.Errorf("dry-run reports inline: %+v", res)
	}
}

func TestUnknownBlocksSurviveStructuredSaves(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "keep"})
	if _, err := s.PutRawConfig(bg, "keep", "name: keep\nroom_prefix: keep\nnotifications:\n  email: a@b.c\nnetwork:\n  allow: [1.2.3.4]\ncluster: {node: edge-1}\n"); err != nil {
		t.Fatal(err)
	}
	_, _ = s.UpdateConfig(bg, "keep", contracts.AppConfigPatch{DisplayName: sp("x")})
	_, _ = s.SetMqtt(bg, "keep", SetMqttInput{Enabled: bp(true)})
	_, _ = s.ApplyConfigPreset(bg, "keep", "low-latency")
	_, disk := readYAML(t, s, "keep")
	if at(disk, "notifications", "email") != "a@b.c" || at(disk, "cluster", "node") != "edge-1" || y.IsUndefined(at(disk, "network", "allow")) {
		t.Errorf("unknown blocks dropped: %v", disk.Keys())
	}
	if disk.Keys()[0] != "notifications" {
		t.Errorf("extras come first: %v", disk.Keys())
	}
}

func TestInitSeedsLive(t *testing.T) {
	s, _ := newTestService(t)
	s.Init(bg)
	s.Init(bg) // idempotent
	rec, _ := s.Get(bg, DefaultApp)
	if rec == nil || rec.DisplayName != "Live" {
		t.Fatalf("live = %+v", rec)
	}
	if list, _ := s.List(bg, nil); len(list) != 1 {
		t.Errorf("seeded twice: %v", list)
	}
}

func TestSamplePages(t *testing.T) {
	raw, err := os.ReadFile("samples/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var want SamplePages
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	got := RenderSamplePages(SamplePageContext{
		AppName: "live", RoomName: `li<v>e"&`, PublicBaseURL: "https://x.example/",
		PublicWsURL: "wss://m.example", APIBase: "https://x.example/api/v1/",
	})
	if got != want {
		t.Errorf("sample pages differ from Node's renderSamplePages")
	}
}
