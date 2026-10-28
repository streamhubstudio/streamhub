// Package streamhealth is the port of src/modules/stream-health: the server
// side of the stream-health Studio App — a per-app stream-health.db (bounded
// health.* event history + per-room threshold overrides), the funnel tap that
// records every health.* dispatch, and the read/settings API at
// /apps/:app/plugins/stream-health.
package streamhealth

import (
	"fmt"
	"math"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// HealthThresholds are the detector knobs (JSON key order = Node's interface).
type HealthThresholds struct {
	SampleIntervalSec  float64 `json:"sample_interval_sec"`
	SilenceDB          float64 `json:"silence_db"`
	SilenceDurationSec float64 `json:"silence_duration_sec"`
	DesyncMs           float64 `json:"desync_ms"`
	StallSec           float64 `json:"stall_sec"`
	BitrateDropPct     float64 `json:"bitrate_drop_pct"`
	RecoverSamples     float64 `json:"recover_samples"`
}

// DefaultThresholds mirror the plugin.meta configSchema.
var DefaultThresholds = HealthThresholds{10, -50, 15, 200, 20, 50, 2}

type bound struct {
	key      string
	min, max float64
	field    func(*HealthThresholds) *float64
}

// bounds are THRESHOLD_BOUNDS in declaration order.
var bounds = []bound{
	{"sample_interval_sec", 2, 300, func(t *HealthThresholds) *float64 { return &t.SampleIntervalSec }},
	{"silence_db", -120, 0, func(t *HealthThresholds) *float64 { return &t.SilenceDB }},
	{"silence_duration_sec", 1, 600, func(t *HealthThresholds) *float64 { return &t.SilenceDurationSec }},
	{"desync_ms", 10, 10000, func(t *HealthThresholds) *float64 { return &t.DesyncMs }},
	{"stall_sec", 2, 600, func(t *HealthThresholds) *float64 { return &t.StallSec }},
	{"bitrate_drop_pct", 0, 95, func(t *HealthThresholds) *float64 { return &t.BitrateDropPct }},
	{"recover_samples", 1, 10, func(t *HealthThresholds) *float64 { return &t.RecoverSamples }},
}

func boundFor(key string) *bound {
	for i := range bounds {
		if bounds[i].key == key {
			return &bounds[i]
		}
	}
	return nil
}

// SettingsError is HealthSettingsError (mapped to a 400).
type SettingsError struct{ msg string }

func (e *SettingsError) Error() string { return e.msg }

// toNumber is `typeof raw === 'string' ? Number(raw) : raw` → (number, ok).
func toNumber(raw any) (float64, bool) {
	switch x := raw.(type) {
	case string:
		n := y.StringToNumber(x)
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case float64:
		return x, !math.IsNaN(x) && !math.IsInf(x, 0)
	}
	return 0, false
}

// SanitizeOverride validates a PARTIAL per-room override: unknown keys and
// non-finite / out-of-range values are rejected. Key order is kept.
func SanitizeOverride(input any) (*y.Map, error) {
	if input == nil || y.IsUndefined(input) {
		return y.NewMap(), nil
	}
	m, ok := input.(*y.Map)
	if !ok {
		return nil, &SettingsError{"settings must be a JSON object"}
	}
	out := y.NewMap()
	for _, key := range m.Keys() {
		b := boundFor(key)
		if b == nil {
			return nil, &SettingsError{fmt.Sprintf("unknown threshold '%s'", key)}
		}
		n, ok := toNumber(m.Get(key))
		if !ok {
			return nil, &SettingsError{fmt.Sprintf("threshold '%s' must be a number", key)}
		}
		if n < b.min || n > b.max {
			return nil, &SettingsError{fmt.Sprintf("threshold '%s' must be between %s and %s", key, y.JSNumberString(b.min), y.JSNumberString(b.max))}
		}
		out.Set(key, n)
	}
	return out, nil
}

// ResolveThresholds is defaults ⊕ app install config ⊕ per-room override;
// invalid values in any layer fall through (never throw).
func ResolveThresholds(appConfig, override *y.Map) HealthThresholds {
	out := DefaultThresholds
	for _, layer := range []*y.Map{appConfig, override} {
		if layer == nil {
			continue
		}
		for _, b := range bounds {
			n, ok := toNumber(layer.Get(b.key))
			if !ok || n < b.min || n > b.max {
				continue
			}
			*b.field(&out) = n
		}
	}
	return out
}
