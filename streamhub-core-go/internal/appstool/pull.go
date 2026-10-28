package appstool

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// LockPath is <root>/apps.lock.json.
func (t *Tool) LockPath() string { return filepath.Join(t.Root, "apps.lock.json") }

// ReadLock reads apps.lock.json (absent = empty; must be an array of objects).
func (t *Tool) ReadLock() ([]*y.Map, error) {
	raw, err := os.ReadFile(t.LockPath())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	v, err := y.ParseJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("apps.lock.json is not valid JSON: %w", err)
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, errors.New("apps.lock.json must be a JSON array")
	}
	out := make([]*y.Map, 0, len(arr))
	for _, e := range arr {
		m, ok := e.(*y.Map)
		if !ok {
			return nil, fmt.Errorf("invalid lock entry: %s", y.ToString(e))
		}
		out = append(out, m)
	}
	return out, nil
}

// WriteLock writes the lock as JSON.stringify(entries, null, 2) + '\n'.
func (t *Tool) WriteLock(entries []*y.Map) error {
	arr := make([]any, len(entries))
	for i, e := range entries {
		arr[i] = e
	}
	return os.WriteFile(t.LockPath(), []byte(StringifyIndent(arr)+"\n"), 0o644)
}

func str(m *y.Map, k string) string { s, _ := m.Get(k).(string); return s }

// authHeader: a deploy token (gldt-…) authenticates with Deploy-Token, any
// other token (glpat-…) with PRIVATE-TOKEN.
func authHeader(token string) (string, string) {
	if strings.HasPrefix(token, "gldt-") {
		return "Deploy-Token", token
	}
	return "PRIVATE-TOKEN", token
}

// get fetches url; a non-2xx status is an error carrying the status code.
func (t *Tool) get(u string, headers map[string]string) ([]byte, int, error) {
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	c := t.HTTP
	if c == nil {
		c = http.DefaultClient
	}
	res, err := c.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, res.StatusCode, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, res.StatusCode, fmt.Errorf("status %d", res.StatusCode)
	}
	return body, res.StatusCode, nil
}

// fetchPackage resolves the package bytes for a lock entry from its `source`
// (else `repo`): file:<repo-relative path>, http(s)://, or gitlab:group/project.
func (t *Tool) fetchPackage(entry *y.Map) ([]byte, error) {
	const cmd = "apps-pull"
	id, version := str(entry, "id"), str(entry, "version")
	src := str(entry, "source")
	if src == "" {
		src = str(entry, "repo")
	}
	switch {
	case strings.HasPrefix(src, "file:"):
		rel := strings.TrimPrefix(strings.TrimPrefix(src, "file:"), "./")
		abs := rel
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(t.Root, rel)
		}
		b, err := os.ReadFile(abs)
		if err != nil {
			return nil, t.die(cmd, "%s: local package not found: %s", id, rel)
		}
		return b, nil
	case strings.HasPrefix(src, "http://"), strings.HasPrefix(src, "https://"):
		b, status, err := t.get(src, nil)
		if err != nil {
			return nil, t.die(cmd, "download failed (%s) for %s", statusText(status, err), src)
		}
		return b, nil
	case strings.HasPrefix(src, "gitlab:"):
		token := t.env("STREAMHUB_APPS_TOKEN")
		if token == "" {
			return nil, t.die(cmd, "%s: STREAMHUB_APPS_TOKEN unset — cannot fetch gitlab package", id)
		}
		// The deterministic generic-package URL needs no read_api call, so a
		// read-only deploy token (read_package_registry) is enough.
		proj := projectPath(strings.TrimPrefix(src, "gitlab:"))
		file := fmt.Sprintf("streamhub-app-%s-%s.tar.gz", id, version)
		u := fmt.Sprintf("%s/api/v4/projects/%s/packages/generic/streamhub-app-%s/%s/%s", t.gitlabHost(), proj, id, version, file)
		k, v := authHeader(token)
		b, status, err := t.get(u, map[string]string{k: v})
		if err != nil {
			return nil, t.die(cmd, "download failed (%s) for %s", statusText(status, err), u)
		}
		return b, nil
	}
	return nil, t.die(cmd, "%s: unsupported source '%s' (use file:, https:// or gitlab:)", id, src)
}

// projectPath is encodeURIComponent(group/project) for the /projects/:id API.
func projectPath(p string) string { return strings.ReplaceAll(url.PathEscape(p), "/", "%2F") }

func statusText(status int, err error) string {
	if status != 0 {
		return fmt.Sprint(status)
	}
	return err.Error()
}

// freshDir is rm -rf + mkdir -p.
func freshDir(dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o755)
}

