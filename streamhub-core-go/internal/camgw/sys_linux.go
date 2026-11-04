package camgw

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// memAvailableKB is MemAvailable from /proc/meminfo (-1 unknown).
func memAvailableKB() int64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return -1
	}
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "MemAvailable:") {
			f := strings.Fields(l)
			if len(f) >= 2 {
				n, _ := strconv.ParseInt(f[1], 10, 64)
				return n
			}
		}
	}
	return -1
}

func load1() float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	f, _ := strconv.ParseFloat(strings.Fields(string(b))[0], 64)
	return f
}

// diskKB is (total, free) of the filesystem holding path.
func diskKB(path string) (total, free int64, ok bool) {
	var s syscall.Statfs_t
	if err := syscall.Statfs(path, &s); err != nil {
		return 0, 0, false
	}
	bs := int64(s.Bsize)
	return int64(s.Blocks) * bs / 1024, int64(s.Bavail) * bs / 1024, true
}
