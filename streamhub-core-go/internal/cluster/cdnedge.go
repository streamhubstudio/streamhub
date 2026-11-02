package cluster

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// CDN edges (3.4.0): nginx/Caddy HLS cache nodes (deploy/nginx-hls-edge.conf)
// registered by `install.sh --cdn-edge`. They join with type "cdn-edge" and
// their public base URL as url, then heartbeat
//
//	{"role":"cdn-edge","cdn":{"conns":N,"reqTotal":N,"txBytes":N,"txMbps":F,"cacheDir":"…"}}
//
// stored as-is in stats_json like any node's. They never open the edge WS
// (no processing assignments, no watchdog). With STREAMHUB_HLS_EDGE_SELECT=
// least-loaded the HLS playlist URLs the API hands out point at the least
// loaded healthy one instead of the origin (HLSEdgeSelector).

// NodeTypeCDNEdge is the nodes.type of an HLS cache edge.
const NodeTypeCDNEdge = "cdn-edge"

// STREAMHUB_HLS_EDGE_SELECT values.
const (
	HLSEdgeSelectEnv         = "STREAMHUB_HLS_EDGE_SELECT"
	HLSEdgeSelectOff         = "off"
	HLSEdgeSelectLeastLoaded = "least-loaded"
)

// CDNEdgeHealthyFor is how long a cdn-edge stays selectable after its last
// heartbeat: 2.5 × the installer's 60 s interval (two missed beats tolerated).
const CDNEdgeHealthyFor = 150 * time.Second

// hlsEdgeCacheTTL bounds how often the selector re-reads the registry: every
// playlist URL handed out consults it, the heartbeats only move every 60 s.
const hlsEdgeCacheTTL = 5 * time.Second

// CDNEdge is the selection view of one cdn-edge row.
type CDNEdge struct {
	ID     string
	URL    string
	Status string
	// LastSeen is the last join/heartbeat (zero = never).
	LastSeen time.Time
	// TxMbps / Conns are the heartbeat's cdn.txMbps / cdn.conns (0 when the
	// edge has not reported yet or reported garbage).
	TxMbps float64
	Conns  int64
}

// ParseHLSEdgeSelect maps the env value to a mode; anything unknown is off.
func ParseHLSEdgeSelect(raw string) string {
	if strings.ToLower(strings.TrimSpace(raw)) == HLSEdgeSelectLeastLoaded {
		return HLSEdgeSelectLeastLoaded
	}
	return HLSEdgeSelectOff
}

// Healthy: operator status active, a heartbeat younger than
// CDNEdgeHealthyFor, and an http(s) base URL to point players at.
func (e CDNEdge) Healthy(now time.Time) bool {
	return e.Status == "active" && !e.LastSeen.IsZero() && now.Sub(e.LastSeen) <= CDNEdgeHealthyFor && IsHTTPURL(e.URL)
}

// PickCDNEdge is the least-loaded healthy edge: lowest txMbps, then fewer
// conns, then the smallest id (stable across calls). false = none healthy.
func PickCDNEdge(edges []CDNEdge, now time.Time) (CDNEdge, bool) {
	var ok []CDNEdge
	for _, e := range edges {
		if e.Healthy(now) {
			ok = append(ok, e)
		}
	}
	if len(ok) == 0 {
		return CDNEdge{}, false
	}
	sort.Slice(ok, func(i, j int) bool {
		a, b := ok[i], ok[j]
		if a.TxMbps != b.TxMbps {
			return a.TxMbps < b.TxMbps
		}
		if a.Conns != b.Conns {
			return a.Conns < b.Conns
		}
		return a.ID < b.ID
	})
	return ok[0], true
}

// HLSEdgeSelector rewrites the base of the HLS playlist URLs the API hands
// out (HLSBase). Mode off (the default) never touches the registry and
// returns the origin base untouched.
type HLSEdgeSelector struct {
	db   *sql.DB
	mode string
	// cacheable reports whether an app's /hls may come from a shared cache
	// that does not ask the core per request (playback.Guard.EdgeCacheable:
	// public, no geo rules). nil = no app is.
	cacheable func(ctx context.Context, app string) bool
	log       *slog.Logger
	now       func() time.Time

	mu    sync.Mutex
	edges []CDNEdge
	at    time.Time
}

