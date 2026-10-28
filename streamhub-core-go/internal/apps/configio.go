package apps

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
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
	if err := os.MkdirAll(filepath.Dir(file), 0o777); err != nil {
		return err
	}
	tmp := file + ".tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// --- secrets (data/secrets.json) ---------------------------------------------

// resolveSecret resolves a *_env ref: env wins, then secrets.json, else ”.
func (s *Service) resolveSecret(ref any) string {
	if !y.Truthy(ref) {
		return ""
	}
	key := y.ToString(ref)
	if v := s.env(key); v != "" {
		return v
	}
	return s.secrets.ReadFresh()[key]
}

// writeSecret persists one secret under ref (no-op for an empty ref).
func (s *Service) writeSecret(ref any, value string) {
	if !y.Truthy(ref) {
		return
	}
	if err := s.secrets.WriteSecret(y.ToString(ref), value); err != nil {
		s.log.Error("secrets write failed: " + err.Error())
	}
}
