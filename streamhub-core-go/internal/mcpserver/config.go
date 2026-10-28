// Package mcpserver is the StreamHub MCP (Model Context Protocol) server: it
// exposes the StreamHub REST API as tools, resources and prompts for AI
// clients (Claude Desktop, Claude Code, ...) over stdio. Port of the former
// TypeScript mcp-server/ — same tool/resource/prompt names, descriptions and
// JSON Schemas (catalog.json), same config, same destructive gate and the
// same error texts (validated against Node vectors in testdata/).
package mcpserver

import (
	"errors"
	"regexp"
	"slices"
	"strings"
)

// Config is the server configuration.
//
//   - STREAMHUB_API_URL: the instance origin ("https://media.example.com") or
//     the full API base (".../api/v1"); both are normalized.
//   - STREAMHUB_API_TOKEN: an sk_ API token (app-scoped recommended).
//   - STREAMHUB_ALLOW_DESTRUCTIVE ("1"/"true"/"yes"/"on") or the
//     --allow-destructive flag registers the destructive tools (default off).
type Config struct {
	// BaseURL always ends in /api/v1 (no trailing slash).
	BaseURL          string
	Token            string
	AllowDestructive bool
}

var (
	trailingSlashes = regexp.MustCompile(`/+$`)
	apiV1Suffix     = regexp.MustCompile(`/api/v1$`)
	truthy          = regexp.MustCompile(`(?i)^(1|true|yes|on)$`)
)

// NormalizeBaseURL strips trailing slashes and appends /api/v1 unless present.
func NormalizeBaseURL(raw string) string {
	u := trailingSlashes.ReplaceAllString(strings.TrimSpace(raw), "")
	if !apiV1Suffix.MatchString(u) {
		u += "/api/v1"
	}
	return u
}

// LoadConfig reads the config from env (getenv) and the CLI args.
func LoadConfig(getenv func(string) string, args []string) (*Config, error) {
	rawURL := getenv("STREAMHUB_API_URL")
	if rawURL == "" {
		return nil, errors.New(`STREAMHUB_API_URL is required (e.g. "https://media.example.com" or "http://127.0.0.1:3020").`)
	}
	token := getenv("STREAMHUB_API_TOKEN")
	if token == "" {
		return nil, errors.New("STREAMHUB_API_TOKEN is required (an sk_ API token; an app-scoped token is recommended).")
	}
	allow := slices.Contains(args, "--allow-destructive") || truthy.MatchString(getenv("STREAMHUB_ALLOW_DESTRUCTIVE"))
	return &Config{BaseURL: NormalizeBaseURL(rawURL), Token: token, AllowDestructive: allow}, nil
}
