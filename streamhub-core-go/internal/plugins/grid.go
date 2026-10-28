package plugins

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of plugin-grid.service.ts (origin side: grid node selection from the
// cluster `nodes` registry + remote dispatch/stop/status) and
// grid-agent.service.ts (node side: run a dispatched resolved spec).

const (
	// GridNodeStaleAfterSeconds mirrors the cluster registry staleness window.
	GridNodeStaleAfterSeconds = 90
	// GridDispatchTimeout bounds every call to a node's grid agent.
	GridDispatchTimeout = 8 * time.Second
)

// GridNodeView is a grid-capable node + its advertised capabilities.
type GridNodeView struct {
	NodeInfo
	GPU          bool     `json:"gpu"`
	VramGb       *float64 `json:"vramGb"`
	Capabilities []string `json:"capabilities"`
}

// GridSpawnRequest is the body POSTed to a node's grid agent.
type GridSpawnRequest struct {
	PluginID    string   `json:"pluginId"`
	AppName     string   `json:"appName"`
	Command     string   `json:"command"`
	Args        []string `json:"args"`
	Env         *y.Map   `json:"env"`
	IngestToken string   `json:"ingestToken,omitempty"`
}

// GridDispatchResult is a dispatch outcome.
type GridDispatchResult struct {
	Dispatched bool
	Node       NodeInfo
	RemoteID   string
	Reason     string
}

// MatchGridNode picks the best eligible node: hard filters gpu / minVramGb /
// capabilities; preferred regions first, then larger VRAM, then name.
func MatchGridNode(nodes []GridNodeView, req *GridRequirements) *GridNodeView {
	needGPU := req != nil && (req.GPU || req.MinVramGb != nil && *req.MinVramGb > 0)
	var eligible []GridNodeView
	for _, n := range nodes {
		if needGPU && !n.GPU {
			continue
		}
		if req != nil && req.MinVramGb != nil && *req.MinVramGb > 0 && (n.VramGb == nil || *n.VramGb < *req.MinVramGb) {
			continue
		}
		ok := true
		if req != nil {
			for _, c := range req.Capabilities {
				found := false
				for _, have := range n.Capabilities {
					found = found || have == c
				}
				ok = ok && found
			}
		}
		if ok {
			eligible = append(eligible, n)
		}
	}
	if len(eligible) == 0 {
		return nil
	}
	preferred := map[string]bool{}
	if req != nil {
		for _, r := range req.Regions {
			preferred[r] = true
		}
	}
	rank := func(n GridNodeView) int {
		if n.Region != nil && preferred[*n.Region] {
			return 0
		}
		return 1
	}
	vram := func(n GridNodeView) float64 {
		if n.VramGb == nil {
			return -1
		}
		return *n.VramGb
	}
	sort.SliceStable(eligible, func(i, j int) bool {
		a, b := eligible[i], eligible[j]
		if rank(a) != rank(b) {
			return rank(a) < rank(b)
		}
		if vram(a) != vram(b) {
			return vram(a) > vram(b)
		}
		return localeCompare(a.Name, b.Name) < 0
	})
	return &eligible[0]
}

// Grid is PluginGridService.
type Grid struct {
	global       *sql.DB
	clusterToken string
	client       *http.Client
}

// NewGrid builds the service.
func NewGrid(global *sql.DB, clusterToken string) *Grid {
	return &Grid{global: global, clusterToken: clusterToken, client: &http.Client{Timeout: GridDispatchTimeout}}
}

// ListGridNodes is every active, non-stale node advertising a `grid` block.
func (g *Grid) ListGridNodes(ctx context.Context) []GridNodeView {
	rows, err := g.global.QueryContext(ctx, fmt.Sprintf(`SELECT id, name, url, region, stats_json
           FROM nodes
          WHERE status = 'active'
            AND last_seen_at IS NOT NULL
            AND (julianday('now') - julianday(last_seen_at)) * 86400
                  <= %d
          ORDER BY name ASC`, GridNodeStaleAfterSeconds))
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []GridNodeView
	for rows.Next() {
		var id, name string
		var nodeURL, region, stats sql.NullString
		if rows.Scan(&id, &name, &nodeURL, &region, &stats) != nil {
			continue
		}
		grid := parseGridBlock(stats)
		if grid == nil {
			continue
		}
		n := GridNodeView{NodeInfo: NodeInfo{ID: id, Name: name}, GPU: grid.Get("gpu") == true, Capabilities: []string{}}
		if nodeURL.Valid {
			n.URL = &nodeURL.String
		}
		if region.Valid {
			n.Region = &region.String
		}
		n.VramGb = numPtr(grid.Get("vramGb"))
		if caps, ok := grid.Get("capabilities").([]any); ok {
			for _, c := range caps {
				if s, ok := c.(string); ok {
					n.Capabilities = append(n.Capabilities, s)
				}
			}
		}
		out = append(out, n)
	}
	return out
}

func parseGridBlock(s sql.NullString) *y.Map {
	if !s.Valid || s.String == "" {
		return nil
	}
	v, err := y.ParseJSON([]byte(s.String))
	if err != nil {
		return nil
	}
	g, _ := prop(v, "grid").(*y.Map)
	return g
}

// SelectNode is the best eligible node, or nil.
func (g *Grid) SelectNode(ctx context.Context, req *GridRequirements) *GridNodeView {
	return MatchGridNode(g.ListGridNodes(ctx), req)
}

// normalizeNodeURL keeps an http(s) origin (SSRF guard), else "".
func normalizeNodeURL(raw *string) string {
	if raw == nil || *raw == "" {
		return ""
	}
	u, err := url.Parse(*raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func (g *Grid) call(ctx context.Context, method, target string, body any) (*http.Response, error) {
	var rd *bytes.Reader
	if body != nil {
		b, err := y.Stringify(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader([]byte(b))
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-cluster-token", g.clusterToken)
	return g.client.Do(req)
}

// Dispatch POSTs a resolved spec to the node's grid agent. Never fails: any
// problem yields Dispatched=false with a reason.
func (g *Grid) Dispatch(ctx context.Context, node NodeInfo, req GridSpawnRequest) GridDispatchResult {
	base := normalizeNodeURL(node.URL)
	if base == "" {
		return GridDispatchResult{Node: node, Reason: "node has no usable http(s) url"}
	}
	if g.clusterToken == "" {
		return GridDispatchResult{Node: node, Reason: "STREAMHUB_CLUSTER_TOKEN unset"}
	}
	res, err := g.call(ctx, http.MethodPost, base+"/api/v1/grid/workers", req)
	if err != nil {
		return GridDispatchResult{Node: node, Reason: "dispatch error: " + err.Error()}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return GridDispatchResult{Node: node, Reason: fmt.Sprintf("agent returned HTTP %d", res.StatusCode)}
	}
	var body any
	_ = json.NewDecoder(res.Body).Decode(&body)
	id := readWorkerID(body)
	if id == "" {
		return GridDispatchResult{Node: node, Reason: "agent did not return a worker id"}
	}
	return GridDispatchResult{Dispatched: true, Node: node, RemoteID: id}
}

func readWorkerID(body any) string {
	m, ok := body.(map[string]any)
	if !ok {
		return ""
	}
	var id any
	if data, ok := m["data"].(map[string]any); ok {
		id = data["id"]
	} else {
		id = m["id"]
	}
	s, _ := id.(string)
	return s
}

// StopRemote asks the owning node to stop a remote worker (best-effort).
func (g *Grid) StopRemote(ctx context.Context, node NodeInfo, remoteID string) bool {
	base := normalizeNodeURL(node.URL)
	if base == "" || g.clusterToken == "" {
		return false
	}
	res, err := g.call(ctx, http.MethodPost, base+"/api/v1/grid/workers/"+jsx.EncodeURIComponent(remoteID)+"/stop", nil)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode >= 200 && res.StatusCode <= 299
}

// RemoteStatus fetches a remote worker's status (nil on any failure).
func (g *Grid) RemoteStatus(ctx context.Context, node NodeInfo, remoteID string) map[string]any {
	base := normalizeNodeURL(node.URL)
	if base == "" || g.clusterToken == "" {
		return nil
	}
	res, err := g.call(ctx, http.MethodGet, base+"/api/v1/grid/workers/"+jsx.EncodeURIComponent(remoteID)+"/status", nil)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil
	}
	var body map[string]any
	if json.NewDecoder(res.Body).Decode(&body) != nil {
		return nil
	}
	data, _ := body["data"].(map[string]any)
	return data
}

// ---------------------------------------------------------------------------
// node side (grid-agent.service.ts)
// ---------------------------------------------------------------------------

// GridWorkerView is a grid-run worker as returned to the origin.
type GridWorkerView struct {
	ID        string          `json:"id"`
	PluginID  string          `json:"pluginId"`
	AppName   string          `json:"appName"`
	Status    string          `json:"status"`
	PID       *int            `json:"pid,omitempty"`
	StartedAt string          `json:"startedAt,omitempty"`
	StoppedAt string          `json:"stoppedAt,omitempty"`
	ExitCode  json.RawMessage `json:"exitCode,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// Agent is GridAgentService.
type Agent struct{ workers *Manager }

// NewAgent builds the agent.
func NewAgent(m *Manager) *Agent { return &Agent{workers: m} }

// GridWorkerInput is the validated GridWorkerDto.
type GridWorkerInput struct {
	PluginID, AppName, Command string
	Args                       []string
	Env                        *y.Map
	IngestToken                string
}

func gridView(id string, s WorkerState) GridWorkerView {
	return GridWorkerView{ID: id, PluginID: s.PluginID, AppName: s.App, Status: s.Status, PID: s.PID,
		StartedAt: s.StartedAt, StoppedAt: s.StoppedAt, ExitCode: s.ExitCode, Error: s.Error}
}

// Spawn runs a dispatched worker under a fresh id.
func (a *Agent) Spawn(in GridWorkerInput) GridWorkerView {
	id := uuid()
	var env []EnvVar
	hasToken := false
	if in.Env != nil {
		for _, k := range in.Env.Keys() {
			if v, ok := in.Env.Get(k).(string); ok {
				env = append(env, EnvVar{k, v})
				hasToken = hasToken || (k == "STREAMHUB_INGEST_TOKEN" && v != "")
			}
		}
	}
	if in.IngestToken != "" && !hasToken {
		env = append(env, EnvVar{"STREAMHUB_INGEST_TOKEN", in.IngestToken})
	}
	state := a.workers.StartSpec(id, in.AppName, in.PluginID, WorkerSpec{Command: in.Command, Args: orEmpty(in.Args), Env: env})
	return gridView(id, state)
}

func gridNotFound(id string) error {
	return httpx.NotFound(fmt.Sprintf("grid worker '%s' not found", id))
}

// Status is a dispatched worker's state.
func (a *Agent) Status(id string) (GridWorkerView, error) {
	s, ok := a.workers.StatusByKey(id)
	if !ok {
		return GridWorkerView{}, gridNotFound(id)
	}
	return gridView(id, s), nil
}

// Stop stops a dispatched worker.
func (a *Agent) Stop(id string) (GridWorkerView, error) {
	if _, ok := a.workers.StatusByKey(id); !ok {
		return GridWorkerView{}, gridNotFound(id)
	}
	return gridView(id, a.workers.StopByKey(id)), nil
}

// Logs returns a dispatched worker's recent lines.
func (a *Agent) Logs(id string, limit int) ([]LogLine, error) {
	if _, ok := a.workers.StatusByKey(id); !ok {
		return nil, gridNotFound(id)
	}
	return a.workers.LogsByKey(id, limit), nil
}

// ---------------------------------------------------------------------------
// cluster token gate (cluster-token.util.ts)
// ---------------------------------------------------------------------------

// ClusterTokenMatches is the constant-time compare over SHA-256 digests.
func ClusterTokenMatches(provided, expected string) bool {
	if provided == "" {
		return false
	}
	a, b := sha256.Sum256([]byte(provided)), sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

type errorOnly struct {
	Error string `json:"error"`
}

// AssertClusterToken: 503 when unset, 401 when the header is wrong/absent.
func AssertClusterToken(r *http.Request, expected, disabledMessage string) error {
	if expected == "" {
		return &httpx.Error{Status: http.StatusServiceUnavailable, Body: errorOnly{disabledMessage}}
	}
	if !ClusterTokenMatches(r.Header.Get("x-cluster-token"), expected) {
		return &httpx.Error{Status: http.StatusUnauthorized, Body: errorOnly{"invalid cluster token"}}
	}
	return nil
}
