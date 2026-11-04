package camgw

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// PruneDisk deletes the oldest finished MP4 segments under dataDir (every
// device) while usage is >= high%, down to low%. Stream-copy recording writes
// ~1 GB/hour per 2 Mbps camera, so a TTL alone cannot keep an SD card alive.
// Files touched in the last 2 minutes (the open segments) are never removed.
func PruneDisk(dataDir string, high, low int, logf func(string, ...any)) int {
	total, free, ok := diskKB(dataDir)
	if !ok || total == 0 || (total-free)*100 < total*int64(high) {
		return 0
	}
	type seg struct {
		path string
		mod  time.Time
		size int64
	}
	var segs []seg
	cut := time.Now().Add(-2 * time.Minute)
	_ = filepath.WalkDir(dataDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".mp4") {
			return nil
		}
		if info, err := d.Info(); err == nil && info.ModTime().Before(cut) {
			segs = append(segs, seg{p, info.ModTime(), info.Size()})
		}
		return nil
	})
	sort.Slice(segs, func(i, j int) bool { return segs[i].mod.Before(segs[j].mod) })
	removed := 0
	for _, s := range segs {
		if (total-free)*100 <= total*int64(low) {
			break
		}
		if os.Remove(s.path) == nil {
			removed++
			free += s.size / 1024
		}
	}
	if removed > 0 {
		logf("disk: removed %d oldest segments (usage now ~%d%%)", removed, (total-free)*100/total)
	}
	return removed
}
