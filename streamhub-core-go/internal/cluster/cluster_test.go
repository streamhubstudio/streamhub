package cluster

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Ports cluster.service.spec.ts, cluster.controller.spec.ts (service side),
// cluster.conversion.spec.ts and node-role.service.spec.ts.

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func setup(t *testing.T, cfg config.Config) (*Service, *sql.DB) {
	t.Helper()
	_, g, dir := testutil.Store(t)
	cfg.DataDir = dir
	t.Setenv("STREAMHUB_CLUSTER_REQUIRE_TLS", "")
	t.Setenv("STREAMHUB_PUBLIC_URL", "")
	role := NewNodeRole(g, env(nil), testutil.Log())
	s := New(&cfg, g, role, nil, testutil.Log())
	s.stats = func(string) *y.Map { m := y.NewMap(); m.Set("role", "origin"); m.Set("cores", 4.0); return m }
	return s, g
}

func status(err error) int {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

func body(err error) string {
	var he *httpx.Error
	if errors.As(err, &he) {
		b, _ := json.Marshal(he.Body)
		return string(b)
	}
	return ""
}

func row(t *testing.T, g *sql.DB, id string) (url, region, status, typ string, lastSeen, stats sql.NullString) {
	t.Helper()
	var u, r sql.NullString
	if err := g.QueryRow(`SELECT url, region, status, type, last_seen_at, stats_json FROM nodes WHERE id = ?`, id).Scan(&u, &r, &status, &typ, &lastSeen, &stats); err != nil {
		t.Fatal(err)
	}
	return u.String, r.String, status, typ, lastSeen, stats
}

func TestJoin(t *testing.T) {
	ctx := context.Background()
	s, g := setup(t, config.Config{LivekitAPIKey: "k", LivekitAPISecret: "sec", ClusterRedisURL: "redis://c:6379", PublicWsURL: "wss://p"})
	p, created, err := s.Join(ctx, JoinInput{Name: "edge-a", IP: "203.0.113.10", Region: "eu", Type: "edge"}, true)
	if err != nil || !created || len(p.NodeID) != 36 {
		t.Fatal(p, created, err)
	}
	if *p.RedisURL != "redis://c:6379" || *p.PublicWsURL != "wss://p" || p.Livekit != (JoinLiveKit{"k", "sec", "ws://127.0.0.1:7880"}) || p.SecretsWithheld {
		t.Fatalf("%+v", p)
	}
	url, region, st, typ, seen, _ := row(t, g, p.NodeID)
	if url != "203.0.113.10" || region != "eu" || st != "active" || typ != "edge" || !seen.Valid {
		t.Fatal(url, region, st, typ)
	}
	// upsert by name keeps the id; url wins over ip; type omitted → kept
	p2, created2, _ := s.Join(ctx, JoinInput{Name: "edge-a", IP: "::1", URL: "https://e"}, true)
	if created2 || p2.NodeID != p.NodeID {
		t.Fatal("re-join must refresh")
	}
	if url, region, _, typ, _, _ := row(t, g, p.NodeID); url != "https://e" || region != "" || typ != "edge" {
		t.Fatal(url, region, typ)
	}
}

func TestJoinSecretGating(t *testing.T) {
	ctx := context.Background()
	s, _ := setup(t, config.Config{LivekitAPIKey: "k", LivekitAPISecret: "sec", ClusterRedisURL: "redis://c"})
	p, _, _ := s.Join(ctx, JoinInput{Name: "n", IP: "1.2.3.4"}, false)
	if !p.SecretsWithheld || p.Livekit.APISecret != "" || p.RedisURL != nil || !strings.HasPrefix(p.Hint, "LiveKit apiSecret + Redis URL withheld") || p.Livekit.APIKey != "k" {
		t.Fatalf("%+v", p)
	}
	t.Setenv("STREAMHUB_CLUSTER_REQUIRE_TLS", "off")
	p, _, _ = s.Join(ctx, JoinInput{Name: "n", IP: "1.2.3.4"}, false)
	if p.SecretsWithheld || p.Livekit.APISecret != "sec" {
		t.Fatalf("%+v", p)
	}
	b, _ := json.Marshal(p)
	if strings.Contains(string(b), "secretsWithheld") || strings.Contains(string(b), "hint") {
		t.Fatal("absent fields must be omitted")
	}
}

func TestIsSecure(t *testing.T) {
	mk := func(remote string, h map[string]string) *http.Request {
		r := httptest.NewRequest("POST", "/", nil)
		r.RemoteAddr = remote
		for k, v := range h {
			r.Header.Set(k, v)
		}
		return r
	}
	cases := []struct {
		r    *http.Request
		want bool
	}{
		{mk("203.0.113.5:1", map[string]string{"X-Forwarded-Proto": "https, http"}), true},
		{mk("203.0.113.5:1", nil), false},
		{mk("127.0.0.1:1", nil), true},
		{mk("[::1]:1", nil), true},
		{mk("[::ffff:127.0.0.1]:1", nil), true},
	}
	for i, c := range cases {
		if got := IsSecure(c.r); got != c.want {
			t.Errorf("%d: %v", i, got)
		}
	}
}

func TestHeartbeat(t *testing.T) {
	ctx := context.Background()
	s, g := setup(t, config.Config{})
	p, _, _ := s.Join(ctx, JoinInput{Name: "n", IP: "1.2.3.4"}, true)
	if err := s.Heartbeat(ctx, "ghost", nil); status(err) != 404 || body(err) != `{"error":"unknown node"}` {
		t.Fatal(err)
	}
	stats := y.NewMap()
	stats.Set("cpu", 0.5)
	stats.Set("a", []any{1.0})
	if err := s.Heartbeat(ctx, p.NodeID, stats); err != nil {
		t.Fatal(err)
	}
	_, _, _, _, _, js := row(t, g, p.NodeID)
	if js.String != `{"cpu":0.5,"a":[1]}` {
		t.Fatal(js.String)
	}
	// bare ping keeps stats
	_ = s.Heartbeat(ctx, p.NodeID, nil)
	if _, _, _, _, _, js := row(t, g, p.NodeID); js.String != `{"cpu":0.5,"a":[1]}` {
		t.Fatal("bare ping touched stats")
	}
	big := y.NewMap()
	big.Set("blob", strings.Repeat("x", 4100))
	if err := s.Heartbeat(ctx, p.NodeID, big); status(err) != 413 || body(err) != `{"error":"stats payload too large (max 4096 bytes serialized)"}` {
		t.Fatal(err)
	}
	// operator-pinned statuses survive; down/unknown are promoted
	for _, c := range []struct{ set, want string }{{"draining", "draining"}, {"disabled", "disabled"}, {"down", "active"}, {"unknown", "active"}} {
		testutil.Exec(t, g, `UPDATE nodes SET status = ? WHERE id = ?`, c.set, p.NodeID)
		_ = s.Heartbeat(ctx, p.NodeID, nil)
		if _, _, st, _, _, _ := row(t, g, p.NodeID); st != c.want {
			t.Errorf("%s → %s", c.set, st)
		}
	}
}

func TestListInfoPatchRemove(t *testing.T) {
	ctx := context.Background()
	s, g := setup(t, config.Config{ClusterToken: "tok", PublicBaseURL: "https://m.example.com/"})
	if l, _ := s.ListNodes(ctx); len(l) != 0 {
		t.Fatal("fresh registry")
	}
	p, _, _ := s.Join(ctx, JoinInput{Name: "b", IP: "1.1.1.1"}, true)
	testutil.Exec(t, g, `INSERT INTO nodes (id, name, status) VALUES ('never', 'a', 'unknown')`)
	testutil.Exec(t, g, `UPDATE nodes SET stats_json = '{"z":1,"a":2}' WHERE id = ?`, p.NodeID)
	testutil.Exec(t, g, `UPDATE nodes SET stats_json = '[1]' WHERE id = 'never'`)
	nodes, _ := s.ListNodes(ctx)
	if len(nodes) != 2 {
		t.Fatal(nodes)
	}
	for _, n := range nodes {
		js, _ := json.Marshal(n)
		switch n.ID {
		case p.NodeID:
			if n.Stale || !strings.Contains(string(js), `"stats":{"z":1,"a":2}`) {
				t.Fatal(string(js))
			}
		case "never":
			if !n.Stale || n.Stats != nil || n.LastSeenAt != nil {
				t.Fatal(string(js))
			}
		}
	}
	testutil.Exec(t, g, `UPDATE nodes SET last_seen_at = datetime('now', '-91 seconds') WHERE id = ?`, p.NodeID)
	if n, _ := s.GetNode(ctx, p.NodeID); !n.Stale {
		t.Fatal("91s old must be stale")
	}

	info, _ := s.Info(ctx)
	if !info.Enabled || info.NodesCount != 2 || info.ClusterToken != "tok" || info.ClusterRedisURL != nil ||
		info.JoinCommand != "curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- --join --master-token tok --master-ip <THIS_SERVER_IP> --master-url https://m.example.com" {
		t.Fatalf("%+v", info)
	}

	name, st := "renamed", "draining"
	n, err := s.UpdateNode(ctx, p.NodeID, NodePatch{Name: &name, Status: &st})
	if err != nil || n.Name != "renamed" || n.Status != "draining" {
		t.Fatal(n, err)
	}
	if n2, _ := s.UpdateNode(ctx, p.NodeID, NodePatch{}); n2.Name != "renamed" {
		t.Fatal("empty patch")
	}
	if _, err := s.UpdateNode(ctx, "ghost", NodePatch{}); status(err) != 404 {
		t.Fatal(err)
	}
	if err := s.RemoveNode(ctx, p.NodeID); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveNode(ctx, p.NodeID); status(err) != 404 {
		t.Fatal(err)
	}
}

func TestInfoDisabled(t *testing.T) {
	s, _ := setup(t, config.Config{})
	info, _ := s.Info(context.Background())
	if info.Enabled || info.ClusterRedisURL != nil || !strings.Contains(info.JoinCommand, "--master-token  --master-ip") {
		t.Fatalf("%+v", info)
	}
}

func TestRegisterSelf(t *testing.T) {
	ctx := context.Background()
	s, g := setup(t, config.Config{})
	s.Init(ctx)
	var n int
	_ = g.QueryRow(`SELECT COUNT(*) FROM nodes`).Scan(&n)
	if n != 0 {
		t.Fatal("no token: no self-row")
	}
	s.cfg.ClusterToken = "tok"
	s.cfg.PublicBaseURL = "https://origin.example.com//"
	s.Init(ctx)
	url, region, st, _, seen, stats := row(t, g, OriginNodeID)
	var name string
	_ = g.QueryRow(`SELECT name FROM nodes WHERE id = 'origin'`).Scan(&name)
	if name != "origin" || region != "origin" || st != "active" || url != "https://origin.example.com" || !seen.Valid || stats.String != `{"role":"origin","cores":4}` {
		t.Fatal(name, region, st, url, stats.String)
	}
	testutil.Exec(t, g, `UPDATE nodes SET status = 'draining' WHERE id = 'origin'`)
	s.Init(ctx)
	_ = g.QueryRow(`SELECT COUNT(*) FROM nodes`).Scan(&n)
	if _, _, st, _, _, _ := row(t, g, OriginNodeID); n != 1 || st != "draining" {
		t.Fatal(n, st)
	}
}

func TestSelfStatsShape(t *testing.T) {
	js, _ := y.Stringify(selfStats(t.TempDir()))
	for _, k := range []string{`{"role":"origin","cores":`, `"loadavg1":`, `"cpu":`, `"memTotal":`, `"memFree":`, `"memUsedRatio":`, `"disk":{"total":`} {
		if !strings.Contains(js, k) {
			t.Fatalf("%s missing in %s", k, js)
		}
	}
}

func TestNodeRole(t *testing.T) {
	ctx := context.Background()
	for in, want := range map[string]string{"EDGE": "edge", " master ": "master", "standalone": "standalone", "junk": "standalone", "": "standalone"} {
		if CoerceRole(in) != want {
			t.Errorf("%q", in)
		}
	}
	_, g, _ := testutil.Store(t)
	r := NewNodeRole(g, env(nil), testutil.Log())
	if r.Role(ctx) != "standalone" || r.MasterURL(ctx) != nil {
		t.Fatal("empty KV default")
	}
	r = NewNodeRole(g, env(map[string]string{"STREAMHUB_NODE_ROLE": "Edge", "STREAMHUB_MASTER_URL": " https://m/// "}), testutil.Log())
	r.Seed(ctx)
	if r.Role(ctx) != "edge" || *r.MasterURL(ctx) != "https://m" {
		t.Fatal(r.Role(ctx))
	}
	// KV wins over env on the next boot
	r2 := NewNodeRole(g, env(map[string]string{"STREAMHUB_NODE_ROLE": "master"}), testutil.Log())
	r2.Seed(ctx)
	if r2.Role(ctx) != "edge" {
		t.Fatal("seed must be first-boot only")
	}
	_ = r.SetRole(ctx, "bogus")
	_ = r.SetMasterURL(ctx, "")
	if r.Role(ctx) != "standalone" || r.MasterURL(ctx) != nil {
		t.Fatal("set/clear")
	}
	_, g2, _ := testutil.Store(t)
	r3 := NewNodeRole(g2, env(map[string]string{"STREAMHUB_NODE_ROLE": "nope"}), testutil.Log())
	r3.Seed(ctx)
	var v string
	_ = g2.QueryRow(`SELECT value FROM _streamhub_meta WHERE key = 'node_role'`).Scan(&v)
	if v != "standalone" {
		t.Fatal(v)
	}
}

type fakeDoer struct {
	status int
	body   string
	err    error
	reqs   []*http.Request
	bodies []string
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.reqs = append(f.reqs, r)
	if r.Body != nil {
		b, _ := io.ReadAll(r.Body)
		f.bodies = append(f.bodies, string(b))
	}
	if f.err != nil {
		return nil, f.err
	}
	return &http.Response{StatusCode: f.status, Body: io.NopCloser(strings.NewReader(f.body))}, nil
}

func TestJoinMasterAndLeave(t *testing.T) {
	ctx := context.Background()
	s, _ := setup(t, config.Config{})
	d := &fakeDoer{status: 201, body: `{"data":{"nodeId":"n-1","secretsWithheld":true},"error":null}`}
	s.http = d
	s.localIP = func() string { return "10.9.9.9" }
	res, err := s.JoinMaster(ctx, JoinMasterInput{MasterURL: " https://m.example.com// ", ClusterToken: "ct", NodeName: "e1", Region: "eu"})
	if err != nil {
		t.Fatal(err)
	}
	r := d.reqs[0]
	if r.URL.String() != "https://m.example.com/api/v1/cluster/join" || r.Header.Get("x-cluster-token") != "ct" || d.bodies[0] != `{"name":"e1","ip":"10.9.9.9","region":"eu"}` {
		t.Fatal(r.URL, d.bodies[0])
	}
	js, _ := json.Marshal(res)
	if string(js) != `{"role":"edge","masterUrl":"https://m.example.com","nodeId":"n-1","secretsWithheld":true,"heartbeatEnv":{"STREAMHUB_NODE_ROLE":"edge","STREAMHUB_MASTER_URL":"https://m.example.com","STREAMHUB_MASTER_NODE_ID":"n-1","STREAMHUB_NODE_ID":"n-1"}}` {
		t.Fatal(string(js))
	}
	if s.role.Role(ctx) != "edge" || *s.role.MasterNodeID(ctx) != "n-1" {
		t.Fatal("role not flipped")
	}

	// leave without a token: local revert only
	lr, _ := s.Leave(ctx, "")
	if lr != (LeaveResult{Role: "standalone", Detail: "no masterToken supplied — de-register at the master manually"}) || s.role.Role(ctx) != "standalone" {
		t.Fatalf("%+v", lr)
	}
	lr, _ = s.Leave(ctx, "tok")
	if lr.Detail != "no master linkage on record" {
		t.Fatalf("%+v", lr)
	}
	// with linkage + token: DELETE at the master
	_ = s.role.SetMasterURL(ctx, "https://m")
	_ = s.role.SetMasterNodeID(ctx, "n/1")
	d2 := &fakeDoer{status: 200, body: `{}`}
	s.http = d2
	lr, _ = s.Leave(ctx, "sk_x")
	if !lr.Deregistered || lr.Detail != "" || d2.reqs[0].Method != "DELETE" || d2.reqs[0].URL.String() != "https://m/api/v1/cluster/nodes/n%2F1" || d2.reqs[0].Header.Get("authorization") != "Bearer sk_x" {
		t.Fatalf("%+v %s", lr, d2.reqs[0].URL)
	}
	_ = s.role.SetMasterURL(ctx, "https://m")
	_ = s.role.SetMasterNodeID(ctx, "n1")
	s.http = &fakeDoer{status: 403, body: ``}
	if lr, _ = s.Leave(ctx, "sk_x"); lr.Deregistered || lr.Detail != "master returned HTTP 403" {
		t.Fatalf("%+v", lr)
	}
	_ = s.role.SetMasterURL(ctx, "https://m")
	_ = s.role.SetMasterNodeID(ctx, "n1")
	s.http = &fakeDoer{err: errors.New("dial tcp: refused")}
	if lr, _ = s.Leave(ctx, "sk_x"); lr.Deregistered || lr.Detail != "de-register failed: Bad Gateway Exception" {
		t.Fatalf("%+v", lr)
	}
}

func TestJoinMasterFailures(t *testing.T) {
	ctx := context.Background()
	s, _ := setup(t, config.Config{})
	s.http = &fakeDoer{status: 401, body: `{"error":"invalid cluster token"}`}
	if _, err := s.JoinMaster(ctx, JoinMasterInput{MasterURL: "http://m", ClusterToken: "x", NodeName: "n", NodeIP: "1.1.1.1"}); status(err) != 502 || body(err) != `{"error":"master rejected join (HTTP 401)"}` {
		t.Fatal(err)
	}
	if s.role.Role(ctx) != "standalone" {
		t.Fatal("role flipped on failure")
	}
	s.http = &fakeDoer{status: 200, body: `{"data":{}}`}
	if _, err := s.JoinMaster(ctx, JoinMasterInput{MasterURL: "http://m", ClusterToken: "x", NodeName: "n", NodeIP: "1.1.1.1"}); body(err) != `{"error":"master join response missing nodeId"}` {
		t.Fatal(err)
	}
	s.http = &fakeDoer{err: errors.New("connection refused")}
	if _, err := s.JoinMaster(ctx, JoinMasterInput{MasterURL: "http://m", ClusterToken: "x", NodeName: "n", NodeIP: "1.1.1.1"}); body(err) != `{"error":"could not reach http://m/api/v1/cluster/join: fetch failed"}` {
		t.Fatal(err)
	}
}

func TestTokenGate(t *testing.T) {
	r := httptest.NewRequest("POST", "/", nil)
	if err := AssertToken(r, "", "", nil); status(err) != 503 || body(err) != `{"error":"cluster joining disabled (STREAMHUB_CLUSTER_TOKEN unset)"}` {
		t.Fatal(err)
	}
	offenses := 0
	if err := AssertToken(r, "tok", "", func() { offenses++ }); status(err) != 401 || body(err) != `{"error":"invalid cluster token"}` || offenses != 1 {
		t.Fatal(err, offenses)
	}
	r.Header.Set("X-Cluster-Token", "tok")
	if err := AssertToken(r, "tok", "", func() { offenses++ }); err != nil || offenses != 1 {
		t.Fatal("valid token must not be an offense")
	}
	if TokenMatches("", "") {
		t.Fatal("empty never matches")
	}
}

func TestValidators(t *testing.T) {
	for v, want := range map[any]bool{"1.2.3.4": true, "::1": true, "fe80::1%eth0": true, "::ffff:1.2.3.4": true, "1.2.3": false, "01.2.3.4": false, "300.1.1.1": false, 5: false} {
		if IsIP(v) != want {
			t.Errorf("IsIP(%v)", v)
		}
	}
	for v, want := range map[any]bool{"http://127.0.0.1:9": true, "https://master.example.com/": true, "http://localhost:3020": true, "http://master": true,
		"ftp://x": false, "master.example.com": false, "http://": false, "http://a b": false, "http://x:99999": false, 3: false} {
		if IsHTTPURL(v) != want {
			t.Errorf("IsHTTPURL(%v)", v)
		}
	}
}
