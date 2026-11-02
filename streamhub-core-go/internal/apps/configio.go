package apps

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/fsperm"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// config.yaml I/O. Node re-reads and YAML-parses the file on every call; the
// port caches the merged tree per app, keyed by the file's mtime + size and
// dropped on every write, and hands out deep copies (callers mutate).

// configLineWidth is the js-yaml dump lineWidth every writer uses.
const configLineWidth = 120

type cachedDisk struct {
	mod  time.Time
	size int64
	disk *y.Map
}

func (s *Service) configPath(name string) string { return filepath.Join(s.AppDir(name), "config.yaml") }

func (s *Service) invalidate(name string) {
	s.cacheMu.Lock()
	delete(s.cache, name)
	s.cacheMu.Unlock()
}

// readRaw is the verbatim config.yaml (404 when missing).
func (s *Service) readRaw(name string) (string, error) {
	b, err := os.ReadFile(s.configPath(name))
	if err != nil {
		return "", httpx.NotFound(fmt.Sprintf(`config.yaml missing for app "%s"`, name))
	}
	return string(b), nil
}

// readDisk is readDiskConfig: the parsed config.yaml merged over a fresh
// default (missing fields tolerated, unknown blocks preserved).
func (s *Service) readDisk(name string) (*y.Map, error) {
	file := s.configPath(name)
	st, statErr := os.Stat(file)
	if statErr == nil {
		s.cacheMu.Lock()
		c, ok := s.cache[name]
		s.cacheMu.Unlock()
		if ok && c.mod.Equal(st.ModTime()) && c.size == st.Size() {
			return y.DeepClone(c.disk).(*y.Map), nil
		}
	}
	raw, err := s.readRaw(name)
	if err != nil {
		return nil, err
	}
	parsed, err := y.Load(raw)
	if err != nil {
		return nil, httpx.Internal(fmt.Sprintf(`invalid config.yaml for app "%s": %s`, name, err))
	}
	disk := mergeOver(name, parsed)
	if dropped := pinSecretRefs(name, disk); len(dropped) > 0 {
		s.log.Warn(fmt.Sprintf(`app "%s": config.yaml names foreign secret refs (%s); ignored, using the server-derived refs`,
			name, strings.Join(dropped, ", ")))
	}
	if statErr == nil {
		s.cacheMu.Lock()
		s.cache[name] = cachedDisk{mod: st.ModTime(), size: st.Size(), disk: y.DeepClone(disk).(*y.Map)}
		s.cacheMu.Unlock()
	}
	return disk, nil
}

// mergeOver is `mergeDisk(defaultDiskConfig(name, …), parsed || {})`.
func mergeOver(name string, parsed any) *y.Map {
	over := parsed
	if !y.Truthy(over) {
		over = y.NewMap()
	}
	return mergeDisk(defaultDisk(name, name, name), over)
}

// writeDisk dumps the tree like js-yaml (lineWidth 120) and drops the cache.
func (s *Service) writeDisk(name string, disk *y.Map) error {
	return s.writeConfigText(name, y.Dump(disk, configLineWidth))
}

// writeConfigText atomically replaces config.yaml (mode 0644).
func (s *Service) writeConfigText(name, text string) error {
	file := s.configPath(name)
	defer s.invalidate(name)
	if err := os.MkdirAll(filepath.Dir(file), fsperm.AppRoot); err != nil {
		return err
	}
	tmp := file + ".tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// --- secrets (data/secrets.json) ---------------------------------------------

// resolveSecret resolves an app credential from data/secrets.json under its
// derived ref (SecretRef — never the *_env value of the yaml), else "". The
// process env is never read, except by a platform-tenant app for its own
// derived refs (platformEnvSecrets, the fixed allowlist): an operator may
// keep those in the .env; no tenant can make the core read any other var.
func (s *Service) resolveSecret(app string, kind SecretKind) string {
	key := SecretRef(app, kind)
	if v := s.secrets.ReadFresh()[key]; v != "" {
		return v
	}
	if platformEnvSecrets[kind] && s.isPlatformApp(app) {
		return s.env(key)
	}
	return ""
}

// platformEnvSecrets are the kinds a platform-tenant app may read from an
// env var named exactly SecretRef(app, kind) when secrets.json lacks them.
var platformEnvSecrets = map[SecretKind]bool{
	SecretS3Key: true, SecretS3Secret: true, SecretSmtpPass: true, SecretMqttPassword: true, SecretDrmToken: true,
}

// isPlatformApp reports whether the app's registry row belongs to the
// platform tenant (fails closed: no tenant column, no row or a NULL tenant
// is not the platform).
func (s *Service) isPlatformApp(app string) bool {
	ctx := context.Background()
	if !s.appsHasTenantColumn(ctx) {
		return false
	}
	var tenant sql.NullString
	if err := s.global.QueryRowContext(ctx, `SELECT tenant_id FROM apps WHERE name = ?`, app).Scan(&tenant); err != nil {
		return false
	}
	return tenant.Valid && tenant.String == auth.PlatformTenantID
}

// writeSecret persists one app credential under its derived ref.
func (s *Service) writeSecret(app string, kind SecretKind, value string) {
	if err := s.secrets.WriteSecret(SecretRef(app, kind), value); err != nil {
		s.log.Error("secrets write failed: " + err.Error())
	}
}
