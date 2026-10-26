/**
 * MCP server assembly: registers the tool catalogue, a couple of resources
 * (app list / app detail / health) and operator prompts on top of the
 * StreamHub HTTP client.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StreamHubApiError, StreamHubClient } from './client.ts';
import type { ServerConfig } from './config.ts';
import { buildTools } from './tools.ts';

export const SERVER_NAME = 'streamhub';
export const SERVER_VERSION = '0.2.0';

function toText(result: unknown): string {
  if (result === undefined) return 'null';
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

function errorText(err: unknown): string {
  if (err instanceof StreamHubApiError) {
    const status = err.status === 0 ? 'network error' : `HTTP ${err.status}`;
    return `StreamHub API error (${status}): ${err.message}`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

export function createServer(cfg: ServerConfig, fetchImpl: typeof fetch = fetch): McpServer {
  const client = new StreamHubClient(cfg, fetchImpl);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ── Tools ─────────────────────────────────────────────────────────────────
  for (const tool of buildTools({ allowDestructive: cfg.allowDestructive })) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(client, (args ?? {}) as Record<string, any>);
          return { content: [{ type: 'text' as const, text: toText(result) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: errorText(err) }], isError: true };
        }
      },
    );
  }

  // ── Resources ─────────────────────────────────────────────────────────────
  server.registerResource(
    'apps',
    'streamhub://apps',
    {
      title: 'StreamHub apps',
      description: 'The list of apps (multi-tenant units) visible to the configured token.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: toText(await client.get('/apps')),
        },
      ],
    }),
  );

  server.registerResource(
    'health',
    'streamhub://health',
    {
      title: 'StreamHub health',
      description: 'Liveness of the configured StreamHub instance.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: toText(await client.get('/health')),
        },
      ],
    }),
  );

  server.registerResource(
    'app',
    new ResourceTemplate('streamhub://apps/{app}', { list: undefined }),
    {
      title: 'StreamHub app detail',
      description: 'One app by slug, with its resolved configuration.',
      mimeType: 'application/json',
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: toText(await client.get(`/apps/${encodeURIComponent(String(variables.app))}`)),
        },
      ],
    }),
  );

  // ── Prompts ───────────────────────────────────────────────────────────────
  server.registerPrompt(
    'go-live',
    {
      title: 'How to go live',
      description:
        'Step-by-step runbook to put a stream on air in a StreamHub app (RTMP ingest via OBS or any encoder) and share playback.',
      argsSchema: {
        app: z.string().describe('App slug to go live in.'),
        room: z.string().optional().describe('Room name (defaults to the app room prefix).'),
      },
    },
    ({ app, room }) => {
      const r = room || '<room>';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Help me go live on the StreamHub app "${app}"${room ? ` in room "${room}"` : ''}. Follow this runbook with the streamhub tools:`,
                '',
                `1. Verify the app exists with get_app (name: "${app}"); if it does not, ask me before creating it with create_app.`,
                `2. Create an RTMP ingest with create_ingress (app: "${app}", inputType: "rtmp"${room ? `, room: "${room}"` : ''}).`,
                '3. Give me the returned rtmp_url and stream_key formatted for OBS: Settings > Stream > Service "Custom", Server = rtmp_url, Stream Key = stream_key.',
                `4. After I start streaming, confirm it is on air with list_ingress (status should be "publishing") and list_streams (app: "${app}").`,
                `5. Share playback: the public player is ${client.origin}/play/${app}/${r} (if the app has publicPlayback disabled, mint a signed URL with sign_playback_url). For embedding use ${client.origin}/embed/${app}/${r}.`,
                '6. Ask me if I want to record: if yes, use start_recording (roomName = the ingress room) and tell me the recording id so we can stop it later.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'diagnose-stream',
    {
      title: 'Diagnose a stream',
      description:
        'Investigate why a stream is not working: ingress state, live rooms, app stats and error logs.',
      argsSchema: {
        app: z.string().describe('App slug.'),
        room: z.string().optional().describe('Room name, if known.'),
      },
    },
    ({ app, room }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `A stream in StreamHub app "${app}"${room ? ` (room "${room}")` : ''} is not working. Diagnose it with the streamhub tools:`,
              '',
              `1. get_health — is the server itself up?`,
              `2. list_ingress (app: "${app}"${room ? `, room: "${room}"` : ''}) — check status (inactive/buffering/publishing/error), bitrate and dimensions. "inactive" means the encoder never connected: re-check rtmp_url + stream_key.`,
              `3. list_streams and list_rooms (app: "${app}") — is the room live, are there participants?`,
              `4. get_app_stats (app: "${app}") — viewers, ingress and the 24h log rollup.`,
              `5. query_logs (app: "${app}", level: "error", limit: 50) — recent errors around ingest/egress.`,
              '6. Summarize the root cause and the fix; typical culprits: wrong stream key, encoder pushing to the wrong host/port (RTMP is 1935 on the server IP, not behind the proxy), app recording/transcoding misconfig, or the room name not matching the app prefix.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
