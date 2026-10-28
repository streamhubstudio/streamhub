package streamflow

import (
	"fmt"
	"regexp"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of boxes/portable.ts: export / import one workflow as portable JSON.
// Export drops db fields and never carries a secret VALUE ({{secret.X}} refs
// are kept; sensitive keys / literal keys are redacted to ''). Import
// validates against the full catalogue and the graph invariants.

const portableVersion = 1.0

var (
	sensitiveKeyRe = regexp.MustCompile(`(?i)secret|token|password|passwd|credential|api[_-]?key|apikey|access[_-]?key|private|dsn`)
	literalKeyRe   = regexp.MustCompile(`^(sk-|sk_|xox|ghp_|AKIA)|^[A-Za-z0-9/+_-]{40,}$`)
)

func looksLiteralSecret(v string) bool {
	s := strings.TrimSpace(v)
	if s == "" || strings.Contains(s, "{{") {
		return false
	}
	return literalKeyRe.MatchString(s)
}

// stripSecretishConfig redacts secret-ish string values; returns the clean
// config and the redacted `<boxId>.<key>` paths.
func stripSecretishConfig(config any, boxID string) (*y.Map, []string) {
	src := asObject(config)
	out := y.NewMap()
	var redactions []string
	for _, k := range src.Keys() {
		v := src.Get(k)
		if s, ok := v.(string); ok {
			if (sensitiveKeyRe.MatchString(k) && !strings.Contains(s, "{{")) || looksLiteralSecret(s) {
				out.Set(k, "")
				redactions = append(redactions, boxID+"."+k)
				continue
			}
		}
		out.Set(k, v)
	}
	return out, redactions
}

// exportWorkflow renders the portable JSON (streamflow, name, graph,
// redactions?).
func exportWorkflow(name string, graph any) *y.Map {
	g := normalizeGraph(graph)
	var redactions []any
	boxes := make([]any, 0, len(g.Boxes))
	for _, b := range g.Boxes {
		cfg, r := stripSecretishConfig(field(b, "config"), y.ToString(field(b, "id")))
		for _, p := range r {
			redactions = append(redactions, p)
		}
		nb := y.Spread(b)
		nb.Set("config", cfg)
		boxes = append(boxes, nb)
	}
	out := obj("streamflow", portableVersion, "name", name, "graph", obj("boxes", boxes, "edges", g.Edges))
	if len(redactions) > 0 {
		out.Set("redactions", redactions)
	}
	return out
}

// importWorkflow validates portable JSON → (name, normalized graph). Errors
// carry the Node messages (surfaced as 400).
func importWorkflow(raw any, fallbackName string) (string, *y.Map, error) {
	o := asObject(raw)
	g := normalizeGraph(o.Get("graph"))
	if len(g.Boxes) == 0 && len(g.Edges) == 0 {
		return "", nil, graphErr("workflow has no boxes to import")
	}
	// [...new Set(types)].join(', '): Set identity per JS value, and join
	// renders undefined / null as ''.
	var unknown []string
	seen := map[string]bool{}
	for _, b := range g.Boxes {
		raw := field(b, "type")
		t := y.ToString(raw)
		if _, ok := raw.(string); ok && knownTypes[t] {
			continue
		}
		key := fmt.Sprintf("%T:%s", raw, t)
		if seen[key] {
			continue
		}
		seen[key] = true
		if y.IsNullish(raw) {
			t = ""
		}
		unknown = append(unknown, t)
	}
	if len(unknown) > 0 {
		s := ""
		if len(unknown) > 1 {
			s = "s"
		}
		return "", nil, graphErr("unknown box type%s: %s", s, strings.Join(unknown, ", "))
	}
	if err := validateGraph(g); err != nil {
		return "", nil, err
	}
	name := fallbackName
	if n, ok := o.Get("name").(string); ok && strings.TrimSpace(n) != "" {
		name = strings.TrimSpace(n)
	}
	return name, obj("boxes", g.Boxes, "edges", g.Edges), nil
}
