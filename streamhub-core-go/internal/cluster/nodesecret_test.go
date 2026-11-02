package cluster

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// C5.3 — per-node credential: the cluster token only joins; every later call
// carries the node's own secret.

func TestNodeSecretDerivation(t *testing.T) {
	a, b := NodeSecret("ct", "n-1"), NodeSecret("ct", "n-2")
	if len(a) != 64 || a == b || a == NodeSecret("other", "n-1") || a != NodeSecret("ct", "n-1") {
		t.Fatal(a, b)
	}
	if strings.Contains(a, "ct") || NodeSecret("", "n-1") != "" || NodeSecret("ct", "") != "" {
		t.Fatal("blank inputs derive nothing")
	}
	for v, want := range map[string]bool{"": true, "on": true, "1": true, "off": false, "0": false, " FALSE ": false, "no": false} {
		if got := LegacyTokenAllowed(env(map[string]string{LegacyTokenEnv: v})); got != want {
			t.Errorf("%q → %v", v, got)
		}
	}
	if !LegacyTokenAllowed(nil) {
		t.Fatal("default on")
	}
}

func TestJoinVendsNodeSecret(t *testing.T) {
	ctx := context.Background()
	s, _ := setup(t, config.Config{ClusterToken: "ct", LivekitAPIKey: "k", LivekitAPISecret: "sec"})
	p, _, err := s.Join(ctx, JoinInput{Name: "edge-a", IP: "203.0.113.10"}, true)
	if err != nil || p.NodeSecret == "" || p.NodeSecret != NodeSecret("ct", p.NodeID) {
		t.Fatalf("%+v %v", p, err)
	}
	// stable across a refresh (same id), distinct per node
	p2, _, _ := s.Join(ctx, JoinInput{Name: "edge-a", IP: "203.0.113.10"}, true)
	q, _, _ := s.Join(ctx, JoinInput{Name: "edge-b", IP: "203.0.113.11"}, true)
	if p2.NodeSecret != p.NodeSecret || q.NodeSecret == p.NodeSecret {
		t.Fatal("secret must follow the node id")
	}
	// vended over plaintext too (the join itself carried the token)
	w, _, _ := s.Join(ctx, JoinInput{Name: "edge-c", IP: "203.0.113.12"}, false)
	if !w.SecretsWithheld || w.NodeSecret != NodeSecret("ct", w.NodeID) {
		t.Fatalf("%+v", w)
	}
	js, _ := json.Marshal(p)
	if !strings.Contains(string(js), `"nodeSecret":"`+p.NodeSecret+`"`) {
		t.Fatal(string(js))
	}
}

// hbServer mounts the cluster routes over a fresh service.
func hbServer(t *testing.T, legacy string) (*Service, http.Handler, *[]string) {
	t.Helper()
	t.Setenv(LegacyTokenEnv, legacy)
	s, _ := setup(t, config.Config{ClusterToken: "ct"})
	s.Init(context.Background()) // the origin row
	var offenses []string
	mux := http.NewServeMux()
	NewRoutes(s, func(ip string) { offenses = append(offenses, ip) }).Register(api.New(mux, "test"))
	return s, httpx.WithRequest(mux), &offenses
}

func heartbeat(h http.Handler, nodeID string, headers map[string]string) int {
	r := httptest.NewRequest("POST", "/api/v1/cluster/heartbeat", strings.NewReader(`{"nodeId":"`+nodeID+`"}`))
	r.Header.Set("content-type", "application/json")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Code
}

