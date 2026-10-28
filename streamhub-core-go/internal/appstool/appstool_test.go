package appstool

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

type treeSpec struct {
	Files []struct {
		Path   string `json:"path"`
		Body   string `json:"body"`
		Repeat []any  `json:"repeat"`
	} `json:"files"`
	Imports []string `json:"imports"`
}

type vectors struct {
	Collect map[string]struct {
		Names  []string `json:"names"`
		Sha256 string   `json:"sha256"`
	} `json:"collect"`
	Imports []struct {
		In  string `json:"in"`
		Out string `json:"out"`
	} `json:"imports"`
}

func loadJSON(t *testing.T, p string, v any) {
	t.Helper()
	if err := json.Unmarshal(mustRead(t, p), v); err != nil {
		t.Fatal(err)
	}
}

// buildTree materializes testdata/tree.json (also what gen-vectors.mjs does).
func buildTree(t *testing.T) string {
	t.Helper()
	var spec treeSpec
	loadJSON(t, "testdata/tree.json", &spec)
	root := t.TempDir()
	for _, f := range spec.Files {
		abs := filepath.Join(root, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		body := []byte(f.Body)
		if f.Repeat != nil {
			body = bytes.Repeat([]byte(f.Repeat[0].(string)), int(f.Repeat[1].(float64)))
		}
		if err := os.WriteFile(abs, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// TestCollectAndPackMatchNode locks CollectDir (localeCompare order, excludes,
// 5 MiB cap) + PackTar (USTAR header, long-name prefix split, padding)
// against the Node tar.mjs/appcompose.mjs output (testdata/gen-vectors.mjs).
func TestCollectAndPackMatchNode(t *testing.T) {
	var vec vectors
	loadJSON(t, "testdata/vectors.json", &vec)
	root := buildTree(t)
	manifest := Entry{Name: "streamhub.app.json", Body: []byte("{\n  \"id\": \"vec\"\n}\n")}
	for k, excl := range map[string]func(string) bool{
		"worker": IsWorkerFileExcluded, "frontend": IsFrontendFileExcluded, "none": nil,
	} {
		want := vec.Collect[k]
		entries, err := CollectDir(root, k, excl)
		if err != nil {
			t.Fatal(err)
		}
		if got := entryNames(entries); strings.Join(got, "\n") != strings.Join(want.Names, "\n") {
			t.Errorf("%s order:\n got %q\nwant %q", k, got, want.Names)
		}
		tarb, err := PackTar(append([]Entry{manifest}, entries...))
		if err != nil {
			t.Fatal(err)
		}
		if got := Sha256Hex(tarb); got != want.Sha256 {
			t.Errorf("%s sha256 %s, want %s", k, got, want.Sha256)
		}
	}
}

func TestRewriteVendorImportsMatchNode(t *testing.T) {
	var vec vectors
	loadJSON(t, "testdata/vectors.json", &vec)
	if len(vec.Imports) == 0 {
		t.Fatal("no import vectors")
	}
	for _, c := range vec.Imports {
		if got := RewriteVendorImports(c.In); got != c.Out {
			t.Errorf("%q → %q, want %q", c.In, got, c.Out)
		}
	}
}

// The writer's output is a valid USTAR archive for a standard reader too.
func TestPackTarReadableByArchiveTar(t *testing.T) {
	long := "worker/" + strings.Repeat("d", 90) + "/" + strings.Repeat("f", 60) + ".py"
	in := []Entry{{Name: "a.txt", Body: []byte("hi")}, {Name: long, Body: bytes.Repeat([]byte("z"), 1024)}, {Name: "empty", Body: nil}}
	b, err := PackTar(in)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(bytes.NewReader(b))
	for i := 0; ; i++ {
		h, err := tr.Next()
		if err == io.EOF {
			if i != len(in) {
				t.Fatalf("read %d entries", i)
			}
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		if h.Name != in[i].Name || !bytes.Equal(body, in[i].Body) || h.Mode != 0o644 || h.ModTime.Unix() != 0 {
			t.Errorf("entry %d: %q mode %o mtime %v", i, h.Name, h.Mode, h.ModTime)
		}
	}
	if got := UnpackTar(b); len(got) != 3 || got[1].Name != long {
		t.Errorf("UnpackTar = %v", entryNames(got))
	}
	if _, err := PackTar([]Entry{{Name: strings.Repeat("x", 101)}}); err == nil || !strings.Contains(err.Error(), "path too long for tar") {
		t.Errorf("unsplittable name: %v", err)
	}
}

func TestExtractRefusesTraversal(t *testing.T) {
	for _, name := range []string{"../evil", "a/../../evil"} {
		b, _ := PackTar([]Entry{{Name: name, Body: []byte("x")}})
		if _, err := ExtractTar(b, t.TempDir()); err == nil || !strings.Contains(err.Error(), "unsafe path in bundle") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// fakeApp is a minimal package: worker + frontend with a ../ import.
func fakeApp(t *testing.T, id, version string) *Package {
	t.Helper()
	src := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(src, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("worker/app_worker/__main__.py", "print('hi')\n")
	write("worker/requirements.txt", "requests\n")
	write("frontend/index.tsx", "import { x } from '../vision-shared/x'\nimport y from '../../lib/y'\n")
	write("frontend/logo.svg", "<svg from '../no'/>")
	m := y.NewMap()
	m.Set("id", id)
	m.Set("version", version)
	w := y.NewMap()
	w.Set("needsWorker", true)
	w.Set("workerDir", "worker")
	m.Set("worker", w)
	pkg, err := BuildPackage(m, "", Sources{Worker: filepath.Join(src, "worker"), Frontend: filepath.Join(src, "frontend")})
	if err != nil {
		t.Fatal(err)
	}
	return pkg
}

func newTool(t *testing.T, root string, env map[string]string, srv *httptest.Server) (*Tool, *bytes.Buffer, *bytes.Buffer) {
	var out, errb bytes.Buffer
	tool := &Tool{Root: root, Env: func(k string) string { return env[k] }, Stdout: &out, Stderr: &errb}
	if srv != nil {
		tool.HTTP = srv.Client()
	}
	return tool, &out, &errb
}

func writeLockFile(t *testing.T, root string, entries ...map[string]string) {
	t.Helper()
	var arr []any
	for _, e := range entries {
		m := y.NewMap()
		for _, k := range []string{"id", "repo", "version", "sha256", "source"} {
			if v, ok := e[k]; ok {
				m.Set(k, v)
			}
		}
		arr = append(arr, m)
	}
	if err := os.WriteFile(filepath.Join(root, "apps.lock.json"), []byte(StringifyIndent(arr)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// gitlabFake serves the generic-package URL and records the auth headers.
func gitlabFake(t *testing.T, pkgs map[string]*Package, seen *[]http.Header) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = append(*seen, r.Header.Clone())
		for _, p := range pkgs {
			want := "/api/v4/projects/grp%2Fstreamhub-app-" + p.ID + "/packages/generic/streamhub-app-" + p.ID + "/" + p.Version + "/streamhub-app-" + p.ID + "-" + p.Version + ".tar.gz"
			if r.URL.EscapedPath() == want {
				_, _ = w.Write(p.Gz)
				return
			}
		}
		t.Logf("fake gitlab: unexpected %s", r.URL.EscapedPath())
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestPullComposesFromGitlab(t *testing.T) {
	for _, tc := range []struct{ token, header string }{
		{"gldt-deploytoken", "Deploy-Token"},
		{"glpat-personal", "Private-Token"},
	} {
		t.Run(tc.header, func(t *testing.T) {
			pkg := fakeApp(t, "demo", "1.2.3")
			var seen []http.Header
			srv := gitlabFake(t, map[string]*Package{"demo": pkg}, &seen)
			root := t.TempDir()
			writeLockFile(t, root, map[string]string{"id": "demo", "repo": "gitlab:grp/streamhub-app-demo", "version": "1.2.3", "sha256": pkg.Sha256})
			tool, out, errb := newTool(t, root, map[string]string{"STREAMHUB_APPS_TOKEN": tc.token, "STREAMHUB_APPS_GITLAB_HOST": srv.URL}, srv)
			if code := tool.Run([]string{"pull"}); code != 0 {
				t.Fatalf("exit %d: %s", code, errb)
			}
			if len(seen) != 1 || seen[0].Get(tc.header) != tc.token {
				t.Fatalf("auth headers %v", seen)
			}
			other := map[string]string{"Deploy-Token": "Private-Token", "Private-Token": "Deploy-Token"}[tc.header]
			if seen[0].Get(other) != "" {
				t.Errorf("both auth headers sent")
			}
			core := filepath.Join(root, "plugins-vendor", "demo")
			if got := string(mustRead(t, filepath.Join(core, "streamhub.app.json"))); got != string(pkg.Entries[0].Body) {
				t.Errorf("vendored manifest:\n%s", got)
			}
			if got := string(mustRead(t, filepath.Join(core, "worker", "app_worker", "__main__.py"))); got != "print('hi')\n" {
				t.Errorf("worker copied: %q", got)
			}
			web := filepath.Join(root, "streamhub-web", "src", "plugins-vendor", "demo")
			if got := string(mustRead(t, filepath.Join(web, "index.tsx"))); got != "import { x } from '../../plugins/vision-shared/x'\nimport y from '../../lib/y'\n" {
				t.Errorf("rewritten imports: %q", got)
			}
			if got := string(mustRead(t, filepath.Join(web, "logo.svg"))); got != "<svg from '../no'/>" {
				t.Errorf("non-script file rewritten: %q", got)
			}
			if _, err := os.Stat(filepath.Join(root, "vendor", "apps", "demo", "frontend", "index.tsx")); err != nil {
				t.Errorf("package not extracted under vendor/apps: %v", err)
			}
			if !strings.Contains(out.String(), "apps-pull:   ✓ demo: backend linked + frontend") {
				t.Errorf("stdout: %s", out)
			}
		})
	}
}

// The lock pins the CONTENT hash: different gzip bytes of the same tar pass,
// a different tar fails closed and composes nothing.
func TestPullContentShaFailsClosed(t *testing.T) {
	pkg := fakeApp(t, "demo", "1.0.0")
	root := t.TempDir()
	regz := Gzip(pkg.Tar) // same tar, re-wrapped
	var buf bytes.Buffer
	zw, _ := newGzipFast(&buf)
	_, _ = zw.Write(pkg.Tar)
	_ = zw.Close()
	if bytes.Equal(buf.Bytes(), regz) {
		t.Fatal("expected different gzip bytes")
	}
	if err := os.WriteFile(filepath.Join(root, "demo.tar.gz"), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	writeLockFile(t, root, map[string]string{"id": "demo", "repo": "local:demo", "version": "1.0.0", "sha256": pkg.Sha256, "source": "file:./demo.tar.gz"})
	tool, _, errb := newTool(t, root, nil, nil)
	if code := tool.Run([]string{"pull"}); code != 0 {
		t.Fatalf("re-gzipped package refused: %s", errb)
	}

	root2 := t.TempDir()
	other := fakeApp(t, "demo", "1.0.1")
	_ = os.WriteFile(filepath.Join(root2, "demo.tar.gz"), other.Gz, 0o644)
	writeLockFile(t, root2, map[string]string{"id": "demo", "repo": "local:demo", "version": "1.0.0", "sha256": pkg.Sha256, "source": "file:./demo.tar.gz"})
	tool, _, errb = newTool(t, root2, nil, nil)
	if code := tool.Run([]string{"pull"}); code != 1 {
		t.Fatalf("mismatch exit %d", code)
	}
	if !strings.Contains(errb.String(), "apps-pull: demo: content sha256 MISMATCH — lock "+pkg.Sha256[:12]+"…, got "+other.Sha256[:12]+"… (refusing)") {
		t.Errorf("stderr: %s", errb)
	}
	if _, err := os.Stat(filepath.Join(root2, "plugins-vendor", "demo")); err == nil {
		t.Error("composed despite mismatch")
	}
}

func TestPullErrors(t *testing.T) {
	root := t.TempDir()
	tool, out, _ := newTool(t, root, nil, nil)
	if code := tool.Run([]string{"pull"}); code != 0 || !strings.Contains(out.String(), "apps.lock.json is empty") {
		t.Errorf("missing lock: %d %s", code, out)
	}
	writeLockFile(t, root, map[string]string{"id": "demo", "repo": "gitlab:grp/x", "version": "1.0.0", "sha256": "ab"})
	tool, _, errb := newTool(t, root, nil, nil)
	if code := tool.Run([]string{"pull"}); code != 1 || !strings.Contains(errb.String(), "STREAMHUB_APPS_TOKEN unset") {
		t.Errorf("no token: %d %s", code, errb)
	}
	writeLockFile(t, root, map[string]string{"id": "demo", "version": "1.0.0"})
	tool, _, errb = newTool(t, root, nil, nil)
	if code := tool.Run([]string{"pull"}); code != 1 || !strings.Contains(errb.String(), "invalid lock entry (needs id, version, sha256)") {
		t.Errorf("bad entry: %d %s", code, errb)
	}
	var seen []http.Header
	srv := gitlabFake(t, nil, &seen)
	writeLockFile(t, root, map[string]string{"id": "demo", "repo": "gitlab:grp/streamhub-app-demo", "version": "1.0.0", "sha256": "ab"})
	tool, _, errb = newTool(t, root, map[string]string{"STREAMHUB_APPS_TOKEN": "t", "STREAMHUB_APPS_GITLAB_HOST": srv.URL}, srv)
	if code := tool.Run([]string{"pull"}); code != 1 || !strings.Contains(errb.String(), "download failed (404)") {
		t.Errorf("404: %d %s", code, errb)
	}
}

func TestBump(t *testing.T) {
	pkg := fakeApp(t, "demo", "1.3.0")
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("PRIVATE-TOKEN") != "glpat-x" {
			http.Error(w, "unauthorized", 401)
			return
		}
		switch r.URL.EscapedPath() {
		case "/api/v4/projects/grp%2Fstreamhub-app-demo/releases":
			_, _ = io.WriteString(w, `[{"tag_name":"v1.3.0","assets":{"links":[{"name":"other.zip","url":"`+srvURL+`/other.zip"},{"name":"streamhub-app-demo-1.3.0.tar.gz","url":"`+srvURL+`/dl/demo.tar.gz"}]}}]`)
		case "/api/v4/projects/grp%2Fstreamhub-app-same/releases":
			_, _ = io.WriteString(w, `[{"tag_name":"v2.0.0","assets":{"links":[]}}]`)
		case "/dl/demo.tar.gz":
			_, _ = w.Write(pkg.Gz)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL
	root := t.TempDir()
	writeLockFile(t, root,
		map[string]string{"id": "demo", "repo": "gitlab:grp/streamhub-app-demo", "version": "1.2.0", "sha256": "old", "source": "file:./stale.tar.gz"},
		map[string]string{"id": "same", "repo": "gitlab:grp/streamhub-app-same", "version": "2.0.0", "sha256": "keep"},
		map[string]string{"id": "loc", "repo": "local:loc", "version": "0.1.0", "sha256": "keep"},
	)
	before := string(mustRead(t, filepath.Join(root, "apps.lock.json")))
	env := map[string]string{"STREAMHUB_APPS_TOKEN": "glpat-x", "STREAMHUB_APPS_GITLAB_HOST": srv.URL}

	tool, out, errb := newTool(t, root, env, srv)
	if code := tool.Run([]string{"bump"}); code != 0 {
		t.Fatalf("dry-run exit %d: %s", code, errb)
	}
	wantDry := "  demo: 1.2.0 → 1.3.0  (available)\n  same: 2.0.0 — up to date\n  loc: 0.1.0 — local/non-gitlab source, skipped\napps-bump: dry-run (pass --write to apply)\n"
	if out.String() != wantDry {
		t.Errorf("dry-run:\n%s", out)
	}
	if string(mustRead(t, filepath.Join(root, "apps.lock.json"))) != before {
		t.Error("dry-run wrote the lock")
	}

	tool, out, errb = newTool(t, root, env, srv)
	if code := tool.Run([]string{"bump", "--write"}); code != 0 {
		t.Fatalf("write exit %d: %s", code, errb)
	}
	if !strings.HasSuffix(out.String(), "apps-bump: updated 1 entry in apps.lock.json\n") {
		t.Errorf("write: %s", out)
	}
	wantLock := `[
  {
    "id": "demo",
    "repo": "gitlab:grp/streamhub-app-demo",
    "version": "1.3.0",
    "sha256": "` + pkg.Sha256 + `"
  },
  {
    "id": "same",
    "repo": "gitlab:grp/streamhub-app-same",
    "version": "2.0.0",
    "sha256": "keep"
  },
  {
    "id": "loc",
    "repo": "local:loc",
    "version": "0.1.0",
    "sha256": "keep"
  }
]
`
	if got := string(mustRead(t, filepath.Join(root, "apps.lock.json"))); got != wantLock {
		t.Errorf("lock:\n%s", got)
	}
}

func TestSemverGt(t *testing.T) {
	for _, c := range []struct {
		a, b string
		gt   bool
	}{
		{"1.2.3", "1.2.2", true}, {"1.10.0", "1.9.9", true}, {"v2.0.0", "1.99.99", true},
		{"1.0.0", "1.0.0-rc.1", true}, {"1.0.0-rc.1", "1.0.0", false}, {"1.0.0", "1.0.0", false},
		{"garbage", "0.0.0", false}, {"0.0.1", "garbage", true},
	} {
		if got := semverGt(c.a, c.b); got != c.gt {
			t.Errorf("semverGt(%s,%s)=%v", c.a, c.b, got)
		}
	}
}

func TestPack(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("m/streamhub.app.json", `{"id":"demo","version":"0.2.0","build":{"workerSrc":"src/w"},"worker":{"needsWorker":true,"workerDir":"worker","n":1.5e3}}`)
	write("src/w/app/__main__.py", "x\n")
	write("src/w/app/__pycache__/m.pyc", "junk")
	write("src/streamhub_sdk/__init__.py", "sdk\n")
	write("src/fe/index.tsx", "fe\n")
	write("src/fe/index.spec.tsx", "test\n")
	write("src/mig/001_init.sql", "sql\n")

	// every source kind, in apps-pack.mjs order; the build block is stripped
	tool, out, errb := newTool(t, root, nil, nil)
	code := tool.Run([]string{"pack", "--manifest", filepath.Join(root, "m/streamhub.app.json"),
		"--worker", filepath.Join(root, "src/w"), "--worker-sdk", filepath.Join(root, "src/streamhub_sdk"),
		"--frontend", filepath.Join(root, "src/fe"), "--migrations", filepath.Join(root, "src/mig"),
		"--out", filepath.Join(root, "dist")})
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	gz := mustRead(t, filepath.Join(root, "dist", "streamhub-app-demo-0.2.0.tar.gz"))
	tarb, _ := Gunzip(gz)
	es := UnpackTar(tarb)
	if got := strings.Join(entryNames(es), ","); got != "streamhub.app.json,worker/app/__main__.py,worker/streamhub_sdk/__init__.py,frontend/index.tsx,migrations/001_init.sql" {
		t.Errorf("entries %s", got)
	}
	wantManifest := "{\n  \"id\": \"demo\",\n  \"version\": \"0.2.0\",\n  \"worker\": {\n    \"needsWorker\": true,\n    \"workerDir\": \"worker\",\n    \"n\": 1500\n  }\n}\n"
	if string(es[0].Body) != wantManifest {
		t.Errorf("published manifest:\n%s", es[0].Body)
	}
	if !strings.Contains(out.String(), "  sha256:  "+Sha256Hex(tarb)+"  (content — the lock pins this)") {
		t.Errorf("stdout:\n%s", out)
	}

	// explicit sources (app-repo CI): CI_COMMIT_TAG wins over the manifest version
	outDir := filepath.Join(root, "out")
	write("repo/apps/demo/streamhub.app.json", `{"id":"demo","version":"0.0.1","worker":{"needsWorker":true}}`)
	tool, _, errb = newTool(t, root, map[string]string{"CI_COMMIT_TAG": "v0.3.0"}, nil)
	code = tool.Run([]string{"pack", "--manifest", filepath.Join(root, "repo/apps/demo/streamhub.app.json"), "--worker", filepath.Join(root, "src/w"), "--frontend", filepath.Join(root, "src/fe"), "--out", outDir})
	if code != 0 {
		t.Fatalf("explicit exit %d: %s", code, errb)
	}
	gz = mustRead(t, filepath.Join(outDir, "streamhub-app-demo-0.3.0.tar.gz"))
	tarb, _ = Gunzip(gz)
	side := string(mustRead(t, filepath.Join(outDir, "streamhub-app-demo-0.3.0.tar.gz.sha256")))
	if side != Sha256Hex(tarb)+"  streamhub-app-demo-0.3.0.tar.gz\n" {
		t.Errorf("sidecar %q", side)
	}
	if es := UnpackTar(tarb); !strings.Contains(string(es[0].Body), `"version": "0.3.0"`) {
		t.Errorf("manifest version not the tag: %s", es[0].Body)
	}

	tool, _, errb = newTool(t, root, map[string]string{"CI_COMMIT_TAG": "nope"}, nil)
	if code := tool.Run([]string{"pack", "--manifest", filepath.Join(root, "repo/apps/demo/streamhub.app.json")}); code != 1 || !strings.Contains(errb.String(), "resolved version 'nope' is not semver") {
		t.Errorf("bad tag: %d %s", code, errb)
	}
	tool, _, errb = newTool(t, root, nil, nil)
	if code := tool.Run([]string{"pack", "nope"}); code != 1 || !strings.Contains(errb.String(), "apps-pack: unknown flag nope") {
		t.Errorf("positional id (in-tree flow removed): %d %s", code, errb)
	}
}

func newGzipFast(w io.Writer) (*gzip.Writer, error) { return gzip.NewWriterLevel(w, gzip.BestSpeed) }

// A vendored id that is also an in-tree built-in is composed but flagged.
func TestPullFlagsShadowedBuiltin(t *testing.T) {
	pkg := fakeApp(t, "cockpit", "9.0.0")
	root := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "c.tar.gz"), pkg.Gz, 0o644)
	writeLockFile(t, root, map[string]string{"id": "cockpit", "repo": "local:cockpit", "version": "9.0.0", "sha256": pkg.Sha256, "source": "file:./c.tar.gz"})
	tool, out, errb := newTool(t, root, nil, nil)
	if code := tool.Run([]string{"pull"}); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if !strings.Contains(out.String(), "✓ cockpit: backend linked + frontend  (shadowed by in-tree app") {
		t.Errorf("stdout: %s", out)
	}
}
