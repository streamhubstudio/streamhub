// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Records the Node edge gateway's wire behaviour into ws_vectors.json.
//
//   node internal/edge/testdata/record-node-ws.js ../streamhub-core > internal/edge/testdata/ws_vectors.json
//
// Boots streamhub-core/dist/main.js on a temp DATA_DIR (cluster token set,
// dead Redis), joins an edge node over HTTP, then drives the WS channel with
// the `ws` client from streamhub-core/node_modules. Every master→edge frame
// and every HTTP reply is recorded after replacing run-specific values
// (node id, assignment ids, cmdId/reqId, timestamps) with placeholders; the
// Go integration test (gateway_ws_test.go) replays the same steps against
// the Go gateway and must produce identical text.
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const core = path.resolve(process.argv[2] || '../streamhub-core');
const WebSocket = require(path.join(core, 'node_modules/ws'));

const TOKEN = 'ws-vector-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-ws-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-ws-cwd-'));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir,
    ADMIN_USER: 'admin', ADMIN_PASS: 'ws-admin-pass', STREAMHUB_JWT_SECRET: 'ws-jwt-secret-0123456789abcdef',
    REDIS_URL: 'redis://127.0.0.1:63999', LIVEKIT_URL: '', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
    STREAMHUB_CLUSTER_TOKEN: TOKEN, STREAMHUB_BACKUPS_ENABLED: 'false', STREAMHUB_AUTHZ_ENFORCE: 'on',
  };
  const proc = spawn(process.execPath, [path.join(core, 'dist/main.js')], { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(`${base}/api/v1/health`)).ok) break; } catch {}
      await sleep(100);
    }
    const out = await record(base, port);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } finally {
    proc.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** Raw upgrade request → the exact bytes the server answers. */
function rawUpgrade(port, pathq, headers = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.on('data', (d) => (buf += d.toString('latin1')));
    sock.on('close', () => resolve(buf));
    sock.on('error', () => resolve(buf));
    const h = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    sock.write(
      `GET ${pathq} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${h}\r\n`,
    );
    setTimeout(() => sock.destroy(), 3000);
  });
}

