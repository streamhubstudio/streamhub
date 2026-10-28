//go:build unix

package apps

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
)

// INVARIANT: media dirs follow the umask like Node's mkdirSync (0777 &^ umask).
// deploy/core-entrypoint.sh sets umask 002 so the egress container (uid 1001,
// gid 0) can write MP4s/HLS into dirs the root core creates; a hardcoded 0755
// made egress fail with "permission denied" (e2e on .50, 2026-10-27).
func TestCreateDirsFollowUmask(t *testing.T) {
	old := syscall.Umask(0o002)
	defer syscall.Umask(old)
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "umaskapp"})
	for _, d := range []string{"recordings", "snapshots", "samples"} {
		fi, err := os.Stat(filepath.Join(s.AppDir("umaskapp"), d))
		if err != nil {
			t.Fatal(err)
		}
		if got := fi.Mode().Perm(); got != 0o775 {
			t.Errorf("%s mode = %o, want 775", d, got)
		}
	}
}
