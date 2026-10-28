package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Ports of appstore.service.spec, plugin-version.service.spec,
// tar.util.spec, spawn-redirect.util.spec and plugin-export.service.spec.

// fixStack is a stack whose registry holds the testdata/vendor/fixapp
// fixture (an exportable worker app) and an appstore over its DATA_DIR.
func fixStack(t *testing.T) (*stack, *Appstore, *Versions) {
	t.Helper()
	st := newStack(t)
	vendor := vendorAbs(t)
	env := func(k string) string { return "" }
	reg := NewRegistry(Paths{VendorRoot: vendor}, env, testutil.Log())
	reg.Discover()
	st.reg.Register(reg.GetMeta("fixapp"))
	st.reg.Register(reg.GetMeta("watermark"))
	store := NewAppstore(st.dir, st.reg, st.logs, Paths{VendorRoot: vendor}, env, func() string { return "9.9.9" })
	st.workers.SetPinner(NewPinSeam(store, st.repo))
	return st, store, NewVersions(st.svc, store, NewHistory(st.store))
}

func bundleFor(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var entries []TarEntry
	for name, body := range files {
		entries = append(entries, TarEntry{Name: name, Body: []byte(body)})
	}
	gz, err := PackTarGz(entries)
	if err != nil {
		t.Fatal(err)
	}
	return gz
}

func TestAppstoreStore(t *testing.T) {
	st, store, _ := fixStack(t)
	if n := store.MaterializeBuiltins(); n != 1 {
		t.Fatalf("materialized %d", n)
	}
	if store.MaterializeBuiltins() != 0 {
		t.Error("idempotent")
	}
	cat := store.ListVersions("fixapp")
	if len(cat.Versions) != 1 || !cat.Versions[0].Builtin || !cat.Versions[0].Latest || *cat.BuiltinVersion != "builtin-9.9.9" ||
		cat.Versions[0].Source != "builtin" || cat.Versions[0].BundleBytes == 0 || cat.Versions[0].Files.Count != 14 {
		t.Fatalf("catalog = %+v", cat)
	}

	good := bundleFor(t, map[string]string{"fixapp/worker/fix_worker/__init__.py": "", "fixapp/README.md": "r"})
	m, err := store.SaveUploaded("fixapp", "2.0.0", good, nil)
	if err != nil || m.Sha256 != Sha256Hex(good) || m.Source != "uploaded" || m.Files.Count != 2 {
		t.Fatalf("upload = %+v, %v", m, err)
	}
	_, err = store.SaveUploaded("fixapp", "2.0.0", good, nil)
	want(t, err, 409, "version '2.0.0' of 'fixapp' already exists (immutable — bump the semver)")
	_, err = store.SaveUploaded("fixapp", "builtin-1", good, nil)
	want(t, err, 400, "")
	_, err = store.SaveUploaded("fixapp", "2.1.0", []byte("plain"), nil)
	want(t, err, 400, "bundle is not a gzip archive")
	_, err = store.SaveUploaded("fixapp", "2.1.0", bundleFor(t, map[string]string{"other/x": "1"}), nil)
	want(t, err, 400, "bundle is missing the 'fixapp/worker/' worker directory (expected the streamhub-app export layout)")
	_, err = store.SaveUploaded("fixapp", "2.1.0", bundleFor(t, map[string]string{"fixapp/worker/x.py": "1"}), nil)
	want(t, err, 400, "bundle is missing the worker entrypoint (expected 'fixapp/worker/fix_worker/__init__.py' or 'fixapp/worker/fix_worker.py')")
	_, err = store.SaveUploaded("watermark", "1.0.0", good, nil)
	want(t, err, 400, "plugin 'watermark' is not versionable (no exportable worker)")
	notes := "rc"
	_, _ = store.SaveUploaded("fixapp", "2.0.0-rc.1", bundleFor(t, map[string]string{"fixapp/worker/fix_worker.py": ""}), &notes)

	cat = store.ListVersions("fixapp")
	var order []string
	for _, v := range cat.Versions {
		order = append(order, v.Version)
	}
	if strings.Join(order, ",") != "builtin-9.9.9,2.0.0,2.0.0-rc.1" || *cat.LatestVersion != "2.0.0" {
		t.Errorf("order = %v latest = %v", order, *cat.LatestVersion)
	}

	dir, err := store.ResolveExtractedWorkerDir("fixapp", "2.0.0")
	if err != nil || !fileExists(filepath.Join(dir, "fix_worker", "__init__.py")) {
		t.Fatalf("extract = %s, %v", dir, err)
	}
	// Tampered bundle refuses to extract.
	_ = os.WriteFile(store.bundlePath("fixapp", "2.0.0-rc.1"), good, 0o644)
	_, err = store.ResolveExtractedWorkerDir("fixapp", "2.0.0-rc.1")
	if status(err) != 400 || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Errorf("tamper = %v", err)
	}

	want(t, store.DeleteVersion("fixapp", "builtin-9.9.9"), 400, "version 'builtin-9.9.9' is a built-in and cannot be deleted")
	want(t, store.DeleteVersion("fixapp", "7.7.7"), 404, "no version '7.7.7' for 'fixapp'")
	if err := store.DeleteVersion("fixapp", "2.0.0-rc.1"); err != nil || store.HasVersion("fixapp", "2.0.0-rc.1") {
		t.Error("delete")
	}
	if _, _, _, err := store.ReadBundle("fixapp", "nope"); status(err) != 404 {
		t.Error("read missing bundle")
	}
	_ = st
}

