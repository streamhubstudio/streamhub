package apps

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/timezone"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Raw config editor (wave-4 §1) + safe editor (wave-5 fold-2): validate,
// dry-run diff, timestamped backups, revert and hot-reload.

// ReloadResult is the result of a hot-reload.
type ReloadResult struct {
	Reloaded bool     `json:"reloaded"`
	Warnings []string `json:"warnings"`
}

// ConfigBackup is one config.yaml.bak.<ts> file.
type ConfigBackup struct {
	File      string `json:"file"`
	TS        string `json:"ts"`
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt string `json:"createdAt"`
}

// ConfigDryRun validates + diffs without writing.
type ConfigDryRun struct {
	Valid    bool     `json:"valid"`
	Warnings []string `json:"warnings"`
	Error    *string  `json:"error"`
	Diff     string   `json:"diff"`
	Changed  bool     `json:"changed"`
}

const backupPrefix = "config.yaml.bak."

// maxBackups is how many config backups are kept per app.
const maxBackups = 20

var backupID = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// GetRawConfig is the verbatim config.yaml.
func (s *Service) GetRawConfig(ctx context.Context, name string) (string, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return "", err
	}
	return s.readRaw(name)
}

// PutRawConfig validates, backs up, writes and hot-reloads. A parse/shape
// error is a 400 and leaves the file untouched.
func (s *Service) PutRawConfig(ctx context.Context, name, raw string) (*ReloadResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.putRawLocked(ctx, name, raw)
}

func (s *Service) putRawLocked(ctx context.Context, name, raw string) (*ReloadResult, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	warnings, err := validateRaw(name, raw)
	if err != nil {
		return nil, err
	}
	if err := s.assertCallbackURLSafe(ctx, callbackURLFromRaw(raw)); err != nil {
		return nil, err
	}
	backupWarnings := s.backupCurrent(name)
	if err := s.writeConfigText(name, raw); err != nil {
		return nil, err
	}
	reload, err := s.reloadLocked(ctx, name)
	if err != nil {
		return nil, err
	}
	return &ReloadResult{Reloaded: reload.Reloaded, Warnings: concat(warnings, backupWarnings, reload.Warnings)}, nil
}

func concat(lists ...[]string) []string {
	out := []string{}
	for _, l := range lists {
		out = append(out, l...)
	}
	return out
}

// DryRunRawConfig validates a proposed config and diffs it against the
// current one, never writing and never throwing on a validation error.
func (s *Service) DryRunRawConfig(ctx context.Context, name, raw string) (*ConfigDryRun, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	out := &ConfigDryRun{Valid: true, Warnings: []string{}}
	warnings, err := validateRaw(name, raw)
	if err == nil {
		out.Warnings = warnings
		err = s.assertCallbackURLSafe(ctx, callbackURLFromRaw(raw))
	}
	if err != nil {
		msg := errMessage(err)
		out.Valid, out.Error = false, &msg
	}
	current, _ := os.ReadFile(s.configPath(name))
	out.Diff = unifiedDiff(string(current), raw)
	out.Changed = out.Diff != ""
	return out, nil
}

// errMessage is (err as Error).message (an *httpx.Error yields its message).
func errMessage(err error) string { return err.Error() }

// ListConfigBackups lists the backups, newest first.
func (s *Service) ListConfigBackups(ctx context.Context, name string) ([]ConfigBackup, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	dir := s.AppDir(name)
	entries, _ := os.ReadDir(dir)
	out := []ConfigBackup{}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), backupPrefix) {
			continue
		}
		st, err := os.Stat(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		out = append(out, ConfigBackup{
			File: e.Name(), TS: strings.TrimPrefix(e.Name(), backupPrefix),
			SizeBytes: st.Size(), CreatedAt: jsx.ISO(st.ModTime()),
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TS > out[j].TS })
	return out, nil
}

// ReadConfigBackup returns one backup's verbatim YAML.
func (s *Service) ReadConfigBackup(ctx context.Context, name, ts string) (string, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return "", err
	}
	return s.readBackup(name, ts)
}

