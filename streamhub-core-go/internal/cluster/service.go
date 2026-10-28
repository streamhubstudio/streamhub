package cluster

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

const (
	// MaxStatsBytes caps a serialized heartbeat stats blob (413 over).
	MaxStatsBytes = 4096
	// NodeStaleAfterSeconds marks a node stale in the registry.
	NodeStaleAfterSeconds = 90
	// OriginNodeID is the origin's stable self-row id (and name).
	OriginNodeID = "origin"
)

// statusKeepOperator promotes to active unless operator-pinned.
const statusKeepOperator = `CASE WHEN status IN ('draining', 'disabled') THEN status ELSE 'active' END`

// selectNode is the shared node SELECT with the SQL-derived stale flag.
const selectNode = `
  SELECT id, name, url, region, status, created_at, last_seen_at, stats_json,
    CASE
      WHEN last_seen_at IS NULL THEN 1
      WHEN (julianday('now') - julianday(last_seen_at)) * 86400
             > 90 THEN 1
      ELSE 0
    END AS stale
  FROM nodes
  WHERE 1 = 1`

// NodeRow is one registry row (no secrets).
type NodeRow struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	URL        *string `json:"url"`
	Region     *string `json:"region"`
	Status     string  `json:"status"`
	CreatedAt  string  `json:"created_at"`
	LastSeenAt *string `json:"last_seen_at"`
	Stats      *y.Map  `json:"stats"`
	Stale      bool    `json:"stale"`
}

// JoinLiveKit are the LiveKit bootstrap credentials.
type JoinLiveKit struct {
	APIKey    string `json:"apiKey"`
	APISecret string `json:"apiSecret"`
	WsURL     string `json:"wsUrl"`
}

// JoinPayload is returned to a joining node.
type JoinPayload struct {
	NodeID          string      `json:"nodeId"`
	Name            string      `json:"name"`
	RedisURL        *string     `json:"redisUrl"`
	PublicWsURL     *string     `json:"publicWsUrl"`
	Livekit         JoinLiveKit `json:"livekit"`
	SecretsWithheld bool        `json:"secretsWithheld,omitempty"`
	Hint            string      `json:"hint,omitempty"`
}

// JoinInput is JoinNodeDto ("" = absent).
type JoinInput struct {
	Name, IP, Region, URL, Type string
}

// ClusterInfo is GET /cluster/info.
type ClusterInfo struct {
	Enabled         bool    `json:"enabled"`
	NodesCount      int64   `json:"nodesCount"`
	ClusterToken    string  `json:"clusterToken"`
	ClusterRedisURL *string `json:"clusterRedisUrl"`
	JoinCommand     string  `json:"joinCommand"`
}

// NodePatch is PatchNodeDto (nil = untouched).
type NodePatch struct {
	Name, Region, Status *string
}

// HeartbeatEnv is what the installer writes to heartbeat.env.
type HeartbeatEnv struct {
	Role         string `json:"STREAMHUB_NODE_ROLE"`
	MasterURL    string `json:"STREAMHUB_MASTER_URL"`
	MasterNodeID string `json:"STREAMHUB_MASTER_NODE_ID"`
	NodeID       string `json:"STREAMHUB_NODE_ID"`
}

// JoinMasterResult is POST /cluster/join-master.
type JoinMasterResult struct {
	Role            string       `json:"role"`
	MasterURL       string       `json:"masterUrl"`
	NodeID          string       `json:"nodeId"`
	SecretsWithheld bool         `json:"secretsWithheld"`
	HeartbeatEnv    HeartbeatEnv `json:"heartbeatEnv"`
}

// JoinMasterInput is JoinMasterDto ("" = absent).
type JoinMasterInput struct {
	MasterURL, ClusterToken, NodeName, Region, NodeIP, NodeURL string
}

// LeaveResult is POST /cluster/leave.
type LeaveResult struct {
	Role         string `json:"role"`
	Deregistered bool   `json:"deregistered"`
	Detail       string `json:"detail,omitempty"`
}

