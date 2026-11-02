//go:build unix

package apps

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// INVARIANT (security 3.3.4): app dirs are no longer 0777 &^ umask (775 in
// prod, listable/readable by every local user). Under the prod umask 002:
// the app root is 751 (egress, gid 0, traverses via group; nginx HLS
// direct-serve traverses as other, no listing), the dirs egress writes into
// (recordings, snapshots) are 770 — group write is load-bearing: a 0755
// made egress fail with "permission denied" (e2e on .50, 2026-10-27) — and
// core-only dirs (samples) are 750.
func TestCreateDirModes(t *testing.T) {
	old := syscall.Umask(0o002)
	defer syscall.Umask(old)
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "umaskapp"})
	root := s.AppDir("umaskapp")
	for d, want := range map[string]os.FileMode{"": 0o751, "recordings": 0o770, "snapshots": 0o770, "samples": 0o750} {
		fi, err := os.Stat(filepath.Join(root, d))
		if err != nil {
			t.Fatal(err)
		}
		if got := fi.Mode().Perm(); got != want {
			t.Errorf("%q mode = %o, want %o", d, got, want)
		}
	}
}
