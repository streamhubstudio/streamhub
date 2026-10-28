//go:build linux

package metricshistory

import (
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Linux readers mirror libuv: os.cpus() sums user+nice+sys+idle+irq from
// /proc/stat, os.freemem() is MemAvailable, os.loadavg() is /proc/loadavg.

const clockTickMs = 10 // USER_HZ = 100

func procStatCPUs() (times CPUTimes, cores int) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return CPUTimes{}, 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 7 || !strings.HasPrefix(f[0], "cpu") || f[0] == "cpu" {
			continue
		}
		cores++
		v := func(i int) float64 { n, _ := strconv.ParseFloat(f[i], 64); return n * clockTickMs }
		user, nice, sys, idle, irq := v(1), v(2), v(3), v(4), v(6)
		times.TotalMs += user + nice + sys + idle + irq
		times.IdleMs += idle
	}
	return times, cores
}

func readCPUTimes() CPUTimes {
	t, _ := procStatCPUs()
	return t
}

func readMem() Usage {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return Usage{}
	}
	var total, avail float64
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		n, _ := strconv.ParseFloat(f[1], 64)
		switch f[0] {
		case "MemTotal:":
			total = n * 1024
		case "MemAvailable:":
			avail = n * 1024
		}
	}
	return Usage{UsedBytes: max(0, total-avail), TotalBytes: total}
}

func readLoadPercent() *float64 {
	_, cores := procStatCPUs()
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return nil
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return nil
	}
	load, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return nil
	}
	return loadPercent(load, cores)
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

func readNet() *NetReading {
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return nil
	}
	n := ParseProcNetDev(string(b))
	return &n
}
