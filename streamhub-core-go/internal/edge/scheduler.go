package edge

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/cluster"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

const (
	// FailbackGrace holds a flapped node out of placement after reconnecting.
	FailbackGrace = 60 * time.Second
	// RetryPendingEvery re-places unplaced pending assignments.
	RetryPendingEvery = 30 * time.Second
)

// Logs is LogsServiceContract.write.
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// ScheduleInput is one new workload.
type ScheduleInput struct {
	App      string
	PluginID string
	StreamID *string
	Config   *y.Map
	Policy   string // "" = instance default
	Req      *plugins.GridRequirements
}

// Scheduler is EdgeSchedulerService.
type Scheduler struct {
	cfg      *config.Config
	db       *sql.DB
	gw       *Gateway
	repo     *Repo
	framer   *Framer
	capacity *Alerter // optional
	logs     Logs     // optional
	log      *slog.Logger
	now      func() time.Time
	rand     func() float64

	mu       sync.Mutex // serializes placement decisions (Node is single-threaded)
	rrCursor int
}

// NewScheduler builds the scheduler; capacity/logs may be nil.
func NewScheduler(cfg *config.Config, global *sql.DB, gw *Gateway, repo *Repo, framer *Framer, capacity *Alerter, logs Logs, log *slog.Logger) *Scheduler {
	return &Scheduler{cfg: cfg, db: global, gw: gw, repo: repo, framer: framer, capacity: capacity, logs: logs, log: log, now: time.Now, rand: rand.Float64}
}

// Start runs the 30s retry loop until ctx ends.
func (s *Scheduler) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(RetryPendingEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.RetryPending(ctx)
			}
		}
	}()
}

func (s *Scheduler) logEvent(level, msg string, meta *y.Map) {
	if s.logs != nil {
		s.logs.Write(level, "edge", msg, meta, nil)
	}
}

func kv(pairs ...any) *y.Map {
	m := y.NewMap()
	for i := 0; i+1 < len(pairs); i += 2 {
		m.Set(pairs[i].(string), pairs[i+1])
	}
	return m
}

// Schedule places + persists + pushes a new assignment.
func (s *Scheduler) Schedule(ctx context.Context, in ScheduleInput) (*Assignment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	policy := in.Policy
	if policy == "" {
		policy = s.defaultPolicy()
	}
	nodes, err := s.NodeViews(ctx)
	if err != nil {
		return nil, err
	}
	nodeID, cursor := Place(nodes, PlaceOptions{Policy: policy, Req: in.Req, AllowCommon: s.allowCommon(), Cursor: s.rrCursor, Rand: s.rand})
	s.rrCursor = cursor
	status := StatusPending
	if nodeID != "" {
		status = StatusOffered
	}
	a, err := s.repo.Create(ctx, CreateInput{NodeID: nodeID, App: in.App, PluginID: in.PluginID, StreamID: in.StreamID, Config: in.Config, Status: status})
	if err != nil {
		return nil, err
	}
	if nodeID != "" {
		if !s.gw.Send(nodeID, s.framer.AssignFrame(*a)) {
			_ = s.repo.UpdateStatus(ctx, a.ID, StatusPending, strPtr("push failed"))
		}
		s.log.Info(fmt.Sprintf("scheduled assignment %s (%s/%s) → %s [%s]", a.ID, in.App, in.PluginID, nodeID, policy))
		s.logEvent("info", fmt.Sprintf("scheduled %s/%s → %s", in.App, in.PluginID, nodeID),
			kv("assignmentId", a.ID, "app", in.App, "pluginId", in.PluginID, "nodeId", nodeID, "policy", policy))
	} else {
		s.log.Warn(fmt.Sprintf("no eligible node for %s/%s — assignment %s pending", in.App, in.PluginID, a.ID))
		s.logEvent("warn", fmt.Sprintf("no eligible node for %s/%s", in.App, in.PluginID),
			kv("assignmentId", a.ID, "app", in.App, "pluginId", in.PluginID, "policy", policy))
		if s.capacity != nil {
			s.capacity.Alert("no-eligible-node", kv("app", in.App, "pluginId", in.PluginID))
		}
	}
	fresh, err := s.repo.Get(ctx, a.ID)
	if err != nil || fresh == nil {
		return a, err
	}
	return fresh, nil
}

// Revoke tells the owning node, then marks the row revoked (nil = unknown).
func (s *Scheduler) Revoke(ctx context.Context, id string) (*Assignment, error) {
	a, err := s.repo.Get(ctx, id)
	if err != nil || a == nil {
		return nil, err
	}
	if a.NodeID != "" {
		s.gw.Revoke(a.NodeID, id)
	}
	if err := s.repo.UpdateStatus(ctx, id, StatusRevoked, nil); err != nil {
		return nil, err
	}
	return s.repo.Get(ctx, id)
}

// RetryPending re-places every unplaced pending assignment.
func (s *Scheduler) RetryPending(ctx context.Context) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	placed, still := 0, 0
	func() {
		pending, err := s.repo.PendingUnplaced(ctx)
		if err != nil {
			return
		}
		for _, a := range pending {
			nodes, err := s.NodeViews(ctx)
			if err != nil {
				return
			}
			nodeID, cursor := Place(nodes, PlaceOptions{Policy: s.defaultPolicy(), AllowCommon: s.allowCommon(), Cursor: s.rrCursor, Rand: s.rand})
			s.rrCursor = cursor
			if nodeID == "" {
				still++
				continue
			}
			_ = s.repo.Reassign(ctx, a.ID, nodeID, StatusOffered)
			a.NodeID = nodeID
			if s.gw.Send(nodeID, s.framer.AssignFrame(a)) {
				placed++
				s.logEvent("info", fmt.Sprintf("re-offered %s/%s → %s", a.App, a.PluginID, nodeID),
					kv("assignmentId", a.ID, "app", a.App, "pluginId", a.PluginID, "nodeId", nodeID))
			} else {
				_ = s.repo.UpdateStatus(ctx, a.ID, StatusPending, strPtr("push failed"))
				still++
			}
		}
	}()
	if still > 0 && s.capacity != nil {
		s.capacity.Alert("no-eligible-node", kv("pending", float64(still)))
	}
	return placed
}

