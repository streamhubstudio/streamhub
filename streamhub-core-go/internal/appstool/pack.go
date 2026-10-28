package appstool

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

var (
	idRE     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	semverRE = regexp.MustCompile(`^\d+\.\d+\.\d+(?:[-+].+)?$`)
)

// Sources are the trees a package is assembled from ("" = absent).
type Sources struct {
	Worker     string // → worker/**   (worker excludes)
	WorkerSdk  string // → worker/<basename>/** appended after the worker tree
	Frontend   string // → frontend/** (frontend excludes: tests dropped)
	Migrations string // → migrations/** (nothing excluded)
}

// Package is a built package.
type Package struct {
	ID, Version string
	Entries     []Entry
	Tar         []byte // uncompressed: what the lock hashes
	Gz          []byte
	Sha256      string // content hash (sha256 of Tar)
}

// BuildPackage assembles streamhub.app.json (the published manifest, `build`
// block dropped, version replaced in place when version != "") followed by
// the source trees, in the order apps-pack.mjs / ci/pack.mjs write them.
func BuildPackage(manifest *y.Map, version string, src Sources) (*Package, error) {
	published := manifest.Clone()
	if version != "" {
		published.Set("version", version)
	}
	published.Delete("build")
	id, _ := published.Get("id").(string)
	ver, _ := published.Get("version").(string)

	entries := []Entry{{Name: "streamhub.app.json", Body: []byte(StringifyIndent(published) + "\n")}}
	add := func(dir, prefix string, excl func(string) bool) error {
		if dir == "" {
			return nil
		}
		es, err := CollectDir(dir, prefix, excl)
		if err != nil {
			return err
		}
		entries = append(entries, es...)
		return nil
	}
	if err := add(src.Worker, "worker", IsWorkerFileExcluded); err != nil {
		return nil, err
	}
	if src.WorkerSdk != "" {
		if err := add(src.WorkerSdk, "worker/"+filepath.Base(src.WorkerSdk), IsWorkerFileExcluded); err != nil {
			return nil, err
		}
	}
	if err := add(src.Frontend, "frontend", IsFrontendFileExcluded); err != nil {
		return nil, err
	}
	if err := add(src.Migrations, "migrations", NoExclude); err != nil {
		return nil, err
	}
	tar, err := PackTar(entries)
	if err != nil {
		return nil, err
	}
	return &Package{ID: id, Version: ver, Entries: entries, Tar: tar, Gz: Gzip(tar), Sha256: Sha256Hex(tar)}, nil
}

// Pack is `apps pack --manifest …`: build a package from explicit sources
// (an app repo's CI — what ci/pack.mjs did). The monorepo's in-tree flow
// (`apps-pack.mjs <id>` + a `build` block) is gone: every app now lives in
// its own repo.
func (t *Tool) Pack(args []string) error { return t.packExplicit(args) }

func (t *Tool) packExplicit(args []string) error {
	const cmd = "apps-pack"
	var manifestPath, version, out string
	var src Sources
	for i := 0; i < len(args); i++ {
		flag := args[i]
		val := ""
		if i+1 < len(args) {
			val = args[i+1]
		}
		var dst *string
		switch flag {
		case "--manifest":
			dst = &manifestPath
		case "--worker":
			dst = &src.Worker
		case "--worker-sdk":
			dst = &src.WorkerSdk
		case "--frontend":
			dst = &src.Frontend
		case "--migrations":
			dst = &src.Migrations
		case "--version":
			dst = &version
		case "--out":
			dst = &out
		default:
			return t.die(cmd, "unknown flag %s (see streamhub-core apps help)", flag)
		}
		if val == "" {
			return t.die(cmd, "%s requires a value", flag)
		}
		*dst = val
		i++
	}
	if manifestPath == "" {
		return t.die(cmd, "usage: streamhub-core apps pack --manifest FILE [--worker DIR] [--worker-sdk DIR] [--frontend DIR] [--migrations DIR] [--version V] [--out DIR]")
	}
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return t.die(cmd, "no manifest at %s", manifestPath)
	}
	manifest, err := ParseJSONObject(raw)
	if err != nil {
		return t.die(cmd, "%s is not valid JSON: %s", manifestPath, err)
	}
	id, _ := manifest.Get("id").(string)
	if !idRE.MatchString(id) {
		return t.die(cmd, "%s: manifest id '%s' is not a valid app id", manifestPath, y.ToString(manifest.Get("id")))
	}
	// The git tag is the version source of truth in CI (ci/pack.mjs).
	if version == "" {
		version = trimV(t.env("CI_COMMIT_TAG"))
	}
	resolved := version
	if resolved == "" {
		resolved, _ = manifest.Get("version").(string)
	}
	if !semverRE.MatchString(resolved) {
		return t.die(cmd, "%s: resolved version '%s' is not semver", id, resolved)
	}
	for _, d := range []string{src.Worker, src.WorkerSdk, src.Frontend, src.Migrations} {
		if d == "" {
			continue
		}
		if st, err := os.Stat(d); err != nil || !st.IsDir() {
			return t.die(cmd, "%s: source dir %s not found", id, d)
		}
	}
	pkg, err := BuildPackage(manifest, version, src)
	if err != nil {
		return t.die(cmd, "%s", err)
	}
	if out == "" {
		out = "dist"
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return t.die(cmd, "%s", err)
	}
	name := fmt.Sprintf("streamhub-app-%s-%s.tar.gz", id, pkg.Version)
	outPath := filepath.Join(out, name)
	if err := os.WriteFile(outPath, pkg.Gz, 0o644); err != nil {
		return t.die(cmd, "%s", err)
	}
	if err := os.WriteFile(outPath+".sha256", []byte(pkg.Sha256+"  "+name+"\n"), 0o644); err != nil {
		return t.die(cmd, "%s", err)
	}
	t.logf("packed %s@%s", id, pkg.Version)
	t.logf("  file:    %s", outPath)
	t.logf("  entries: %d", len(pkg.Entries))
	t.logf("  bytes:   %d", len(pkg.Gz))
	t.logf("  sha256:  %s  (content — the lock pins this)", pkg.Sha256)
	return nil
}
