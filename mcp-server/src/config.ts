/**
 * Configuration for the StreamHub MCP server.
 *
 * Everything comes from the environment (the standard way MCP clients pass
 * settings) plus one CLI flag:
 *
 * - STREAMHUB_API_URL        base URL of the StreamHub instance. Either the
 *                            origin ("https://media.example.com") or the full
 *                            API base ("https://media.example.com/api/v1") —
 *                            both are accepted and normalized.
 * - STREAMHUB_API_TOKEN      an `sk_` API token (app-scoped recommended).
 * - STREAMHUB_ALLOW_DESTRUCTIVE  "true"/"1"/"yes"/"on" to register the
 *                            destructive tools (delete app, delete VOD,
 *                            db purge). Defaults to off.
 * - --allow-destructive      CLI flag, same effect as the env var.
 */

export interface ServerConfig {
  /** Normalized base URL, always ending in `/api/v1` (no trailing slash). */
  baseUrl: string;
  /** `sk_` bearer token (or a login JWT). */
  token: string;
  /** Whether destructive tools are registered. Default false. */
  allowDestructive: boolean;
}

/** Strip trailing slashes and append `/api/v1` unless already present. */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (!/\/api\/v1$/.test(url)) url += '/api/v1';
  return url;
}

const TRUTHY = /^(1|true|yes|on)$/i;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
): ServerConfig {
  const rawUrl = env.STREAMHUB_API_URL;
  if (!rawUrl) {
    throw new Error(
      'STREAMHUB_API_URL is required (e.g. "https://media.example.com" or "http://127.0.0.1:3020").',
    );
  }
  const token = env.STREAMHUB_API_TOKEN;
  if (!token) {
    throw new Error(
      'STREAMHUB_API_TOKEN is required (an sk_ API token; an app-scoped token is recommended).',
    );
  }
  const allowDestructive =
    argv.includes('--allow-destructive') || TRUTHY.test(env.STREAMHUB_ALLOW_DESTRUCTIVE ?? '');

  return { baseUrl: normalizeBaseUrl(rawUrl), token, allowDestructive };
}
