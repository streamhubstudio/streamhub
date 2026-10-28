package cluster

import (
	"encoding/binary"

	"golang.org/x/sys/unix"
)

// loadAvg1 is os.loadavg()[0] (vm.loadavg: 3×uint32, pad, int64 fscale).
func loadAvg1() float64 {
	raw, err := unix.SysctlRaw("vm.loadavg")
	if err != nil || len(raw) < 24 {
		return 0
	}
	ld := binary.LittleEndian.Uint32(raw[0:4])
	scale := binary.LittleEndian.Uint64(raw[16:24])
	if scale == 0 {
		return 0
	}
	return float64(ld) / float64(scale)
}

// memInfo is os.totalmem() / os.freemem() (free pages × page size).
func memInfo() (total, free uint64) {
	total, _ = unix.SysctlUint64("hw.memsize")
	pages, err := unix.SysctlUint32("vm.page_free_count")
	if err != nil {
		return total, 0
	}
	size, err := unix.SysctlUint32("hw.pagesize")
	if err != nil {
		return total, 0
	}
	return total, uint64(pages) * uint64(size)
}
