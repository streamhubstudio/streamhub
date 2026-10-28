package metrics

import (
	"encoding/json"
	"math"
	"strings"
	"time"
)

// Port of metrics/cluster-metrics.ts: pure, defensive projection of the
// master's `nodes` + `edge_assignments` tables onto the cluster gauges. The
// stats_json blob is edge-fed, so every field degrades to "absent" instead of
// failing the scrape.

// NodeUpWithin is the liveness window (cluster NODE_STALE_AFTER_SECONDS).
const NodeUpWithin = 90 * time.Second

// RawNodeRow is the subset of a `nodes` row the projection reads.
type RawNodeRow struct {
	Name       string
	Type       *string
	Weight     *float64
	Status     string
	LastSeenAt *string
	StatsJSON  *string
}

// NodeMetrics are the per-node numbers exported as labelled gauges. Pointer
// fields are nil when telemetry has not reported them.
type NodeMetrics struct {
	Node          string
	Type          string // edge | common
	Up            float64
	CPURatio      *float64
	MemUsedRatio  *float64
	DiskUsedRatio *float64
	GPU           float64
	VramFreeMb    *float64
	Weight        float64
	Active        bool
}

// ParseStatsBlob parses a stored stats blob; corrupt/absent/array → nil.
func ParseStatsBlob(raw *string) map[string]any {
	if raw == nil || *raw == "" {
		return nil
	}
	var v any
	if err := json.Unmarshal([]byte(*raw), &v); err != nil {
		return nil
	}
	m, _ := v.(map[string]any)
	return m
}

// NodeUp: SQLite datetime('now') is UTC without a zone marker.
func NodeUp(lastSeenAt *string, now time.Time) bool {
	if lastSeenAt == nil || *lastSeenAt == "" {
		return false
	}
	s := strings.Replace(*lastSeenAt, " ", "T", 1) + "Z"
	var t time.Time
	var err error
	for _, layout := range []string{"2006-01-02T15:04:05Z", "2006-01-02T15:04:05.999999999Z", "2006-01-02T15:04Z"} {
		if t, err = time.Parse(layout, s); err == nil {
			return now.Sub(t) <= NodeUpWithin
		}
	}
	return false
}

// num is a finite JSON number, or nil.
func num(v any) *float64 {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return &f
}

func object(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// ProjectNode projects one raw node row onto its metrics. Never panics.
func ProjectNode(row RawNodeRow, now time.Time) NodeMetrics {
	stats := ParseStatsBlob(row.StatsJSON)
	grid := object(stats["grid"])
	disk := object(stats["disk"])
	m := NodeMetrics{
		Node:          row.Name,
		Type:          "common",
		CPURatio:      num(stats["cpu"]),
		MemUsedRatio:  num(stats["memUsedRatio"]),
		DiskUsedRatio: num(disk["usedRatio"]),
		VramFreeMb:    num(grid["vramFreeMb"]),
		Weight:        100,
		Active:        row.Status == "active",
	}
	if row.Type != nil && *row.Type == "edge" {
		m.Type = "edge"
	}
	if NodeUp(row.LastSeenAt, now) {
		m.Up = 1
	}
	if g, _ := grid["gpu"].(bool); g {
		m.GPU = 1
	}
	if row.Weight != nil && !math.IsNaN(*row.Weight) && !math.IsInf(*row.Weight, 0) {
		m.Weight = *row.Weight
	}
	return m
}

// EligibleCounts is the GPU split of placeable nodes.
type EligibleCounts struct {
	GPUTrue  int
	GPUFalse int
}

// Eligible approximates the scheduler's eligible set: up + active + a
// placeable type (edge, or common when allowCommon).
func Eligible(nodes []NodeMetrics, allowCommon bool) EligibleCounts {
	var c EligibleCounts
	for _, n := range nodes {
		if n.Up != 1 || !n.Active {
			continue
		}
		if n.Type != "edge" && !(allowCommon && n.Type == "common") {
			continue
		}
		if n.GPU == 1 {
			c.GPUTrue++
		} else {
			c.GPUFalse++
		}
	}
	return c
}

// AssignmentCounts tallies edge_assignments rows by status ("" → unknown).
func AssignmentCounts(statuses []string) (byStatus map[string]int, pending int) {
	byStatus = map[string]int{}
	for _, s := range statuses {
		if s == "" {
			s = "unknown"
		}
		byStatus[s]++
	}
	return byStatus, byStatus["pending"]
}