// HTTPDoer performs the master calls (join-master / leave).
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// Service is ClusterService.
type Service struct {
	cfg  *config.Config
	db   *sql.DB
	role *NodeRole
	http HTTPDoer
	log  *slog.Logger
	// stats is the origin's own resource snapshot (sysstats.go).
	stats func(dataDir string) *y.Map
	// localIP is the best-effort non-internal IPv4.
	localIP func() string
}

// New builds the service.
func New(cfg *config.Config, global *sql.DB, role *NodeRole, doer HTTPDoer, log *slog.Logger) *Service {
	if doer == nil {
		doer = &http.Client{}
	}
	return &Service{cfg: cfg, db: global, role: role, http: doer, log: log, stats: selfStats, localIP: localIPv4}
}

// Init is onModuleInit: origin self-registration (no-op without a token).
func (s *Service) Init(ctx context.Context) {
	if err := s.registerSelf(ctx); err != nil {
		s.log.Error("origin self-register failed (continuing): " + err.Error())
	}
}

// Join registers (or refreshes, by name) a node. secure = the request came
// over TLS / loopback; over plaintext the secrets are withheld unless
// STREAMHUB_CLUSTER_REQUIRE_TLS is off. created picks 201 vs 200.
func (s *Service) Join(ctx context.Context, in JoinInput, secure bool) (payload JoinPayload, created bool, err error) {
	url := in.URL
	if url == "" {
		url = in.IP
	}
	region := nullStr(in.Region)
	var typ any
	if in.Type == "edge" || in.Type == "common" {
		typ = in.Type
	}
	var nodeID string
	err = s.db.QueryRowContext(ctx, `SELECT id FROM nodes WHERE name = ?`, in.Name).Scan(&nodeID)
	switch {
	case err == nil:
		if typ != nil {
			_, err = s.db.ExecContext(ctx, `UPDATE nodes
             SET url = ?, region = ?, type = ?, status = 'active',
                 last_seen_at = datetime('now')
           WHERE id = ?`, url, region, typ, nodeID)
		} else {
			_, err = s.db.ExecContext(ctx, `UPDATE nodes
             SET url = ?, region = ?, status = 'active',
                 last_seen_at = datetime('now')
           WHERE id = ?`, url, region, nodeID)
		}
	case errors.Is(err, sql.ErrNoRows):
		nodeID, created = uuid.NewString(), true
		if typ != nil {
			_, err = s.db.ExecContext(ctx, `INSERT INTO nodes (id, name, url, region, type, status, last_seen_at)
           VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))`, nodeID, in.Name, url, region, typ)
		} else {
			_, err = s.db.ExecContext(ctx, `INSERT INTO nodes (id, name, url, region, status, last_seen_at)
           VALUES (?, ?, ?, ?, 'active', datetime('now'))`, nodeID, in.Name, url, region)
		}
	}
	if err != nil {
		return JoinPayload{}, false, err
	}

	withhold := s.requireTLS() && !secure
	kind, extra := "refresh", ""
	if created {
		kind = "new"
	}
	if withhold {
		extra = ", secrets withheld: not TLS"
	}
	s.log.Info(fmt.Sprintf("cluster join: name=%s ip=%s nodeId=%s (%s%s)", in.Name, in.IP, nodeID, kind, extra))

	wsURL := s.cfg.LivekitURL
	if wsURL == "" {
		wsURL = "ws://127.0.0.1:7880"
	}
	payload = JoinPayload{
		NodeID: nodeID, Name: in.Name, PublicWsURL: nullStr(s.cfg.PublicWsURL),
		Livekit: JoinLiveKit{APIKey: s.cfg.LivekitAPIKey, APISecret: s.cfg.LivekitAPISecret, WsURL: wsURL},
	}
	if withhold {
		payload.Livekit.APISecret = ""
		payload.SecretsWithheld = true
		payload.Hint = "LiveKit apiSecret + Redis URL withheld: join over TLS (https, so " +
			"X-Forwarded-Proto=https at the proxy) or set " +
			"STREAMHUB_CLUSTER_REQUIRE_TLS=off on the master to allow plaintext."
	} else {
		payload.RedisURL = nullStr(s.cfg.ClusterRedisURL)
	}
	return payload, created, nil
}

