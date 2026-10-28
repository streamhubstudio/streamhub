// Package system ports modules/system: GPU detection (nvidia-smi / VAAPI),
// the per-app hwaccel resolver, the read-only server-settings reporter and
// the OS-tuning posture (GET/POST /system/gpu, GET /system/settings,
// GET /system/os-tuning).
package system

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// driDir holds the VAAPI/DRM render nodes.
const driDir = "/dev/dri"

// probeTimeout caps any external probe binary.
const probeTimeout = 4 * time.Second

// GpuType is nvidia | vaapi | none.
type GpuType = string

// GpuDevice is one acceleration-capable device.
type GpuDevice struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Index     *int   `json:"index,omitempty"`
	MemoryMiB *int   `json:"memoryMiB,omitempty"`
}

// GpuStatus is a probe result.
type GpuStatus struct {
	Available bool        `json:"available"`
	Type      GpuType     `json:"type"`
	Devices   []GpuDevice `json:"devices"`
	Driver    string      `json:"driver,omitempty"`
	CheckedAt string      `json:"checkedAt"`
	Detail    string      `json:"detail,omitempty"`
}

// Runner runs a probe binary (execFile with a timeout).
type Runner interface {
	Run(ctx context.Context, bin string, args ...string) (string, error)
}

// ExecRunner is the real Runner.
type ExecRunner struct{}

// Run implements Runner (1 MiB output cap like maxBuffer).
func (ExecRunner) Run(ctx context.Context, bin string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).Output()
	if err != nil {
		return "", err
	}
	if len(out) > 1024*1024 {
		return "", errors.New("maxBuffer length exceeded")
	}
	return string(out), nil
}

// DirReader lists a directory (fs.readdirSync).
type DirReader func(dir string) ([]string, error)

// OSDirReader is the real DirReader.
func OSDirReader(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	return names, nil
}

// Logger is LogsServiceContract.write.
type Logger interface {
	Write(level, source, message string, meta any, appID *int64)
}

// GpuMetrics receives the probe result (MetricsService.setGpuAvailable).
type GpuMetrics interface {
	SetGpuAvailable(GpuStatus)
}

// Gpu is GpuService: cached status, coalesced refresh, never fails.
type Gpu struct {
	cfg     *config.Config
	run     Runner
	readDir DirReader
	logs    Logger
	now     func() time.Time

	mu       sync.Mutex
	cached   *GpuStatus
	inflight chan struct{}
	metrics  GpuMetrics
}

// NewGpu builds the detector.
func NewGpu(cfg *config.Config, run Runner, readDir DirReader, logs Logger) *Gpu {
	return &Gpu{cfg: cfg, run: run, readDir: readDir, logs: logs, now: time.Now}
}

// SetMetrics late-binds the metrics sink.
func (g *Gpu) SetMetrics(m GpuMetrics) {
	g.mu.Lock()
	g.metrics = m
	g.mu.Unlock()
}

// Status is the cached status, probing on first use.
func (g *Gpu) Status(ctx context.Context) GpuStatus {
	g.mu.Lock()
	c := g.cached
	g.mu.Unlock()
	if c != nil {
		return *c
	}
	return g.Refresh(ctx)
}

// Cached is the last probe (nil before the first one).
func (g *Gpu) Cached() *GpuStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.cached
}

// Refresh forces a probe; concurrent callers share one.
func (g *Gpu) Refresh(ctx context.Context) GpuStatus {
	g.mu.Lock()
	if wait := g.inflight; wait != nil {
		g.mu.Unlock()
		<-wait
		g.mu.Lock()
		defer g.mu.Unlock()
		return *g.cached
	}
	done := make(chan struct{})
	g.inflight = done
	g.mu.Unlock()

	s := g.probe(context.WithoutCancel(ctx))

	g.mu.Lock()
	g.cached = &s
	g.inflight = nil
	m := g.metrics
	g.mu.Unlock()
	close(done)
	if m != nil {
		func() {
			defer func() { _ = recover() }()
			m.SetGpuAvailable(s)
		}()
	}
	return s
}

