//go:build darwin

package metricshistory

import "golang.org/x/sys/unix"

// macOS (dev laptops): no /proc. Disk works through statfs and
// memory through sysctl on darwin; CPU times are unknown (cpu_pct falls back
// to null) and network is null, as in Node on macOS.

func readCPUTimes() CPUTimes { return CPUTimes{} }

func readLoadPercent() *float64 { return nil }

func readNet() *NetReading { return nil }

func readMem() Usage {
	total, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return Usage{}
	}
	free, _ := unix.SysctlUint32("vm.page_free_count")
	page := uint64(unix.Getpagesize())
	return Usage{UsedBytes: max(0, float64(total)-float64(uint64(free)*page)), TotalBytes: float64(total)}
}

func readDisk(dir string) *Usage {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return nil
	}
	total := float64(st.Bsize) * float64(st.Blocks)
	free := float64(st.Bsize) * float64(st.Bavail)
	if total <= 0 {
		return nil
	}
	return &Usage{UsedBytes: max(0, total-free), TotalBytes: total}
}
