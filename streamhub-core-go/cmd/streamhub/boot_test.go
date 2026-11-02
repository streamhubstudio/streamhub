package main

import (
	"context"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/livekit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/db"
)

// boot builds the complete handler exactly as main does and returns it with
// the huma API every module registered on.
func boot(t *testing.T) (http.Handler, huma.API) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("NODE_ENV", "test")
	t.Setenv("STREAMHUB_SHADOW", "1") // no background work in a unit test
	t.Setenv("STREAMHUB_JWT_SECRET", "boot-test-secret")
	t.Setenv("LIVEKIT_URL", "")
	cfg := config.Load()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()

	store := db.New(cfg.DataDir, log)
	if err := store.Open(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })

	var (
		h http.Handler
		a huma.API
	)
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("wiring panicked: %v", r)
			}
		}()
		var err error
		if h, err = buildHandler(ctx, cfg, log, store, func(x huma.API) { a = x }); err != nil {
			t.Fatal(err)
		}
	}()
	return h, a
}

// TestBootWiresEveryPlane builds the complete handler exactly as main does:
// every registered plane, every module's routes. It catches provide/need
// mismatches and huma registration panics (duplicate schema names,
// conflicting routes) before they reach a real boot.
func TestBootWiresEveryPlane(t *testing.T) {
	h, _ := boot(t)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("openapi.json: %d", rec.Code)
	}
	var spec struct {
		Paths map[string]map[string]any `json:"paths"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &spec); err != nil {
		t.Fatal(err)
	}
	ops := 0
	for _, p := range spec.Paths {
		ops += len(p)
	}
	t.Logf("%d paths, %d operations registered", len(spec.Paths), ops)
	if ops < 100 {
		t.Fatalf("only %d operations registered — a plane failed to register?", ops)
	}
}

// publicByDesign are the auth-less (api.Public) operations. Each one either
// serves anonymous viewers or authenticates by other means in its handler.
// TestBootWiresHLSGate: the playback plane's guard reaches the static mounts
// — /hls-auth (the direct-serve subrequest) exists, fails closed without an
// original URI and passes a segment of the seeded public `live` app.
func TestBootWiresHLSGate(t *testing.T) {
	h, _ := boot(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/hls-auth", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("/hls-auth without X-Original-URI: %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/hls-auth", nil)
	req.Header.Set("X-Original-URI", "/hls/live/room/seg_00001.ts")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("/hls-auth public app: %d %s", rec.Code, rec.Body.String())
	}
}

// TestPrivateAppHLSNeedsToken reproduces A3 on the complete wiring: the
// seeded `live` app turned private (features.public_playback:false) must not
// serve its /hls playlist or segments without the ?st= token (before 3.4.0
// both answered 200), and serves them with one minted by the public
// hls-token route from a signed playback URL.
func TestPrivateAppHLSNeedsToken(t *testing.T) {
	h, _ := boot(t)
	appDir := filepath.Join(os.Getenv("DATA_DIR"), "apps", "live")
	cfgFile := filepath.Join(appDir, "config.yaml")
	raw, err := os.ReadFile(cfgFile)
	if err != nil || !strings.Contains(string(raw), "public_playback: true") {
		t.Fatalf("seeded config.yaml: %v\n%s", err, raw)
	}
	if err := os.WriteFile(cfgFile, []byte(strings.Replace(string(raw), "public_playback: true", "public_playback: false", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	hlsDir := filepath.Join(appDir, "hls", "room")
	if err := os.MkdirAll(hlsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"index.m3u8": "#EXTM3U\n#EXTINF:4,\nseg_1.ts\n", "seg_1.ts": "TS"} {
		if err := os.WriteFile(filepath.Join(hlsDir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	get := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		return rec
	}
	for _, target := range []string{"/hls/live/room/index.m3u8", "/hls/live/room/seg_1.ts", "/hls/live/room/index.m3u8?st=1.x"} {
		if rec := get(target); rec.Code != http.StatusForbidden {
			t.Fatalf("A3: %s served without a valid token: %d", target, rec.Code)
		}
	}
	// The public hls-token route refuses without the signed capability…
	if rec := get("/api/v1/apps/live/hls-token/room"); rec.Code != http.StatusForbidden {
		t.Fatalf("hls-token without a signed URL: %d %s", rec.Code, rec.Body.String())
	}
	// …and mints with one (exp/sig as POST play-token/:room/sign would).
	exp := time.Now().Unix() + 300
	sig := livekit.SignPlayback("boot-test-secret", "live", "room", exp)
	rec := get(fmt.Sprintf("/api/v1/apps/live/hls-token/room?exp=%d&sig=%s", exp, sig))
	if rec.Code != http.StatusOK {
		t.Fatalf("hls-token: %d %s", rec.Code, rec.Body.String())
	}
	var tok struct {
		Data struct {
			Required bool   `json:"required"`
			St       string `json:"st"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &tok); err != nil || !tok.Data.Required || tok.Data.St == "" {
		t.Fatalf("hls-token body: %v %s", err, rec.Body.String())
	}
	pl := get("/hls/live/room/index.m3u8?st=" + tok.Data.St)
	if pl.Code != http.StatusOK || !strings.Contains(pl.Body.String(), "seg_1.ts?st="+tok.Data.St) {
		t.Fatalf("playlist with token: %d %q", pl.Code, pl.Body.String())
	}
	if seg := get("/hls/live/room/seg_1.ts?st=" + tok.Data.St); seg.Code != http.StatusOK || seg.Body.String() != "TS" {
		t.Fatalf("segment with token: %d", seg.Code)
	}
	if other := get("/hls/live/other/seg_1.ts?st=" + tok.Data.St); other.Code != http.StatusForbidden {
		t.Fatalf("token reused on another room: %d", other.Code)
	}
}

