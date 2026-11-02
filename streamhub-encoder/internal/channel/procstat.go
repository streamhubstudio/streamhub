package channel

import (
	"os"
	"strconv"
	"strings"
)

// ProcStat is a /proc sample of one process.
type ProcStat struct {
	RSSBytes int64   `json:"rssBytes"`
	CPUSecs  float64 `json:"cpuSeconds"` // utime+stime, cumulative
	FDs      int     `json:"fds"`
	Threads  int     `json:"threads"`
}

var clkTck = 100.0 // USER_HZ on every Linux we target

// ReadProcStat samples /proc/<pid> (zero value if unavailable).
func ReadProcStat(pid int) ProcStat {
	var s ProcStat
	if pid <= 0 {
		return s
	}
	p := "/proc/" + strconv.Itoa(pid)
	if b, err := os.ReadFile(p + "/stat"); err == nil {
		str := string(b)
		if i := strings.LastIndexByte(str, ')'); i > 0 && i+2 < len(str) {
			f := strings.Fields(str[i+2:])
			// fields after ')' start at index 3 (state); utime=14, stime=15, threads=20, rss=24 (1-based in man)
			if len(f) > 21 {
				ut, _ := strconv.ParseFloat(f[11], 64)
				st, _ := strconv.ParseFloat(f[12], 64)
				s.CPUSecs = (ut + st) / clkTck
				s.Threads, _ = strconv.Atoi(f[17])
				rss, _ := strconv.ParseInt(f[21], 10, 64)
				s.RSSBytes = rss * int64(os.Getpagesize())
			}
		}
	}
	if ents, err := os.ReadDir(p + "/fd"); err == nil {
		s.FDs = len(ents)
	}
	return s
}

// ReadProcTreeStat sums ReadProcStat over pid and all its descendants: an
// engine fed by ffmpeg runs as sh → (ffmpeg, gst-launch), a WHIP output as
// whip-push → gst helper, and the numbers that matter live in the children.
func ReadProcTreeStat(pid int) ProcStat {
	var sum ProcStat
	seen := map[int]bool{}
	var walk func(int, int)
	walk = func(p, depth int) {
		if p <= 0 || seen[p] || depth > 8 {
			return
		}
		seen[p] = true
		s := ReadProcStat(p)
		sum.RSSBytes += s.RSSBytes
		sum.CPUSecs += s.CPUSecs
		sum.FDs += s.FDs
		sum.Threads += s.Threads
		for _, c := range procChildren(p) {
			walk(c, depth+1)
		}
	}
	walk(pid, 0)
	return sum
}

// procChildren lists the direct children of pid from
// /proc/<pid>/task/<tid>/children (CONFIG_PROC_CHILDREN).
func procChildren(pid int) []int {
	base := "/proc/" + strconv.Itoa(pid) + "/task"
	tasks, err := os.ReadDir(base)
	if err != nil {
		return nil
	}
	var out []int
	for _, t := range tasks {
		b, err := os.ReadFile(base + "/" + t.Name() + "/children")
		if err != nil {
			continue
		}
		for _, f := range strings.Fields(string(b)) {
			if c, err := strconv.Atoi(f); err == nil {
				out = append(out, c)
			}
		}
	}
	return out
}
