// Parity vectors for the Go MCP server (internal/mcpserver), generated from the
// TypeScript server (mcp-server/, @modelcontextprotocol/sdk 1.29.0, zod 3)
// before it was removed (last present at commit d05b0512). Run from such a checkout:
//   cd mcp-server && npm ci && cp ../streamhub-core-go/internal/mcpserver/testdata/gen.mjs . \
//     && node gen.mjs && rm gen.mjs
// Writes ../streamhub-core-go/internal/mcpserver/testdata/ts_catalog.json (the
// initialize result + tools/resources/templates/prompts lists, gate off and
// on, and rendered prompts) and ts_calls.json (tools/call, resources/read
// and prompts/get exchanges against the scripted fake API below — the Go
// tests replay them against an httptest fake with the same script).
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './src/server.ts';
import { TOOLS } from './src/tools.ts';

const OUT = '../streamhub-core-go/internal/mcpserver/testdata';
const BASE = 'https://media.example.com/api/v1';

// Scripted fake StreamHub API: the first path segment after /apps/ (or the
// `name` of get_app) selects a canned response; anything else echoes.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const seg = u.pathname.split('/')[4] ?? '';
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  switch (seg) {
    case 'e404': return json(404, { statusCode: 404, message: "app 'e404' not found", error: 'Not Found' });
    case 'e400': return json(400, { statusCode: 400, message: ['name must be a string', 'room too long'], error: 'Bad Request' });
    case 'e403err': return json(403, { statusCode: 403, error: 'Forbidden' });
    case 'e500text': return new Response('upstream exploded', { status: 500 });
    case 'e502empty': return new Response('', { status: 502 });
    case 'e204': return new Response(null, { status: 204 });
    case 'eenv': return json(200, { data: null, error: { code: 'quota', message: 'quota exceeded' } });
    case 'eenvstr': return json(200, { data: null, error: 'bad thing' });
    case 'paged': return json(200, { data: [{ id: 1 }, { id: 2 }], total: 9, limit: 2, offset: 0 });
    case 'bare': return json(200, [1, 'x', { b: 2, a: 1, '2': 3 }]);
    case 'text': return new Response('plain text body', { status: 200 });
    case 'undef': return json(200, { data: null, error: null });
    case 'net': throw new TypeError('fetch failed');
  }
  const h = init.headers ?? {};
  return json(200, { data: { method: init.method, url, authorization: h.authorization, accept: h.accept, contentType: h['content-type'] ?? null, body: init.body ?? null }, error: null });
}