// NewHLSEdgeSelector reads STREAMHUB_HLS_EDGE_SELECT once.
func NewHLSEdgeSelector(global *sql.DB, env func(string) string, cacheable func(ctx context.Context, app string) bool, log *slog.Logger) *HLSEdgeSelector {
	mode := HLSEdgeSelectOff
	if env != nil {
		raw := env(HLSEdgeSelectEnv)
		mode = ParseHLSEdgeSelect(raw)
		if mode == HLSEdgeSelectOff && strings.TrimSpace(raw) != "" && !strings.EqualFold(strings.TrimSpace(raw), HLSEdgeSelectOff) {
			log.Warn("unknown " + HLSEdgeSelectEnv + " value, HLS edge selection off (want off | least-loaded)")
		}
	}
	if mode != HLSEdgeSelectOff {
		log.Info("HLS edge selection on: playlist URLs point at the least-loaded healthy cdn-edge (" + mode + ")")
	}
	return &HLSEdgeSelector{db: global, mode: mode, cacheable: cacheable, log: log, now: time.Now}
}

// Mode is the active selection mode.
func (s *HLSEdgeSelector) Mode() string {
	if s == nil {
		return HLSEdgeSelectOff
	}
	return s.mode
}

// HLSBase is the base URL for app's playlist URLs: the picked cdn-edge's url
// (trailing slashes trimmed) when selection is on, the app is edge-cacheable
// and an edge is healthy; origin otherwise (verbatim, "" included).
func (s *HLSEdgeSelector) HLSBase(ctx context.Context, app, origin string) string {
	if s == nil || s.mode == HLSEdgeSelectOff {
		return origin
	}
	if s.cacheable == nil || !s.cacheable(ctx, app) {
		return origin
	}
	e, ok := PickCDNEdge(s.snapshot(ctx), s.now())
	if !ok {
		return origin
	}
	return strings.TrimRight(e.URL, "/")
}

// snapshot is the cached cdn-edge rows (re-read every hlsEdgeCacheTTL; a
// failed read keeps the previous list).
func (s *HLSEdgeSelector) snapshot(ctx context.Context) []CDNEdge {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.at.IsZero() && now.Sub(s.at) < hlsEdgeCacheTTL {
		return s.edges
	}
	edges, err := LoadCDNEdges(ctx, s.db)
	if err != nil {
		s.log.Warn("hls edge select: cannot read the node registry, keeping the last list", "error", err.Error())
	} else {
		s.edges = edges
	}
	s.at = now
	return s.edges
}

// LoadCDNEdges reads every cdn-edge row of the registry.
func LoadCDNEdges(ctx context.Context, global *sql.DB) ([]CDNEdge, error) {
	rows, err := global.QueryContext(ctx, `SELECT id, url, status, last_seen_at, stats_json FROM nodes WHERE type = ?`, NodeTypeCDNEdge)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CDNEdge
	for rows.Next() {
		var (
			e                    CDNEdge
			url, seen, statsJSON sql.NullString
		)
		if err := rows.Scan(&e.ID, &url, &e.Status, &seen, &statsJSON); err != nil {
			return nil, err
		}
		e.URL = url.String
		if seen.Valid {
			if t, err := time.ParseInLocation("2006-01-02 15:04:05", seen.String, time.UTC); err == nil {
				e.LastSeen = t
			}
		}
		if stats := ParseStats(statsJSON); stats != nil {
			if cdn, ok := stats.Get("cdn").(*y.Map); ok {
				e.TxMbps = load(cdn.Get("txMbps"))
				e.Conns = int64(load(cdn.Get("conns")))
			}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// load is a reported load figure: a finite non-negative number, else 0.
func load(v any) float64 {
	var f float64
	switch x := v.(type) {
	case float64:
		f = x
	case json.Number:
		f, _ = x.Float64()
	default:
		return 0
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return 0
	}
	return f
}
