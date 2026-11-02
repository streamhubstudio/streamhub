package cluster

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// CDN edges (3.4.0): type cdn-edge on join, the heartbeat stats contract and
// the least-loaded HLS edge selection.

func TestPickCDNEdge(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	ago := func(s int) time.Time { return now.Add(-time.Duration(s) * time.Second) }
	edge := func(id string, mbps float64, conns int64) CDNEdge {
		return CDNEdge{ID: id, URL: "https://" + id + ".example.com", Status: "active", LastSeen: ago(10), TxMbps: mbps, Conns: conns}
	}
	with := func(e CDNEdge, f func(*CDNEdge)) CDNEdge { f(&e); return e }
	for _, c := range []struct {
		name  string
		edges []CDNEdge
		want  string // "" = none (origin)
	}{
		{"no edges", nil, ""},
		{"lowest txMbps wins", []CDNEdge{edge("a", 900, 1), edge("b", 300, 5000), edge("c", 600, 0)}, "b"},
		{"tie on txMbps → fewer conns", []CDNEdge{edge("a", 300, 40), edge("b", 300, 20)}, "b"},
		{"full tie → smallest id", []CDNEdge{edge("b", 300, 20), edge("a", 300, 20)}, "a"},
		{"not reported yet counts as idle", []CDNEdge{edge("a", 10, 1), edge("b", 0, 0)}, "b"},
		{"heartbeat at the 150 s limit is healthy", []CDNEdge{with(edge("a", 0, 0), func(e *CDNEdge) { e.LastSeen = ago(150) })}, "a"},
		{"heartbeat older than 150 s is skipped", []CDNEdge{with(edge("a", 0, 0), func(e *CDNEdge) { e.LastSeen = ago(151) }), edge("b", 999, 9)}, "b"},
		{"never seen is skipped", []CDNEdge{with(edge("a", 0, 0), func(e *CDNEdge) { e.LastSeen = time.Time{} })}, ""},
		{"draining is skipped", []CDNEdge{with(edge("a", 0, 0), func(e *CDNEdge) { e.Status = "draining" }), edge("b", 50, 0)}, "b"},
		{"disabled is skipped", []CDNEdge{with(edge("a", 0, 0), func(e *CDNEdge) { e.Status = "disabled" })}, ""},
		{"no url is skipped", []CDNEdge{with(edge("a", 0, 0), func(e *CDNEdge) { e.URL = "" })}, ""},
		{"bare ip url is skipped", []CDNEdge{with(edge("a", 0, 0), func(e *CDNEdge) { e.URL = "203.0.113.9" })}, ""},
		{"http url is fine", []CDNEdge{with(edge("a", 0, 0), func(e *CDNEdge) { e.URL = "http://203.0.113.9:8080" })}, "a"},
	} {
		got, ok := PickCDNEdge(c.edges, now)
		if (c.want == "") == ok || (ok && got.ID != c.want) {
			t.Errorf("%s: got %q ok=%v, want %q", c.name, got.ID, ok, c.want)
		}
	}
}

func TestParseHLSEdgeSelect(t *testing.T) {
	for raw, want := range map[string]string{
		"": HLSEdgeSelectOff, "off": HLSEdgeSelectOff, "least-loaded": HLSEdgeSelectLeastLoaded,
		" Least-Loaded ": HLSEdgeSelectLeastLoaded, "on": HLSEdgeSelectOff, "random": HLSEdgeSelectOff,
	} {
		if got := ParseHLSEdgeSelect(raw); got != want {
			t.Errorf("%q → %q, want %q", raw, got, want)
		}
	}
}

func cdnStats(mbps float64, conns int) *y.Map {
	cdn := y.NewMap()
	cdn.Set("conns", float64(conns))
	cdn.Set("reqTotal", 123456.0)
	cdn.Set("txBytes", 9.9e12)
	cdn.Set("txMbps", mbps)
	cdn.Set("cacheDir", "/var/cache/nginx/hls")
	m := y.NewMap()
	m.Set("role", NodeTypeCDNEdge)
	m.Set("cdn", cdn)
	return m
}