// Heartbeat refreshes liveness (+ stats when non-nil, ≤ 4 KiB serialized).
// Operator-pinned statuses survive; unknown node → 404 {error}.
func (s *Service) Heartbeat(ctx context.Context, nodeID string, stats *y.Map) error {
	var (
		res sql.Result
		err error
	)
	if stats != nil {
		js, _ := y.Stringify(stats)
		if len(js) > MaxStatsBytes {
			return ObjErr(http.StatusRequestEntityTooLarge, fmt.Sprintf("stats payload too large (max %d bytes serialized)", MaxStatsBytes))
		}
		res, err = s.db.ExecContext(ctx, `UPDATE nodes
             SET status = `+statusKeepOperator+`,
                 last_seen_at = datetime('now'), stats_json = ?
           WHERE id = ?`, js, nodeID)
	} else {
		res, err = s.db.ExecContext(ctx, `UPDATE nodes
             SET status = `+statusKeepOperator+`, last_seen_at = datetime('now')
           WHERE id = ?`, nodeID)
	}
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ObjErr(http.StatusNotFound, "unknown node")
	}
	return nil
}

// ListNodes is every node, oldest first.
func (s *Service) ListNodes(ctx context.Context) ([]NodeRow, error) {
	rows, err := s.db.QueryContext(ctx, selectNode+` ORDER BY created_at ASC, name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NodeRow{}
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// GetNode is one node, or 404 {error: unknown node}.
func (s *Service) GetNode(ctx context.Context, id string) (NodeRow, error) {
	n, err := scanNode(s.db.QueryRowContext(ctx, selectNode+` AND id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return NodeRow{}, ObjErr(http.StatusNotFound, "unknown node")
	}
	return n, err
}

type scanner interface{ Scan(...any) error }

func scanNode(r scanner) (NodeRow, error) {
	var (
		n                            NodeRow
		name                         sql.NullString
		url, region, lastSeen, stats sql.NullString
		stale                        int
	)
	if err := r.Scan(&n.ID, &name, &url, &region, &n.Status, &n.CreatedAt, &lastSeen, &stats, &stale); err != nil {
		return n, err
	}
	n.Name = name.String
	n.URL, n.Region, n.LastSeenAt = ptr(url), ptr(region), ptr(lastSeen)
	n.Stats = ParseStats(stats)
	n.Stale = stale == 1
	return n, nil
}

// ParseStats parses a stored stats blob (null when absent/corrupt/not an
// object), keeping JS key order.
func ParseStats(js sql.NullString) *y.Map {
	if !js.Valid || js.String == "" {
		return nil
	}
	v, err := y.ParseJSON([]byte(js.String))
	if err != nil {
		return nil
	}
	m, _ := v.(*y.Map)
	return m
}

// Info is the dashboard overview.
func (s *Service) Info(ctx context.Context) (ClusterInfo, error) {
	var n int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM nodes`).Scan(&n); err != nil {
		return ClusterInfo{}, err
	}
	token := s.cfg.ClusterToken
	return ClusterInfo{
		Enabled: token != "", NodesCount: n, ClusterToken: token, ClusterRedisURL: nullStr(s.cfg.ClusterRedisURL),
		JoinCommand: "curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- " +
			"--join --master-token " + token + " --master-ip <THIS_SERVER_IP> " +
			"--master-url " + s.masterURL(),
	}, nil
}

// RemoveNode deletes a node (404 when unknown).
func (s *Service) RemoveNode(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM nodes WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ObjErr(http.StatusNotFound, "unknown node")
	}
	s.log.Info("cluster node removed: id=" + id)
	return nil
}

// UpdateNode patches name/region/status and returns the enriched row.
func (s *Service) UpdateNode(ctx context.Context, id string, p NodePatch) (NodeRow, error) {
	var one int
	if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM nodes WHERE id = ?`, id).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return NodeRow{}, ObjErr(http.StatusNotFound, "unknown node")
		}
		return NodeRow{}, err
	}
	var sets []string
	var vals []any
	for _, f := range []struct {
		col string
		v   *string
	}{{"name", p.Name}, {"region", p.Region}, {"status", p.Status}} {
		if f.v != nil {
			sets = append(sets, f.col+" = ?")
			vals = append(vals, *f.v)
		}
	}
	if len(sets) > 0 {
		if _, err := s.db.ExecContext(ctx, `UPDATE nodes SET `+strings.Join(sets, ", ")+` WHERE id = ?`, append(vals, id)...); err != nil {
			return NodeRow{}, err
		}
	}
	return s.GetNode(ctx, id)
}