// copyTree copies directories and regular files verbatim (worker sources);
// transform, when set, rewrites the files it returns true for.
func copyTree(src, dest string, transform func(name string, b []byte) ([]byte, bool)) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	ents, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, d := range ents {
		s, t := filepath.Join(src, d.Name()), filepath.Join(dest, d.Name())
		switch {
		case d.IsDir():
			if err := copyTree(s, t, transform); err != nil {
				return err
			}
		case d.Type().IsRegular():
			b, err := os.ReadFile(s)
			if err != nil {
				return err
			}
			if transform != nil {
				if nb, ok := transform(d.Name(), b); ok {
					b = nb
				}
			}
			if err := os.WriteFile(t, b, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}

var rewriteExt = map[string]bool{".ts": true, ".tsx": true, ".js": true, ".jsx": true}

// truthy is JS ToBoolean over the value model.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	}
	return !y.IsUndefined(v)
}

// linkBackend writes the package's manifest (re-serialized, worker.workerDir
// kept package-relative) plus its worker tree into
// <repo>/plugins-vendor/<id>/ (the dir the core binary's registry scans) —
// self-contained, no host paths.
func (t *Tool) linkBackend(id, pkgDir string) error {
	const cmd = "apps-pull"
	raw, err := os.ReadFile(filepath.Join(pkgDir, "streamhub.app.json"))
	if err != nil {
		return t.die(cmd, "%s: package is missing streamhub.app.json", id)
	}
	manifest, err := ParseJSONObject(raw)
	if err != nil {
		return t.die(cmd, "%s: streamhub.app.json: %s", id, err)
	}
	dest := filepath.Join(t.Root, "plugins-vendor", id)
	if err := freshDir(dest); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dest, "streamhub.app.json"), []byte(StringifyIndent(manifest)+"\n"), 0o644); err != nil {
		return err
	}
	worker, _ := manifest.Get("worker").(*y.Map)
	if worker == nil || !truthy(worker.Get("needsWorker")) {
		return nil
	}
	rel := "worker"
	if v := worker.Get("workerDir"); !y.IsUndefined(v) && v != nil {
		rel = y.ToString(v)
	}
	if filepath.IsAbs(rel) {
		return t.die(cmd, "%s: manifest worker.workerDir must be package-relative, got '%s'", id, rel)
	}
	workerSrc := filepath.Join(pkgDir, rel)
	if _, err := os.Stat(workerSrc); err != nil {
		return t.die(cmd, "%s: package worker dir '%s' missing", id, rel)
	}
	return copyTree(workerSrc, filepath.Join(dest, rel), nil)
}

// linkFrontend copies the package's frontend/ into
// streamhub-web/src/plugins-vendor/<id>/, rewriting relative imports.
func (t *Tool) linkFrontend(id, pkgDir string) (bool, error) {
	src := filepath.Join(pkgDir, "frontend")
	if _, err := os.Stat(src); err != nil {
		return false, nil
	}
	dest := filepath.Join(t.Root, "streamhub-web", "src", "plugins-vendor", id)
	if err := freshDir(dest); err != nil {
		return false, err
	}
	return true, copyTree(src, dest, func(name string, b []byte) ([]byte, bool) {
		if !rewriteExt[filepath.Ext(name)] {
			return nil, false
		}
		return []byte(RewriteVendorImports(string(b))), true
	})
}

// Pull is `apps pull`: compose every pinned app into the build after
// verifying its CONTENT sha256 (sha of the uncompressed tar — gzip bytes drift
// across zlib versions, the tar does not). Fails closed on any mismatch.
func (t *Tool) Pull() error {
	const cmd = "apps-pull"
	logf := func(format string, a ...any) { t.logf(cmd+": "+format, a...) }
	lock, err := t.ReadLock()
	if err != nil {
		return t.die(cmd, "%s", err)
	}
	if len(lock) == 0 {
		logf("apps.lock.json is empty — nothing to compose")
		return nil
	}
	vendorApps := filepath.Join(t.Root, "vendor", "apps")
	for _, d := range []string{vendorApps,
		filepath.Join(t.Root, "plugins-vendor"),
		filepath.Join(t.Root, "streamhub-web", "src", "plugins-vendor")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return t.die(cmd, "%s", err)
		}
	}
	inTree := map[string]bool{}
	for _, id := range plugins.BuiltinIDs() {
		inTree[id] = true
	}
	for _, entry := range lock {
		id, version, want := str(entry, "id"), str(entry, "version"), str(entry, "sha256")
		if id == "" || version == "" || want == "" {
			s, _ := y.Stringify(entry)
			return t.die(cmd, "invalid lock entry (needs id, version, sha256): %s", s)
		}
		if !idRE.MatchString(id) {
			return t.die(cmd, "invalid lock entry id '%s'", id)
		}
		logf("composing %s@%s…", id, version)
		gz, err := t.fetchPackage(entry)
		if err != nil {
			return err
		}
		tar, err := Gunzip(gz)
		if err != nil {
			return t.die(cmd, "%s: package is not a valid gzip: %s", id, err)
		}
		if got := Sha256Hex(tar); got != want {
			return t.die(cmd, "%s: content sha256 MISMATCH — lock %s…, got %s… (refusing)", id, prefix12(want), prefix12(got))
		}
		pkgDir := filepath.Join(vendorApps, id)
		if err := freshDir(pkgDir); err != nil {
			return t.die(cmd, "%s", err)
		}
		if _, err := ExtractTar(tar, pkgDir); err != nil {
			return t.die(cmd, "%s: %s", id, err)
		}
		if err := t.linkBackend(id, pkgDir); err != nil {
			return err
		}
		hasFrontend, err := t.linkFrontend(id, pkgDir)
		if err != nil {
			return t.die(cmd, "%s: %s", id, err)
		}
		extra := ""
		if hasFrontend {
			extra = " + frontend"
		}
		// An in-tree app of the same id wins: the registry keeps it and skips
		// the vendored package — never a silent no-op.
		if inTree[id] {
			extra += "  (shadowed by in-tree app — the registry keeps the in-tree copy)"
		}
		logf("  ✓ %s: backend linked%s", id, extra)
	}
	logf("composed %d app(s) into vendor/", len(lock))
	return nil
}

func prefix12(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