func (s *Service) readBackup(name, ts string) (string, error) {
	if !backupID.MatchString(ts) {
		return "", httpx.BadRequest("invalid backup id")
	}
	b, err := os.ReadFile(filepath.Join(s.AppDir(name), backupPrefix+ts))
	if err != nil {
		return "", httpx.NotFound(fmt.Sprintf(`backup "%s" not found for app "%s"`, ts, name))
	}
	return string(b), nil
}

// RevertConfigBackup restores a backup as the live config (the current one
// is backed up first, so a revert is reversible) and hot-reloads.
func (s *Service) RevertConfigBackup(ctx context.Context, name, ts string) (*ReloadResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	content, err := s.readBackup(name, ts)
	if err != nil {
		return nil, err
	}
	warnings, err := validateRaw(name, content)
	if err != nil {
		return nil, err
	}
	backupWarnings := s.backupCurrent(name)
	if err := s.writeConfigText(name, content); err != nil {
		return nil, err
	}
	reload, err := s.reloadLocked(ctx, name)
	if err != nil {
		return nil, err
	}
	return &ReloadResult{Reloaded: reload.Reloaded, Warnings: concat(warnings, backupWarnings, reload.Warnings)}, nil
}

// now is the clock (tests pin it).
var now = time.Now

// backupCurrent copies config.yaml to config.yaml.bak.<ts> and prunes to
// the newest maxBackups. Failures are warnings, never errors.
func (s *Service) backupCurrent(name string) []string {
	file := s.configPath(name)
	data, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return []string{"config backup failed: " + err.Error()}
	}
	// 2026-06-30T18:45:00.123Z → 20260630T184500123Z
	stamp := strings.NewReplacer("-", "", ":", "", ".", "").Replace(jsx.ISO(now()))
	if err := os.WriteFile(file+".bak."+stamp, data, 0o644); err != nil {
		return []string{"config backup failed: " + err.Error()}
	}
	dir := s.AppDir(name)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var backups []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), backupPrefix) {
			backups = append(backups, e.Name())
		}
	}
	sort.Strings(backups)
	for i := 0; i < len(backups)-maxBackups; i++ {
		_ = os.Remove(filepath.Join(dir, backups[i]))
	}
	return nil
}

// unifiedDiff is the minimal LCS line diff ("  ", "- ", "+ " prefixes);
// "" when nothing changed.
func unifiedDiff(before, after string) string {
	var a, b []string
	if before != "" {
		a = strings.Split(before, "\n")
	}
	if after != "" {
		b = strings.Split(after, "\n")
	}
	n, m := len(a), len(b)
	w := m + 1
	lcs := make([]int32, (n+1)*w)
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i*w+j] = lcs[(i+1)*w+j+1] + 1
			} else {
				lcs[i*w+j] = max(lcs[(i+1)*w+j], lcs[i*w+j+1])
			}
		}
	}
	lines := make([]string, 0, n+m)
	changed := false
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			lines = append(lines, "  "+a[i])
			i++
			j++
		case lcs[(i+1)*w+j] >= lcs[i*w+j+1]:
			lines = append(lines, "- "+a[i])
			i++
			changed = true
		default:
			lines = append(lines, "+ "+b[j])
			j++
			changed = true
		}
	}
	for ; i < n; i++ {
		lines = append(lines, "- "+a[i])
		changed = true
	}
	for ; j < m; j++ {
		lines = append(lines, "+ "+b[j])
		changed = true
	}
	if !changed {
		return ""
	}
	return strings.Join(lines, "\n")
}

// Reload re-reads config.yaml, re-syncs the registry row, drops cached
// secrets / S3 clients and the app's MQTT client. Never restarts LiveKit.
func (s *Service) Reload(ctx context.Context, name string) (*ReloadResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reloadLocked(ctx, name)
}

