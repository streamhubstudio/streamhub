#!/usr/bin/env node
/**
 * StreamHub MCP server — stdio entry point.
 *
 * Reads STREAMHUB_API_URL / STREAMHUB_API_TOKEN from the environment (the MCP
 * client passes them via its `env` block) and serves the tool catalogue over
 * stdio. Never writes to stdout directly: stdout is the MCP transport.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { createServer, SERVER_VERSION } from './server.ts';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`[streamhub-mcp] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
  console.error(
    `[streamhub-mcp] v${SERVER_VERSION} ready — ${cfg.baseUrl} (destructive tools ${
      cfg.allowDestructive ? 'ENABLED' : 'disabled'
    })`,
  );
}

main().catch((err) => {
  console.error(`[streamhub-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