func TestPinRollbackAndSpawnRedirect(t *testing.T) {
	st, store, versions := fixStack(t)
	store.MaterializeBuiltins()
	gz := bundleFor(t, map[string]string{"fixapp/worker/fix_worker/__init__.py": ""})
	_, _ = store.SaveUploaded("fixapp", "3.0.0", gz, nil)

	_, err := versions.Pin(bg, "live", "fixapp", ptrStr("3.0.0"))
	want(t, err, 400, "plugin 'fixapp' is not installed in app 'live'")
	_ = st.repo.Install(bg, "live", "fixapp", DefaultConfig(st.reg.GetMeta("fixapp")), false)
	_, err = versions.Rollback(bg, "live", "fixapp")
	want(t, err, 400, "no version history for 'fixapp' in app 'live' — nothing to roll back to")
	_, err = versions.Pin(bg, "live", "fixapp", ptrStr("4.0.0"))
	want(t, err, 404, "version '4.0.0' of 'fixapp' is not in the appstore")

	v, err := versions.Pin(bg, "live", "fixapp", ptrStr("3.0.0"))
	if err != nil || *v.Active != "3.0.0" || *v.Effective != "3.0.0" || len(v.History) != 1 {
		t.Fatalf("pin = %+v, %v", v, err)
	}
	if v, _ = versions.Pin(bg, "live", "fixapp", ptrStr("3.0.0")); len(v.History) != 1 {
		t.Error("re-pinning the active version is a no-op")
	}
	eventually(t, "version event", func() bool { return strings.Contains(strings.Join(st.dispatch.list(), ","), "plugin.version_changed") })

	err = versions.DeleteVersion(bg, "fixapp", "3.0.0")
	want(t, err, 409, "version '3.0.0' of 'fixapp' is pinned by 1 app(s) (live) — unpin first")

	// A pinned LOCAL spawn runs from the extracted bundle.
	meta := st.reg.GetMeta("fixapp")
	e := &workerEntry{}
	spec := st.workers.applyPin(bg, meta.Worker.Spawn(WorkerContext{App: "live", Config: DefaultConfig(meta)}), meta, "live", e, nil)
	extracted := filepath.Join(st.dir, "appstore", "fixapp", "3.0.0", "extracted", "fixapp", "worker")
	if spec.Cwd != extracted || spec.EnvMap()["PYTHONPATH"] != extracted {
		t.Errorf("pinned spec = %+v", spec)
	}

	v, err = versions.Rollback(bg, "live", "fixapp")
	if err != nil || v.Active != nil || *v.Effective != "builtin-9.9.9" || len(v.History) != 2 {
		t.Fatalf("rollback = %+v, %v", v, err)
	}
	v, _ = versions.Rollback(bg, "live", "fixapp")
	if v.Active == nil || *v.Active != "3.0.0" {
		t.Error("rollback is itself reversible")
	}
}

