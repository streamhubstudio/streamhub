//go:build linux

package livekit

import (
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// loadAvg is os.loadavg() (/proc/loadavg).
func loadAvg() []float64 {
	out := []float64{0, 0, 0}
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return out
	}
	f := strings.Fields(string(b))
	for i := 0; i < 3 && i < len(f); i++ {
		out[i], _ = strconv.ParseFloat(f[i], 64)
	}
	return out
}

// memory is os.totalmem() / os.freemem() (libuv: MemTotal / MemAvailable).
func memory() (total, free int64) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		n, _ := strconv.ParseInt(f[1], 10, 64)
		switch f[0] {
		case "MemTotal:":
			total = n * 1024
		case "MemAvailable:":
			free = n * 1024
		}
	}
	return total, free
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