// JoinMaster converts this node into an edge of a remote master.
func (s *Service) JoinMaster(ctx context.Context, in JoinMasterInput) (JoinMasterResult, error) {
	master := strings.TrimRight(strings.TrimSpace(in.MasterURL), "/")
	ip := strings.TrimSpace(in.NodeIP)
	if ip == "" {
		ip = s.localIP()
	}
	body := y.NewMap()
	body.Set("name", in.NodeName)
	body.Set("ip", ip)
	if in.Region != "" {
		body.Set("region", in.Region)
	}
	if in.NodeURL != "" {
		body.Set("url", in.NodeURL)
	}
	status, js, err := s.httpJSON(ctx, http.MethodPost, master+"/api/v1/cluster/join", map[string]string{"x-cluster-token": in.ClusterToken}, body)
	if err != nil {
		return JoinMasterResult{}, err
	}
	if status < 200 || status > 299 {
		return JoinMasterResult{}, ObjErr(http.StatusBadGateway, fmt.Sprintf("master rejected join (HTTP %d)", status))
	}
	var env struct {
		Data struct {
			NodeID          any `json:"nodeId"`
			SecretsWithheld any `json:"secretsWithheld"`
		} `json:"data"`
	}
	_ = json.Unmarshal(js, &env)
	nodeID, _ := env.Data.NodeID.(string)
	if nodeID == "" {
		return JoinMasterResult{}, ObjErr(http.StatusBadGateway, "master join response missing nodeId")
	}
	if err := s.role.SetRole(ctx, RoleEdge); err != nil {
		return JoinMasterResult{}, err
	}
	_ = s.role.SetMasterURL(ctx, master)
	_ = s.role.SetMasterNodeID(ctx, nodeID)
	s.log.Info(fmt.Sprintf("joined master %s as edge nodeId=%s", master, nodeID))
	return JoinMasterResult{
		Role: RoleEdge, MasterURL: master, NodeID: nodeID, SecretsWithheld: env.Data.SecretsWithheld == true,
		HeartbeatEnv: HeartbeatEnv{Role: RoleEdge, MasterURL: master, MasterNodeID: nodeID, NodeID: nodeID},
	}, nil
}

// Leave reverts to standalone (always), then best-effort de-registers.
func (s *Service) Leave(ctx context.Context, masterToken string) (LeaveResult, error) {
	master := s.role.MasterURL(ctx)
	nodeID := s.role.MasterNodeID(ctx)
	if err := s.role.SetRole(ctx, RoleStandalone); err != nil {
		return LeaveResult{}, err
	}
	_ = s.role.SetMasterURL(ctx, "")
	_ = s.role.SetMasterNodeID(ctx, "")
	s.log.Info("left cluster: role reverted to standalone")

	if master == nil || nodeID == nil {
		return LeaveResult{Role: RoleStandalone, Detail: "no master linkage on record"}, nil
	}
	if masterToken == "" {
		return LeaveResult{Role: RoleStandalone, Detail: "no masterToken supplied — de-register at the master manually"}, nil
	}
	status, _, err := s.httpJSON(ctx, http.MethodDelete, *master+"/api/v1/cluster/nodes/"+jsx.EncodeURIComponent(*nodeID),
		map[string]string{"authorization": "Bearer " + masterToken}, nil)
	if err != nil {
		// Node reports (err as Error).message of the BadGatewayException built
		// from an object: its class-derived default message.
		return LeaveResult{Role: RoleStandalone, Detail: "de-register failed: Bad Gateway Exception"}, nil
	}
	ok := status >= 200 && status <= 299
	r := LeaveResult{Role: RoleStandalone, Deregistered: ok}
	if !ok {
		r.Detail = fmt.Sprintf("master returned HTTP %d", status)
	}
	return r, nil
}

