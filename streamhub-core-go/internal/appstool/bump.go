package appstool

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

var bumpSemverRE = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(-.+)?`)

// semverGt is the naive major.minor.patch ordering of apps-bump.mjs (release
// > prerelease; anything unparsable sorts as 0.0.0 release).
func semverGt(a, b string) bool {
	parse := func(v string) [4]int {
		m := bumpSemverRE.FindStringSubmatch(v)
		if m == nil {
			return [4]int{0, 0, 0, 1}
		}
		var p [4]int
		for i := 0; i < 3; i++ {
			p[i], _ = strconv.Atoi(m[i+1])
		}
		if m[4] == "" {
			p[3] = 1
		}
		return p
	}
	pa, pb := parse(a), parse(b)
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

type release struct{ version, assetURL string }

// latestRelease is the newest release tag of a gitlab project and its
// streamhub-app-<id>-<version>.tar.gz asset link (else any .tar.gz link).
func (t *Tool) latestRelease(repoPath, id, token string) (*release, error) {
	const cmd = "apps-bump"
	k, v := authHeader(token)
	u := fmt.Sprintf("%s/api/v4/projects/%s/releases?per_page=1", t.gitlabHost(), projectPath(repoPath))
	body, status, err := t.get(u, map[string]string{k: v})
	if err != nil {
		return nil, t.die(cmd, "%s: gitlab releases query failed (%s)", id, statusText(status, err))
	}
	parsed, err := y.ParseJSON(body)
	if err != nil {
		return nil, t.die(cmd, "%s: gitlab releases response is not JSON", id)
	}
	arr, ok := parsed.([]any)
	if !ok || len(arr) == 0 {
		return nil, nil
	}
	rel, _ := arr[0].(*y.Map)
	if rel == nil {
		return nil, nil
	}
	tag := ""
	if v := rel.Get("tag_name"); v != nil && !y.IsUndefined(v) {
		tag = y.ToString(v)
	}
	version := trimV(tag)
	want := fmt.Sprintf("streamhub-app-%s-%s.tar.gz", id, version)
	var links []*y.Map
	if assets, _ := rel.Get("assets").(*y.Map); assets != nil {
		if ls, _ := assets.Get("links").([]any); ls != nil {
			for _, l := range ls {
				if m, ok := l.(*y.Map); ok {
					links = append(links, m)
				}
			}
		}
	}
	out := &release{version: version}
	for _, l := range links {
		if str(l, "name") == want {
			out.assetURL = str(l, "url")
			return out, nil
		}
	}
	for _, l := range links {
		if strings.HasSuffix(str(l, "url"), ".tar.gz") {
			out.assetURL = str(l, "url")
			return out, nil
		}
	}
	return out, nil
}

// Bump is `apps bump [--write]`: the human-run "use the newest releases"
// command. CI never resolves latest on its own; with --write the new sha256 is
// computed from the DOWNLOADED asset (content hash), so the lock stays a pin.
func (t *Tool) Bump(write bool) error {
	const cmd = "apps-bump"
	lock, err := t.ReadLock()
	if err != nil {
		return t.die(cmd, "%s", err)
	}
	if len(lock) == 0 {
		t.logf("apps-bump: apps.lock.json is empty — nothing to bump")
		return nil
	}
	token := t.env("STREAMHUB_APPS_TOKEN")
	changed := 0
	for _, entry := range lock {
		id, cur := str(entry, "id"), str(entry, "version")
		repo := str(entry, "repo")
		if !strings.HasPrefix(repo, "gitlab:") {
			t.logf("  %s: %s — local/non-gitlab source, skipped", id, cur)
			continue
		}
		if token == "" {
			return t.die(cmd, "STREAMHUB_APPS_TOKEN unset — required to query gitlab releases")
		}
		info, err := t.latestRelease(strings.TrimPrefix(repo, "gitlab:"), id, token)
		if err != nil {
			return err
		}
		if info == nil || info.version == "" {
			t.logf("  %s: %s — no releases found", id, cur)
			continue
		}
		if !semverGt(info.version, cur) {
			t.logf("  %s: %s — up to date", id, cur)
			continue
		}
		mode := "(available)"
		if write {
			mode = "(updating)"
		}
		t.logf("  %s: %s → %s  %s", id, cur, info.version, mode)
		if !write {
			continue
		}
		if info.assetURL == "" {
			return t.die(cmd, "%s: release %s has no tar.gz asset", id, info.version)
		}
		k, v := authHeader(token)
		gz, status, err := t.get(info.assetURL, map[string]string{k: v})
		if err != nil {
			return t.die(cmd, "%s: asset download failed (%s)", id, statusText(status, err))
		}
		tar, err := Gunzip(gz)
		if err != nil {
			return t.die(cmd, "%s: asset is not a valid gzip: %s", id, err)
		}
		entry.Set("version", info.version)
		entry.Set("sha256", Sha256Hex(tar))
		entry.Delete("source") // a remote bump drops any stale file: override
		changed++
	}
	switch {
	case write && changed > 0:
		if err := t.WriteLock(lock); err != nil {
			return t.die(cmd, "%s", err)
		}
		noun := "entries"
		if changed == 1 {
			noun = "entry"
		}
		t.logf("apps-bump: updated %d %s in apps.lock.json", changed, noun)
	case !write:
		t.logf("apps-bump: dry-run (pass --write to apply)")
	}
	return nil
}
