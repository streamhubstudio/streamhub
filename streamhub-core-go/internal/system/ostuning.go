package system

import (
	"fmt"
	"math"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// UDPBufferMin is the 16 MiB UDP buffer floor install.sh applies.
const UDPBufferMin = 16 * 1024 * 1024

// OsTuningKnob is one knob as reported to the panel.
type OsTuningKnob struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	Source      string  `json:"source"` // sysctl | limits | sys
	Key         string  `json:"key"`
	Current     *string `json:"current"`
	Recommended string  `json:"recommended"`
	Status      string  `json:"status"` // applied | not-applied | unknown
	Why         string  `json:"why"`
	Remedy      string  `json:"remedy"`
	Optional    bool    `json:"optional"`
}

// OsTuningSummary counts knobs per status.
type OsTuningSummary struct {
	Applied    int `json:"applied"`
	NotApplied int `json:"notApplied"`
	Unknown    int `json:"unknown"`
}

// OsTuningReport is GET /system/os-tuning.
type OsTuningReport struct {
	CheckedAt string          `json:"checkedAt"`
	Platform  string          `json:"platform"`
	Supported bool            `json:"supported"`
	Summary   OsTuningSummary `json:"summary"`
	Knobs     []OsTuningKnob  `json:"knobs"`
	Note      string          `json:"note"`
}

type verdict func(raw *string) string

// firstInt is parseInt of the first whitespace token ("unlimited" = +Inf).
func firstInt(raw string) (float64, bool) {
	tok := ""
	if f := strings.Fields(raw); len(f) > 0 {
		tok = strings.ToLower(f[0])
	}
	if tok == "unlimited" {
		return math.Inf(1), true
	}
	return parseIntJS(tok)
}

var intRun = regexp.MustCompile(`^\s*[+-]?\d+`)

// parseIntJS is Number.parseInt(v, 10) as a float64 (no int64 overflow:
// fs.file-max can be 2^63-1 and beyond).
func parseIntJS(v string) (float64, bool) {
	m := intRun.FindString(v)
	if m == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(m), 64)
	return f, err == nil
}

func gte(threshold float64) verdict {
	return func(raw *string) string {
		if raw == nil {
			return "unknown"
		}
		n, ok := firstInt(*raw)
		if !ok {
			return "unknown"
		}
		if n >= threshold {
			return "applied"
		}
		return "not-applied"
	}
}

func lte(threshold float64) verdict {
	return func(raw *string) string {
		if raw == nil {
			return "unknown"
		}
		n, ok := firstInt(*raw)
		if !ok {
			return "unknown"
		}
		if n <= threshold {
			return "applied"
		}
		return "not-applied"
	}
}

