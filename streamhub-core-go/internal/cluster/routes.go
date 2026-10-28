package cluster

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// OffenseSink feeds a failed X-Cluster-Token to the auto-ban
// (IpReputationService.recordOffense(ip, 'invalid_token')).
type OffenseSink func(ip string)

// Routes is ClusterController.
type Routes struct {
	svc     *Service
	offense OffenseSink
}

// NewRoutes wraps the service; offense may be nil.
func NewRoutes(s *Service, offense OffenseSink) *Routes { return &Routes{svc: s, offense: offense} }

var nameRE = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

func op(id, method, path, summary string, status int) *huma.Operation {
	return &huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"cluster"}, DefaultStatus: status}
}

// statusOut lets join pick 201 vs 200 at runtime.
type statusOut[T any] struct {
	Status int
	Body   T
}

// Register implements api.Module.
func (m *Routes) Register(a huma.API) {
	huma.Register(a, *api.Public(op("ClusterController_join", http.MethodPost, "/cluster/join",
		"Register an edge node (X-Cluster-Token).", http.StatusCreated)),
		func(ctx context.Context, in *api.RawBodyInput) (*statusOut[api.Envelope[JoinPayload]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Field("name").Matches(nameRE, "name may only contain a-z A-Z 0-9 . _ -").Length(1, 64).IsString()
			b.Field("ip").Check(IsIP(b.Raw("ip")), "ip must be a valid IPv4 or IPv6 address").IsString()
			b.Optional("region").MaxLength(64).IsString()
			b.Optional("url").MaxLength(255).IsString()
			b.Optional("type").IsIn("common", "edge")
			if err := b.Err(); err != nil {
				return nil, err
			}
			r := api.Request(ctx)
			if err := m.assertToken(r); err != nil {
				return nil, err
			}
			payload, created, err := m.svc.Join(ctx, JoinInput{
				Name: b.String("name"), IP: b.String("ip"), Region: b.String("region"), URL: b.String("url"), Type: b.String("type"),
			}, IsSecure(r))
			if err != nil {
				return nil, err
			}
			status := http.StatusOK
			if created {
				status = http.StatusCreated
			}
			return &statusOut[api.Envelope[JoinPayload]]{Status: status, Body: api.Envelope[JoinPayload]{Data: payload}}, nil
		})

	type heartbeatOK struct {
		OK bool `json:"ok"`
	}
	huma.Register(a, *api.Public(op("ClusterController_heartbeat", http.MethodPost, "/cluster/heartbeat",
		"Node liveness ping (X-Cluster-Token).", http.StatusOK)),
		func(ctx context.Context, in *api.RawBodyInput) (*api.Out[api.Envelope[heartbeatOK]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Field("nodeId").MaxLength(64).Check(b.Raw("nodeId") != nil && b.Raw("nodeId") != "", "nodeId should not be empty").IsString()
			b.Optional("stats").IsObject()
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := m.assertToken(api.Request(ctx)); err != nil {
				return nil, err
			}
			if err := m.svc.Heartbeat(ctx, b.String("nodeId"), orderedObject(in.RawBody, "stats")); err != nil {
				return nil, err
			}
			return api.OK(heartbeatOK{true}), nil
		})

	huma.Register(a, *api.Bearer(op("ClusterController_info", http.MethodGet, "/cluster/info",
		"Cluster overview for the dashboard manager.", http.StatusOK)),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[ClusterInfo]], error) {
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			info, err := m.svc.Info(ctx)
			if err != nil {
				return nil, err
			}
			return api.OK(info), nil
		})

	huma.Register(a, *api.Bearer(op("ClusterController_listNodes", http.MethodGet, "/cluster/nodes",
		"List registered cluster nodes.", http.StatusOK)),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[[]NodeRow]], error) {
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			nodes, err := m.svc.ListNodes(ctx)
			if err != nil {
				return nil, err
			}
			return api.OK(nodes), nil
		})

	type patchIn struct {
		ID      string `path:"id"`
		RawBody []byte
	}
	huma.Register(a, *api.Bearer(op("ClusterController_patchNode", http.MethodPatch, "/cluster/nodes/{id}",
		"Update a node's name/region/status.", http.StatusOK)),
		func(ctx context.Context, in *patchIn) (*api.Out[api.Envelope[NodeRow]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Optional("name").Matches(nameRE, "name may only contain a-z A-Z 0-9 . _ -").Length(1, 64).IsString()
			b.Optional("region").MaxLength(64).IsString()
			b.Optional("status").IsIn("active", "draining", "disabled")
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			row, err := m.svc.UpdateNode(ctx, in.ID, NodePatch{Name: b.StringPtr("name"), Region: b.StringPtr("region"), Status: b.StringPtr("status")})
			if err != nil {
				return nil, err
			}
			return api.OK(row), nil
		})

	type idIn struct {
		ID string `path:"id"`
	}
	type nodeDeleted struct {
		ID      string `json:"id"`
		Deleted bool   `json:"deleted"`
	}
	huma.Register(a, *api.Bearer(op("ClusterController_removeNode", http.MethodDelete, "/cluster/nodes/{id}",
		"Remove a node from the registry.", http.StatusOK)),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[nodeDeleted]], error) {
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			if err := m.svc.RemoveNode(ctx, in.ID); err != nil {
				return nil, err
			}
			return api.OK(nodeDeleted{in.ID, true}), nil
		})

	huma.Register(a, *api.Bearer(op("ClusterController_joinMaster", http.MethodPost, "/cluster/join-master",
		"Convert this node into a cluster EDGE of a remote master.", http.StatusOK)),
		func(ctx context.Context, in *api.RawBodyInput) (*api.Out[api.Envelope[JoinMasterResult]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Field("masterUrl").MaxLength(255).Check(IsHTTPURL(b.Raw("masterUrl")), "masterUrl must be an http(s) URL").IsString()
			b.Field("clusterToken").MaxLength(512).Check(b.Raw("clusterToken") != nil && b.Raw("clusterToken") != "", "clusterToken should not be empty").IsString()
			b.Field("nodeName").Matches(nameRE, "nodeName may only contain a-z A-Z 0-9 . _ -").Length(1, 64).IsString()
			b.Optional("region").MaxLength(64).IsString()
			b.Optional("nodeIp").Check(IsIP(b.Raw("nodeIp")), "nodeIp must be a valid IPv4 or IPv6 address").IsString()
			b.Optional("nodeUrl").MaxLength(255).IsString()
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			res, err := m.svc.JoinMaster(ctx, JoinMasterInput{
				MasterURL: b.String("masterUrl"), ClusterToken: b.String("clusterToken"), NodeName: b.String("nodeName"),
				Region: b.String("region"), NodeIP: b.String("nodeIp"), NodeURL: b.String("nodeUrl"),
			})
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})

	huma.Register(a, *api.Bearer(op("ClusterController_leave", http.MethodPost, "/cluster/leave",
		"Leave the cluster: revert this node to standalone.", http.StatusOK)),
		func(ctx context.Context, in *api.RawBodyInput) (*api.Out[api.Envelope[LeaveResult]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Optional("masterToken").MaxLength(512).IsString()
			if err := b.Err(); err != nil {
				return nil, err
			}
			if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
				return nil, err
			}
			res, err := m.svc.Leave(ctx, b.String("masterToken"))
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})
}

