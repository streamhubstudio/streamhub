package backups

import (
	"os"
	"path/filepath"
	"syscall"
)

// lockDir takes an exclusive advisory flock on <backupDir>/.lock — the
// Redis-free replacement of the BullMQ single-worker guarantee: two
// processes sharing a DATA_DIR never snapshot/restore concurrently. Best
// effort: if the lock file can't be opened the run proceeds unlocked.
func lockDir(dir string) (unlock func()) {
	if err := os.MkdirAll(dir, 0o775); err != nil {
		return func() {}
	}
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return func() {}
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return func() {}
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}
}
