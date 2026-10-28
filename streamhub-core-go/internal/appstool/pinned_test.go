package appstool

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestPinnedPackagesRebuild is the opt-in byte-identity check against real
// releases: point STREAMHUB_APPS_PINS at a dir of downloaded
// streamhub-app-<id>-<version>.tar.gz files (`apps pull` fetches the same
// ones). Each is (a) re-packed entry-for-entry and (b) extracted and REBUILT
// from its trees with CollectDir (the localeCompare walk) — both must
// reproduce the content sha256 (the tar written by tar.mjs / ci/pack.mjs).
// When STREAMHUB_APPS_LOCK names an apps.lock.json, every pin is also checked
// against its lock sha256. Skipped when unset (no network, no fixtures in git).
func TestPinnedPackagesRebuild(t *testing.T) {
	dir := os.Getenv("STREAMHUB_APPS_PINS")
	if dir == "" {
		t.Skip("STREAMHUB_APPS_PINS unset")
	}
	want := map[string]string{} // file name → lock sha
	if lockPath := os.Getenv("STREAMHUB_APPS_LOCK"); lockPath != "" {
		tool := &Tool{Root: filepath.Dir(lockPath)}
		lock, err := tool.ReadLock()
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range lock {
			want["streamhub-app-"+str(e, "id")+"-"+str(e, "version")+".tar.gz"] = str(e, "sha256")
		}
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.tar.gz"))
	sort.Strings(files)
	if len(files) == 0 {
		t.Fatalf("no *.tar.gz in %s", dir)
	}
	for _, f := range files {
		name := filepath.Base(f)
		t.Run(name, func(t *testing.T) {
			gz, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			tar, err := Gunzip(gz)
			if err != nil {
				t.Fatal(err)
			}
			orig := Sha256Hex(tar)
			if w, ok := want[name]; ok && w != orig {
				t.Errorf("lock %s, release %s", w, orig)
			}
			repacked, err := PackTar(UnpackTar(tar))
			if err != nil {
				t.Fatal(err)
			}
			if got := Sha256Hex(repacked); got != orig {
				t.Errorf("repack: %s, want %s", got, orig)
			}

			tree := t.TempDir()
			if _, err := ExtractTar(tar, tree); err != nil {
				t.Fatal(err)
			}
			manifest, err := ParseJSONObject(mustRead(t, filepath.Join(tree, "streamhub.app.json")))
			if err != nil {
				t.Fatal(err)
			}
			src := Sources{}
			for _, d := range []struct {
				sub string
				dst *string
			}{{"worker", &src.Worker}, {"frontend", &src.Frontend}, {"migrations", &src.Migrations}} {
				if st, err := os.Stat(filepath.Join(tree, d.sub)); err == nil && st.IsDir() {
					*d.dst = filepath.Join(tree, d.sub)
				}
			}
			pkg, err := BuildPackage(manifest, "", src)
			if err != nil {
				t.Fatal(err)
			}
			if pkg.Sha256 != orig {
				t.Errorf("rebuild: %s, want %s", pkg.Sha256, orig)
				got, exp := entryNames(pkg.Entries), entryNames(UnpackTar(tar))
				t.Logf("rebuilt order:\n%s\nrelease order:\n%s", strings.Join(got, "\n"), strings.Join(exp, "\n"))
			}
		})
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func entryNames(es []Entry) []string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.Name
	}
	return out
}
