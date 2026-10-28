package edge

import (
	"math"
	"math/rand/v2"
	"sort"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// Pure scheduler logic (edge-scheduler.logic.ts): a deterministic function
// of the node view + options. Hardware eligibility reuses the GRID matcher
// (plugins.MatchGridNode) so both planes agree on what "eligible" means.

const (
	// VramReserveMB is held back per node before counting capacity.
	VramReserveMB = 500
	// VramPerStreamMB is the budget assumed per placed stream.
	VramPerStreamMB = 200
)

// GridCaps is the `stats.grid` block a node advertises.
type GridCaps struct {
	GPU          bool
	VramGb       *float64
	VramFreeMb   *float64
	GPUName      *string
	Capabilities []string
}

// SchedNode is a node as the scheduler sees it.
type SchedNode struct {
	ID     string
	Name   string
	Region *string
	Type   string // edge | common
	Weight float64
	Status string
	// Connected: live WS past any failback grace.
	Connected bool
	Grid      *GridCaps
	Load      int
}

// PlaceOptions shape a placement.
type PlaceOptions struct {
	Policy      string
	Req         *plugins.GridRequirements
	AllowCommon bool
	Cursor      int
	// Rand returns [0,1) for the weighted policy (default math/rand).
	Rand func() float64
}

// VramMaxStreams is floor((vramFreeMb - 500) / 200); +Inf without a figure.
func VramMaxStreams(n SchedNode) float64 {
	if n.Grid == nil || n.Grid.VramFreeMb == nil {
		return math.Inf(1)
	}
	return math.Floor((*n.Grid.VramFreeMb - VramReserveMB) / VramPerStreamMB)
}

// HasCapacity: room for one more stream.
func HasCapacity(n SchedNode) bool { return float64(n.Load) < VramMaxStreams(n) }

// PassesRequirements delegates to the GRID matcher.
func PassesRequirements(n SchedNode, req *plugins.GridRequirements) bool {
	v := plugins.GridNodeView{NodeInfo: plugins.NodeInfo{ID: n.ID, Name: n.Name, Region: n.Region}}
	if n.Grid != nil {
		v.GPU = n.Grid.GPU
		v.VramGb = n.Grid.VramGb
		v.Capabilities = n.Grid.Capabilities
	}
	if v.Capabilities == nil {
		v.Capabilities = []string{}
	}
	return plugins.MatchGridNode([]plugins.GridNodeView{v}, req) != nil
}

// EligibleNodes: connected + active + allowed type + requirements +
// capacity, sorted by id.
func EligibleNodes(nodes []SchedNode, req *plugins.GridRequirements, allowCommon bool) []SchedNode {
	out := []SchedNode{}
	for _, n := range nodes {
		if !n.Connected || n.Status != "active" {
			continue
		}
		if !(n.Type == "edge" || (allowCommon && n.Type == "common")) {
			continue
		}
		if !PassesRequirements(n, req) || !HasCapacity(n) {
			continue
		}
		out = append(out, n)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// PickRoundRobin picks eligible[cursor mod n] and advances the cursor.
func PickRoundRobin(eligible []SchedNode, cursor int) (string, int) {
	if len(eligible) == 0 {
		return "", cursor
	}
	n := len(eligible)
	return eligible[((cursor%n)+n)%n].ID, cursor + 1
}

// PickWeighted picks with probability ∝ weight (non-positive = 0; all zero
// → uniform).
func PickWeighted(eligible []SchedNode, rnd func() float64) string {
	if len(eligible) == 0 {
		return ""
	}
	if rnd == nil {
		rnd = rand.Float64
	}
	total := 0.0
	weights := make([]float64, len(eligible))
	for i, n := range eligible {
		if n.Weight > 0 {
			weights[i] = n.Weight
		}
		total += weights[i]
	}
	if total <= 0 {
		return eligible[int(math.Floor(rnd()*float64(len(eligible))))%len(eligible)].ID
	}
	r := rnd() * total
	for i := range eligible {
		r -= weights[i]
		if r < 0 {
			return eligible[i].ID
		}
	}
	return eligible[len(eligible)-1].ID
}

// Place picks a node for one assignment ("" when none fits).
func Place(nodes []SchedNode, o PlaceOptions) (string, int) {
	eligible := EligibleNodes(nodes, o.Req, o.AllowCommon)
	if len(eligible) == 0 {
		return "", o.Cursor
	}
	if o.Policy == PolicyWeighted {
		return PickWeighted(eligible, o.Rand), o.Cursor
	}
	return PickRoundRobin(eligible, o.Cursor)
}

// FailoverMove is where one orphaned assignment goes ("" = park pending).
type FailoverMove struct {
	AssignmentID string
	ToNodeID     string
}

// PlanFailover spreads orphaned assignments across the eligible nodes,
// counting each placement against a working copy of the load.
func PlanFailover(ids []string, nodes []SchedNode, o PlaceOptions) ([]FailoverMove, int) {
	work := make([]SchedNode, len(nodes))
	copy(work, nodes)
	cursor := o.Cursor
	moves := make([]FailoverMove, 0, len(ids))
	for _, id := range ids {
		opts := o
		opts.Cursor = cursor
		nodeID, next := Place(work, opts)
		cursor = next
		if nodeID != "" {
			for i := range work {
				if work[i].ID == nodeID {
					work[i].Load++
				}
			}
		}
		moves = append(moves, FailoverMove{id, nodeID})
	}
	return moves, cursor
}