// A new Public route fails TestEveryOperationDeclaresItsGuard until it is
// justified here.
var publicByDesign = map[string]string{
	"getHealth":                          "liveness probe",
	"LoginController_config":             "login page bootstrap (auth/*)",
	"LoginController_login":              "auth/*: issues the credential",
	"LoginController_signup":             "auth/*: gated by STREAMHUB_ALLOW_SIGNUP",
	"MagicController_request":            "auth/*: magic-link request (rate-limited)",
	"MagicController_verify":             "auth/*: the link token is the credential",
	"LiveKitController_playToken":        "anonymous playback token (play-token gates on the app's access mode)",
	"LiveKitController_listenToken":      "anonymous radio listener token, same contract as play-token",
	"LiveKitController_hlsToken":         "anonymous HLS token, gated exactly like play-token (signed URL for private apps, geo, play-auth)",
	"ClusterController_join":             "node join, X-Cluster-Token checked in the handler",
	"ClusterController_heartbeat":        "node heartbeat, the node secret (legacy: X-Cluster-Token) checked in the handler",
	"GridAgentController_createWorker":   "grid: the node secret (legacy: X-Cluster-Token) checked in the handler",
	"GridAgentController_status":         "grid: the node secret (legacy: X-Cluster-Token) checked in the handler",
	"GridAgentController_stop":           "grid: the node secret (legacy: X-Cluster-Token) checked in the handler",
	"GridAgentController_logs":           "grid: the node secret (legacy: X-Cluster-Token) checked in the handler",
	"PluginsController_ingestLive":       "plugin worker ingest, per-worker ingest token checked in the handler",
	"PluginsController_ingestEvent":      "plugin worker ingest, per-worker ingest token checked in the handler",
	"PluginsController_publicOverlays":   "anonymous player: enabled player-overlay plugins only",
	"PluginsController_liveData":         "anonymous player: live data of an enabled player-overlay plugin only",
	"LiveControlController_publicState":  "anonymous overlay: public live-control state",
	"ScheduledLiveController_listPublic": "anonymous player: public agenda (enabled + upcoming)",
	"WsKeysController_liveInfo":          "anonymous /play and /embed: is a ws-mjpeg camera live",
	"AppstoreController_list":            "@Public in Node; the handler authenticates (superadmin/global only)",
	"AppstoreController_upload":          "@Public in Node (multipart); the handler authenticates (superadmin/global only)",
	"AppstoreController_downloadBundle":  "the handler authenticates (superadmin/global sk_ or X-Cluster-Token)",
	"AppstoreController_remove":          "@Public in Node; the handler authenticates (superadmin/global only)",
	"DevicesController_pairStart":        "unpaired field device: mints a pairing code (rate-limited per IP, capped, 10 min TTL; off unless STREAMHUB_DEVICES_ENABLE)",
	"DevicesController_pairPoll":         "unpaired field device: the pairing's pollToken is the credential (hash compare, burnt after 5 misses)",
}

