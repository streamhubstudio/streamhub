package streamflow

import (
	"context"
	"fmt"
	"math"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of streamflow.graph.ts: the PURE workflow DAG walk. Boxes and edges
// stay value-model objects (the stored graph_json round-trips untouched);
// these helpers read their fields the way the JS reads `b.id` / `e.from`.

// Graph is a normalized workflow graph.
type Graph struct {
	Boxes []any
	Edges []any
}

// GraphError is a structural problem (GraphValidationError / CyclicGraphError /
// MaxStepsError in Node); Error() is the Node message.
type GraphError struct{ Msg string }

func (e *GraphError) Error() string { return e.Msg }

func graphErr(format string, a ...any) error { return &GraphError{Msg: fmt.Sprintf(format, a...)} }

// normalizeGraph keeps only array boxes/edges (anything else → []).
func normalizeGraph(graph any) Graph {
	g := asObject(graph)
	boxes, _ := g.Get("boxes").([]any)
	edges, _ := g.Get("edges").([]any)
	if boxes == nil {
		boxes = []any{}
	}
	if edges == nil {
		edges = []any{}
	}
	return Graph{Boxes: boxes, Edges: edges}
}

// field reads obj[key] (Undefined for non-objects).
func field(v any, key string) any {
	if m, ok := v.(*y.Map); ok && m != nil {
		return m.Get(key)
	}
	return y.Undefined
}

// boxID / boxType are the string id / type of a box ("" when not a string).
func boxID(b any) string   { s, _ := field(b, "id").(string); return s }
func boxType(b any) string { s, _ := field(b, "type").(string); return s }

// boxConfig is `box.config ?? {}` as an object.
func boxConfig(b any) *y.Map { return asObject(field(b, "config")) }

// endpointBox is the box id of an endpoint (`a` or `a:port`).
func endpointBox(ep any) string {
	s := y.ToString(y.Coalesce(ep, ""))
	if i := strings.Index(s, ":"); i >= 0 {
		return s[:i]
	}
	return s
}

// noPort never equals a real port (a non-string explicit fromPort in JS).
const noPort = "\x00"

// endpointPort: the explicit field wins; else after `:`; else def.
func endpointPort(ep, explicit any, def string) string {
	if !y.IsUndefined(explicit) && explicit != "" {
		if s, ok := explicit.(string); ok {
			return s
		}
		return noPort
	}
	s := y.ToString(y.Coalesce(ep, ""))
	if i := strings.Index(s, ":"); i >= 0 {
		return s[i+1:]
	}
	return def
}

func edgeFromBox(e any) string  { return endpointBox(field(e, "from")) }
func edgeFromPort(e any) string { return endpointPort(field(e, "from"), field(e, "fromPort"), "out") }
func edgeToBox(e any) string    { return endpointBox(field(e, "to")) }

// validateGraph: unique non-empty string ids, edges reference known boxes,
// acyclic.
func validateGraph(g Graph) error {
	ids := map[string]bool{}
	for _, b := range g.Boxes {
		id, ok := field(b, "id").(string)
		if !ok || id == "" {
			return graphErr("every box needs a non-empty string id")
		}
		if ids[id] {
			return graphErr("duplicate box id '%s'", id)
		}
		ids[id] = true
	}
	for _, e := range g.Edges {
		if from := edgeFromBox(e); !ids[from] {
			return graphErr("edge from unknown box '%s'", from)
		}
		if to := edgeToBox(e); !ids[to] {
			return graphErr("edge to unknown box '%s'", to)
		}
	}
	return assertAcyclic(g)
}

func assertAcyclic(g Graph) error {
	adj := map[string][]string{}
	for _, b := range g.Boxes {
		adj[boxID(b)] = []string{}
	}
	for _, e := range g.Edges {
		from := edgeFromBox(e)
		if _, ok := adj[from]; ok {
			adj[from] = append(adj[from], edgeToBox(e))
		}
	}
	const white, grey, black = 0, 1, 2
	color := map[string]int{}
	var visit func(string) error
	visit = func(node string) error {
		color[node] = grey
		for _, next := range adj[node] {
			switch color[next] {
			case grey:
				return graphErr("cycle through box '%s'", next)
			case white:
				if err := visit(next); err != nil {
					return err
				}
			}
		}
		color[node] = black
		return nil
	}
	for _, b := range g.Boxes {
		if color[boxID(b)] == white {
			if err := visit(boxID(b)); err != nil {
				return err
			}
		}
	}
	return nil
}

// ExecFunc runs one box; it returns the output and the port that fired.
type ExecFunc func(ctx context.Context, box any) (output any, port string, err error)

// runGraph walks from startBoxID executing each reachable box once,
// following the edges leaving the returned port. Returns the executed count.
func runGraph(ctx context.Context, g Graph, startBoxID string, exec ExecFunc, maxSteps int) error {
	if err := validateGraph(g); err != nil {
		return err
	}
	maxSteps = int(math.Max(1, float64(maxSteps)))
	byID := map[string]any{}
	for _, b := range g.Boxes {
		byID[boxID(b)] = b
	}
	if _, ok := byID[startBoxID]; !ok {
		return graphErr("start box '%s' not in graph", startBoxID)
	}
	executed := map[string]bool{}
	queue := []string{startBoxID}
	executions := 0
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if executed[id] {
			continue
		}
		box, ok := byID[id]
		if !ok {
			continue
		}
		if executions++; executions > maxSteps {
			return graphErr("exceeded max steps (%d)", maxSteps)
		}
		executed[id] = true
		if err := ctx.Err(); err != nil {
			return err
		}
		_, port, err := exec(ctx, box)
		if err != nil {
			return err
		}
		for _, e := range g.Edges {
			if edgeFromBox(e) == id && edgeFromPort(e) == port {
				if t := edgeToBox(e); !executed[t] {
					queue = append(queue, t)
				}
			}
		}
	}
	return nil
}

// findTriggerBox prefers a box whose type matches, else the first box with
// no inbound edge, else the first box (nil when empty).
func findTriggerBox(g Graph, prefer func(string) bool) any {
	if prefer != nil {
		for _, b := range g.Boxes {
			if t, ok := field(b, "type").(string); ok && prefer(t) {
				return b
			}
		}
	}
	targets := map[string]bool{}
	for _, e := range g.Edges {
		targets[edgeToBox(e)] = true
	}
	for _, b := range g.Boxes {
		if !targets[y.ToString(field(b, "id"))] {
			return b
		}
	}
	if len(g.Boxes) > 0 {
		return g.Boxes[0]
	}
	return nil
}
