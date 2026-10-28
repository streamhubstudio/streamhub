// Package buildinfo serves "About / Build": the running core's version, VCS
// stamp and Go toolchain (GET /system/build) and the embedded product
// changelog (GET /system/changelog). Both are additive 3.x routes with no 2.x
// Node counterpart (internal design notes).
package buildinfo

//go:generate cp ../../../CHANGELOG.md changelog/CHANGELOG.md

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version"
)

//go:embed changelog
var embedded embed.FS

// BuildVCS is the toolchain's own VCS stamp (debug.ReadBuildInfo `vcs.*`). Present
// only when the build saw a .git (not inside the Docker context).
type BuildVCS struct {
	System   string `json:"system,omitempty"`
	Revision string `json:"revision,omitempty"`
	Time     string `json:"time,omitempty"`
	Modified *bool  `json:"modified,omitempty"`
}

// BuildToolchain is how the binary was compiled.
type BuildToolchain struct {
	GoVersion string `json:"goVersion" doc:"Go release that compiled the binary, e.g. go1.26.8"`
	Compiler  string `json:"compiler"`
	GOOS      string `json:"goos"`
	GOARCH    string `json:"goarch"`
	CGO       string `json:"cgo,omitempty" doc:"CGO_ENABLED build setting"`
	Trimpath  bool   `json:"trimpath"`
	Module    string `json:"module,omitempty"`
}

// BuildInfo is the GET /system/build body.
type BuildInfo struct {
	Version   string         `json:"version" doc:"product version (ldflags > VERSION file > dev)"`
	Commit    string         `json:"commit" doc:"git commit: ldflags stamp, else vcs.revision, else empty"`
	BuildDate string         `json:"buildDate" doc:"RFC 3339 UTC: ldflags stamp, else vcs.time, else empty"`
	Dirty     *bool          `json:"dirty" doc:"vcs.modified when the toolchain stamped it, else null"`
	Toolchain BuildToolchain `json:"toolchain"`
	VCS       *BuildVCS      `json:"vcs" doc:"raw debug.ReadBuildInfo vcs.* settings, null when absent"`
}

// readBuildInfo is swapped in tests.
var readBuildInfo = debug.ReadBuildInfo

// Collect assembles BuildInfo from the ldflags stamps, the toolchain's build info
// and the runtime.
func Collect() BuildInfo {
	out := BuildInfo{
		Version:   version.Get(),
		Commit:    version.Commit,
		BuildDate: version.BuildDate,
		Toolchain: BuildToolchain{
			GoVersion: runtime.Version(),
			Compiler:  runtime.Compiler,
			GOOS:      runtime.GOOS,
			GOARCH:    runtime.GOARCH,
		},
	}
	bi, ok := readBuildInfo()
	if !ok || bi == nil {
		return out
	}
	if bi.GoVersion != "" {
		out.Toolchain.GoVersion = bi.GoVersion
	}
	out.Toolchain.Module = bi.Main.Path
	var vcs BuildVCS
	for _, s := range bi.Settings {
		switch s.Key {
		case "CGO_ENABLED":
			out.Toolchain.CGO = s.Value
		case "-trimpath":
			out.Toolchain.Trimpath = s.Value == "true"
		case "GOOS":
			out.Toolchain.GOOS = s.Value
		case "GOARCH":
			out.Toolchain.GOARCH = s.Value
		case "vcs":
			vcs.System = s.Value
		case "vcs.revision":
			vcs.Revision = s.Value
		case "vcs.time":
			vcs.Time = s.Value
		case "vcs.modified":
			m := s.Value == "true"
			vcs.Modified = &m
		}
	}
	if vcs != (BuildVCS{}) {
		out.VCS = &vcs
		if out.Commit == "" {
			out.Commit = vcs.Revision
		}
		if out.BuildDate == "" {
			out.BuildDate = vcs.Time
		}
		out.Dirty = vcs.Modified
	}
	return out
}

// CoreChangelog is the GET /system/changelog body.
type CoreChangelog struct {
	Version  string `json:"version" doc:"running product version, to highlight its section"`
	Source   string `json:"source" enum:"embedded,file,none" doc:"where the markdown came from"`
	Markdown string `json:"markdown" doc:"repo-root CHANGELOG.md, verbatim (newest version first)"`
}

// maxChangelog caps a file read from disk (the embedded copy is trusted).
const maxChangelog = 4 << 20

// LoadChangelog returns the embedded CHANGELOG.md, else one found on disk next
// to VERSION (cwd / binary dir / one level up), else an empty "none".
func LoadChangelog() CoreChangelog {
	return loadChangelog(embedded, changelogCandidates())
}

func loadChangelog(fsys fs.FS, files []string) CoreChangelog {
	out := CoreChangelog{Version: version.Get(), Source: "none"}
	if b, err := fs.ReadFile(fsys, "changelog/CHANGELOG.md"); err == nil && len(b) > 0 {
		out.Source, out.Markdown = "embedded", normalize(b)
		return out
	}
	for _, f := range files {
		st, err := os.Stat(f)
		if err != nil || st.IsDir() || st.Size() == 0 || st.Size() > maxChangelog {
			continue
		}
		if b, err := os.ReadFile(f); err == nil {
			out.Source, out.Markdown = "file", normalize(b)
			return out
		}
	}
	return out
}

func normalize(b []byte) string { return strings.ReplaceAll(string(b), "\r\n", "\n") }

func changelogCandidates() []string {
	var out []string
	if wd, err := os.Getwd(); err == nil {
		out = append(out, filepath.Join(wd, "CHANGELOG.md"), filepath.Join(wd, "..", "CHANGELOG.md"))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		out = append(out, filepath.Join(dir, "CHANGELOG.md"), filepath.Join(dir, "..", "CHANGELOG.md"))
	}
	return out
}
