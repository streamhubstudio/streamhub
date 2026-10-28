package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Fixture identities. Plaintext credentials are fixed so cases can reference
// them; everything the server generates (ids, JWTs, minted sk_ tokens) is
// captured into fixture.json and exposed as {{vars}}.
const (
	fixtureAdminUser   = "admin"
	fixtureAdminPass   = "parity-admin-pass"
	fixtureJWTSecret   = "parity-jwt-secret-0123456789abcdef"
	fixtureGlobalToken = "sk_parityGlobalSeedToken0123456789abcdefXYZ"
	fixtureOwnerEmail  = "owner@parity.test"
	fixtureOwnerPass   = "owner-pass-123"
	fixtureViewerEmail = "viewer@parity.test"
	fixtureViewerPass  = "viewer-pass-123"
	fixtureEditorEmail = "editor@parity.test"
	fixtureEditorPass  = "editor-pass-123"
)

// baseEnv is the env BOTH runtimes get in the comparison run. No Redis/LiveKit:
// REDIS_URL points at a dead port (every BullMQ init catches the failure),
// LiveKit creds are empty. Extra -env flags are layered on top.
func baseEnv() map[string]string {
	return map[string]string{
		"NODE_ENV":                      "production",
		"LOG_LEVEL":                     "info",
		"ADMIN_USER":                    fixtureAdminUser,
		"ADMIN_PASS":                    fixtureAdminPass,
		"STREAMHUB_JWT_SECRET":          fixtureJWTSecret,
		"REDIS_URL":                     "redis://127.0.0.1:63999",
		"LIVEKIT_URL":                   "",
		"LIVEKIT_API_KEY":               "",
		"LIVEKIT_API_SECRET":            "",
		"STREAMHUB_AUTHZ_ENFORCE":       "on",
		"STREAMHUB_PUBLIC_REGISTRATION": "off",
		"STREAMHUB_IP_ACCESS_MODE":      "off",
		"AUTH_RATE_LIMIT_MAX":           "50",
		"AUTH_RATE_LIMIT_WINDOW_MS":     "900000",
		// Node's backup scheduler runs a boot catch-up through BullMQ, which
		// never executes here (dead Redis); Go's in-process scheduler would.
		// Disable both so the snapshot list is deterministic.
		"STREAMHUB_BACKUPS_ENABLED": "false",
	}
}

// parityVersion is the product version both runtimes report: a fixed VERSION
// file in each server cwd (and the {{appVersion}} variable), so recordings
// don't churn on release bumps. 13 chars → also normalized inside strings
// (builtin-<version> appstore entries).
const parityVersion = "99.0.0-parity"

