// Command streamhub-mcp is the StreamHub MCP server: it exposes the StreamHub
// REST API as tools, resources and prompts to MCP clients (Claude Desktop,
// Claude Code, …) over stdio.
//
//	STREAMHUB_API_URL=https://media.example.com STREAMHUB_API_TOKEN=sk_… streamhub-mcp [--allow-destructive]
//
// The core binary serves the same thing as `streamhub-core mcp`.
package main

import (
	"os"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/mcpserver"
)

func main() {
	os.Exit(mcpserver.Main(os.Args[1:], os.Getenv, os.Stderr))
}
