//go:build darwin

package livekit

import (
	"encoding/binary"

	"golang.org/x/sys/unix"
)

// loadAvg is os.loadavg() (sysctl vm.loadavg: 3 fixpt_t + fscale).
func loadAvg() []float64 {
	out := []float64{0, 0, 0}
	raw, err := unix.SysctlRaw("vm.loadavg")
	if err != nil || len(raw) < 24 {
		return out
	}
	scale := float64(binary.LittleEndian.Uint64(raw[16:24]))
	if scale == 0 {
		return out
	}
	for i := 0; i < 3; i++ {
		out[i] = float64(binary.LittleEndian.Uint32(raw[i*4:])) / scale
	}
	return out
}

// memory is os.totalmem() / os.freemem() (hw.memsize / free pages).
func memory() (total, free int64) {
	t, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0, 0
	}
	pages, _ := unix.SysctlUint32("vm.page_free_count")
	return int64(t), int64(pages) * int64(unix.Getpagesize())
}

func diskStats(dir string) *DiskStats {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return nil
	}
	total := int64(st.Bsize) * int64(st.Blocks)
	free := int64(st.Bsize) * int64(st.Bavail)
	return &DiskStats{total, free, total - free}
}
