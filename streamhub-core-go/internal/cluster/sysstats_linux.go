package cluster

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// loadAvg1 is os.loadavg()[0].
func loadAvg1() float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	f, _ := strconv.ParseFloat(strings.Fields(string(b) + " 0")[0], 64)
	return f
}

// memInfo is os.totalmem() / os.freemem() (libuv reads MemAvailable).
func memInfo() (total, free uint64) {
	fh, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer fh.Close()
	sc := bufio.NewScanner(fh)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 {
			continue
		}
		kb, _ := strconv.ParseUint(f[1], 10, 64)
		switch f[0] {
		case "MemTotal:":
			total = kb * 1024
		case "MemAvailable:":
			free = kb * 1024
		}
	}
	return total, free
}