func TestRedirectAndTar(t *testing.T) {
	spec := WorkerSpec{Command: "py", Args: []string{"/src/w/main.py", "/src/wx", "-m"}, Env: []EnvVar{{"P", "/src/w"}, {"Q", "/other"}}}
	out := RedirectWorkerDir(spec, "/src/w", "/pin")
	if out.Args[0] != "/pin/main.py" || out.Args[1] != "/src/wx" || out.Env[0].Value != "/pin" || out.Cwd != "/pin" || spec.Args[0] != "/src/w/main.py" {
		t.Errorf("redirect = %+v", out)
	}
	if RedirectWorkerDir(WorkerSpec{Cwd: "/src/w/sub"}, "/src/w", "/pin").Cwd != "/pin/sub" {
		t.Error("cwd under fromDir is swapped")
	}

	if UnpackTarGz([]byte("garbage")) != nil {
		t.Error("garbage → nil")
	}
	evil := bundleFor(t, map[string]string{"../escape.txt": "x"})
	if _, err := ExtractTarGz(evil, t.TempDir()); err == nil || !strings.Contains(err.Error(), "unsafe path in bundle") {
		t.Errorf("traversal = %v", err)
	}
	long := strings.Repeat("d/", 60) + "f.txt"
	gz := bundleFor(t, map[string]string{long: "ok"})
	if p := ListTarGzPaths(gz); len(p) != 1 || p[0] != long {
		t.Errorf("prefix split round trip = %v", p)
	}
	if _, err := PackTar([]TarEntry{{Name: strings.Repeat("x", 101)}}); err == nil {
		t.Error("an unsplittable path fails loud")
	}
}

func TestExportService(t *testing.T) {
	st, _, _ := fixStack(t)
	ex := NewExporter(st.svc, Paths{VendorRoot: vendorAbs(t)}, func(string) string { return "" })
	_, _, err := ex.Export(bg, "ghost", "fixapp")
	want(t, err, 404, "app 'ghost' not found")
	_, _, err = ex.Export(bg, "live", "watermark")
	want(t, err, 400, "plugin 'watermark' is not exportable")
	_, _, err = ex.Export(bg, "live", "fixapp")
	want(t, err, 400, "plugin 'fixapp' is not installed in app 'live'")
	_ = st.repo.Install(bg, "live", "fixapp", y.NewMap(), false)
	name, body, err := ex.Export(bg, "live", "fixapp")
	if err != nil || name != "streamhub-app-fixapp-1.2.3-rc.1.tar.gz" || len(UnpackTarGz(body)) != 14 {
		t.Fatalf("export = %s %d %v", name, len(body), err)
	}
	if got := st.logs.messages(); !strings.HasPrefix(got[len(got)-1], "exported standalone app bundle from 'live' (streamhub-app-fixapp-1.2.3-rc.1.tar.gz, ") {
		t.Errorf("audit log = %v", got)
	}
	noSrc := NewExporter(st.svc, Paths{VendorRoot: t.TempDir()}, func(string) string { return "" })
	_, _, err = noSrc.Export(bg, "live", "fixapp")
	want(t, err, 503, "worker source for 'fixapp' not found — set STREAMHUB_WORKER_SRC_ROOT or run from a repo checkout")
}
