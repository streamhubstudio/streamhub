package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/appstool"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/healthworker"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/mcpserver"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/opsfmt"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version"
)

// Operator subcommands of the core binary (no subcommand = serve):
//
//	streamhub-core seed-token <sk_token|-> [name]   seed the global API token
//	streamhub-core healthcheck                      exit 0 iff /api/v1/health is 200
//	streamhub-core version                          print the product version
//	streamhub-core apps pull|pack|bump              decoupled-apps tooling (internal/appstool)
//	streamhub-core mcp [--allow-destructive]        the MCP stdio server (= streamhub-mcp)
//	streamhub-core health-worker                    the stream-health worker (spawned
//	                                                per app by the plugin framework)
//	streamhub-core opsfmt <view> [args]             render a /api/v1 JSON response (stdin)
//	                                                for the deploy/streamhub ops CLI
//
// They replace the Node-era deploy/seed-token.js, the `node -e` compose
// healthcheck, scripts/apps-*.mjs and the Node health-worker/ — and opsfmt the
// `python3 -c` JSON one-liners of deploy/streamhub — so neither the runtime
// nor the build needs Node, and host ops need no Python.
func subcommand(args []string, stdin io.Reader, stdout, stderr io.Writer) (code int, handled bool) {
	if len(args) == 0 {
		return 0, false
	}
	switch args[0] {
	case "seed-token":
		return seedToken(args[1:], stdin, stdout, stderr), true
	case "healthcheck":
		return healthcheck(stderr), true
	case "apps":
		return appstool.Run(args[1:], stdout, stderr), true
	case "opsfmt":
		return opsfmt.Run(args[1:], stdin, stdout, stderr), true
	case "mcp":
		return mcpserver.Main(args[1:], os.Getenv, stderr), true
	case "health-worker":
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer stop()
		return healthworker.Run(ctx, healthworker.Options{Stdout: stdout, Stderr: stderr}), true
	case "version", "--version":
		fmt.Fprintln(stdout, version.Get())
		return 0, true
	case "help", "-h", "--help":
		fmt.Fprintln(stdout, "usage: streamhub-core [seed-token <token|-> [name] | healthcheck | apps <pull|pack|bump> | mcp [--allow-destructive] | health-worker | opsfmt <view> | version]\n(no arguments: run the core server; configuration comes from the environment / .env)")
		return 0, true
	}
	return 0, false
}

// seedToken is deploy/seed-token.js: insert a global api_token (sha256 of
// the token) unless a non-revoked global token already exists. The token
// comes from argv, or from stdin when absent or "-" (preferred: it never
// shows in ps). DATA_DIR defaults to /data, as the Node script did.
func seedToken(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	token := ""
	if len(args) > 0 {
		token = args[0]
	}
	if token == "" || token == "-" {
		b, _ := io.ReadAll(stdin)
		token = strings.TrimSpace(string(b))
	}
	name := "bootstrap"
	if len(args) > 1 && args[1] != "" {
		name = args[1]
	}
	if token == "" {
		fmt.Fprintln(stderr, "usage: streamhub-core seed-token <token> [name]")
		return 2
	}
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "/data"
	}
	ctx := context.Background()
	store := db.New(dataDir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer store.Close()
	g, err := store.Global(ctx) // opens (and migrates, idempotently) data/streamhub.db
	if err != nil {
		fmt.Fprintln(stderr, "seed-token:", err)
		return 1
	}
	var n int
	if err := g.QueryRowContext(ctx, `SELECT COUNT(*) AS c FROM api_tokens WHERE scope='global' AND revoked=0`).Scan(&n); err != nil {
		fmt.Fprintln(stderr, "seed-token:", err)
		return 1
	}
	if n > 0 {
		fmt.Fprintln(stdout, "global api_token already present — skipping seed")
		return 0
	}
	sum := sha256.Sum256([]byte(token))
	if _, err := g.ExecContext(ctx, `INSERT INTO api_tokens(name, token_hash, scope, app_id) VALUES(?, ?, 'global', NULL)`,
		name, hex.EncodeToString(sum[:])); err != nil {
		fmt.Fprintln(stderr, "seed-token:", err)
		return 1
	}
	fmt.Fprintln(stdout, "seeded global api_token:", name)
	return 0
}

// healthcheck probes http://127.0.0.1:$PORT/api/v1/health (the container
// HEALTHCHECK / compose healthcheck; replaces `node -e …`).
func healthcheck(stderr io.Writer) int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3020"
	}
	c := &http.Client{Timeout: 4 * time.Second}
	res, err := c.Get("http://127.0.0.1:" + port + "/api/v1/health")
	if err != nil {
		fmt.Fprintln(stderr, "healthcheck:", err)
		return 1
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		fmt.Fprintln(stderr, "healthcheck: status", res.StatusCode)
		return 1
	}
	return 0
}
