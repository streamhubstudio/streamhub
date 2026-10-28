package mcpserver

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

// Main runs the stdio server (the streamhub-mcp binary and the
// `streamhub-core mcp` subcommand). Diagnostics go to stderr only: stdout is
// the MCP transport. Returns the process exit code.
func Main(args []string, getenv func(string) string, stderr io.Writer) int {
	cfg, err := LoadConfig(getenv, args)
	if err != nil {
		fmt.Fprintf(stderr, "[streamhub-mcp] %s\n", err)
		return 1
	}
	srv, err := New(cfg, nil)
	if err != nil {
		fmt.Fprintf(stderr, "[streamhub-mcp] fatal: %s\n", err)
		return 1
	}
	state := "disabled"
	if cfg.AllowDestructive {
		state = "ENABLED"
	}
	fmt.Fprintf(stderr, "[streamhub-mcp] v%s ready — %s (destructive tools %s)\n", Version, cfg.BaseURL, state)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := srv.Run(ctx); err != nil && ctx.Err() == nil {
		fmt.Fprintf(stderr, "[streamhub-mcp] fatal: %s\n", err)
		return 1
	}
	return 0
}
