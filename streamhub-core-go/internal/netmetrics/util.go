package netmetrics

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// GBBytes is one GiB: the threshold compares with the dashboard's
// 1024-based formatBytes.
const GBBytes = 1024 * 1024 * 1024

// HourBucket is the UTC hour bucket YYYY-MM-DDTHH of an instant.
func HourBucket(at time.Time) string { return at.UTC().Format("2006-01-02T15") }

// WindowStartBucket is the bucket `hours` before now (negative → now), the
// inclusive lower bound of a rolling-window query.
func WindowStartBucket(now time.Time, hours float64) string {
	return HourBucket(now.Add(-time.Duration(math.Max(0, hours) * float64(time.Hour))))
}

// GBToBytes converts a GB/day threshold (0/negative/NaN → 0).
func GBToBytes(gb float64) float64 {
	if math.IsNaN(gb) || math.IsInf(gb, 0) || gb <= 0 {
		return 0
	}
	return gb * GBBytes
}

// ReadThresholdGBDay reads network.threshold_gb_day RAW from the app's
// config.yaml (the block is not part of the typed AppConfig). Any parse/IO
// error, or a non-positive value, is 0 (monitoring off). Never fails.
func ReadThresholdGBDay(appDir string) float64 {
	b, err := os.ReadFile(filepath.Join(appDir, "config.yaml"))
	if err != nil {
		return 0
	}
	parsed, err := yamljs.Load(string(b))
	if err != nil {
		return 0
	}
	root, _ := parsed.(*yamljs.Map)
	network := yamljs.MapAt(root, "network")
	if network == nil {
		return 0
	}
	raw, ok := network.Lookup("threshold_gb_day")
	if !ok {
		return 0
	}
	n := yamljs.ToNumber(raw)
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return 0
	}
	return n
}

// passthroughKeyPrefix is the ptk_ passthrough capability prefix
// (livekit/ingress-auth.service.ts).
const passthroughKeyPrefix = "ptk_"

var twoSegments = regexp.MustCompile(`^([^/]+)/([^/]+)$`)

// passthroughApp classifies a MediaMTX path (passthrough/mediamtx-path.util.ts)
// and returns the app of a passthrough push; ok=false for the LiveKit plane
// (live/<non-ptk key>) and invalid shapes.
func passthroughApp(rawPath string) (app string, ok bool) {
	path := strings.TrimLeft(rawPath, "/")
	if m := twoSegments.FindStringSubmatch(path); m != nil {
		if strings.HasPrefix(m[2], passthroughKeyPrefix) || m[1] != "live" {
			return m[1], true
		}
		return "", false
	}
	return "", false // live/a/b is the LiveKit plane; anything else invalid
}
