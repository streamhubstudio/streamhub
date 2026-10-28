package plugins

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of appstore/appstore.service.ts: the immutable per-app-version store
// DATA_DIR/appstore/<pluginId>/<version>/{bundle.tar.gz, manifest.json,
// extracted/}. Built-ins are materialized at boot as builtin-<coreVersion>.

const (
	bundleFile   = "bundle.tar.gz"
	manifestFile = "manifest.json"
	extractedDir = "extracted"
)

// BundleFiles is the informational file stats of a version.
type BundleFiles struct {
	Count int64 `json:"count"`
	Bytes int64 `json:"bytes"`
}

// BundleManifest is a version's manifest.json.
type BundleManifest struct {
	PluginID  string       `json:"pluginId"`
	Version   string       `json:"version"`
	Sha256    string       `json:"sha256"`
	Source    string       `json:"source"` // builtin | uploaded
	CreatedAt string       `json:"createdAt"`
	Files     *BundleFiles `json:"files,omitempty"`
	Notes     *string      `json:"notes"`
}

// VersionListItem is a catalog row.
type VersionListItem struct {
	BundleManifest
	Builtin     bool  `json:"builtin"`
	Latest      bool  `json:"latest"`
	BundleBytes int64 `json:"bundleBytes"`
}

// VersionCatalog is a plugin's version catalog.
type VersionCatalog struct {
	PluginID       string            `json:"pluginId"`
	Versions       []VersionListItem `json:"versions"`
	BuiltinVersion *string           `json:"builtinVersion"`
	LatestVersion  *string           `json:"latestVersion"`
}

// Sha256Hex is the hex SHA-256 of b.
func Sha256Hex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// IsUploadableVersion: a real semver, not a reserved builtin-*.
func IsUploadableVersion(v string) bool {
	return semverRe.MatchString(v) && !strings.HasPrefix(v, "builtin")
}