// buildFixture boots one core (impl "node" = the oracle, for -live/-record;
// "go" for -replay) against an empty DATA_DIR, seeds a global token with that
// runtime's seed tool and the rest through its own API, stops it (flushing the
// WAL) and returns the captured variables. seed-data/ ends up a reusable seed.
func buildFixture(ctx context.Context, o *options, root string, env map[string]string, impl string) (map[string]any, error) {
	dataDir := filepath.Join(root, "seed-data")
	cwd := filepath.Join(root, "cwd-seed")
	for _, d := range []string{dataDir, cwd} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	if err := writeVersion(cwd); err != nil {
		return nil, err
	}
	seedEnv := map[string]string{}
	for k, v := range env {
		seedEnv[k] = v
	}
	// Signup must be open while seeding the owner; the run itself uses
	// whatever env says (default off) so signup_disabled is testable.
	seedEnv["STREAMHUB_PUBLIC_REGISTRATION"] = "on"
	seedEnv["AUTH_RATE_LIMIT_MAX"] = "1000"

	node, err := startServer(ctx, serverSpec{
		label:   impl + "(seed)",
		argv:    o.serverArgv(impl),
		cwd:     cwd,
		dataDir: dataDir,
		logPath: filepath.Join(root, "logs", impl+"-seed.log"),
		env:     seedEnv,
	})
	if err != nil {
		return nil, err
	}
	defer node.stop()

	vars := map[string]any{
		"adminUser":   fixtureAdminUser,
		"adminPass":   fixtureAdminPass,
		"globalToken": fixtureGlobalToken,
		"ownerEmail":  fixtureOwnerEmail,
		"ownerPass":   fixtureOwnerPass,
		"viewerEmail": fixtureViewerEmail,
		"viewerPass":  fixtureViewerPass,
		"editorEmail": fixtureEditorEmail,
		"editorPass":  fixtureEditorPass,
		"appVersion":  parityVersion,
	}

	// 1. Global sk_ token via the runtime's seed tool (stdin form, as in prod):
	// the oracle's scripts/seed-token.js, or `streamhub-core seed-token`.
	var seed *exec.Cmd
	if impl == "node" {
		seed = exec.CommandContext(ctx, o.nodeBin, filepath.Join(o.nodeDir, "scripts", "seed-token.js"), "-", "parity-global")
		seed.Env = processEnv(map[string]string{
			"DATA_DIR":  dataDir,
			"NODE_PATH": filepath.Join(o.nodeDir, "node_modules"),
		})
	} else {
		seed = exec.CommandContext(ctx, o.goBin, "seed-token", "-", "parity-global")
		seed.Env = processEnv(map[string]string{"DATA_DIR": dataDir})
	}
	seed.Stdin = strings.NewReader(fixtureGlobalToken)
	if out, err := seed.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("seed-token: %w\n%s", err, out)
	}

	c := &seedClient{base: node.baseURL + "/api/v1"}

	// 2. Break-glass admin JWT.
	adminJWT, err := c.token("POST", "/auth/login", "", map[string]any{"user": fixtureAdminUser, "password": fixtureAdminPass})
	if err != nil {
		return nil, fmt.Errorf("admin login: %w", err)
	}
	vars["adminJwt"] = adminJWT

	// 3. The default app `live` is auto-seeded at boot.
	var apps []map[string]any
	if err := c.do("GET", "/apps", adminJWT, nil, 200, &apps); err != nil {
		return nil, err
	}
	for _, a := range apps {
		if a["name"] == "live" {
			vars["liveAppId"] = a["id"]
		}
	}
	if vars["liveAppId"] == nil {
		return nil, fmt.Errorf("default app `live` not found in /apps")
	}

	// 4. An app-scoped token and a revoked global token.
	var tok struct {
		ID    json.Number `json:"id"`
		Token string      `json:"token"`
	}
	if err := c.do("POST", "/tokens", adminJWT, map[string]any{"name": "parity-app", "scope": "app", "appId": vars["liveAppId"]}, 201, &tok); err != nil {
		return nil, err
	}
	vars["appToken"], vars["appTokenId"] = tok.Token, tok.ID
	if err := c.do("POST", "/tokens", adminJWT, map[string]any{"name": "parity-revoked", "scope": "global"}, 201, &tok); err != nil {
		return nil, err
	}
	vars["revokedToken"], vars["revokedTokenId"] = tok.Token, tok.ID
	if err := c.do("DELETE", "/tokens/"+tok.ID.String(), adminJWT, nil, 204, nil); err != nil {
		return nil, err
	}

	// 5. A team: owner (self-signup) + invited viewer/editor completing signup.
	ownerJWT, err := c.token("POST", "/auth/signup", "", map[string]any{"email": fixtureOwnerEmail, "password": fixtureOwnerPass, "teamName": "Parity Team"})
	if err != nil {
		return nil, fmt.Errorf("owner signup: %w", err)
	}
	vars["ownerJwt"] = ownerJWT
	var me struct {
		Data struct {
			UserID   string `json:"userId"`
			TenantID string `json:"tenantId"`
		} `json:"data"`
	}
	if err := c.do("GET", "/auth/me", ownerJWT, nil, 200, &me); err != nil {
		return nil, err
	}
	vars["ownerUserId"], vars["ownerTenantId"] = me.Data.UserID, me.Data.TenantID

	for _, m := range []struct{ role, email, pass string }{
		{"viewer", fixtureViewerEmail, fixtureViewerPass},
		{"editor", fixtureEditorEmail, fixtureEditorPass},
	} {
		var inv struct {
			Data struct {
				UserID string `json:"userId"`
			} `json:"data"`
		}
		if err := c.do("POST", "/tenant/invites", ownerJWT, map[string]any{"email": m.email, "role": m.role}, 201, &inv); err != nil {
			return nil, fmt.Errorf("invite %s: %w", m.role, err)
		}
		jwt, err := c.token("POST", "/auth/signup", "", map[string]any{"email": m.email, "password": m.pass})
		if err != nil {
			return nil, fmt.Errorf("%s signup: %w", m.role, err)
		}
		vars[m.role+"UserId"], vars[m.role+"Jwt"] = inv.Data.UserID, jwt
	}

	node.stop()
	return vars, nil
}

// writeVersion puts the fixed parity VERSION into a server's cwd: both
// runtimes resolve it from there (a dev build has no baked-in version).
func writeVersion(cwd string) error {
	return os.WriteFile(filepath.Join(cwd, "VERSION"), []byte(parityVersion+"\n"), 0o644)
}

// seedClient is a tiny JSON client for fixture seeding (not the corpus runner).
type seedClient struct{ base string }

func (c *seedClient) do(method, path, bearer string, body any, want int, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		return fmt.Errorf("%s %s: status %d (want %d): %s", method, path, resp.StatusCode, want, raw)
	}
	if out != nil {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		if err := dec.Decode(out); err != nil {
			return fmt.Errorf("%s %s: decode: %w", method, path, err)
		}
	}
	return nil
}

// token performs a login/signup-style call and returns data.token.
func (c *seedClient) token(method, path, bearer string, body any) (string, error) {
	var r struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	want := 200
	if strings.HasSuffix(path, "/signup") {
		want = 201
	}
	if err := c.do(method, path, bearer, body, want, &r); err != nil {
		return "", err
	}
	if r.Data.Token == "" {
		return "", fmt.Errorf("%s %s: no data.token", method, path)
	}
	return r.Data.Token, nil
}
