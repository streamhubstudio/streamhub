/**
 * Unit specs for the Studio-App exporter's PURE core (`composePluginBundle` +
 * `packTarGz`) — no Nest DI, no install guards.
 *
 * Given a fake exportable meta + a temp worker source tree, the bundle must:
 *   - contain the exact expected file list (worker source + generated files),
 *   - exclude __pycache__, *.pyc, *.db and oversized model binaries,
 *   - render a .env.example carrying EVERY spawn env key, with secrets blanked,
 *     `*_HLS_DIR` blanked and `*_PUBLIC_BASE` forced to a placeholder host (no
 *     real hostname leaks),
 *   - be deterministic (byte-identical on repeat packs).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { composePluginBundle, packTarGz } from './plugin-export.service';
import type { PluginMeta } from './plugin.contract';

const REAL_HOST = 'https://real-prod-host.internal';

const fakeMeta: PluginMeta = {
  id: 'demo-app',
  name: 'Demo App',
  description: 'A demo studio app for the exporter spec.',
  category: 'processor',
  ui: 'app-tab',
  version: '1.2.3',
  kind: 'app',
  export: { workerDir: 'demo-worker' },
  needsWorker: true,
  configSchema: [
    { key: 'room', type: 'string', label: 'Room', default: '' },
    { key: 'apiKey', type: 'secret', label: 'API key', default: '' },
  ],
  worker: {
    spawn(ctx) {
      return {
        command: 'python3',
        args: ['-m', 'demo_worker', '--app', ctx.app],
        cwd: '/whatever',
        env: {
          PYTHONPATH: '/whatever',
          DEMO_APP: ctx.app,
          DEMO_ROOM: String(ctx.config.room ?? ''),
          // A non-empty secret-looking value the EXPORTER must blank.
          DEMO_API_TOKEN: 'leak-me-if-you-can',
          DEMO_CALLBACK_URL: '',
          DEMO_CALLBACK_SECRET: String(ctx.config.apiKey ?? ''),
          // Sourced from process.env → must never carry a real host through.
          DEMO_PUBLIC_BASE: process.env.PUBLIC_BASE_URL ?? '',
          DEMO_HLS_DIR: `${ctx.appDir}/hls`,
          DEMO_LIVEKIT_URL: ctx.livekitUrl,
        },
      };
    },
  },
};

describe('plugin-export — composePluginBundle', () => {
  let root: string;
  let srcDir: string;
  let prevSrcRoot: string | undefined;
  let prevPublicBase: string | undefined;

  const write = (rel: string, body: Buffer | string): void => {
    const full = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-export-'));
    srcDir = path.join(root, 'repo', 'demo-worker');
    fs.mkdirSync(srcDir, { recursive: true });
    // A repo-root LICENSE sibling of the worker dir → the exporter bundles it.
    fs.writeFileSync(path.join(root, 'repo', 'LICENSE'), 'FAKE LICENSE TEXT');

    // Worker source (kept) + noise (dropped).
    write('requirements.txt', 'opencv-python-headless\n');
    write('demo_worker/__init__.py', '# demo\n');
    write('demo_worker/runner.py', 'print("run")\n');
    write('tests/test_demo.py', 'def test_ok():\n    assert True\n');
    write('__pycache__/runner.cpython-311.pyc', Buffer.from([0, 1, 2]));
    write('demo_worker/__pycache__/x.pyc', Buffer.from([0]));
    write('demo.db', Buffer.from('SQLite format 3\0'));
    write('models/big.onnx', Buffer.alloc(6 * 1024 * 1024, 1)); // > 5MB → skipped

    // Isolate license/host resolution from the surrounding environment.
    prevSrcRoot = process.env.STREAMHUB_WORKER_SRC_ROOT;
    delete process.env.STREAMHUB_WORKER_SRC_ROOT;
    prevPublicBase = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = REAL_HOST;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (prevSrcRoot === undefined) delete process.env.STREAMHUB_WORKER_SRC_ROOT;
    else process.env.STREAMHUB_WORKER_SRC_ROOT = prevSrcRoot;
    if (prevPublicBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = prevPublicBase;
  });

  it('produces the exact expected file list (source + generated, noise dropped)', () => {
    const names = composePluginBundle(fakeMeta, 'demo-app', srcDir)
      .map((e) => e.name)
      .sort();
    expect(names).toEqual([
      'demo-app/.env.example',
      'demo-app/Dockerfile',
      'demo-app/LICENSE',
      'demo-app/README.md',
      'demo-app/docker-compose.yml',
      'demo-app/worker/demo_worker/__init__.py',
      'demo-app/worker/demo_worker/runner.py',
      'demo-app/worker/requirements.txt',
      'demo-app/worker/tests/test_demo.py',
    ]);
  });

  it('never bundles __pycache__, *.pyc, *.db or >5MB binaries', () => {
    const names = composePluginBundle(fakeMeta, 'demo-app', srcDir).map(
      (e) => e.name,
    );
    const joined = names.join('\n');
    expect(joined).not.toMatch(/__pycache__/);
    expect(joined).not.toMatch(/\.pyc$/m);
    expect(joined).not.toMatch(/\.db$/m);
    expect(joined).not.toMatch(/big\.onnx/);
  });

  it('.env.example lists every spawn env key, with secrets + hls blanked', () => {
    const entries = composePluginBundle(fakeMeta, 'demo-app', srcDir);
    const env = entries.find((e) => e.name === 'demo-app/.env.example')!;
    const txt = env.body.toString('utf8');

    // Every key the meta's spawn injects appears.
    for (const key of [
      'PYTHONPATH',
      'DEMO_APP',
      'DEMO_ROOM',
      'DEMO_API_TOKEN',
      'DEMO_CALLBACK_URL',
      'DEMO_CALLBACK_SECRET',
      'DEMO_PUBLIC_BASE',
      'DEMO_HLS_DIR',
      'DEMO_LIVEKIT_URL',
    ]) {
      expect(txt).toMatch(new RegExp(`^${key}=`, 'm'));
    }
    // Framework identity vars added.
    expect(txt).toMatch(/^STREAMHUB_APP=myapp$/m);
    expect(txt).toMatch(/^STREAMHUB_PLUGIN_ID=demo-app$/m);

    // Secrets blanked (even the non-empty token), HLS blanked.
    expect(txt).toMatch(/^DEMO_API_TOKEN=$/m);
    expect(txt).toMatch(/^DEMO_CALLBACK_SECRET=$/m);
    expect(txt).toMatch(/^DEMO_HLS_DIR=$/m);
    expect(txt).not.toContain('leak-me-if-you-can');

    // PUBLIC_BASE forced to the placeholder host; the real host never leaks.
    expect(txt).toMatch(/^DEMO_PUBLIC_BASE=https:\/\/your-streamhub\.example\.com$/m);
    expect(txt).not.toContain('real-prod-host');

    // A non-secret config default is kept verbatim.
    expect(txt).toMatch(/^DEMO_APP=myapp$/m);
  });

  it('generates a Dockerfile + compose that run the derived module', () => {
    const entries = composePluginBundle(fakeMeta, 'demo-app', srcDir);
    const docker = entries
      .find((e) => e.name === 'demo-app/Dockerfile')!
      .body.toString('utf8');
    const compose = entries
      .find((e) => e.name === 'demo-app/docker-compose.yml')!
      .body.toString('utf8');
    expect(docker).toContain('python:3.11-slim');
    expect(docker).toContain('CMD ["python", "-m", "demo_worker"]');
    expect(compose).toContain('env_file: .env');
    expect(compose).toContain('demo-app:');
  });

  it('bundles the README (app name) and the repo LICENSE', () => {
    const entries = composePluginBundle(fakeMeta, 'demo-app', srcDir);
    const readme = entries
      .find((e) => e.name === 'demo-app/README.md')!
      .body.toString('utf8');
    const license = entries
      .find((e) => e.name === 'demo-app/LICENSE')!
      .body.toString('utf8');
    expect(readme).toContain('Demo App');
    expect(readme).toContain('docker compose up');
    expect(license).toBe('FAKE LICENSE TEXT');
  });

  it('packs a deterministic, valid gzip tarball', () => {
    const a = packTarGz(composePluginBundle(fakeMeta, 'demo-app', srcDir));
    const b = packTarGz(composePluginBundle(fakeMeta, 'demo-app', srcDir));
    expect(a.equals(b)).toBe(true); // byte-identical across runs

    // gzip magic + a tar body that is a whole number of 512-byte blocks.
    expect(a[0]).toBe(0x1f);
    expect(a[1]).toBe(0x8b);
    const tar = zlib.gunzipSync(a);
    expect(tar.length % 512).toBe(0);
    // first header's name field starts with the first entry's path
    expect(tar.toString('utf8', 0, 20)).toContain('demo-app/');
  });
});