// scopedByDesign are the authenticated operations outside /apps/{app} that
// are not global-only: each one is scoped to the caller by its handler. App
// operations need an authz.Require; anything else not listed here must be
// api.Global.
var scopedByDesign = map[string]string{
	"LoginController_me":                  "the caller's own resolved auth context",
	"SessionController_list":              "the caller's own sessions",
	"SessionController_revoke":            "the caller's own sessions",
	"SessionController_revokeOthers":      "the caller's own sessions",
	"AccountController_me":                "own user account; API tokens rejected",
	"AccountController_update":            "own user account; API tokens rejected",
	"AccountController_changePassword":    "own user account; API tokens rejected",
	"AccountController_setup2fa":          "own user account; API tokens rejected",
	"AccountController_enable2fa":         "own user account; API tokens rejected",
	"AccountController_disable2fa":        "own user account; API tokens rejected",
	"AccountController_getSmtp":           "own user account; API tokens rejected",
	"AccountController_setSmtp":           "own user account; API tokens rejected",
	"AccountController_testSmtp":          "own user account; API tokens rejected",
	"AccountController_tenants":           "own memberships; API tokens rejected",
	"AccountController_switchTenant":      "own session, only into an active membership; API tokens rejected",
	"AccountController_invitations":       "own pending memberships; API tokens rejected",
	"AccountController_acceptInvitation":  "own pending membership; API tokens rejected",
	"AccountController_declineInvitation": "own pending membership; API tokens rejected",
	"AppsController_list":                 "app:read; filtered to the caller's tenant unless global",
	"AppsController_create":               "app:create; created in the caller's tenant, app-scoped tokens rejected",
	"TeamsController_mine":                "usage:read; the caller's tenant, app-scoped tokens rejected",
	"TeamsController_invite":              "tenant:write; the caller's tenant, owner only",
	"TenantInvitesController_list":        "tenant:read; the caller's tenant, owner only",
	"TenantInvitesController_invite":      "tenant:write; the caller's tenant, owner only",
	"TenantInvitesController_revoke":      "tenant:write; the caller's tenant, owner only",
	"QuotasController_list":               "superadmin only (requireSuperadmin, stricter than global)",
	"QuotasController_updateQuotas":       "superadmin only (requireSuperadmin, stricter than global)",
	"QuotasController_usage":              "usage:read; own tenant unless global",
	"SystemController_getBuild":           "build stamp of the core, any authenticated principal (About panel)",
	"SystemController_getChangelog":       "embedded CHANGELOG.md, any authenticated principal (About panel)",
	"SystemController_getGpu":             "node GPU capability, read by the transcoding UI of every tenant",
	"HealthController_getStats":           "dashboard home of every user: host metrics + server totals only for global credentials, else the caller's own apps' counts",
}

func isAppPath(path string) bool {
	return strings.Contains(path, "{app}") || strings.Contains(path, "{name}")
}

// TestEveryOperationDeclaresItsGuard walks every registered operation and
// fails unless it declares who may call it: an /apps/{app} (or {name})
// operation needs a permission (authz.Require), any other one must be
// api.Global — or be listed, with its reason, as public or caller-scoped by
// design. It also fails on stale allowlist entries.
func TestEveryOperationDeclaresItsGuard(t *testing.T) {
	_, a := boot(t)
	seen := map[string]bool{}
	var bad []string
	for path, item := range a.OpenAPI().Paths {
		for _, op := range []*huma.Operation{item.Get, item.Put, item.Post, item.Delete, item.Options, item.Head, item.Patch, item.Trace} {
			if op == nil {
				continue
			}
			id := op.OperationID
			seen[id] = true
			_, hasPerm := authz.RequiredBy(op)
			global := api.IsGlobal(op)
			_, public := publicByDesign[id]
			_, scoped := scopedByDesign[id]
			switch {
			case api.IsPublic(op):
				if !public {
					bad = append(bad, op.Method+" "+path+" "+id+": public but not in publicByDesign")
				}
			case public:
				bad = append(bad, op.Method+" "+path+" "+id+": in publicByDesign but not api.Public")
			case scoped && (global || isAppPath(path)):
				bad = append(bad, op.Method+" "+path+" "+id+": in scopedByDesign but global or app-scoped (drop the entry)")
			case isAppPath(path):
				if !hasPerm {
					bad = append(bad, op.Method+" "+path+" "+id+": app operation without authz.Require")
				}
			case !global && !scoped:
				bad = append(bad, op.Method+" "+path+" "+id+": not api.Global and not in scopedByDesign")
			}
		}
	}
	for _, m := range []map[string]string{publicByDesign, scopedByDesign} {
		for id := range m {
			if !seen[id] {
				bad = append(bad, id+": allowlisted but not registered (stale entry)")
			}
		}
	}
	sort.Strings(bad)
	for _, b := range bad {
		t.Error(b)
	}
}

