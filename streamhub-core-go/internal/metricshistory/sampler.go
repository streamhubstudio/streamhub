package metricshistory

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Port of host-sampler.util.ts: host CPU / memory / disk / network readers.
// Every reader degrades gracefully (nil / zero) where a source does not
// exist; the number-crunching is pure and tested without touching the host.

// CPUTimes is cumulative CPU time (ms) since boot, summed across cores.
type CPUTimes struct {
	TotalMs float64
	IdleMs  float64
}

// Usage is a used/total byte pair (memory or disk).
type Usage struct {
	UsedBytes  float64
	TotalBytes float64
}

// NetReading is cumulative rx/tx bytes since boot (Linux /proc/net/dev).
type NetReading struct {
	RxBytes float64
	TxBytes float64
}

// HostReading is one raw point-in-time reading.
type HostReading struct {
	CPU         CPUTimes
	Mem         Usage
	Disk        *Usage
	Net         *NetReading
	LoadPercent *float64 // loadavg[0]/cores·100, clamped — the CPU% fallback
}

// HostSample is a finished row, ready to persist.
type HostSample struct {
	CPUPercent     *float64
	MemUsedBytes   float64
	MemTotalBytes  float64
	DiskUsedBytes  *float64
	DiskTotalBytes *float64
	NetRxBytes     *float64
	NetTxBytes     *float64
}

var virtualIface = regexp.MustCompile(`^(veth|docker|br-|virbr|vnet|tap|tun|kube|cni|flannel|cali)`)

// ParseProcNetDev sums rx/tx bytes across real interfaces (skipping lo and
// virtual/bridge/container ones). rx is column 0, tx column 8.
func ParseProcNetDev(text string) NetReading {
	var n NetReading
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		colon := strings.Index(line, ":")
		if colon <= 0 {
			continue
		}
		iface := strings.TrimSpace(line[:colon])
		if iface == "lo" || virtualIface.MatchString(iface) {
			continue
		}
		cols := strings.Fields(line[colon+1:])
		if v, ok := parseIntPrefix(cols, 0); ok {
			n.RxBytes += v
		}
		if v, ok := parseIntPrefix(cols, 8); ok {
			n.TxBytes += v
		}
	}
	return n
}

var intPrefix = regexp.MustCompile(`^[+-]?\d+`)

// parseIntPrefix is Number.parseInt(cols[i], 10) (NaN → false).
func parseIntPrefix(cols []string, i int) (float64, bool) {
	if i >= len(cols) {
		return 0, false
	}
	m := intPrefix.FindString(cols[i])
	if m == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(m, 64)
	return v, err == nil
}

// CPUPercent is the average utilisation between two cumulative readings,
// falling back to the load estimate on the first sample or a counter reset.
func CPUPercent(prev *CPUTimes, cur CPUTimes, loadFallback *float64) *float64 {
	if prev != nil {
		total := cur.TotalMs - prev.TotalMs
		idle := cur.IdleMs - prev.IdleMs
		if total > 0 && idle >= 0 && idle <= total {
			v := clampPct((1 - idle/total) * 100)
			return &v
		}
	}
	return loadFallback
}

// ToSample folds a reading (+ the previous CPU snapshot) into a row.
func ToSample(r HostReading, prev *CPUTimes) HostSample {
	s := HostSample{
		CPUPercent:    CPUPercent(prev, r.CPU, r.LoadPercent),
		MemUsedBytes:  r.Mem.UsedBytes,
		MemTotalBytes: r.Mem.TotalBytes,
	}
	if r.Disk != nil {
		s.DiskUsedBytes, s.DiskTotalBytes = &r.Disk.UsedBytes, &r.Disk.TotalBytes
	}
	if r.Net != nil {
		s.NetRxBytes, s.NetTxBytes = &r.Net.RxBytes, &r.Net.TxBytes
	}
	return s
}

// ReadHost snapshots every source at once (defensive per source).
func ReadHost(dataDir string) HostReading {
	return HostReading{
		CPU:         readCPUTimes(),
		Mem:         readMem(),
		Disk:        readDisk(dataDir),
		Net:         readNet(),
		LoadPercent: readLoadPercent(),
	}
}

// loadPercent is loadavg[0] as a percentage of the core count.
func loadPercent(load float64, cores int) *float64 {
	if cores == 0 || math.IsNaN(load) || math.IsInf(load, 0) {
		return nil
	}
	v := clampPct(load / float64(cores) * 100)
	return &v
}

func clampPct(n float64) float64 {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	return math.Min(100, math.Max(0, jsRound(n*100)/100))
}

// jsRound is Math.round (half up, toward +∞).
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }
