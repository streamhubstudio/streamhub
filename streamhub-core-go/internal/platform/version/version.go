// Package version resolves the product version from the repo-root VERSION
// file (first line, ≤32 chars), like modules/health/app-version.ts.
package version

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Override is set at build time (-ldflags "-X …/version.Override=2.25.0") and
// wins over the VERSION file when non-empty.
var Override string

// Commit and BuildDate are stamped at build time by deploy/Dockerfile and
// deploy/make-core-bundle.sh (-ldflags "-X …/version.Commit=<sha> -X
// …/version.BuildDate=<RFC3339 UTC>"). Empty for a plain `go build`; then
// GET /system/build falls back to the toolchain's own vcs.* stamp
// (debug.ReadBuildInfo), which only exists when the build saw .git — the
// Docker context excludes it, hence the ldflags.
var (
	Commit    string
	BuildDate string
)

var (
	once   sync.Once
	cached string
)

// Get returns the cached product version ("dev" when nothing is found).
func Get() string {
	once.Do(func() { cached = resolve(candidates()) })
	return cached
}

func candidates() []string {
	var out []string
	if wd, err := os.Getwd(); err == nil {
		out = append(out, filepath.Join(wd, "VERSION"), filepath.Join(wd, "..", "VERSION"))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		out = append(out, filepath.Join(dir, "VERSION"), filepath.Join(dir, "..", "VERSION"))
	}
	return out
}

func resolve(files []string) string {
	if Override != "" {
		return Override
	}
	for _, f := range files {
		if v := fromFile(f); v != "" {
			return v
		}
	}
	return "dev"
}

func fromFile(file string) string {
	b, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	line, _, _ := strings.Cut(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	line = strings.TrimSpace(line)
	if line == "" || len(line) > 32 {
		return ""
	}
	return line
}