func TestHeartbeatNodeSecret(t *testing.T) {
	for _, legacy := range []string{"", "off"} {
		s, h, offenses := hbServer(t, legacy)
		ctx := context.Background()
		a, _, _ := s.Join(ctx, JoinInput{Name: "a", IP: "1.1.1.1"}, true)
		b, _, _ := s.Join(ctx, JoinInput{Name: "b", IP: "1.1.1.2"}, true)
		legacyOn := legacy == ""
		globalOK := 401
		if legacyOn {
			globalOK = 200
		}
		for name, c := range map[string]struct {
			node    string
			headers map[string]string
			want    int
		}{
			"own secret":                  {a.NodeID, map[string]string{NodeSecretHeader: a.NodeSecret}, 200},
			"own secret in cluster hdr":   {a.NodeID, map[string]string{"X-Cluster-Token": a.NodeSecret}, 200},
			"other node's secret":         {a.NodeID, map[string]string{NodeSecretHeader: b.NodeSecret}, 401},
			"other's secret, cluster hdr": {a.NodeID, map[string]string{"X-Cluster-Token": b.NodeSecret}, 401},
			"secret for an unknown node":  {"ghost", map[string]string{NodeSecretHeader: NodeSecret("ct", "ghost")}, 404},
			"shared token":                {a.NodeID, map[string]string{"X-Cluster-Token": "ct"}, globalOK},
			"shared token as secret":      {a.NodeID, map[string]string{NodeSecretHeader: "ct"}, globalOK},
			"origin with shared token":    {OriginNodeID, map[string]string{"X-Cluster-Token": "ct"}, 200},
			"nothing":                     {a.NodeID, nil, 401},
		} {
			if got := heartbeat(h, c.node, c.headers); got != c.want {
				t.Errorf("legacy=%q %s → %d, want %d", legacy, name, got, c.want)
			}
		}
		if len(*offenses) == 0 {
			t.Errorf("legacy=%q: a refused heartbeat must feed the auto-ban", legacy)
		}
	}
	// no cluster token → 503, as before
	t.Setenv(LegacyTokenEnv, "")
	s, _ := setup(t, config.Config{})
	mux := http.NewServeMux()
	NewRoutes(s, nil).Register(api.New(mux, "test"))
	if got := heartbeat(httpx.WithRequest(mux), "x", map[string]string{"X-Cluster-Token": "ct"}); got != 503 {
		t.Fatal(got)
	}
}

func TestNodeAuthCheckAny(t *testing.T) {
	ctx := context.Background()
	_, g, _ := testutil.Store(t)
	testutil.Exec(t, g, `INSERT INTO nodes (id, name, status) VALUES ('n1', 'a', 'active')`)
	on := NewNodeAuth(g, func() string { return "ct" }, true, testutil.Log())
	off := NewNodeAuth(g, func() string { return "ct" }, false, testutil.Log())
	for name, c := range map[string]struct {
		a    *NodeAuth
		p    string
		want Credential
	}{
		"registered node":    {off, NodeSecret("ct", "n1"), CredNode},
		"deleted/unknown":    {off, NodeSecret("ct", "n2"), CredNone},
		"shared, legacy on":  {on, "ct", CredLegacy},
		"shared, legacy off": {off, "ct", CredNone},
		"junk":               {on, "nope", CredNone},
		"blank":              {on, "", CredNone},
	} {
		if got := c.a.CheckAny(ctx, "test", c.p); got != c.want {
			t.Errorf("%s → %v", name, got)
		}
	}
	if NewNodeAuth(g, func() string { return "" }, true, nil).CheckAny(ctx, "test", "") != CredNone {
		t.Fatal("disabled")
	}
}

func TestJoinMasterStoresNodeSecret(t *testing.T) {
	ctx := context.Background()
	s, _ := setup(t, config.Config{})
	s.http = &fakeDoer{status: 201, body: `{"data":{"nodeId":"n-1","nodeSecret":"s3cr3t"},"error":null}`}
	res, err := s.JoinMaster(ctx, JoinMasterInput{MasterURL: "https://m", ClusterToken: "ct", NodeName: "e1", NodeIP: "10.0.0.1"})
	if err != nil || res.HeartbeatEnv.NodeSecret != "s3cr3t" {
		t.Fatalf("%+v %v", res, err)
	}
	if v := s.role.NodeSecret(ctx); v == nil || *v != "s3cr3t" {
		t.Fatal("node secret not stored")
	}
	js, _ := json.Marshal(res.HeartbeatEnv)
	if !strings.Contains(string(js), `"STREAMHUB_NODE_SECRET":"s3cr3t"`) {
		t.Fatal(string(js))
	}
	// the cluster token itself is never stored on the node
	var n int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM _streamhub_meta WHERE value = 'ct'`).Scan(&n)
	if n != 0 {
		t.Fatal("cluster token persisted on the node")
	}
	if _, err := s.Leave(ctx, ""); err != nil || s.role.NodeSecret(ctx) != nil {
		t.Fatal("leave must drop the node secret")
	}
	// env fallback (install.sh --join writes STREAMHUB_NODE_SECRET)
	r := NewNodeRole(s.db, env(map[string]string{NodeSecretEnv: "from-env"}), testutil.Log())
	if v := r.NodeSecret(ctx); v == nil || *v != "from-env" {
		t.Fatal("env fallback")
	}
}
