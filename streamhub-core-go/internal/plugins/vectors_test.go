package plugins

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Node-generated vectors (testdata/gen.js, run against the compiled
// streamhub-core): spawn specs of every worker plugin, the catalog, the
// localeCompare order, the export tar bytes and config validation.

type vectorEnv map[string]string

func (e vectorEnv) get(k string) string { return e[k] }

func vendorAbs(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs("testdata/vendor")
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

func vectorRegistry(t *testing.T, env vectorEnv) *Registry {
	t.Helper()
	r := NewRegistry(Paths{VendorRoot: vendorAbs(t)}, env.get, testutil.Log())
	r.Discover()
	return r
}

func TestSpawnVectors(t *testing.T) {
	var vec struct {
		Env   vectorEnv `json:"env"`
		Spawn []struct {
			ID      string      `json:"id"`
			Remote  bool        `json:"remote"`
			Command string      `json:"command"`
			Args    []string    `json:"args"`
			Env     [][2]string `json:"env"`
			Cwd     *string     `json:"cwd"`
		} `json:"spawn"`
	}
	raw, _ := os.ReadFile("testdata/spawn_vectors.json")
	if err := json.Unmarshal(raw, &vec); err != nil {
		t.Fatal(err)
	}
	reg := vectorRegistry(t, vec.Env)
	vendor := vendorAbs(t)
	selfExecutable = func() (string, error) { return "/app/streamhub-core", nil }
	t.Cleanup(func() { selfExecutable = os.Executable })
	norm := func(s string) string { return strings.ReplaceAll(s, vendor, "<VENDOR>") }
	for _, v := range vec.Spawn {
		meta := reg.GetMeta(v.ID)
		if meta == nil || meta.Worker == nil || meta.Worker.Spawn == nil {
			t.Fatalf("%s: no worker", v.ID)
		}
		ctx := WorkerContext{App: "live", Config: DefaultConfig(meta), AppDir: "/data/apps/live", DataDir: "/data",
			LivekitURL: "ws://127.0.0.1:7880", AppTimezone: "Europe/Madrid"}
		if v.Remote {
			u, r := "https://gpu-1.example", "eu"
			ctx.Node = &NodeInfo{ID: "n1", Name: "gpu-1", URL: &u, Region: &r}
			ctx.OriginURL = "https://origin.example"
		}
		got := meta.Worker.Spawn(ctx)
		if v.ID == "stream-health" {
			// Deliberate divergence (internal design notes): Node spawned
			// `node health-worker/src/main.js` in health-worker/; Go spawns
			// its own `health-worker` subcommand in the app dir. The env
			// contract stays locked to the Node vector.
			v.Command, v.Args, v.Cwd = "/app/streamhub-core", []string{"health-worker"}, new(string)
		}
		env := make([][2]string, len(got.Env))
		for i, e := range got.Env {
			env[i] = [2]string{e.Key, norm(e.Value)}
		}
		args := make([]string, len(got.Args))
		for i, a := range got.Args {
			args[i] = norm(a)
		}
		cwd := norm(got.Cwd)
		if norm(got.Command) != v.Command || !reflect.DeepEqual(args, orEmpty(v.Args)) || !reflect.DeepEqual(env, v.Env) || v.Cwd == nil || cwd != *v.Cwd {
			t.Errorf("%s remote=%v:\n go   %q %q %q %q\n node %q %q %q %v", v.ID, v.Remote, got.Command, args, env, cwd, v.Command, v.Args, v.Env, v.Cwd)
		}
	}
}

// update re-baselines testdata/catalog.json from the Go registry — only for a
// deliberate change to builtin/builtins.json (review the diff).
var update = flag.Bool("update", false, "rewrite testdata/catalog.json from the Go registry")

func TestCatalogVector(t *testing.T) {
	reg := vectorRegistry(t, vectorEnv{})
	got, _ := json.Marshal(reg.ListManifests())
	if *update {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf) // JSON.stringify(v, null, 2) shape: no HTML escaping
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(reg.ListManifests()); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile("testdata/catalog.json", bytes.TrimSuffix(buf.Bytes(), []byte("\n")), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, _ := os.ReadFile("testdata/catalog.json")
	var g, w any
	_ = json.Unmarshal(got, &g)
	_ = json.Unmarshal(want, &w)
	if !reflect.DeepEqual(g, w) {
		gl, wl := g.([]any), w.([]any)
		for i := range min(len(gl), len(wl)) {
			if !reflect.DeepEqual(gl[i], wl[i]) {
				a, _ := json.Marshal(gl[i])
				b, _ := json.Marshal(wl[i])
				t.Fatalf("manifest %d differs:\n go   %s\n node %s", i, a, b)
			}
		}
		t.Fatalf("catalog length go=%d node=%d", len(gl), len(wl))
	}
}

func TestCollationVector(t *testing.T) {
	var want []string
	raw, _ := os.ReadFile("testdata/collation.json")
	_ = json.Unmarshal(raw, &want)
	got := append([]string(nil), want...)
	sort.Slice(got, func(i, j int) bool { return got[i] > got[j] }) // scramble
	sort.SliceStable(got, func(i, j int) bool { return localeCompare(got[i], got[j]) < 0 })
	if !reflect.DeepEqual(got, want) {
		t.Errorf("localeCompare order:\n go   %q\n node %q", got, want)
	}
}

func TestExportTarVector(t *testing.T) {
	env := vectorEnv{"FIX_HOST": "h.example", "PLUGIN_PYTHON": "/opt/py/bin/python3", "PUBLIC_BASE_URL": "https://public.example"}
	reg := vectorRegistry(t, env)
	meta := reg.GetMeta("fixapp")
	src := filepath.Join(vendorAbs(t), "fixapp", "worker")
	entries, err := ComposeBundle(meta, "fixapp", src, Paths{VendorRoot: vendorAbs(t)}, env.get)
	if err != nil {
		t.Fatal(err)
	}
	got, err := PackTar(entries)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile("testdata/export_fixapp.tar")
	if !bytes.Equal(got, want) {
		gotE := UnpackTarGz(mustGzip(t, got))
		wantE := UnpackTarGz(mustGzip(t, want))
		for i := range min(len(gotE), len(wantE)) {
			if gotE[i].Name != wantE[i].Name || !bytes.Equal(gotE[i].Body, wantE[i].Body) {
				t.Fatalf("entry %d: go %s\n%s\nnode %s\n%s", i, gotE[i].Name, gotE[i].Body, wantE[i].Name, wantE[i].Body)
			}
		}
		t.Fatalf("tar bytes differ (go %d entries / %d bytes, node %d / %d)", len(gotE), len(got), len(wantE), len(want))
	}
	// Round trip through the gzip writer + reader.
	gz, _ := PackTarGz(entries)
	if back := UnpackTarGz(gz); len(back) != len(entries) || back[0].Name != entries[0].Name {
		t.Error("PackTarGz/UnpackTarGz round trip")
	}
}

func mustGzip(t *testing.T, tar []byte) []byte {
	t.Helper()
	return gzipBytes(tar)
}

func TestConfigVectors(t *testing.T) {
	raw, _ := os.ReadFile("testdata/config_vectors.json")
	parsed, err := y.ParseJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	schema := prop(parsed, "schema").([]any)
	meta := &Meta{ID: "x", ConfigSchema: schema, Fields: parseFields(schema)}
	for _, c := range prop(parsed, "cases").([]any) {
		input, _ := prop(c, "input").(*y.Map)
		req := prop(c, "req") == true
		got, err := ValidateConfig(meta, input, req)
		in, _ := y.Stringify(prop(c, "input"))
		if want, ok := prop(c, "error").(string); ok {
			if err == nil || err.Error() != want {
				t.Errorf("%s req=%v: err %v, want %q", in, req, err, want)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s req=%v: unexpected %v", in, req, err)
			continue
		}
		for _, k := range []struct {
			name string
			got  *y.Map
		}{{"ok", got}, {"redacted", RedactSecrets(meta, got)}, {"public", SanitizePublicConfig(meta, got)}} {
			g, _ := y.Stringify(k.got)
			w, _ := y.Stringify(prop(c, k.name))
			if g != w {
				t.Errorf("%s req=%v %s: go %s node %s", in, req, k.name, g, w)
			}
		}
	}
}
