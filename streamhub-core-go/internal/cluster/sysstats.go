package cluster

import (
	"runtime"

	"golang.org/x/sys/unix"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// selfStats is the origin's resource snapshot for its registry row, in
// Node's key order: role, cores, loadavg1, cpu, memTotal, memFree,
// memUsedRatio[, disk{total, free, usedRatio}].
func selfStats(dataDir string) *y.Map {
	cores := runtime.NumCPU()
	load1 := loadAvg1()
	total, free := memInfo()
	m := y.NewMap()
	m.Set("role", "origin")
	m.Set("cores", float64(cores))
	m.Set("loadavg1", round(load1, 2))
	cpu := 0.0
	if cores > 0 {
		cpu = round(load1/float64(cores), 3)
	}
	m.Set("cpu", cpu)
	m.Set("memTotal", float64(total))
	m.Set("memFree", float64(free))
	ratio := 0.0
	if total > 0 {
		ratio = round(float64(total-free)/float64(total), 3)
	}
	m.Set("memUsedRatio", ratio)
	var st unix.Statfs_t
	if err := unix.Statfs(dataDir, &st); err == nil {
		dt := float64(st.Blocks) * float64(st.Bsize)
		df := float64(st.Bavail) * float64(st.Bsize)
		if dt > 0 {
			d := y.NewMap()
			d.Set("total", dt)
			d.Set("free", df)
			d.Set("usedRatio", round((dt-df)/dt, 3))
			m.Set("disk", d)
		}
	}
	return m
}