func TestJoinCDNEdge(t *testing.T) {
	ctx := context.Background()
	s, g := setup(t, config.Config{ClusterToken: "ct", LivekitAPIKey: "k", LivekitAPISecret: "sec", ClusterRedisURL: "redis://c:6379"})
	p, created, err := s.Join(ctx, JoinInput{Name: "cdn-1", IP: "203.0.113.20", URL: "https://cdn1.example.com", Type: NodeTypeCDNEdge}, true)
	if err != nil || !created {
		t.Fatal(err)
	}
	// the per-node secret flow is unchanged; LiveKit secret + Redis are not vended
	if p.NodeSecret != NodeSecret("ct", p.NodeID) || p.Livekit.APISecret != "" || p.RedisURL != nil || p.SecretsWithheld || p.Livekit.APIKey != "k" {
		t.Fatalf("%+v", p)
	}
	url, _, st, typ, _, _ := row(t, g, p.NodeID)
	if url != "https://cdn1.example.com" || st != "active" || typ != NodeTypeCDNEdge {
		t.Fatal(url, st, typ)
	}
	// the heartbeat contract is stored and listed as-is (key order kept)
	if err := s.Heartbeat(ctx, p.NodeID, cdnStats(812.5, 4100)); err != nil {
		t.Fatal(err)
	}
	n, err := s.GetNode(ctx, p.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	js, _ := y.Stringify(n.Stats)
	if js != `{"role":"cdn-edge","cdn":{"conns":4100,"reqTotal":123456,"txBytes":9900000000000,"txMbps":812.5,"cacheDir":"/var/cache/nginx/hls"}}` {
		t.Fatal(js)
	}
	edges, err := LoadCDNEdges(ctx, g)
	if err != nil || len(edges) != 1 || edges[0].TxMbps != 812.5 || edges[0].Conns != 4100 || edges[0].LastSeen.IsZero() {
		t.Fatalf("%+v %v", edges, err)
	}
	// a non-cdn join still gets everything
	q, _, _ := s.Join(ctx, JoinInput{Name: "lk-1", IP: "203.0.113.21", Type: "edge"}, true)
	if q.Livekit.APISecret != "sec" || q.RedisURL == nil {
		t.Fatalf("%+v", q)
	}
}

func TestJoinRouteAcceptsCDNEdge(t *testing.T) {
	_, h, _ := hbServer(t, "")
	post := func(body string) (int, string) {
		r := httptest.NewRequest("POST", "/api/v1/cluster/join", strings.NewReader(body))
		r.Header.Set("content-type", "application/json")
		r.Header.Set("X-Cluster-Token", "ct")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec.Code, rec.Body.String()
	}
	code, out := post(`{"name":"cdn-1","ip":"203.0.113.20","url":"https://cdn1.example.com","type":"cdn-edge"}`)
	var env struct {
		Data JoinPayload `json:"data"`
	}
	if code != 201 || json.Unmarshal([]byte(out), &env) != nil || env.Data.NodeSecret == "" {
		t.Fatal(code, out)
	}
	code, out = post(`{"name":"x","ip":"203.0.113.20","type":"gpu"}`)
	if code != 400 || !strings.Contains(out, "type must be one of the following values: common, edge, cdn-edge") {
		t.Fatal(code, out)
	}
}

func TestHLSEdgeSelector(t *testing.T) {
	ctx := context.Background()
	const origin = "https://origin.example.com"
	public := func(_ context.Context, app string) bool { return app == "live" }

	// off (the default): the origin base verbatim, the registry never read
	off := NewHLSEdgeSelector(nil, env(nil), public, testutil.Log())
	if off.Mode() != HLSEdgeSelectOff || off.HLSBase(ctx, "live", origin) != origin || off.HLSBase(ctx, "live", "") != "" {
		t.Fatal("off must be a no-op")
	}
	var nilSel *HLSEdgeSelector
	if nilSel.HLSBase(ctx, "live", origin) != origin {
		t.Fatal("nil selector")
	}

	s, g := setup(t, config.Config{ClusterToken: "ct"})
	sel := NewHLSEdgeSelector(g, env(map[string]string{HLSEdgeSelectEnv: "least-loaded"}), public, testutil.Log())
	now := time.Now()
	sel.now = func() time.Time { return now }

	// no cdn-edge registered → origin
	if got := sel.HLSBase(ctx, "live", origin); got != origin {
		t.Fatal(got)
	}
	a, _, _ := s.Join(ctx, JoinInput{Name: "cdn-a", IP: "203.0.113.30", URL: "https://a.cdn.example.com/", Type: NodeTypeCDNEdge}, true)
	b, _, _ := s.Join(ctx, JoinInput{Name: "cdn-b", IP: "203.0.113.31", URL: "https://b.cdn.example.com", Type: NodeTypeCDNEdge}, true)
	_, _, _ = s.Join(ctx, JoinInput{Name: "lk", IP: "203.0.113.32", URL: "https://lk.example.com", Type: "edge"}, true)
	_ = s.Heartbeat(ctx, a.NodeID, cdnStats(900, 10))
	_ = s.Heartbeat(ctx, b.NodeID, cdnStats(400, 10))

	// the empty result above is cached for 5 s
	if got := sel.HLSBase(ctx, "live", origin); got != origin {
		t.Fatal("cached snapshot", got)
	}
	now = now.Add(hlsEdgeCacheTTL)
	if got := sel.HLSBase(ctx, "live", origin); got != "https://b.cdn.example.com" {
		t.Fatal(got)
	}
	// a private / geo app (not edge-cacheable) keeps the origin
	if got := sel.HLSBase(ctx, "private-app", origin); got != origin {
		t.Fatal(got)
	}
	// b drained by the operator → a (trailing slash trimmed); a non-cdn edge is never picked
	if _, err := s.UpdateNode(ctx, b.NodeID, NodePatch{Status: strp("draining")}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(hlsEdgeCacheTTL)
	if got := sel.HLSBase(ctx, "live", origin); got != "https://a.cdn.example.com" {
		t.Fatal(got)
	}
	// every heartbeat older than 150 s → back to the origin
	now = now.Add(CDNEdgeHealthyFor + time.Minute)
	if got := sel.HLSBase(ctx, "live", origin); got != origin {
		t.Fatal(got)
	}
	// no cacheability oracle → nothing is steered
	blind := NewHLSEdgeSelector(g, env(map[string]string{HLSEdgeSelectEnv: "least-loaded"}), nil, testutil.Log())
	if got := blind.HLSBase(ctx, "live", origin); got != origin {
		t.Fatal(got)
	}
}

func strp(s string) *string { return &s }
