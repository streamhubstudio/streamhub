package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCore answers the smoke's probes and records every method+path.
func fakeCore(t *testing.T) (*httptest.Server, func() []string) {
	var mu sync.Mutex
	var seen []string
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") == "Bearer sk_invalid" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.URL.Path == "/api/v1/health":
			_, _ = w.Write([]byte(`{"up":true,"version":"3.0.0"}`))
		case r.URL.Path == "/api/v1/apps":
			_, _ = w.Write([]byte(`[{"name":"live"},{"name":"tv"}]`))
		case r.URL.Path == "/api/v1/openapi.json":
			_, _ = w.Write([]byte(`{"paths":{"/api/v1/apps/{app}/tags":{"get":{}},"/api/v1/apps/{app}/x/{other}":{"get":{}},` +
				`"/api/v1/cluster/nodes":{"get":{}},"/api/v1/boom":{"get":{}},"/api/v1/off":{"get":{}},"/api/v1/apps":{"post":{}}}}`))
		case r.URL.Path == "/api/v1/off":
			w.WriteHeader(503)
		case r.URL.Path == "/api/v1/boom":
			w.WriteHeader(500)
		case strings.HasSuffix(r.URL.Path, "/plugins"):
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
		default:
			_, _ = w.Write([]byte(`{"data":[]}`))
		}
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), seen...) }
}

func TestReadOnlyClientRefusesMutations(t *testing.T) {
	srv, seen := fakeCore(t)
	c := &client{base: srv.URL, token: "sk_x", readOnly: true, http: srv.Client()}
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		if _, err := c.do(m, "/api/v1/apps", map[string]any{"name": "x"}, true); err != errMutation {
			t.Errorf("%s: err = %v, want errMutation", m, err)
		}
	}
	if len(seen()) != 0 {
		t.Fatalf("a refused request reached the server: %v", seen())
	}
}

// The whole read-only suite (+ route walk) sends GETs only.
func TestReadOnlySuiteSendsOnlyGET(t *testing.T) {
	srv, seen := fakeCore(t)
	c := &client{base: srv.URL, token: "sk_x", readOnly: true, http: &http.Client{Timeout: 5 * time.Second}}
	s := &suite{}
	s.prodChecks(c, "")
	s.routeWalk(c)
	got := seen()
	if len(got) < 15 {
		t.Fatalf("suspiciously few requests: %v", got)
	}
	for _, r := range got {
		if !strings.HasPrefix(r, "GET ") {
			t.Errorf("read-only smoke sent %s", r)
		}
	}
	// It probed the first app and never a throwaway smoke* app.
	for _, r := range got {
		if strings.Contains(r, "/apps/smoke") {
			t.Errorf("read-only smoke touched a throwaway app: %s", r)
		}
	}
	if !contains(got, "GET /api/v1/apps/live/tags") || !contains(got, "GET /api/v1/apps/tv/tags") {
		t.Errorf("route walk did not cover every app: %v", got)
	}
	if contains(got, "GET /api/v1/apps/live/x/{other}") {
		t.Error("route walk probed a path with an unresolved parameter")
	}
	// The 500 on /boom is a failed check; the 503 on /off is not counted.
	if !contains(s.fails, "route walk: no 5xx (5 GETs, 1× 503 not counted)") {
		t.Errorf("5xx not reported as a failure: %v", s.fails)
	}
}

// Without -read-only the throwaway app is created and always deleted.
func TestMutatingSuiteCleansUp(t *testing.T) {
	srv, seen := fakeCore(t)
	c := &client{base: srv.URL, token: "sk_x", http: &http.Client{Timeout: 5 * time.Second}}
	(&suite{}).prodChecks(c, "")
	var create, del string
	for _, r := range seen() {
		if r == "POST /api/v1/apps" {
			create = r
		}
		if strings.HasPrefix(r, "DELETE /api/v1/apps/smoke") {
			del = r
		}
	}
	if create == "" || del == "" {
		t.Fatalf("throwaway app not created+deleted: %v", seen())
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// The origin-node check skips only on a standalone core (cluster disabled +
// empty registry); with a cluster configured a missing origin still fails.
func TestOriginNodeCheckStandalone(t *testing.T) {
	const check = "origin node present + reports disk"
	origin := `{"data":[{"name":"origin","stats":{"disk":{"usedPct":12}}}]}`
	cases := []struct {
		name, info, nodes string
		want              string // pass | fail | skip
	}{
		{"standalone, empty registry", `{"data":{"enabled":false,"nodesCount":0}}`, `{"data":[]}`, "skip"},
		{"cluster on, origin missing", `{"data":{"enabled":true,"nodesCount":0}}`, `{"data":[]}`, "fail"},
		{"cluster on, origin + disk", `{"data":{"enabled":true,"nodesCount":1}}`, origin, "pass"},
		{"cluster on, origin without disk", `{"data":{"enabled":true,"nodesCount":1}}`, `{"data":[{"name":"origin","stats":{}}]}`, "fail"},
		{"cluster info unreadable", `{"statusCode":404}`, `{"data":[]}`, "fail"},
		{"disabled but nodes registered", `{"data":{"enabled":false,"nodesCount":1}}`, `{"data":[{"name":"edge-1"}]}`, "fail"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/cluster/info":
					if strings.Contains(tc.info, "statusCode") {
						w.WriteHeader(404)
					}
					_, _ = w.Write([]byte(tc.info))
				case "/api/v1/edge/nodes":
					_, _ = w.Write([]byte(tc.nodes))
				case "/api/v1/apps":
					_, _ = w.Write([]byte(`[{"name":"live"}]`))
				default:
					_, _ = w.Write([]byte(`{"data":[]}`))
				}
			}))
			defer srv.Close()
			c := &client{base: srv.URL, token: "sk_x", readOnly: true, http: srv.Client()}
			s := &suite{}
			s.prodChecks(c, "live")
			failed := contains(s.fails, check)
			got := "pass"
			switch {
			case failed:
				got = "fail"
			case s.skip > 4: // the 4 read-only skips + this one
				got = "skip"
			}
			if got != tc.want {
				t.Fatalf("origin check = %s, want %s (fails=%v skips=%d)", got, tc.want, s.fails, s.skip)
			}
		})
	}
}