// HandleNodeDown fails a down node's offered/running work over.
func (s *Scheduler) HandleNodeDown(ctx context.Context, nodeID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	orphaned, err := s.repo.ActiveByNode(ctx, nodeID)
	if err != nil || len(orphaned) == 0 {
		return
	}
	nodes, err := s.NodeViews(ctx)
	if err != nil {
		return
	}
	ids := make([]string, len(orphaned))
	for i, a := range orphaned {
		ids[i] = a.ID
	}
	moves, cursor := PlanFailover(ids, nodes, PlaceOptions{Policy: s.defaultPolicy(), AllowCommon: s.allowCommon(), Cursor: s.rrCursor, Rand: s.rand})
	s.rrCursor = cursor
	moved := 0
	for _, m := range moves {
		if m.ToNodeID == "" {
			_ = s.repo.UpdateStatus(ctx, m.AssignmentID, StatusPending, strPtr("no eligible node for failover"))
			continue
		}
		_ = s.repo.Reassign(ctx, m.AssignmentID, m.ToNodeID, StatusOffered)
		if a, _ := s.repo.Get(ctx, m.AssignmentID); a != nil && s.gw.Send(m.ToNodeID, s.framer.AssignFrame(*a)) {
			moved++
		}
	}
	parked := len(orphaned) - moved
	s.log.Warn(fmt.Sprintf("node %s down — failed over %d assignment(s) (%d placed, %d parked)", nodeID, len(orphaned), moved, parked))
	s.logEvent("warn", fmt.Sprintf("node %s down — failover", nodeID),
		kv("nodeId", nodeID, "orphaned", float64(len(orphaned)), "moved", float64(moved), "parked", float64(parked)))
	if parked > 0 && s.capacity != nil {
		s.capacity.Alert("failover-parked", kv("nodeId", nodeID, "parked", float64(parked)))
	}
}

// NodeViews builds the scheduler view of every registered node.
func (s *Scheduler) NodeViews(ctx context.Context) ([]SchedNode, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, region, type, weight, status, stats_json FROM nodes`)
	if err != nil {
		return nil, err
	}
	type raw struct {
		id                       string
		name, region, typ, stats sql.NullString
		weight                   sql.NullFloat64
		status                   string
	}
	var rs []raw
	for rows.Next() {
		var r raw
		if err := rows.Scan(&r.id, &r.name, &r.region, &r.typ, &r.weight, &r.status, &r.stats); err != nil {
			rows.Close()
			return nil, err
		}
		rs = append(rs, r)
	}
	rows.Close()
	out := make([]SchedNode, 0, len(rs))
	for _, r := range rs {
		n := SchedNode{ID: r.id, Name: r.name.String, Type: "common", Weight: 100, Status: r.status,
			Connected: s.eligibleConnected(r.id), Grid: parseGrid(r.stats), Load: s.repo.ActiveCountByNode(ctx, r.id)}
		if r.region.Valid {
			v := r.region.String
			n.Region = &v
		}
		if r.typ.String == "edge" {
			n.Type = "edge"
		}
		if r.weight.Valid {
			n.Weight = r.weight.Float64
		}
		out = append(out, n)
	}
	return out, nil
}

// eligibleConnected: connected and, after a flap, past the failback grace.
func (s *Scheduler) eligibleConnected(nodeID string) bool {
	if !s.gw.IsConnected(nodeID) {
		return false
	}
	if _, flapped := s.gw.LastDisconnectAt(nodeID); !flapped {
		return true
	}
	since, ok := s.gw.ConnectedSince(nodeID)
	if !ok {
		return false
	}
	return s.now().Sub(since) >= FailbackGrace
}

func parseGrid(js sql.NullString) *GridCaps {
	stats := cluster.ParseStats(js)
	if stats == nil {
		return nil
	}
	g, ok := stats.Get("grid").(*y.Map)
	if !ok {
		return nil
	}
	caps := &GridCaps{GPU: g.Get("gpu") == true, Capabilities: []string{}}
	if f, ok := g.Get("vramGb").(float64); ok {
		caps.VramGb = &f
	}
	if f, ok := g.Get("vramFreeMb").(float64); ok {
		caps.VramFreeMb = &f
	}
	if s, ok := g.Get("gpuName").(string); ok {
		caps.GPUName = &s
	}
	if arr, ok := g.Get("capabilities").([]any); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok {
				caps.Capabilities = append(caps.Capabilities, s)
			}
		}
	}
	return caps
}

// defaultPolicy is STREAMHUB_EDGE_SCHEDULER_POLICY (weighted | round_robin).
func (s *Scheduler) defaultPolicy() string {
	if strings.ToLower(strings.TrimSpace(s.cfg.Env("STREAMHUB_EDGE_SCHEDULER_POLICY"))) == PolicyWeighted {
		return PolicyWeighted
	}
	return PolicyRoundRobin
}

// allowCommon is STREAMHUB_EDGE_ALLOW_COMMON.
func (s *Scheduler) allowCommon() bool {
	switch strings.ToLower(strings.TrimSpace(s.cfg.Env("STREAMHUB_EDGE_ALLOW_COMMON"))) {
	case "1", "true", "on", "yes":
		return true
	}
	return false
}
