package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// errMutation is returned by a read-only client for any non-GET request.
var errMutation = errors.New("refused: read-only smoke never sends a mutating request")

// client is the API client. In read-only mode it refuses every method but
// GET/HEAD before anything reaches the network.
type client struct {
	base, token string
	readOnly    bool
	http        *http.Client
}

type resp struct {
	status int
	header http.Header
	body   []byte
	json   map[string]any
}

func (c *client) do(method, path string, body any, auth bool) (*resp, error) {
	if c.readOnly && method != http.MethodGet && method != http.MethodHead {
		return nil, errMutation
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	if auth {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	r := &resp{status: res.StatusCode, header: res.Header, body: b}
	_ = json.Unmarshal(b, &r.json)
	return r, nil
}

// api calls /api/v1<path> with the token; a transport error reads as status 0.
func (c *client) api(method, path string, body any) *resp {
	r, err := c.do(method, "/api/v1"+path, body, true)
	if err != nil {
		return &resp{status: 0, body: []byte(err.Error())}
	}
	return r
}

// suite accumulates ✓/✗ lines like the Node smoke.
type suite struct {
	pass, fail, skip int
	fails            []string
}

func (s *suite) ok(name string, cond bool, detail ...any) {
	if cond {
		s.pass++
		fmt.Printf("  ✓ %s\n", name)
		return
	}
	s.fail++
	s.fails = append(s.fails, name)
	fmt.Printf("  ✗ %s %s\n", name, strings.TrimSpace(fmt.Sprint(detail...)))
}

func (s *suite) skipped(name string) { s.skippedWhy(name, "read-only") }

func (s *suite) skippedWhy(name, reason string) {
	s.skip++
	fmt.Printf("  - %s (skipped: %s)\n", name, reason)
}

// data returns json.data as the given shape (nil when absent).
func data[T any](r *resp) T {
	var zero T
	v, ok := r.json["data"]
	if !ok {
		return zero
	}
	b, _ := json.Marshal(v)
	var out T
	if json.Unmarshal(b, &out) != nil {
		return zero
	}
	return out
}

type manifest struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Version    string `json:"version"`
	Exportable bool   `json:"exportable"`
	Edge       bool   `json:"edge"`
}

type catalogItem struct {
	Manifest  *manifest `json:"manifest"`
	Installed bool      `json:"installed"`
	manifest
}

var semver = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func runProd(args []string) int {
	fs := flag.NewFlagSet("prod", flag.ContinueOnError)
	base := fs.String("base", envOr("STREAMHUB_BASE", "http://127.0.0.1:3020"), "core base URL")
	token := fs.String("token", os.Getenv("STREAMHUB_TOKEN"), "global sk_ API token")
	readOnly := fs.Bool("read-only", false, "GET-only: probe an existing app, never create/modify anything")
	appFlag := fs.String("app", "", "app to probe in -read-only mode (default: first app)")
	routes := fs.Bool("routes", false, "also walk every parameter-free OpenAPI GET for every app (fail on 5xx)")
	timeout := fs.Duration("timeout", 30*time.Second, "per-request timeout")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *token == "" {
		fmt.Fprintln(os.Stderr, "STREAMHUB_TOKEN required")
		return 2
	}
	c := &client{base: strings.TrimRight(*base, "/"), token: *token, readOnly: *readOnly, http: &http.Client{Timeout: *timeout}}
	s := &suite{}
	code := func() (code int) {
		defer func() {
			if r := recover(); r != nil {
				fmt.Fprintln(os.Stderr, "smoke crashed:", r)
				code = 1
			}
		}()
		s.prodChecks(c, *appFlag)
		if *routes {
			s.routeWalk(c)
		}
		return 0
	}()
	summary := fmt.Sprintf("\n%d passed, %d failed", s.pass, s.fail)
	if s.skip > 0 {
		summary += fmt.Sprintf(", %d skipped", s.skip)
	}
	if s.fail > 0 {
		summary += " → " + strings.Join(s.fails, ", ")
	}
	fmt.Println(summary)
	if code != 0 || s.fail > 0 {
		return 1
	}
	return 0
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// prodChecks is prod-smoke.mjs: every major API surface. Without -read-only
// it creates a throwaway smoke<ts> app (deleted in a deferred cleanup).
func (s *suite) prodChecks(c *client, appFlag string) {
	app := "smoke" + strconv.FormatInt(time.Now().UnixMilli(), 36)
	mode := "test app: " + app
	if c.readOnly {
		app = appFlag
		if app == "" {
			apps := c.api("GET", "/apps", nil)
			var list []struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(apps.body, &list)
			if len(list) == 0 {
				list = data[[]struct {
					Name string `json:"name"`
				}](apps)
			}
			if len(list) > 0 {
				app = list[0].Name
			}
		}
		mode = "read-only, probing app: " + app
	}
	fmt.Printf("StreamHub prod-smoke → %s (%s)\n\n", c.base, mode)

	// 1. health + version
	h, err := c.do("GET", "/api/v1/health", nil, false)
	up, version := false, ""
	if err == nil {
		up, _ = h.json["up"].(bool)
		version, _ = h.json["version"].(string)
	}
	s.ok("health up", up)
	s.ok("version present", version != "", version)

	// 2. auth: token works; a bad token is rejected
	s.ok("token authorized (GET /apps 200)", c.api("GET", "/apps", nil).status == 200)
	badStatus := 0
	req, _ := http.NewRequest("GET", c.base+"/api/v1/apps", nil)
	req.Header.Set("Authorization", "Bearer sk_invalid")
	if res, e := c.http.Do(req); e == nil {
		res.Body.Close()
		badStatus = res.StatusCode
	}
	s.ok("bad token rejected (401)", badStatus == 401)

	if !c.readOnly {
		defer func() {
			del := c.api("DELETE", "/apps/"+app, nil)
			s.ok("cleanup: test app deleted", del.status < 300 && del.status > 0, del.status)
		}()
		// 3. create throwaway app
		s.ok("create app (201)", c.api("POST", "/apps", map[string]any{"name": app}).status == 201)
	} else if app == "" {
		s.ok("an app exists to probe", false)
		return
	}

	// 4. Studio taxonomy: catalog carries kind/exportable/version
	cat := data[[]catalogItem](c.api("GET", "/apps/"+app+"/plugins", nil))
	metas := make([]manifest, 0, len(cat))
	installed := map[string]bool{}
	for _, x := range cat {
		m := x.manifest
		if x.Manifest != nil {
			m = *x.Manifest
		}
		metas = append(metas, m)
		installed[m.ID] = x.Installed
	}
	nApps, nPlugins := 0, 0
	allSemver, anyExportable := len(metas) > 0, false
	for _, m := range metas {
		switch m.Kind {
		case "app":
			nApps++
		case "plugin":
			nPlugins++
		}
		allSemver = allSemver && semver.MatchString(m.Version)
		anyExportable = anyExportable || m.Exportable
	}
	s.ok("catalog has kind=app entries", nApps >= 8, fmt.Sprintf("apps=%d", nApps))
	s.ok("catalog has kind=plugin entries", nPlugins >= 5, fmt.Sprintf("plugins=%d", nPlugins))
	s.ok("all metas carry a semver version", allSemver)
	s.ok("exportable flag present on apps", anyExportable)

	// 5. install an exportable app + export bundle (read-only: export one
	// that is already installed, if any)
	var exp *manifest
	for i := range metas {
		if metas[i].Exportable && (!c.readOnly || installed[metas[i].ID]) {
			exp = &metas[i]
			break
		}
	}
	switch {
	case exp != nil:
		if !c.readOnly {
			c.api("POST", "/apps/"+app+"/plugins/"+exp.ID+"/install", nil)
		}
		b := c.api("GET", "/apps/"+app+"/plugins/"+exp.ID+"/export", nil)
		ct := ""
		if b.header != nil {
			ct = b.header.Get("Content-Type")
		}
		s.ok("export "+exp.ID+" → gzip (200)", b.status == 200 && strings.Contains(ct, "gzip"), b.status, ct)
	case c.readOnly:
		s.skipped("export bundle (no exportable app installed on " + app + ")")
	default:
		s.ok("an exportable app exists", false)
	}

	// 6. passthrough ingress (reversible — deleted with the app)
	if c.readOnly {
		s.skipped("passthrough ingress create")
	} else {
		ing := c.api("POST", "/apps/"+app+"/ingress", map[string]any{"inputType": "rtmp", "mode": "passthrough", "room": app + "-cam"})
		d := data[map[string]any](ing)
		_, hasURL := d["rtmp_url"].(string)
		if !hasURL {
			_, hasURL = d["rtmpUrl"].(string)
		}
		s.ok("passthrough ingress created", ing.status > 0 && ing.status < 300 && hasURL, ing.status)
	}

	// 7. tags CRUD (read-only: list only)
	if c.readOnly {
		s.skipped("tag create")
	} else {
		tag := c.api("POST", "/apps/"+app+"/tags", map[string]any{"slug": "smoke-zone", "label": "Smoke", "kind": "custom"})
		s.ok("tag create", tag.status > 0 && tag.status < 300, tag.status)
	}
	s.ok("tag list", c.api("GET", "/apps/"+app+"/tags", nil).status == 200)
	if c.readOnly {
		s.skipped("tag delete")
	} else {
		d := c.api("DELETE", "/apps/"+app+"/tags/smoke-zone", nil)
		s.ok("tag delete", d.status > 0 && d.status < 300)
	}

	// 8. per-app net metrics
	s.ok("net summary endpoint", c.api("GET", "/apps/"+app+"/net", nil).status == 200)

	// 9. vision apps (2.16.0: vision split into 4 edge-capable Studio Apps)
	has := func(id string, pred func(manifest) bool) bool {
		return slices.ContainsFunc(metas, func(m manifest) bool { return m.ID == id && pred(m) })
	}
	vision := true
	for _, id := range []string{"occupancy", "counting", "crowd", "demography"} {
		vision = vision && has(id, func(m manifest) bool { return m.Kind == "app" })
	}
	s.ok("4 vision apps in catalog", vision)
	s.ok("edge flag on manifests", slices.ContainsFunc(metas, func(m manifest) bool { return m.Edge }) &&
		has("transcription", func(m manifest) bool { return !m.Edge }))
	ov := c.api("GET", "/apps/"+app+"/plugins/occupancy/overview", nil).status
	s.ok("occupancy overview endpoint", ov == 200 || ov == 404)

	// 9b. generic per-app edge assignments API (2.16.0)
	s.ok("edge assignments list", c.api("GET", "/apps/"+app+"/edge/assignments", nil).status == 200)

	// 9c. appstore: versions catalog carries the materialized builtin. deface
	// is a DECOUPLED app — the COMPOSITION SENTINEL: a deploy that skipped
	// apps-pull ships no vendored apps and must FAIL here.
	vers := c.api("GET", "/plugins/deface/versions", nil)
	builtin := false
	for _, v := range data[struct {
		Versions []struct {
			Builtin bool `json:"builtin"`
		} `json:"versions"`
	}](vers).Versions {
		builtin = builtin || v.Builtin
	}
	s.ok("appstore versions + builtin (composition sentinel)", vers.status == 200 && builtin, vers.status)

	// 10. streamflow: box catalogue + workflow CRUD (read-only: list only)
	boxes := c.api("GET", "/apps/"+app+"/plugins/streamflow/boxes", nil)
	s.ok("streamflow box catalogue", boxes.status == 200 && len(data[[]any](boxes)) > 0, boxes.status)
	if c.readOnly {
		s.ok("streamflow workflow list", c.api("GET", "/apps/"+app+"/plugins/streamflow/workflows", nil).status == 200)
	} else {
		wf := c.api("POST", "/apps/"+app+"/plugins/streamflow/workflows", map[string]any{
			"name": "smoke-wf",
			"graph": map[string]any{
				"boxes": []any{
					map[string]any{"id": "a", "type": "trigger.manual", "config": map[string]any{}},
					map[string]any{"id": "b", "type": "action.emit", "config": map[string]any{"event": "smoke.ping"}},
				},
				"edges": []any{map[string]any{"from": "a", "to": "b"}},
			},
		})
		s.ok("streamflow workflow create", wf.status > 0 && wf.status < 300, wf.status)
		id := data[map[string]any](wf)["id"]
		ok := id == nil
		if id != nil {
			d := c.api("DELETE", fmt.Sprintf("/apps/%s/plugins/streamflow/workflows/%v", app, id), nil)
			ok = d.status > 0 && d.status < 300
		}
		s.ok("streamflow workflow delete", ok)
	}

	// 11. cluster + edge nodes (global)
	s.ok("cluster nodes list", c.api("GET", "/cluster/nodes", nil).status == 200)
	edge := c.api("GET", "/edge/nodes", nil)
	s.ok("edge nodes list", edge.status == 200)
	nodes := data[[]map[string]any](edge)
	var disk any
	for _, n := range nodes {
		if n["name"] == "origin" {
			if st, ok := n["stats"].(map[string]any); ok {
				disk = st["disk"]
			}
		}
	}
	// The origin only self-registers with a cluster token: a standalone core
	// (GET /cluster/info → enabled:false) with an empty registry has no origin
	// row by design. An unreadable /cluster/info keeps the strict check.
	info := c.api("GET", "/cluster/info", nil)
	ci := data[struct {
		Enabled    *bool `json:"enabled"`
		NodesCount int64 `json:"nodesCount"`
	}](info)
	if info.status == 200 && ci.Enabled != nil && !*ci.Enabled && len(nodes) == 0 && ci.NodesCount == 0 {
		s.skippedWhy("origin node present + reports disk", "standalone core — cluster disabled (no STREAMHUB_CLUSTER_TOKEN), node registry empty")
		return
	}
	db, _ := json.Marshal(disk)
	s.ok("origin node present + reports disk", disk != nil, string(db))
}

// routeWalk is prod-smoke.py: every parameter-free GET of the core's
// OpenAPI ({app}/{name} → each app, {id}/{tenantId} → "platform"), counting
// status codes. Any 5xx other than 503 (or a transport error) fails; a 503 is
// a deliberately unavailable dependency (grid agent off, edge node not
// connected) and is listed but not counted. Global paths are probed once.
func (s *suite) routeWalk(c *client) {
	fmt.Printf("\nroute walk (OpenAPI GETs × apps):\n")
	spec, err := c.do("GET", "/api/v1/openapi.json", nil, false)
	if err != nil || spec.status != 200 {
		s.ok("openapi.json reachable", false, err)
		return
	}
	var doc struct {
		Paths map[string]map[string]any `json:"paths"`
	}
	if json.Unmarshal(spec.body, &doc) != nil {
		s.ok("openapi.json parses", false)
		return
	}
	appsRes := c.api("GET", "/apps", nil)
	var apps []struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(appsRes.body, &apps)
	if len(apps) == 0 {
		s.ok("apps listed for the route walk", false, appsRes.status)
		return
	}
	paths := make([]string, 0, len(doc.Paths))
	for p, ops := range doc.Paths {
		if _, ok := ops["get"]; ok && !strings.HasSuffix(p, "/docs") && !strings.HasSuffix(p, "/openapi.json") {
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	codes := map[int]int{}
	n, bad, unavailable := 0, 0, 0
	for i, a := range apps {
		for _, p := range paths {
			perApp := strings.Contains(p, "{app}") || strings.Contains(p, "{name}")
			q := strings.NewReplacer("{app}", a.Name, "{name}", a.Name, "{id}", "platform", "{tenantId}", "platform").Replace(p)
			if strings.Contains(q, "{") || (!perApp && i > 0) {
				continue
			}
			n++
			r, err := c.do("GET", q, nil, true)
			st := 0
			if err == nil {
				st = r.status
			}
			codes[st]++
			if st == http.StatusServiceUnavailable {
				unavailable++
				fmt.Printf("  503 GET %s (unavailable, not counted): %s\n", q, strings.TrimSpace(string(r.body)))
				continue
			}
			if st >= 500 || st == 0 {
				bad++
				body := ""
				if r != nil {
					body = string(r.body)
				} else if err != nil {
					body = err.Error()
				}
				if len(body) > 200 {
					body = body[:200]
				}
				fmt.Printf("  5xx %d GET %s: %q\n", st, q, body)
			}
		}
	}
	keys := make([]int, 0, len(codes))
	for k := range codes {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%d:%d", k, codes[k]))
	}
	names := make([]string, 0, len(apps))
	for _, a := range apps {
		names = append(names, a.Name)
	}
	fmt.Printf("  apps=%v requests=%d status-codes={%s}\n", names, n, strings.Join(parts, " "))
	s.ok(fmt.Sprintf("route walk: no 5xx (%d GETs, %d× 503 not counted)", n, unavailable), bad == 0, fmt.Sprintf("5xx=%d", bad))
}