async function record(base, port) {
  const login = await (await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'ws-admin-pass' }),
  })).json();
  const jwt = login.data.token;
  const api = async (method, p, body) => {
    const r = await fetch(`${base}/api/v1${p}`, {
      method, headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const join = await (await fetch(`${base}/api/v1/cluster/join`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cluster-token': TOKEN },
    body: JSON.stringify({ name: 'ws-edge', ip: '192.0.2.10', type: 'edge' }),
  })).json();
  const nodeId = join.data.nodeId;

  // placeholders for run-specific values
  const ph = new Map([[nodeId, '{{nodeId}}']]);
  const norm = (text) => {
    let t = text;
    for (const [v, k] of ph) t = t.split(v).join(k);
    return t
      .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, '<sql-ts>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<iso-ts>');
  };
  const steps = [];

  // 1) upgrade rejections
  const q = (s) => `/api/v1/edge/ws${s}`;
  steps.push({ step: 'reject-no-token', response: await rawUpgrade(port, q(`?nodeId=${nodeId}`)) });
  steps.push({ step: 'reject-bad-token', response: await rawUpgrade(port, q(`?nodeId=${nodeId}`), { 'X-Cluster-Token': 'nope' }) });
  steps.push({ step: 'reject-no-node', response: await rawUpgrade(port, q(''), { 'X-Cluster-Token': TOKEN }) });
  steps.push({ step: 'reject-unknown-node', response: await rawUpgrade(port, q('?nodeId=ghost&token=' + TOKEN)) });

  // 2) connect + register
  const frames = [];
  const open = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${q('?nodeId=' + nodeId)}`, { headers });
    ws.on('message', (d) => frames.push(d.toString()));
    ws.on('open', () => resolve(ws));
  });
  const next = async () => {
    for (let i = 0; i < 100 && frames.length === 0; i++) await sleep(50);
    return frames.shift();
  };
  let ws = await open({ 'X-Cluster-Token': TOKEN });
  ws.send(JSON.stringify({ type: 'register', role: 'edge', agentVersion: '1.2.3', capabilities: ['cuda', 7] }));
  await sleep(200);

  // 3) schedule onto the connected node → assign frame
  const created = await api('POST', '/edge/assignments', { app: 'live', pluginId: 'wsplug', streamId: 'cam1', config: { room: 'cam1', z: 1, a: { b: [1, 2.5, 'x'] } } });
  ph.set(created.body.data.id, '{{asg1}}');
  steps.push({ step: 'schedule-http', response: norm(JSON.stringify(created)) });
  steps.push({ step: 'schedule-frame', frame: norm(await next()) });

  // 4) assignment_status + telemetry → state via HTTP
  ws.send(JSON.stringify({ type: 'assignment_status', id: created.body.data.id, status: 'running', detail: 'pid 42' }));
  ws.send(JSON.stringify({ type: 'telemetry', stats: { cpu: 0.5, grid: { gpu: true, vramFreeMb: 3000 }, z: [1] } }));
  ws.send('not json');
  ws.send(JSON.stringify({ type: 'mystery' }));
  await sleep(300);
  steps.push({ step: 'after-status', response: norm(JSON.stringify(await api('GET', '/edge/assignments?app=live'))) });
  const nodes = await api('GET', '/edge/nodes');
  steps.push({ step: 'after-telemetry', response: norm(JSON.stringify(nodes.body.data.find((n) => n.id === nodeId))) });

  // 5) command round-trip
  const cmdP = api('POST', `/edge/nodes/${nodeId}/command`, { command: 'restart', args: { soft: true, n: 1 } });
  const cmdFrame = await next();
  const cmdId = JSON.parse(cmdFrame).cmdId;
  ph.set(cmdId, '{{cmdId}}');
  steps.push({ step: 'cmd-frame', frame: norm(cmdFrame) });
  ws.send(JSON.stringify({ type: 'cmd_result', cmdId, ok: true, output: 'restarted' }));
  steps.push({ step: 'cmd-http', response: norm(JSON.stringify(await cmdP)) });

  // 6) log tail round-trip
  const logP = api('GET', `/edge/nodes/${nodeId}/logs?lines=5`);
  const logFrame = await next();
  const reqId = JSON.parse(logFrame).reqId;
  ph.set(reqId, '{{reqId}}');
  steps.push({ step: 'logtail-frame', frame: norm(logFrame) });
  ws.send(JSON.stringify({ type: 'log_tail_result', reqId, lines: ['a', 2, 'b'] }));
  steps.push({ step: 'logtail-http', response: norm(JSON.stringify(await logP)) });

  // 7) command timeout (no reply) → 504
  const toP = api('POST', `/edge/nodes/${nodeId}/command`, { command: 'ping' });
  const toFrame = await next();
  ph.set(JSON.parse(toFrame).cmdId, '{{cmdId2}}');
  steps.push({ step: 'cmd2-frame', frame: norm(toFrame) });
  steps.push({ step: 'cmd-timeout-http', response: norm(JSON.stringify(await toP)) });

  // 8) keepalive ping (15s cadence)
  let ping;
  for (let i = 0; i < 400 && !ping; i++) {
    await sleep(50);
    const k = frames.findIndex((f) => JSON.parse(f).type === 'ping');
    if (k >= 0) ping = frames.splice(k, 1)[0];
  }
  steps.push({ step: 'ping-frame', frame: ping });
  ws.send(JSON.stringify({ type: 'pong' }));

  // 9) revoke → frame
  const rev = await api('DELETE', `/edge/assignments/${created.body.data.id}`);
  steps.push({ step: 'revoke-http', response: norm(JSON.stringify(rev)) });
  steps.push({ step: 'revoke-frame', frame: norm(await next()) });

  // 10) a second assignment, then a newer connection replaces the old one (4409)
  const c2 = await api('POST', '/edge/assignments', { app: 'live', pluginId: 'wsplug2' });
  ph.set(c2.body.data.id, '{{asg2}}');
  steps.push({ step: 'schedule2-frame', frame: norm(await next()) });
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  const frames2 = [];
  const ws2 = await new Promise((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}${q('?nodeId=' + nodeId + '&token=' + TOKEN)}`);
    s.on('message', (d) => frames2.push(d.toString()));
    s.on('open', () => resolve(s));
  });
  steps.push({ step: 'replaced-close', close: await closed });
  // register on the new socket re-offers the still-offered assignment
  ws2.send(JSON.stringify({ type: 'register', role: 'edge' }));
  for (let i = 0; i < 100 && frames2.length === 0; i++) await sleep(50);
  steps.push({ step: 'reoffer-frame', frame: norm(frames2.shift()) });
  steps.push({ step: 'after-reoffer', response: norm(JSON.stringify(await api('GET', '/edge/assignments?app=live'))) });
  ws2.close();
  await sleep(300);
  const nodes2 = await api('GET', '/edge/nodes');
  steps.push({ step: 'after-close', response: norm(JSON.stringify(nodes2.body.data.find((n) => n.id === nodeId))) });
  return { generator: 'internal/edge/testdata/record-node-ws.js', token: TOKEN, steps };
}

main().catch((e) => { console.error(e); process.exit(1); });
