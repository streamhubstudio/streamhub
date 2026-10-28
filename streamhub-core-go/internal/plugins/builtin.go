package plugins

import (
	"os"
	"path/filepath"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Filesystem anchors. The binary resolves them from the environment, then
// next to the executable, then — in a repo checkout — from the repo root
// (found by walking up from the executable to the dir holding
// streamhub-core-go/).

// VendorDirEnv overrides where vendored app packages are discovered.
const VendorDirEnv = "STREAMHUB_PLUGINS_VENDOR_DIR"

// Paths are the resolved anchors.
type Paths struct {
	// VendorRoot holds the vendored `<id>/streamhub.app.json` packages.
	VendorRoot string
	// RepoRoot is the repo checkout root ("" when not running from one): the
	// dev fallback for worker sources (Node's repo-root climb).
	RepoRoot string
	// ExeDir is the directory of the running binary.
	ExeDir string
}

// ResolvePaths computes the anchors: VendorRoot = $STREAMHUB_PLUGINS_VENDOR_DIR
// > <exe dir>/plugins-vendor > <repo>/plugins-vendor (where the apps tooling
// composes apps.lock.json in a checkout) — first existing; else the exe-dir
// default.
func ResolvePaths(env func(string) string) Paths {
	exe, _ := os.Executable()
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	p := Paths{ExeDir: filepath.Dir(exe)}
	for dir, i := p.ExeDir, 0; i < 6; dir, i = filepath.Dir(dir), i+1 {
		if st, err := os.Stat(filepath.Join(dir, "streamhub-core-go")); err == nil && st.IsDir() {
			p.RepoRoot = dir
			break
		}
		if dir == filepath.Dir(dir) {
			break
		}
	}
	if v := env(VendorDirEnv); v != "" {
		p.VendorRoot = v
		return p
	}
	candidates := []string{filepath.Join(p.ExeDir, "plugins-vendor")}
	if p.RepoRoot != "" {
		candidates = append(candidates, filepath.Join(p.RepoRoot, "plugins-vendor"))
	}
	p.VendorRoot = candidates[0]
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			p.VendorRoot = c
			break
		}
	}
	return p
}

// builtinSpawn returns the Go reproduction of an in-tree meta's
// `worker.spawn` closure (locked to Node by testdata/spawn_vectors.json).
func (r *Registry) builtinSpawn(key string) func(WorkerContext) WorkerSpec {
	switch key {
	case "stream-health":
		return streamHealthSpawn
	}
	return nil
}

// selfExecutable is the running core binary (a test seam).
var selfExecutable = os.Executable

// healthWorkerCommand is the core binary itself: the stream-health worker is
// its `health-worker` subcommand (internal/healthworker).
func healthWorkerCommand() string {
	if exe, err := selfExecutable(); err == nil {
		return exe
	}
	return "streamhub-core"
}

// streamHealthSpawn is the stream-health `worker.spawn` (builtins.json
// "spawn": "stream-health"; the 2.x plugin.meta.ts closure),
// except for the command: Node ran `node health-worker/src/main.js` (cwd
// health-worker/); Go runs `<core binary> health-worker` (cwd = the app dir).
// The env contract is identical (internal design notes).
func streamHealthSpawn(ctx WorkerContext) WorkerSpec {
	cfg := "{}"
	if ctx.Config != nil {
		cfg, _ = y.Stringify(ctx.Config)
	}
	return WorkerSpec{
		Command: healthWorkerCommand(),
		Args:    []string{"health-worker"},
		Env: []EnvVar{
			{"HEALTH_APP", ctx.App},
			{"HEALTH_HLS_DIR", filepath.Join(ctx.AppDir, "hls")},
			{"HEALTH_DATA_DIR", filepath.Join(ctx.AppDir, "stream-health")},
			{"HEALTH_CONFIG_JSON", cfg},
		},
	}
}