func (g *Gpu) probe(ctx context.Context) GpuStatus {
	checkedAt := jsx.ISO(g.now())
	if strings.ToLower(g.cfg.Env("GPU_DISABLE")) == "true" {
		return GpuStatus{Type: "none", Devices: []GpuDevice{}, CheckedAt: checkedAt, Detail: "disabled via GPU_DISABLE=true"}
	}
	if s, ok := g.probeNvidia(ctx, checkedAt); ok {
		return s
	}
	if s, ok := g.probeVaapi(ctx, checkedAt); ok {
		return s
	}
	return GpuStatus{Type: "none", Devices: []GpuDevice{}, CheckedAt: checkedAt,
		Detail: "no NVIDIA (nvidia-smi) and no VAAPI (/dev/dri render node)"}
}

type errMeta struct {
	Error string `json:"error"`
}

func (g *Gpu) probeNvidia(ctx context.Context, checkedAt string) (GpuStatus, bool) {
	out, err := g.run.Run(ctx, "nvidia-smi", "--query-gpu=index,name,memory.total,driver_version", "--format=csv,noheader,nounits")
	if err != nil {
		g.logs.Write("debug", "system", "nvidia-smi probe failed", errMeta{err.Error()}, nil)
		return GpuStatus{}, false
	}
	devices := []GpuDevice{}
	driver := ""
	for _, line := range strings.Split(out, "\n") {
		row := strings.TrimSpace(line)
		if row == "" {
			continue
		}
		cols := strings.Split(row, ",")
		for i := range cols {
			cols[i] = strings.TrimSpace(cols[i])
		}
		col := func(i int) string {
			if i < len(cols) {
				return cols[i]
			}
			return ""
		}
		name := col(1)
		if name == "" {
			continue
		}
		d := GpuDevice{Kind: "nvidia", Name: name}
		if n, ok := config.ParseIntPrefix(col(0)); ok {
			d.Index = &n
		}
		if n, ok := config.ParseIntPrefix(col(2)); ok {
			d.MemoryMiB = &n
		}
		devices = append(devices, d)
		if driver == "" && col(3) != "" {
			driver = col(3)
		}
	}
	if len(devices) == 0 {
		return GpuStatus{}, false
	}
	return GpuStatus{Available: true, Type: "nvidia", Devices: devices, Driver: driver, CheckedAt: checkedAt,
		Detail: fmt.Sprintf("nvidia-smi reported %d GPU(s)", len(devices))}, true
}

var vainfoDriver = regexp.MustCompile(`(?i)Driver version:\s*(.+)`)

func (g *Gpu) probeVaapi(ctx context.Context, checkedAt string) (GpuStatus, bool) {
	names, err := g.readDir(driDir)
	if err != nil {
		g.logs.Write("debug", "system", "vaapi /dev/dri scan failed", errMeta{err.Error()}, nil)
		return GpuStatus{}, false
	}
	var nodes []string
	for _, n := range names {
		if strings.HasPrefix(n, "renderD") {
			nodes = append(nodes, n)
		}
	}
	if len(nodes) == 0 {
		return GpuStatus{}, false
	}
	sort.Strings(nodes)
	devices := make([]GpuDevice, len(nodes))
	for i, n := range nodes {
		devices[i] = GpuDevice{Kind: "vaapi", Name: driDir + "/" + n}
	}
	driver := ""
	if out, err := g.run.Run(ctx, "vainfo", "--display", "drm", "--device", devices[0].Name); err == nil {
		if m := vainfoDriver.FindStringSubmatch(out); m != nil {
			driver = strings.TrimSpace(m[1])
		}
	}
	return GpuStatus{Available: true, Type: "vaapi", Devices: devices, Driver: driver, CheckedAt: checkedAt,
		Detail: fmt.Sprintf("found %d VAAPI render node(s)", len(devices))}, true
}