var semverHead = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(-.+)?`)

func semverCompare(a, b string) int {
	parse := func(v string) [4]float64 {
		m := semverHead.FindStringSubmatch(v)
		if m == nil {
			return [4]float64{0, 0, 0, 1}
		}
		var out [4]float64
		for i := 0; i < 3; i++ {
			out[i], _ = strconv.ParseFloat(m[i+1], 64)
		}
		if m[4] == "" {
			out[3] = 1
		}
		return out
	}
	pa, pb := parse(a), parse(b)
	for i := 0; i < 4; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return localeCompare(a, b)
}

// Appstore is AppstoreService.
type Appstore struct {
	dataDir     string
	registry    *Registry
	logs        LogWriter
	paths       Paths
	env         func(string) string
	coreVersion func() string
	now         func() time.Time
}

// NewAppstore builds the store.
func NewAppstore(dataDir string, reg *Registry, logs LogWriter, paths Paths, env func(string) string, coreVersion func() string) *Appstore {
	if logs == nil {
		logs = nopLogs{}
	}
	return &Appstore{dataDir: dataDir, registry: reg, logs: logs, paths: paths, env: env, coreVersion: coreVersion, now: time.Now}
}

func (a *Appstore) storeRoot() string              { return filepath.Join(a.dataDir, "appstore") }
func (a *Appstore) versionDir(id, v string) string { return filepath.Join(a.storeRoot(), id, v) }
func (a *Appstore) bundlePath(id, v string) string {
	return filepath.Join(a.versionDir(id, v), bundleFile)
}
func (a *Appstore) manifestPath(id, v string) string {
	return filepath.Join(a.versionDir(id, v), manifestFile)
}

// BuiltinVersionID is builtin-<coreVersion>.
func (a *Appstore) BuiltinVersionID() string { return "builtin-" + a.coreVersion() }

// Boot materializes built-ins (onApplicationBootstrap). Never fails.
func (a *Appstore) Boot() {
	made := a.MaterializeBuiltins()
	a.logs.Write("info", "appstore", fmt.Sprintf("builtin bundles materialized: %d; store size %.0f KiB", made, float64(a.storeSizeBytes())/1024), struct{}{}, nil)
}

// MaterializeBuiltins writes builtin-<core> for every exportable worker app
// that lacks one. Returns how many were built.
func (a *Appstore) MaterializeBuiltins() int {
	version, made := a.BuiltinVersionID(), 0
	for _, man := range a.registry.ListManifests() {
		if !man.NeedsWorker || !man.Exportable {
			continue
		}
		meta := a.registry.GetMeta(man.ID)
		if meta == nil || meta.ExportDir == nil || *meta.ExportDir == "" || meta.Worker == nil || meta.Worker.Spawn == nil {
			continue
		}
		if fileExists(a.manifestPath(meta.ID, version)) {
			continue
		}
		src := ResolveWorkerDir(*meta.ExportDir, meta.ID, a.paths, a.env)
		if src == "" {
			continue
		}
		entries, err := ComposeBundle(meta, meta.ID, src, a.paths, a.env)
		if err != nil {
			continue
		}
		gz, err := PackTarGz(entries)
		if err != nil {
			continue
		}
		var bytes int64
		for _, e := range entries {
			bytes += int64(len(e.Body))
		}
		if _, err := a.writeVersion(meta.ID, version, gz, "builtin", nil, &BundleFiles{int64(len(entries)), bytes}); err == nil {
			made++
		}
	}
	return made
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func (a *Appstore) writeVersion(id, version string, gz []byte, source string, notes *string, files *BundleFiles) (*BundleManifest, error) {
	if err := os.MkdirAll(a.versionDir(id, version), 0o777); err != nil {
		return nil, err
	}
	if err := os.WriteFile(a.bundlePath(id, version), gz, 0o644); err != nil {
		return nil, err
	}
	m := &BundleManifest{PluginID: id, Version: version, Sha256: Sha256Hex(gz), Source: source,
		CreatedAt: jsx.ISO(a.now()), Files: files, Notes: notes}
	if err := os.WriteFile(a.manifestPath(id, version), []byte(jsonIndent(m)), 0o644); err != nil {
		return nil, err
	}
	return m, nil
}

// ReadManifest reads one version's manifest (nil when absent/unreadable).
func (a *Appstore) ReadManifest(id, version string) *BundleManifest {
	b, err := os.ReadFile(a.manifestPath(id, version))
	if err != nil {
		return nil
	}
	var m BundleManifest
	if jsonUnmarshal(b, &m) != nil {
		return nil
	}
	return &m
}

// HasVersion reports whether a version exists.
func (a *Appstore) HasVersion(id, version string) bool {
	return fileExists(a.manifestPath(id, version))
}

// ListVersions is a plugin's catalog: builtin first, then uploads newest first.
func (a *Appstore) ListVersions(id string) VersionCatalog {
	builtin := a.BuiltinVersionID()
	var manifests []*BundleManifest
	if entries, err := os.ReadDir(filepath.Join(a.storeRoot(), id)); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				if m := a.ReadManifest(id, e.Name()); m != nil {
					manifests = append(manifests, m)
				}
			}
		}
	}
	var uploaded []string
	hasBuiltin := false
	for _, m := range manifests {
		if m.Source == "uploaded" {
			uploaded = append(uploaded, m.Version)
		}
		hasBuiltin = hasBuiltin || m.Version == builtin
	}
	sort.SliceStable(uploaded, func(i, j int) bool { return semverCompare(uploaded[i], uploaded[j]) < 0 })
	var latest *string
	switch {
	case len(uploaded) > 0:
		latest = &uploaded[len(uploaded)-1]
	case hasBuiltin:
		latest = &builtin
	}
	versions := make([]VersionListItem, 0, len(manifests))
	for _, m := range manifests {
		versions = append(versions, VersionListItem{BundleManifest: *m, Builtin: m.Version == builtin,
			Latest: latest != nil && m.Version == *latest, BundleBytes: fileSize(a.bundlePath(id, m.Version))})
	}
	sort.SliceStable(versions, func(i, j int) bool {
		if versions[i].Builtin != versions[j].Builtin {
			return versions[i].Builtin
		}
		return semverCompare(versions[i].Version, versions[j].Version) > 0
	})
	cat := VersionCatalog{PluginID: id, Versions: versions, LatestVersion: latest}
	if hasBuiltin {
		cat.BuiltinVersion = &builtin
	}
	return cat
}

func fileSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}

// ReadBundle returns a stored bundle (404 when unknown).
func (a *Appstore) ReadBundle(id, version string) ([]byte, string, string, error) {
	m := a.ReadManifest(id, version)
	if m == nil {
		return nil, "", "", httpx.NotFound(fmt.Sprintf("no bundle for '%s' version '%s'", id, version))
	}
	body, err := os.ReadFile(a.bundlePath(id, version))
	if err != nil {
		return nil, "", "", err
	}
	return body, m.Sha256, "streamhub-app-" + id + "-" + version + ".tar.gz", nil
}

func (a *Appstore) requireVersionableMeta(id string) (*Meta, error) {
	meta := a.registry.GetMeta(id)
	if meta == nil {
		return nil, httpx.NotFound(fmt.Sprintf("plugin '%s' not found", id))
	}
	if !meta.NeedsWorker || meta.Worker == nil || meta.ExportDir == nil || *meta.ExportDir == "" {
		return nil, httpx.BadRequest(fmt.Sprintf("plugin '%s' is not versionable (no exportable worker)", id))
	}
	return meta, nil
}

type versionMeta struct {
	Version string `json:"version"`
}

// SaveUploaded stores an operator upload as a new immutable version.
func (a *Appstore) SaveUploaded(id, version string, gz []byte, notes *string) (*BundleManifest, error) {
	meta, err := a.requireVersionableMeta(id)
	if err != nil {
		return nil, err
	}
	if !IsUploadableVersion(version) {
		return nil, httpx.BadRequest(fmt.Sprintf("invalid version '%s' — expected a semver (e.g. 2.9.0); 'builtin-*' is reserved", version))
	}
	if a.HasVersion(id, version) {
		return nil, httpx.Conflict(fmt.Sprintf("version '%s' of '%s' already exists (immutable — bump the semver)", version, id))
	}
	if len(gz) == 0 {
		return nil, httpx.BadRequest("empty bundle upload")
	}
	if len(gz) < 2 || gz[0] != 0x1f || gz[1] != 0x8b {
		return nil, httpx.BadRequest("bundle is not a gzip archive")
	}
	paths := ListTarGzPaths(gz)
	if len(paths) == 0 {
		return nil, httpx.BadRequest("bundle is not a valid tar.gz archive")
	}
	if err := a.assertWorkerEntrypoint(meta, id, paths); err != nil {
		return nil, err
	}
	m, err := a.writeVersion(id, version, gz, "uploaded", notes, &BundleFiles{int64(len(paths)), int64(len(gz))})
	if err != nil {
		return nil, err
	}
	a.logs.Write("info", "plugin:"+id, fmt.Sprintf("appstore: uploaded version '%s' (%d bytes, sha256 %s…)", version, len(gz), m.Sha256[:12]), versionMeta{version}, nil)
	return m, nil
}

func (a *Appstore) assertWorkerEntrypoint(meta *Meta, id string, paths []string) error {
	prefix := id + "/worker/"
	var workerFiles []string
	for _, p := range paths {
		if strings.HasPrefix(p, prefix) {
			workerFiles = append(workerFiles, p)
		}
	}
	if len(workerFiles) == 0 {
		return httpx.BadRequest(fmt.Sprintf("bundle is missing the '%s' worker directory (expected the streamhub-app export layout)", prefix))
	}
	mod := a.deriveModule(meta, id)
	wanted := []string{prefix + mod + "/__init__.py", prefix + mod + "/__main__.py", prefix + mod + ".py"}
	has := false
	for _, p := range paths {
		for _, w := range wanted {
			has = has || p == w
		}
	}
	if !has {
		return httpx.BadRequest(fmt.Sprintf("bundle is missing the worker entrypoint (expected '%s' or '%s')", wanted[0], wanted[2]))
	}
	return nil
}

func (a *Appstore) deriveModule(meta *Meta, id string) string {
	spec := meta.Worker.Spawn(WorkerContext{App: "validate", Config: DefaultConfig(meta), AppDir: "/data/apps/validate", DataDir: a.dataDir})
	return deriveModule(spec.Args, id)
}

// DeleteVersion removes a stored version (never a built-in).
func (a *Appstore) DeleteVersion(id, version string) error {
	if version == a.BuiltinVersionID() || strings.HasPrefix(version, "builtin") {
		return httpx.BadRequest(fmt.Sprintf("version '%s' is a built-in and cannot be deleted", version))
	}
	if !a.HasVersion(id, version) {
		return httpx.NotFound(fmt.Sprintf("no version '%s' for '%s'", version, id))
	}
	if err := os.RemoveAll(a.versionDir(id, version)); err != nil {
		return err
	}
	a.logs.Write("info", "plugin:"+id, fmt.Sprintf("appstore: deleted version '%s'", version), versionMeta{version}, nil)
	return nil
}

// ResolveExtractedWorkerDir extracts a pinned bundle (sha256-verified) on
// first use and returns <version>/extracted/<id>/worker.
func (a *Appstore) ResolveExtractedWorkerDir(id, version string) (string, error) {
	m := a.ReadManifest(id, version)
	if m == nil {
		return "", httpx.NotFound(fmt.Sprintf("no version '%s' for '%s'", version, id))
	}
	root := filepath.Join(a.versionDir(id, version), extractedDir)
	workerDir := filepath.Join(root, id, "worker")
	if !fileExists(workerDir) {
		gz, err := os.ReadFile(a.bundlePath(id, version))
		if err != nil {
			return "", err
		}
		if digest := Sha256Hex(gz); digest != m.Sha256 {
			return "", httpx.BadRequest(fmt.Sprintf("bundle sha256 mismatch for '%s' '%s' (manifest %s…, actual %s…) — refusing to extract",
				id, version, prefix12(m.Sha256), digest[:12]))
		}
		if _, err := ExtractTarGz(gz, root); err != nil {
			return "", err
		}
	}
	return workerDir, nil
}

func prefix12(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

// VersionSha256 is the recorded sha256 ("" when unknown).
func (a *Appstore) VersionSha256(id, version string) string {
	if m := a.ReadManifest(id, version); m != nil {
		return m.Sha256
	}
	return ""
}

func (a *Appstore) storeSizeBytes() int64 {
	var total int64
	_ = filepath.WalkDir(a.storeRoot(), func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == bundleFile {
			total += fileSize(p)
		}
		return nil
	})
	return total
}

// pinSeam implements Pinner for the worker manager.
type pinSeam struct {
	store *Appstore
	repo  *Repo
}

func (p pinSeam) PinnedWorkerDir(ctx context.Context, app string, meta *Meta) (string, string, error) {
	row, err := p.repo.Get(ctx, app, meta.ID)
	if err != nil || row == nil || row.WorkerVersion == nil || *row.WorkerVersion == "" {
		return "", "", nil
	}
	dir, err := p.store.ResolveExtractedWorkerDir(meta.ID, *row.WorkerVersion)
	if err != nil {
		return *row.WorkerVersion, "", errors.New(errMessage(err))
	}
	return *row.WorkerVersion, dir, nil
}

// WorkerSourceDir is resolveWorkerDir(meta.export.workerDir) (no plugin id).
func (p pinSeam) WorkerSourceDir(meta *Meta) string {
	if meta.ExportDir == nil {
		return ""
	}
	return ResolveWorkerDir(*meta.ExportDir, "", p.store.paths, p.store.env)
}

func errMessage(err error) string { return err.Error() }

// jsonIndent is JSON.stringify(v, null, 2).
func jsonIndent(v any) string {
	s, err := y.Stringify(v)
	if err != nil {
		return ""
	}
	parsed, err := y.ParseJSON([]byte(s))
	if err != nil {
		return s
	}
	return indentJSON(parsed, "")
}

// NewPinSeam wires the appstore + installs as the manager's Pinner.
func NewPinSeam(store *Appstore, repo *Repo) Pinner { return pinSeam{store: store, repo: repo} }
