package buildinfo

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version"
)

func withBuildInfo(t *testing.T, bi *debug.BuildInfo, ok bool) {
	t.Helper()
	prev := readBuildInfo
	readBuildInfo = func() (*debug.BuildInfo, bool) { return bi, ok }
	t.Cleanup(func() { readBuildInfo = prev })
}

func withStamps(t *testing.T, commit, date string) {
	t.Helper()
	pc, pd := version.Commit, version.BuildDate
	version.Commit, version.BuildDate = commit, date
	t.Cleanup(func() { version.Commit, version.BuildDate = pc, pd })
}

func TestCollectPrefersLdflagsOverVCS(t *testing.T) {
	withStamps(t, "abc1234", "2026-10-28T10:00:00Z")
	withBuildInfo(t, &debug.BuildInfo{GoVersion: "go1.26.8", Main: debug.Module{Path: "example/mod"}, Settings: []debug.BuildSetting{
		{Key: "vcs", Value: "git"}, {Key: "vcs.revision", Value: "ffffffff"}, {Key: "vcs.time", Value: "2020-01-01T00:00:00Z"},
		{Key: "vcs.modified", Value: "true"}, {Key: "CGO_ENABLED", Value: "0"}, {Key: "-trimpath", Value: "true"},
		{Key: "GOOS", Value: "linux"}, {Key: "GOARCH", Value: "amd64"},
	}}, true)
	got := Collect()
	if got.Commit != "abc1234" || got.BuildDate != "2026-10-28T10:00:00Z" {
		t.Fatalf("ldflags must win: %+v", got)
	}
	if got.Dirty == nil || !*got.Dirty || got.VCS == nil || got.VCS.Revision != "ffffffff" {
		t.Fatalf("vcs not reported: %+v", got)
	}
	tc := got.Toolchain
	if tc.GoVersion != "go1.26.8" || tc.CGO != "0" || !tc.Trimpath || tc.GOOS != "linux" || tc.GOARCH != "amd64" || tc.Module != "example/mod" {
		t.Fatalf("toolchain: %+v", tc)
	}
}

func TestCollectFallsBackToVCS(t *testing.T) {
	withStamps(t, "", "")
	withBuildInfo(t, &debug.BuildInfo{Settings: []debug.BuildSetting{
		{Key: "vcs.revision", Value: "deadbeef"}, {Key: "vcs.time", Value: "2026-01-02T03:04:05Z"}, {Key: "vcs.modified", Value: "false"},
	}}, true)
	got := Collect()
	if got.Commit != "deadbeef" || got.BuildDate != "2026-01-02T03:04:05Z" || got.Dirty == nil || *got.Dirty {
		t.Fatalf("vcs fallback: %+v", got)
	}
}

func TestCollectWithoutBuildInfo(t *testing.T) {
	withStamps(t, "", "")
	withBuildInfo(t, nil, false)
	got := Collect()
	if got.Commit != "" || got.BuildDate != "" || got.Dirty != nil || got.VCS != nil {
		t.Fatalf("expected empty stamps: %+v", got)
	}
	if got.Toolchain.GoVersion != runtime.Version() || got.Toolchain.GOOS != runtime.GOOS || got.Version == "" {
		t.Fatalf("runtime fallback: %+v", got)
	}
}

func TestLoadChangelogSources(t *testing.T) {
	emb := fstest.MapFS{"changelog/CHANGELOG.md": {Data: []byte("# Changelog\r\n\r\n## 3.1.0\r\n")}}
	if c := loadChangelog(emb, nil); c.Source != "embedded" || c.Markdown != "# Changelog\n\n## 3.1.0\n" {
		t.Fatalf("embedded: %+v", c)
	}

	dir := t.TempDir()
	f := filepath.Join(dir, "CHANGELOG.md")
	if err := os.WriteFile(f, []byte("## 9.9.9\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	placeholderOnly := fstest.MapFS{"changelog/README.md": {Data: []byte("x")}}
	missing := filepath.Join(dir, "nope.md")
	if c := loadChangelog(placeholderOnly, []string{missing, dir, f}); c.Source != "file" || c.Markdown != "## 9.9.9\n" {
		t.Fatalf("file fallback: %+v", c)
	}
	if c := loadChangelog(placeholderOnly, []string{missing}); c.Source != "none" || c.Markdown != "" || c.Version == "" {
		t.Fatalf("none: %+v", c)
	}
}

// The routes are enveloped and registered with the operationIds the docs list.
func TestRoutes(t *testing.T) {
	_, a := humatest.New(t)
	New().Register(a)
	for _, tc := range []struct{ path, want string }{
		{"/api/v1/system/build", `"toolchain":{"goVersion":"`},
		{"/api/v1/system/changelog", `"source":"`},
	} {
		resp := a.Get(tc.path)
		if resp.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", tc.path, resp.Code, resp.Body.String())
		}
		body := resp.Body.String()
		if !strings.Contains(body, `"error":null`) || !strings.Contains(body, tc.want) {
			t.Fatalf("%s body: %s", tc.path, body)
		}
		var env struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil || env.Data["version"] == nil {
			t.Fatalf("%s: not enveloped: %v %s", tc.path, err, body)
		}
	}
}