// TestGlobalMarkerMatchesHandlers keeps api.Global honest: it is only a
// declaration, and the handler enforces it with api.RequireGlobal (after
// its own body validation, Node's order). Over the source of every module,
// a huma.Register whose op carries api.Global must have a handler that calls
// api.RequireGlobal (directly or through a helper of its package), and vice
// versa.
func TestGlobalMarkerMatchesHandlers(t *testing.T) {
	root := filepath.Join("..", "..", "internal")
	pkgs := map[string][]*ast.File{}
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			return err
		}
		pkgs[filepath.Dir(p)] = append(pkgs[filepath.Dir(p)], f)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	registers := 0
	for _, files := range pkgs {
		enforcing := enforcingFuncs(files)
		for _, f := range files {
			ast.Inspect(f, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || !isSel(call.Fun, "huma", "Register") || len(call.Args) != 3 {
					return true
				}
				registers++
				marked := containsCall(call.Args[1], func(fn ast.Expr) bool { return isSel(fn, "api", "Global") })
				enforced := containsCall(call.Args[2], func(fn ast.Expr) bool { return callsRequireGlobal(fn, enforcing) })
				if marked != enforced {
					t.Errorf("%s: api.Global=%v but the handler calls api.RequireGlobal=%v", fset.Position(call.Pos()), marked, enforced)
				}
				return true
			})
		}
	}
	if registers < 100 {
		t.Fatalf("only %d huma.Register calls found under %s", registers, root)
	}
}

// enforcingFuncs: the package's functions and methods (by name) that call
// api.RequireGlobal, directly or through each other.
func enforcingFuncs(files []*ast.File) map[string]bool {
	bodies := map[string]*ast.BlockStmt{}
	for _, f := range files {
		for _, d := range f.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok && fd.Body != nil {
				bodies[fd.Name.Name] = fd.Body
			}
		}
	}
	set := map[string]bool{}
	for changed := true; changed; {
		changed = false
		for name, body := range bodies {
			// a handler closure (a FuncLit inside Register) doesn't make
			// its enclosing function an enforcing helper
			if !set[name] && containsCall(body, func(fn ast.Expr) bool { return callsRequireGlobal(fn, set) }, true) {
				set[name], changed = true, true
			}
		}
	}
	return set
}

func callsRequireGlobal(fn ast.Expr, enforcing map[string]bool) bool {
	if isSel(fn, "api", "RequireGlobal") {
		return true
	}
	switch f := fn.(type) {
	case *ast.Ident:
		return enforcing[f.Name]
	case *ast.SelectorExpr:
		return enforcing[f.Sel.Name]
	}
	return false
}

func containsCall(n ast.Node, match func(ast.Expr) bool, skipFuncLits ...bool) bool {
	found := false
	ast.Inspect(n, func(n ast.Node) bool {
		if _, lit := n.(*ast.FuncLit); lit && len(skipFuncLits) > 0 {
			return false
		}
		if c, ok := n.(*ast.CallExpr); ok && match(c.Fun) {
			found = true
		}
		return !found
	})
	return found
}

func isSel(e ast.Expr, pkg, name string) bool {
	s, ok := e.(*ast.SelectorExpr)
	if !ok || s.Sel.Name != name {
		return false
	}
	id, ok := s.X.(*ast.Ident)
	return ok && id.Name == pkg
}