func (s *Service) reloadLocked(ctx context.Context, name string) (*ReloadResult, error) {
	rec, err := s.mustGet(ctx, name)
	if err != nil {
		return nil, err
	}
	warnings := []string{}
	disk, err := s.readDisk(name)
	if err != nil {
		return &ReloadResult{Reloaded: false, Warnings: append(warnings, "config re-read failed: "+errMessage(err))}, nil
	}
	if dn, err := bindable(disk.Get("display_name")); err != nil {
		warnings = append(warnings, "registry sync failed: "+err.Error())
	} else if rp, err := bindable(disk.Get("room_prefix")); err != nil {
		warnings = append(warnings, "registry sync failed: "+err.Error())
	} else if _, err := s.global.ExecContext(ctx, `UPDATE apps
             SET display_name = ?, livekit_room_prefix = ?, updated_at = datetime('now')
           WHERE id = ?`, dn, rp, rec.ID); err != nil {
		warnings = append(warnings, "registry sync failed: "+err.Error())
	}
	s.secrets.Invalidate()
	s.s3.Evict(nil)
	s.disconnectMqtt(name)
	s.log.Info(fmt.Sprintf(`hot-reloaded app "%s"`, name))
	return &ReloadResult{Reloaded: true, Warnings: warnings}, nil
}

// validateRaw: must parse to a mapping with the minimal shape; soft
// warnings for tolerated issues; 400 on a hard error.
func validateRaw(name, raw string) ([]string, error) {
	parsed, err := y.Load(raw)
	if err != nil {
		return nil, httpx.BadRequest("YAML parse error: " + err.Error())
	}
	obj, ok := parsed.(*y.Map)
	if !ok || obj == nil {
		return nil, httpx.BadRequest("config must be a YAML mapping (object) at the top level")
	}
	warnings := []string{}
	if n := obj.Get("name"); !y.IsUndefined(n) && n != name {
		return nil, httpx.BadRequest(fmt.Sprintf(`config "name" ("%s") must match the app name "%s"`, y.ToString(n), name))
	}
	if v := obj.Get("s3"); !y.IsUndefined(v) && !y.IsObject(v) {
		return nil, httpx.BadRequest(`"s3" must be a mapping if present`)
	}
	if v := obj.Get("recording"); !y.IsUndefined(v) && !y.IsObject(v) {
		return nil, httpx.BadRequest(`"recording" must be a mapping if present`)
	}
	// `(obj.x as Record) || {}` then `.key !== undefined`.
	has := func(block, key string) bool { return !y.IsUndefined(prop(orObject(obj.Get(block)), key)) }
	if has("s3", "key") || has("s3", "secret") {
		warnings = append(warnings, "s3.key/s3.secret in the yaml are ignored; use PUT /apps/:app/s3 to set credentials")
	}
	if has("mqtt", "password") {
		warnings = append(warnings, "mqtt.password in the yaml is ignored; use PUT /apps/:app/mqtt to set the broker password")
	}
	if has("smtp", "pass") {
		warnings = append(warnings, "smtp.pass in the yaml is ignored; use PUT /apps/:app/smtp to set the SMTP password")
	}
	if y.IsUndefined(obj.Get("room_prefix")) {
		warnings = append(warnings, "room_prefix missing; defaulting to the app name on reload")
	}
	if tz, ok := obj.Get("timezone").(string); ok && y.Trim(tz) != "" {
		if t := y.Trim(tz); !timezone.IsValid(t) {
			warnings = append(warnings, fmt.Sprintf(`timezone "%s" is not a recognized IANA zone; it will be ignored (falls back to the server default) on reload`, t))
		}
	}
	return warnings, nil
}

// orObject is `v || {}`.
func orObject(v any) any {
	if y.Truthy(v) {
		return v
	}
	return y.NewMap()
}

// callbackURLFromRaw is callbacks.url of a raw yaml ("" when absent/unparseable).
func callbackURLFromRaw(raw string) string {
	parsed, err := y.Load(raw)
	if err != nil {
		return ""
	}
	u, _ := prop(y.Coalesce(prop(parsed, "callbacks"), y.NewMap()), "url").(string)
	return u
}
