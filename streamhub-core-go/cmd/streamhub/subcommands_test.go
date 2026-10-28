package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// seed-token keeps deploy/seed-token.js's contract: token from argv or
// stdin ("-"), default name "bootstrap", sha256 hash, global scope,
// idempotent while a non-revoked global token exists.
func TestSeedToken(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	run := func(args []string, stdin string) (int, string, string) {
		var out, errb bytes.Buffer
		code, ok := subcommand(append([]string{"seed-token"}, args...), strings.NewReader(stdin), &out, &errb)
		if !ok {
			t.Fatal("not handled")
		}
		return code, out.String(), errb.String()
	}
	if code, _, e := run(nil, "  \n"); code != 2 || !strings.Contains(e, "usage:") {
		t.Fatal(code, e)
	}
	if code, out, _ := run([]string{"-"}, "sk_first\n"); code != 0 || out != "seeded global api_token: bootstrap\n" {
		t.Fatal(code, out)
	}
	if code, out, _ := run([]string{"sk_second", "other"}, ""); code != 0 || out != "global api_token already present — skipping seed\n" {
		t.Fatal(code, out)
	}
	h, err := sql.Open("sqlite", filepath.Join(dir, "data", "streamhub.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var name, hash, scope string
	var appID sql.NullInt64
	var n int
	if err := h.QueryRow(`SELECT COUNT(*) FROM api_tokens`).Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	_ = h.QueryRow(`SELECT name, token_hash, scope, app_id FROM api_tokens`).Scan(&name, &hash, &scope, &appID)
	sum := sha256.Sum256([]byte("sk_first"))
	if name != "bootstrap" || hash != hex.EncodeToString(sum[:]) || scope != "global" || appID.Valid {
		t.Fatal(name, hash, scope, appID)
	}
	// revoked tokens don't count: a new seed goes in, with the argv form + name
	if _, err := h.Exec(`UPDATE api_tokens SET revoked = 1`); err != nil {
		t.Fatal(err)
	}
	if code, out, _ := run([]string{"sk_third", "ops"}, ""); code != 0 || out != "seeded global api_token: ops\n" {
		t.Fatal(code, out)
	}
}

func TestSubcommandDispatch(t *testing.T) {
	var out bytes.Buffer
	if _, ok := subcommand(nil, nil, &out, &out); ok {
		t.Fatal("no args must serve")
	}
	if code, ok := subcommand([]string{"version"}, nil, &out, &out); !ok || code != 0 || out.Len() == 0 {
		t.Fatal("version")
	}
	t.Setenv("PORT", "1") // nothing listens there
	if code, ok := subcommand([]string{"healthcheck"}, nil, &out, &out); !ok || code != 1 {
		t.Fatal("healthcheck must fail without a server")
	}
}

// `streamhub-core mcp` is the MCP stdio server: without its env it fails
// fast with the same message as the standalone streamhub-mcp binary.
func TestSubcommandMCPConfigError(t *testing.T) {
	t.Setenv("STREAMHUB_API_URL", "")
	t.Setenv("STREAMHUB_API_TOKEN", "")
	var out, errOut strings.Builder
	code, ok := subcommand([]string{"mcp"}, strings.NewReader(""), &out, &errOut)
	if !ok || code != 1 || out.Len() != 0 || !strings.Contains(errOut.String(), "STREAMHUB_API_URL is required") {
		t.Fatalf("ok=%v code=%d stdout=%q stderr=%q", ok, code, out.String(), errOut.String())
	}
}
