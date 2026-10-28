// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Node-side golden generator for the apps package: drives the REAL compiled
// AppsService (streamhub-core/dist) through a fixed scenario and records, per
// step, the config.yaml text it wrote (js-yaml dump) and the resolved config.
// golden_test.go replays the same steps on the Go service and compares.
//
//   cd streamhub-core && npm run build   # if src is newer than dist
//   node ../streamhub-core-go/internal/apps/testdata/gen.js
//
// No network: callback URLs are IP literals, SSRF DNS seam stubbed anyway.
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = process.cwd();
const Database = require(path.join(core, 'node_modules/better-sqlite3'));
const { AppsService } = require(path.join(core, 'dist/modules/apps/apps.service'));
const { S3Service } = require(path.join(core, 'dist/modules/s3/s3.service'));
const { SecretsStore } = require(path.join(core, 'dist/modules/s3/secrets.store'));
const steps = require('./steps.json');

const out = path.join(__dirname, 'golden');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-golden-'));
const config = { dataDir, publicWsUrl: '', env: (k) => process.env[k] };
const g = new Database(':memory:');
g.exec(`CREATE TABLE apps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  display_name TEXT, livekit_room_prefix TEXT, created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), settings_json TEXT, tenant_id TEXT DEFAULT 'platform')`);
const db = { global: () => g, appDb: () => null, closeApp: () => undefined };
const moduleRef = { get: () => { throw new Error('no samples'); } };
const s3 = new S3Service();
const secrets = new SecretsStore(config);
const apps = new AppsService(config, db, s3, secrets, moduleRef);
apps.hostResolver = async () => ['93.184.216.34'];
apps.logger = { log() {}, warn() {}, error() {}, debug() {} };

(async () => {
  const results = [];
  for (const [i, step] of steps.entries()) {
    const id = String(i).padStart(2, '0');
    let res;
    try {
      res = await apps[step.op](...step.args);
    } catch (err) {
      res = { $error: err.message };
    }
    const app = typeof step.args[0] === 'string' ? step.args[0] : step.args[0].name;
    const cfgFile = path.join(dataDir, 'apps', app, 'config.yaml');
    const yamlText = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    let resolved = null;
    try { resolved = await apps.getConfig(app); } catch { resolved = null; }
    if (yamlText !== null) fs.writeFileSync(path.join(out, `${id}.yaml`), yamlText);
    results.push({ step: i, op: step.op, result: res === undefined ? null : res, resolved });
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  fs.rmSync(dataDir, { recursive: true, force: true });
})();
