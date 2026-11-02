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
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/cluster"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
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

// GridSpawnRequest is the body POSTed to a node's grid agent: WHAT to run
// (plugin + app + validated config + the per-start ingest token), never HOW.
// GO-DIVERGENCE (security, 3.3.3): Node sent the resolved command/args/env,
// so anyone holding the cluster token ran arbitrary commands on every node;
// the node now resolves the spawn from its own registry (gridSpawn).
type GridSpawnRequest struct {
	PluginID    string `json:"pluginId"`
	AppName     string `json:"appName"`
	Config      *y.Map `json:"config"`
	IngestToken string `json:"ingestToken,omitempty"`
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

// call signs with the TARGET node's secret, never the shared cluster token
// (GO-DIVERGENCE, security 3.3.4 — C5.3): a grid node learns only its own
// credential. A pre-3.3.4 agent (which checks the raw token) answers 401 and
// the worker falls back to a local spawn until that node is upgraded.
func (g *Grid) call(ctx context.Context, node NodeInfo, method, target string, body any) (*http.Response, error) {
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
	req.Header.Set(cluster.NodeSecretHeader, cluster.NodeSecret(g.clusterToken, node.ID))
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
	res, err := g.call(ctx, node, http.MethodPost, base+"/api/v1/grid/workers", req)
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
	res, err := g.call(ctx, node, http.MethodPost, base+"/api/v1/grid/workers/"+jsx.EncodeURIComponent(remoteID)+"/stop", nil)
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
	res, err := g.call(ctx, node, http.MethodGet, base+"/api/v1/grid/workers/"+jsx.EncodeURIComponent(remoteID)+"/status", nil)
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

// GridNode is the node-role view the agent needs (cluster.NodeRole).
type GridNode interface {
	Role(ctx context.Context) string
	MasterURL(ctx context.Context) *string
	MasterNodeID(ctx context.Context) *string
	// NodeSecret is the per-node credential the master signs with.
	NodeSecret(ctx context.Context) *string
}

// gridAgentRole is the only role that serves /grid: a node joined to a
// master. A master or standalone core never runs dispatched workers.
const gridAgentRole = "edge"

// Agent is GridAgentService.
type Agent struct {
	workers    *Manager
	registry   *Registry
	node       func() GridNode
	legacyOnce sync.Once
}

// NewAgent builds the agent. reg resolves dispatched plugins; node is looked
// up lazily (nil, or a non-edge role, = agent off → /grid 404).
func NewAgent(m *Manager, reg *Registry, node func() GridNode) *Agent {
	return &Agent{workers: m, registry: reg, node: node}
}

// Enabled reports that this node serves /grid (role edge).
func (a *Agent) Enabled(ctx context.Context) bool {
	n := a.gridNode()
	return n != nil && n.Role(ctx) == gridAgentRole
}

func (a *Agent) gridNode() GridNode {
	if a == nil || a.node == nil {
		return nil
	}
	return a.node()
}

// warnLegacy logs (once) that the master still signs with the raw token.
func (a *Agent) warnLegacy() {
	a.legacyOnce.Do(func() {
		if a.registry != nil && a.registry.log != nil {
			a.registry.log.Warn("grid: master authenticated with the shared STREAMHUB_CLUSTER_TOKEN — legacy mode; " +
				"upgrade the master to 3.3.4+ and re-join this node, then set STREAMHUB_CLUSTER_LEGACY_TOKEN=off")
		}
	})
}

// GridWorkerInput is the validated GridWorkerDto.
type GridWorkerInput struct {
	PluginID, AppName string
	Config            *y.Map
	IngestToken       string
}

// gridAppName keeps the app name path-safe (it names the worker's app dir).
var gridAppName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

func gridView(id string, s WorkerState) GridWorkerView {
	return GridWorkerView{ID: id, PluginID: s.PluginID, AppName: s.App, Status: s.Status, PID: s.PID,
		StartedAt: s.StartedAt, StoppedAt: s.StoppedAt, ExitCode: s.ExitCode, Error: s.Error}
}

// Spawn runs a dispatched worker under a fresh id. The spec comes from THIS
// node's registry exactly as a local spawn (the plugin's own spawn builder /
// declarative template over the validated config), with the remote context:
// the master as origin (ingest feed-back) and this node as ctx.node. Only
// plugins declaring `placement: grid` can be dispatched.
func (a *Agent) Spawn(ctx context.Context, in GridWorkerInput) (GridWorkerView, error) {
	spec, err := a.gridSpawn(ctx, in)
	if err != nil {
		return GridWorkerView{}, err
	}
	id := uuid()
	return gridView(id, a.workers.StartSpec(id, in.AppName, in.PluginID, spec)), nil
}

func (a *Agent) gridSpawn(ctx context.Context, in GridWorkerInput) (WorkerSpec, error) {
	if !gridAppName.MatchString(in.AppName) {
		return WorkerSpec{}, httpx.BadRequest(fmt.Sprintf("invalid app name '%s'", in.AppName))
	}
	var meta *Meta
	if a.registry != nil {
		meta = a.registry.GetMeta(in.PluginID)
	}
	if meta == nil {
		return WorkerSpec{}, httpx.NotFound(fmt.Sprintf("plugin '%s' not found", in.PluginID))
	}
	if !meta.NeedsWorker || meta.Worker == nil || meta.Worker.Spawn == nil || meta.Worker.Placement != "grid" {
		return WorkerSpec{}, httpx.BadRequest(fmt.Sprintf("plugin '%s' is not a grid worker", in.PluginID))
	}
	cfg, err := ValidateConfig(meta, in.Config, true)
	if err != nil {
		return WorkerSpec{}, badRequestOnConfig(err)
	}
	origin, nodeID := "", ""
	var n GridNode
	if a.node != nil {
		n = a.node()
	}
	if n != nil {
		if u := n.MasterURL(ctx); u != nil {
			origin = *u
		}
		if id := n.MasterNodeID(ctx); id != nil {
			nodeID = *id
		}
	}
	dataDir := a.workers.cfg.DataDir
	spec := meta.Worker.Spawn(WorkerContext{App: in.AppName, Config: cfg, AppDir: filepath.Join(dataDir, "apps", in.AppName),
		DataDir: dataDir, LivekitURL: a.workers.cfg.LivekitURL, Node: &NodeInfo{ID: nodeID}, OriginURL: origin})
	env := []EnvVar{{"STREAMHUB_APP", in.AppName}, {"STREAMHUB_PLUGIN_ID", meta.ID}}
	if origin != "" {
		base := strings.TrimRight(origin, "/") + "/api/v1/apps/" + jsx.EncodeURIComponent(in.AppName) + "/plugins/" + jsx.EncodeURIComponent(meta.ID)
		env = append(env, EnvVar{"STREAMHUB_INGEST_URL", base + "/live"}, EnvVar{"STREAMHUB_EVENTS_URL", base + "/events"})
	}
	if in.IngestToken != "" {
		env = append(env, EnvVar{"STREAMHUB_INGEST_TOKEN", in.IngestToken})
	}
	spec.Args, spec.Env = orEmpty(spec.Args), append(env, spec.Env...)
	return spec, nil
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
