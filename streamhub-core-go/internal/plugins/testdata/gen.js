// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Node-side vectors for the plugins package (run from streamhub-core after
// `npm run build`):
//
//   node ../streamhub-core-go/internal/plugins/testdata/gen.js
//
// Writes testdata/:
//   spawn_vectors.json  — {command,args,env(ordered pairs),cwd} the compiled
//                         registry's worker.spawn returns for every
//                         needsWorker plugin × a local and a remote context,
//                         plus the framework env of a local start;
//   catalog.json        — listManifests() (order = localeCompare by name);
//   collation.json      — a localeCompare sort vector;
//   export_fixapp.tar   — the UNCOMPRESSED tar of composePluginBundle for the
//                         vendor/fixapp fixture (gzip framing differs);
//   config_vectors.json — validateConfig / redact / sanitize outcomes.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const core = process.cwd();
const dist = (p) => require(path.join(core, 'dist', p));
const { PluginRegistryService } = dist('modules/plugins/plugin-registry.service');
const { toManifest } = dist('modules/plugins/plugin.contract');
const { composePluginBundle, packTarGz, resolveWorkerDir } = dist('modules/plugins/plugin-export.service');
const cfgUtil = dist('modules/plugins/plugin-config.util');

const out = __dirname;
// In-tree metas from dist + the vendored manifests COPIED into testdata/vendor
// (so the Go test is independent of the locally composed plugins-vendor).
const vendorRoot = path.join(out, 'vendor');
const reg = new PluginRegistryService(path.join(core, 'dist', 'plugins'), vendorRoot);
reg.discover();

const norm = (s) => (typeof s === 'string' ? s.split(vendorRoot).join('<VENDOR>') : s);
const ctxFor = (meta, remote) => ({
  app: 'live',
  config: cfgUtil.defaultConfig(meta),
  appDir: '/data/apps/live',
  dataDir: '/data',
  livekitUrl: 'ws://127.0.0.1:7880',
  ...(remote
    ? { node: { id: 'n1', name: 'gpu-1', url: 'https://gpu-1.example', region: 'eu' }, originUrl: 'https://origin.example' }
    : {}),
  appTimezone: 'Europe/Madrid',
});
const spawn = [];
const env = { FIX_HOST: 'h.example', PLUGIN_PYTHON: '/opt/py/bin/python3', PUBLIC_BASE_URL: 'https://public.example', PLUGIN_NODE: '/usr/bin/node', HEALTH_WORKER_DIR: '/opt/workers/health-worker' };
Object.assign(process.env, env);
for (const m of reg.listManifests()) {
  const meta = reg.getMeta(m.id);
  if (!meta.needsWorker || !meta.worker) continue;
  for (const remote of [false, true]) {
    const s = meta.worker.spawn(ctxFor(meta, remote));
    spawn.push({
      id: m.id, remote,
      command: norm(s.command), args: (s.args ?? []).map(norm),
      env: Object.entries(s.env ?? {}).map(([k, v]) => [k, norm(v)]),
      cwd: s.cwd === undefined ? null : norm(s.cwd),
    });
  }
}
fs.writeFileSync(path.join(out, 'spawn_vectors.json'), JSON.stringify({ env, spawn }, null, 2));

fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(reg.listManifests(), null, 2));

const words = ['Zeta', 'alpha', 'Alpha', 'älpha', '_init_.py', '__init__.py', 'README.md', 'readme.md', 'requirements.txt',
  'tests', 'Tests', 'a-b', 'a_b', 'ab', 'a.b', 'a1', 'a10', 'a2', 'Fleet — Agent Management', 'Fleet', 'Counting — x', 'Cockpit',
  '.env', 'main.py', 'Main.py', '1.0.0', '1.0.0-beta', 'ñandú', 'nandu', 'Ñ'];
fs.writeFileSync(path.join(out, 'collation.json'), JSON.stringify([...words].sort((a, b) => a.localeCompare(b)), null, 2));

{
  const meta = reg.getMeta('fixapp');
  const src = path.join(vendorRoot, 'fixapp', 'worker');
  const tar = zlib.gunzipSync(packTarGz(composePluginBundle(meta, 'fixapp', src)));
  fs.writeFileSync(path.join(out, 'export_fixapp.tar'), tar);
}

const meta = {
  id: 'x', configSchema: [
    { key: 's', type: 'string', label: 'S', default: 'a' },
    { key: 'n', type: 'number', label: 'N', default: 2, min: 1, max: 10.5 },
    { key: 'b', type: 'boolean', label: 'B', default: false },
    { key: 'sel', type: 'select', label: 'Sel', default: 'x', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] },
    { key: 'apiKey', type: 'secret', label: 'K', default: '', required: true },
    { key: 'callbackUrl', type: 'string', label: 'C', default: '' },
  ],
};
const inputs = [null, {}, { s: 'q' }, { n: '3.5' }, { n: 'abc' }, { n: 0 }, { n: 11 }, { b: 'true' }, { b: 1 }, { sel: 'z' }, { sel: 5 },
  { nope: 1 }, { s: null }, { apiKey: 'k' }, { s: 5 }, { n: '1e400' }];
const cases = [];
for (const input of inputs) {
  for (const req of [false, true]) {
    try {
      const v = cfgUtil.validateConfig(meta, input, req);
      cases.push({ input, req, ok: v, redacted: cfgUtil.redactSecrets(meta, v), public: cfgUtil.sanitizePublicConfig(meta, v) });
    } catch (e) {
      cases.push({ input, req, error: e.message });
    }
  }
}
fs.writeFileSync(path.join(out, 'config_vectors.json'), JSON.stringify({ schema: meta.configSchema, cases }, null, 2));
console.log('spawn', spawn.length, 'catalog', reg.listManifests().length);
