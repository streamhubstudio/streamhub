package streamhub

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

var gpuCache struct {
	mu   sync.Mutex
	at   time.Time
	val  float64
	ok   bool
	none bool // nvidia-smi absent: stop trying
}

// gpuUtil returns the max NVIDIA GPU utilisation % (cached 5 s).
func gpuUtil() (float64, bool) {
	gpuCache.mu.Lock()
	defer gpuCache.mu.Unlock()
	if gpuCache.none {
		return 0, false
	}
	if time.Since(gpuCache.at) < 5*time.Second {
		return gpuCache.val, gpuCache.ok
	}
	gpuCache.at = time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits").Output()
	if err != nil {
		if _, lerr := exec.LookPath("nvidia-smi"); lerr != nil {
			gpuCache.none = true
		}
		gpuCache.ok = false
		return 0, false
	}
	max := 0.0
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if v, err := strconv.ParseFloat(strings.TrimSpace(l), 64); err == nil && v > max {
			max = v
		}
	}
	gpuCache.val, gpuCache.ok = max, true
	return max, true
}