func (m *Routes) assertToken(r *http.Request) error {
	return AssertToken(r, m.svc.cfg.ClusterToken, "", func() {
		if m.offense != nil {
			m.offense(ClientIP(r))
		}
	})
}

// orderedObject re-reads a top-level object property of a JSON body with JS
// key order (nil when absent / not an object).
func orderedObject(raw []byte, key string) *y.Map {
	v, err := y.ParseJSON(raw)
	if err != nil {
		return nil
	}
	root, ok := v.(*y.Map)
	if !ok {
		return nil
	}
	obj, _ := root.Get(key).(*y.Map)
	return obj
}

// IsIP is validator.js isIP (v4 or v6; zone ids allowed on v6).
func IsIP(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return false
	}
	if addr.Is4() {
		return !strings.Contains(s, ":")
	}
	return true
}

var hostLabel = regexp.MustCompile(`^[a-zA-Z0-9\x{00a1}-\x{ffff}]([a-zA-Z0-9\x{00a1}-\x{ffff}-]*[a-zA-Z0-9\x{00a1}-\x{ffff}])?$`)

// IsHTTPURL approximates validator.js isURL({protocols: [http, https],
// require_tld: false, require_protocol: true}).
func IsHTTPURL(v any) bool {
	s, ok := v.(string)
	if !ok || s == "" || len(s) >= 2083 || strings.ContainsAny(s, " \t\r\n<>") {
		return false
	}
	lower := strings.ToLower(s)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return false
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return false
	}
	host := u.Hostname()
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n <= 0 || n > 65535 {
			return false
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if host == "localhost" || IsIP(host) {
		return true
	}
	for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
		if len(label) > 63 || !hostLabel.MatchString(label) {
			return false
		}
	}
	return true
}