// registerSelf keeps the stable `origin` row (only with a cluster token).
func (s *Service) registerSelf(ctx context.Context) error {
	if s.cfg.ClusterToken == "" {
		return nil
	}
	url := nullStr(s.masterURL())
	stats, _ := y.Stringify(s.stats(s.cfg.DataDir))
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM nodes WHERE id = ?`, OriginNodeID).Scan(&id)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if exists {
		_, err = s.db.ExecContext(ctx, `UPDATE nodes
           SET url = ?, status = `+statusKeepOperator+`,
               last_seen_at = datetime('now'), stats_json = ?
         WHERE id = ?`, url, stats, OriginNodeID)
	} else {
		_, err = s.db.ExecContext(ctx, `INSERT INTO nodes (id, name, url, region, status, last_seen_at, stats_json)
         VALUES (?, 'origin', ?, 'origin', 'active', datetime('now'), ?)`, OriginNodeID, url, stats)
	}
	if err != nil {
		return err
	}
	kind := "new"
	if exists {
		kind = "refresh"
	}
	s.log.Info("cluster self-register: origin node present in registry (" + kind + ")")
	return nil
}

// masterURL is STREAMHUB_PUBLIC_URL || PUBLIC_BASE_URL without trailing /.
func (s *Service) masterURL() string {
	raw := s.cfg.Env("STREAMHUB_PUBLIC_URL")
	if raw == "" {
		raw = s.cfg.PublicBaseURL
	}
	return strings.TrimRight(raw, "/")
}

// requireTLS is STREAMHUB_CLUSTER_REQUIRE_TLS (default on).
func (s *Service) requireTLS() bool {
	switch strings.ToLower(strings.TrimSpace(s.cfg.Env("STREAMHUB_CLUSTER_REQUIRE_TLS"))) {
	case "0", "false", "off", "no":
		return false
	}
	return true
}

// httpJSON is the master-call client: 10s timeout, JSON body when given; a
// non-2xx is a status (not an error); a network failure / timeout → 502.
func (s *Service) httpJSON(ctx context.Context, method, target string, headers map[string]string, body *y.Map) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var rd io.Reader
	if body != nil {
		js, _ := y.Stringify(body)
		rd = bytes.NewBufferString(js)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rd)
	if err != nil {
		return 0, nil, ObjErr(http.StatusBadGateway, fmt.Sprintf("could not reach %s: %s", target, "fetch failed"))
	}
	req.Header.Set("accept", "application/json")
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := s.http.Do(req)
	if err != nil {
		reason := "fetch failed" // undici's message for every network-level failure
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			reason = "timeout after 10s"
		}
		return 0, nil, ObjErr(http.StatusBadGateway, fmt.Sprintf("could not reach %s: %s", target, reason))
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, raw, nil
}

// IsSecure: X-Forwarded-Proto https, a TLS socket, or a loopback client.
func IsSecure(r *http.Request) bool {
	xfp := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]))
	if xfp == "https" || r.TLS != nil {
		return true
	}
	ip := ClientIP(r)
	return ip == "127.0.0.1" || ip == "::1" || ip == "localhost"
}

// ClientIP is the proxy-validated client IP with ::ffff: stripped.
func ClientIP(r *http.Request) string {
	return strings.TrimPrefix(httpx.ClientIP(r), "::ffff:")
}

func localIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "127.0.0.1"
	}
	for _, iface := range ifaces {
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && !n.IP.IsLoopback() {
				return n.IP.String()
			}
		}
	}
	return "127.0.0.1"
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func ptr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	return &n.String
}

// round is Number(x.toFixed(d)).
func round(x float64, d int) float64 {
	p := math.Pow(10, float64(d))
	return math.Round(x*p) / p
}