// ints parses every whitespace field with parseInt (ok=false on any NaN).
func ints(raw string) ([]int, bool) {
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		fields = []string{""}
	}
	out := make([]int, len(fields))
	for i, f := range fields {
		n, ok := config.ParseIntPrefix(f)
		if !ok {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

func udpMemMaxGte(thresholdPages int) verdict {
	return func(raw *string) string {
		if raw == nil {
			return "unknown"
		}
		parts, ok := ints(*raw)
		if len(parts) < 3 || !ok {
			return "unknown"
		}
		if parts[2] >= thresholdPages {
			return "applied"
		}
		return "not-applied"
	}
}

func portRange(minWidth, minHigh int) verdict {
	return func(raw *string) string {
		if raw == nil {
			return "unknown"
		}
		fields := strings.Fields(*raw)
		if len(fields) < 2 {
			return "unknown"
		}
		lo, ok1 := config.ParseIntPrefix(fields[0])
		hi, ok2 := config.ParseIntPrefix(fields[1])
		if !ok1 || !ok2 {
			return "unknown"
		}
		if hi-lo+1 >= minWidth && hi >= minHigh {
			return "applied"
		}
		return "not-applied"
	}
}

var thpActive = regexp.MustCompile(`\[([a-z]+)\]`)

func thpNotAlways() verdict {
	return func(raw *string) string {
		if raw == nil {
			return "unknown"
		}
		m := thpActive.FindStringSubmatch(strings.TrimSpace(*raw))
		if m == nil {
			return "unknown"
		}
		if m[1] == "always" {
			return "not-applied"
		}
		return "applied"
	}
}

// KnobDef is a catalogue entry.
type KnobDef struct {
	ID, Label, Source, Key, Recommended, Why, Remedy string
	Optional                                         bool
	verdict                                          verdict
}

// Knobs is the catalogue, in display order.
var Knobs = []KnobDef{
	{
		ID: "net.core.rmem_max", Label: "UDP receive buffer max", Source: "sysctl", Key: "net.core.rmem_max",
		Recommended: fmt.Sprintf("≥ %d (16 MiB)", UDPBufferMin),
		Why:         "WebRTC/RTP media arrives over UDP; the ~208 KB default drops packets when several publishers/subscribers saturate the socket. install.sh raises this to 16 MiB.",
		Remedy:      fmt.Sprintf("sysctl -w net.core.rmem_max=%d   # persist in /etc/sysctl.d/99-streamhub-webrtc.conf", UDPBufferMin),
		verdict:     gte(UDPBufferMin),
	},
	{
		ID: "net.core.wmem_max", Label: "UDP send buffer max", Source: "sysctl", Key: "net.core.wmem_max",
		Recommended: fmt.Sprintf("≥ %d (16 MiB)", UDPBufferMin),
		Why:         "Send-side counterpart of rmem_max: a small default throttles outbound RTP to subscribers under load. install.sh raises this to 16 MiB.",
		Remedy:      fmt.Sprintf("sysctl -w net.core.wmem_max=%d   # persist in /etc/sysctl.d/99-streamhub-webrtc.conf", UDPBufferMin),
		verdict:     gte(UDPBufferMin),
	},
	{
		ID: "net.core.somaxconn", Label: "Listen backlog (somaxconn)", Source: "sysctl", Key: "net.core.somaxconn",
		Recommended: "≥ 1024",
		Why:         "Caps the accept() queue for TCP signalling/HLS/API. A low backlog drops connections during viewer surges (joins after a broadcast starts).",
		Remedy:      "sysctl -w net.core.somaxconn=1024",
		verdict:     gte(1024),
	},
	{
		ID: "net.ipv4.udp_mem", Label: "UDP memory ceiling (udp_mem max)", Source: "sysctl", Key: "net.ipv4.udp_mem",
		Recommended: "max ≥ 262144 pages (~1 GiB)",
		Why:         "System-wide UDP memory pressure thresholds (min/pressure/max, in pages). A low max column throttles all UDP once media load grows.",
		Remedy:      `sysctl -w net.ipv4.udp_mem="65536 131072 262144"`,
		verdict:     udpMemMaxGte(262144),
	},
	{
		ID: "net.ipv4.ip_local_port_range", Label: "Ephemeral port range", Source: "sysctl", Key: "net.ipv4.ip_local_port_range",
		Recommended: "1024 65535 (wide range)",
		Why:         "A media server holds many relay/outbound sockets; a narrow ephemeral range exhausts ports and refuses new connections.",
		Remedy:      `sysctl -w net.ipv4.ip_local_port_range="1024 65535"`,
		verdict:     portRange(16384, 60999),
	},
	{
		ID: "fs.file-max", Label: "System-wide file-descriptor cap", Source: "sysctl", Key: "fs.file-max",
		Recommended: "≥ 1000000",
		Why:         "Every socket, HLS segment and recording is a file descriptor. A low system cap makes the kernel refuse new fds server-wide under load.",
		Remedy:      "sysctl -w fs.file-max=1000000",
		verdict:     gte(1_000_000),
	},
	{
		ID: "nofile", Label: "Process open-files limit (ulimit -n)", Source: "limits", Key: "Max open files",
		Recommended: "≥ 65535 (units set LimitNOFILE 200000/500000)",
		Why:         "Per-process fd ceiling for the core/LiveKit. Too low and the process hits EMFILE under many concurrent viewers. deploy/*.service set LimitNOFILE high.",
		Remedy:      "LimitNOFILE=200000 in the systemd unit   # or: ulimit -n 65535",
		verdict:     gte(65535),
	},
	{
		ID: "vm.swappiness", Label: "Swappiness", Source: "sysctl", Key: "vm.swappiness",
		Recommended: "≤ 10",
		Why:         "High swappiness lets the kernel swap out hot media/jitter buffers, spiking latency and stalls. Keep the media path in RAM.",
		Remedy:      "sysctl -w vm.swappiness=10",
		verdict:     lte(10),
	},
	{
		ID: "transparent_hugepage", Label: "Transparent hugepages", Source: "sys", Key: "/sys/kernel/mm/transparent_hugepage/enabled",
		Recommended: "madvise or never (not always)",
		Why:         "THP=always causes latency spikes from background compaction — bad for real-time media. `madvise`/`never` avoids the stalls. Optional.",
		Remedy:      "echo madvise > /sys/kernel/mm/transparent_hugepage/enabled",
		Optional:    true,
		verdict:     thpNotAlways(),
	},
}

// TuningReader reads raw knob values off the host (the test seam).
type TuningReader interface {
	Platform() string
	// Read returns the raw value, or nil when unreadable / absent.
	Read(source, key string) *string
}

// BuildReport is the pure report over a reader (non-Linux → all unknown).
func BuildReport(r TuningReader, now time.Time) OsTuningReport {
	supported := r.Platform() == "linux"
	knobs := make([]OsTuningKnob, 0, len(Knobs))
	var sum OsTuningSummary
	for _, def := range Knobs {
		var raw *string
		status := "unknown"
		if supported {
			raw = normalize(r.Read(def.Source, def.Key))
			status = def.verdict(raw)
		}
		switch status {
		case "applied":
			sum.Applied++
		case "not-applied":
			sum.NotApplied++
		default:
			sum.Unknown++
		}
		knobs = append(knobs, OsTuningKnob{
			ID: def.ID, Label: def.Label, Source: def.Source, Key: def.Key, Current: raw,
			Recommended: def.Recommended, Status: status, Why: def.Why, Remedy: def.Remedy, Optional: def.Optional,
		})
	}
	note := "Non-Linux host: /proc tuning is not inspectable here. These knobs apply on the production Linux host, where install.sh sets them."
	if supported {
		note = "install.sh applies the network/fd tunings on a real host (sysctl + systemd LimitNOFILE). Values shown are live; this endpoint never writes."
	}
	return OsTuningReport{CheckedAt: jsx.ISO(now), Platform: r.Platform(), Supported: supported, Summary: sum, Knobs: knobs, Note: note}
}

func normalize(raw *string) *string {
	if raw == nil {
		return nil
	}
	t := strings.TrimSpace(*raw)
	if t == "" {
		return nil
	}
	return &t
}

// SysctlPath maps a dotted key to its /proc/sys file.
func SysctlPath(key string) string { return "/proc/sys/" + strings.ReplaceAll(key, ".", "/") }

// ProcReader is the real fs-backed reader (fresh per report so
// /proc/self/limits reflects the live process).
type ProcReader struct {
	limits     *string
	limitsRead bool
}

// Platform is process.platform.
func (p *ProcReader) Platform() string { return runtime.GOOS }

// Read implements TuningReader.
func (p *ProcReader) Read(source, key string) *string {
	switch source {
	case "limits":
		return p.limitsRow(key)
	case "sys":
		return readFile(key)
	}
	return readFile(SysctlPath(key))
}

func (p *ProcReader) limitsRow(row string) *string {
	if !p.limitsRead {
		p.limits, p.limitsRead = readFile("/proc/self/limits"), true
	}
	if p.limits == nil || *p.limits == "" {
		return nil
	}
	for _, line := range strings.Split(*p.limits, "\n") {
		if strings.HasPrefix(line, row) {
			rest := strings.Fields(line[len(row):])
			if len(rest) == 0 {
				empty := ""
				return &empty
			}
			return &rest[0]
		}
	}
	return nil
}

func readFile(path string) *string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	s := string(b)
	return &s
}

// OsTuning is OsTuningService.
type OsTuning struct{ now func() time.Time }

// Report is the live report (never fails).
func (o OsTuning) Report() OsTuningReport {
	now := time.Now
	if o.now != nil {
		now = o.now
	}
	return BuildReport(&ProcReader{}, now())
}