async function connect(allowDestructive) {
  const server = createServer({ baseUrl: BASE, token: 'sk_test', allowDestructive }, fakeFetch);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'gen', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function catalog(allowDestructive) {
  const client = await connect(allowDestructive);
  const out = {
    serverInfo: client.getServerVersion(),
    capabilities: client.getServerCapabilities(),
    instructions: client.getInstructions() ?? null,
    tools: (await client.listTools()).tools,
    resources: (await client.listResources()).resources,
    resourceTemplates: (await client.listResourceTemplates()).resourceTemplates,
    prompts: (await client.listPrompts()).prompts,
  };
  await client.close();
  return out;
}

// One sentinel value per schema property: exercises every tool's mapping.
function sentinel(key, s, i) {
  const t = s.type ?? s.anyOf?.[0]?.type;
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[s.enum.length - 1];
  if (t === 'string') return `s${i}-${key} /&?é`;
  if (t === 'integer' || t === 'number') return 1000 + i;
  if (t === 'boolean') return i % 2 === 0;
  if (t === 'array') return [`a${i}`, `b ${i}`];
  if (t === 'object') return { z: i, a: { nested: [true, null] }, [`${i}`]: 'num-key' };
  return `s${i}`;
}

const cases = [];
for (const tool of TOOLS) {
  const schema = zodToJsonSchema(z.object(tool.inputSchema));
  const props = schema.properties ?? {};
  const req = new Set(schema.required ?? []);
  const all = {}, required = {};
  Object.entries(props).forEach(([k, s], i) => { all[k] = sentinel(k, s, i); if (req.has(k)) required[k] = all[k]; });
  cases.push({ tool: tool.name, args: all }, { tool: tool.name, args: required });
  for (const [k, s] of Object.entries(props)) {
    if (s.enum) for (const v of s.enum.slice(0, -1)) cases.push({ tool: tool.name, args: { ...all, [k]: v } });
  }
}
// Response handling + error mapping.
for (const name of ['e404', 'e400', 'e403err', 'e500text', 'e502empty', 'e204', 'eenv', 'eenvstr', 'paged', 'bare', 'text', 'undef', 'net']) {
  cases.push({ tool: 'get_app', args: { name } });
}
cases.push({ tool: 'list_streams', args: { app: 'paged' } }, { tool: 'set_live_control_settings', args: { app: 'live', defaultPauseAssetId: null } });
// Input validation (zod issues) + unknown/gated tools.
const bad = [
  ['get_vod', { app: 'live', id: 'x' }], ['get_vod', {}], ['get_vod', { app: 'live', id: 1.5 }], ['get_vod', { app: null, id: 2 }],
  ['get_app', { name: 5 }], ['get_app', { name: 'a', extra: 1 }], ['get_app', { name: true }], ['get_app', { name: [] }], ['get_app', { name: {} }],
  ['query_logs', { limit: 0 }], ['query_logs', { limit: -1, offset: -2 }], ['query_logs', { offset: 1.5 }], ['query_logs', { level: 'nope' }],
  ['query_logs', { level: 3 }], ['query_logs', { limit: '5' }],
  ['delete_app', { name: 'x', confirm: false }], ['delete_app', { name: 'x' }], ['delete_app', { name: 'x', confirm: 'true' }],
  ['purge_app_db', { app: 'x', confirm: true }], ['purge_app_db', { app: 'x', scope: 'bogus', confirm: true }],
  ['apply_room_tags', { app: 'live', room: 'r', tags: 'x' }], ['apply_room_tags', { app: 'live', room: 'r', tags: ['a', 2, null] }],
  ['update_app', { name: 'live', variables: { a: 'b', c: 3 } }], ['update_app', { name: 'live', variables: [] }],
  ['create_tag', { app: 'live', slug: 's', label: 'l', config_json: 'x' }], ['create_tag', { app: 'live', slug: 's', label: 'l', config_json: null }],
  ['set_live_control_settings', { app: 'live', defaultPauseAssetId: 'x' }], ['set_live_control_settings', { app: 'live', defaultPauseAssetId: 2.5 }],
  ['control_plugin_worker', { app: 'live', id: 'w' }],
  ['nope', {}],
];
for (const [tool, args] of bad) cases.push({ tool, args });
const s = TOOLS.find((t) => t.name === 'set_stream_health_room_settings');
const shProps = Object.keys(zodToJsonSchema(z.object(s.inputSchema)).properties);
cases.push({ tool: s.name, args: { app: 'live', room: 'r', stall_sec: 1 } }, { tool: s.name, args: { app: 'live', room: 'r', stall_sec: 601, silence_db: 1 } });
void shProps;

async function runCalls(allowDestructive) {
  const client = await connect(allowDestructive);
  const out = [];
  for (const c of cases) {
    try { out.push({ ...c, result: await client.callTool({ name: c.tool, arguments: c.args }) }); }
    catch (e) { out.push({ ...c, error: { code: e.code, message: e.message } }); }
  }
  const reads = [];
  for (const uri of ['streamhub://apps', 'streamhub://health', 'streamhub://apps/live', 'streamhub://apps/a%20b', 'streamhub://apps/e404', 'streamhub://nope']) {
    try { reads.push({ uri, result: await client.readResource({ uri }) }); }
    catch (e) { reads.push({ uri, error: { code: e.code, message: e.message } }); }
  }
  const prompts = [];
  for (const p of [
    { name: 'go-live', arguments: { app: 'live' } }, { name: 'go-live', arguments: { app: 'live', room: 'lobby' } },
    { name: 'go-live', arguments: { app: 'live', room: '' } },
    { name: 'diagnose-stream', arguments: { app: 'live' } }, { name: 'diagnose-stream', arguments: { app: 'live', room: 'cam1' } },
    { name: 'go-live', arguments: {} }, { name: 'nope', arguments: {} },
  ]) {
    try { prompts.push({ ...p, result: await client.getPrompt(p) }); }
    catch (e) { prompts.push({ ...p, error: { code: e.code, message: e.message } }); }
  }
  await client.close();
  return { calls: out, reads, prompts };
}

writeFileSync(`${OUT}/ts_catalog.json`, JSON.stringify({ safe: await catalog(false), destructive: await catalog(true) }, null, 2) + '\n');
writeFileSync(`${OUT}/ts_calls.json`, JSON.stringify({ base: BASE, safe: await runCalls(false), destructive: await runCalls(true) }, null, 2) + '\n');
