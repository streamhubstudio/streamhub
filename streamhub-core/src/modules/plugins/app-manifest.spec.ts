/**
 * Unit specs for the declarative app-manifest validator + meta synthesizer.
 * The validator holds a `streamhub.app.json` to the SAME bar as a built-in meta
 * (PluginRegistryService.validate); `synthesizeMeta` must produce a PluginMeta
 * whose worker spawns via the template interpreter.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AppManifest,
  synthesizeMeta,
  validateAppManifest,
} from './app-manifest';
import { toManifest, PluginWorkerContext } from './plugin.contract';
import { defaultConfig } from './plugin-config.util';
import { interpretWorkerTemplate } from './spawn-template';

// lpr is the DECOUPLED pilot: its in-tree source was removed (F1 exodus), so it
// ships ONLY as a vendored release. `scripts/apps-pull.mjs` extracts the PUBLISHED
// bundle manifest (worker.workerDir = 'worker', package-relative — exactly what
// the in-tree authored manifest carried) to vendor/apps/lpr/; that is the
// "shipped lpr manifest" these specs assert on. When the app isn't composed
// (offline / no STREAMHUB_APPS_TOKEN), the lpr cases skip — the synthetic
// `refapp` fixture (test/fixtures/plugins/) is the always-present interpreter
// witness in spawn-template.spec.ts (a fixture never decouples).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const LPR_MANIFEST = path.join(REPO_ROOT, 'vendor', 'apps', 'lpr', 'streamhub.app.json');
const lprComposed = fs.existsSync(LPR_MANIFEST);

function loadLpr(): AppManifest {
  return JSON.parse(fs.readFileSync(LPR_MANIFEST, 'utf8')) as AppManifest;
}

describe('validateAppManifest', () => {
  (lprComposed ? it : it.skip)('accepts the shipped lpr manifest', () => {
    expect(validateAppManifest(loadLpr())).toEqual([]);
    expect(validateAppManifest(loadLpr(), 'lpr')).toEqual([]);
  });

  (lprComposed ? it : it.skip)('enforces id === folder when a folder is given', () => {
    const errs = validateAppManifest(loadLpr(), 'other');
    expect(errs.some((e) => e.includes("must equal folder name 'other'"))).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateAppManifest(null)).toEqual(['manifest is not an object']);
    expect(validateAppManifest('x')).toEqual(['manifest is not an object']);
  });

  it('flags the core structural problems', () => {
    const bad = {
      id: 'X_bad',
      name: '',
      description: 1,
      category: 'nope',
      ui: 'nowhere',
      version: 'v1',
      kind: 'widget',
      storage: { db: '../etc/passwd' },
      events: [1, 2],
      configSchema: 'no',
    };
    const errs = validateAppManifest(bad);
    expect(errs.some((e) => e.includes('lowercase slug'))).toBe(true);
    expect(errs).toContain('missing name');
    expect(errs).toContain('missing description');
    expect(errs.some((e) => e.includes('invalid category'))).toBe(true);
    expect(errs.some((e) => e.includes('invalid ui slot'))).toBe(true);
    expect(errs.some((e) => e.includes('invalid version'))).toBe(true);
    expect(errs.some((e) => e.includes('invalid kind'))).toBe(true);
    expect(errs.some((e) => e.includes('bare filename'))).toBe(true);
    expect(errs.some((e) => e.includes('events must be an array'))).toBe(true);
    expect(errs).toContain('configSchema must be an array');
  });

  it('validates config fields (default required, select needs options)', () => {
    const base = {
      id: 'demo',
      name: 'Demo',
      description: '',
      category: 'tool',
      ui: 'panel',
      version: '1.0.0',
    };
    expect(
      validateAppManifest({ ...base, configSchema: [{ key: 'a', type: 'string', label: 'A' }] }),
    ).toContain("field 'a' missing default");
    expect(
      validateAppManifest({
        ...base,
        configSchema: [{ key: 's', type: 'select', label: 'S', default: 'x', options: [] }],
      }),
    ).toContain("select field 's' needs options");
  });

  it('validates the declarative worker block', () => {
    const base = {
      id: 'demo',
      name: 'Demo',
      description: '',
      category: 'processor',
      ui: 'app-tab',
      version: '1.0.0',
      configSchema: [],
    };
    // needsWorker without entry/command
    expect(
      validateAppManifest({ ...base, worker: { needsWorker: true } }),
    ).toContain("worker needs an 'entry' string or a 'command'");
    // env value not a string
    expect(
      validateAppManifest({
        ...base,
        worker: { needsWorker: true, entry: 'python3 -m m', env: { X: 5 } },
      }),
    ).toContain('worker.env.X must be a string template');
    // grid without grid placement
    expect(
      validateAppManifest({
        ...base,
        worker: { needsWorker: true, entry: 'python3 -m m', grid: { gpu: true } },
      }),
    ).toContain("worker.grid requirements need worker.placement 'grid'");
    // valid
    expect(
      validateAppManifest({
        ...base,
        worker: { needsWorker: true, entry: 'python3 -m m', placement: 'grid', grid: { gpu: true } },
      }),
    ).toEqual([]);
  });
});

(lprComposed ? describe : describe.skip)('synthesizeMeta', () => {
  it('projects the lpr manifest to a runnable PluginMeta', () => {
    const meta = synthesizeMeta(loadLpr(), { packageDir: '/vendor/lpr' });
    expect(meta.id).toBe('lpr');
    expect(meta.kind).toBe('app');
    expect(meta.needsWorker).toBe(true);
    expect(meta.storage).toEqual({ db: 'lpr.db' });
    expect(meta.events).toEqual(['plate.detected', 'plate.allowed', 'plate.denied']);
    expect(typeof meta.worker?.spawn).toBe('function');
    expect(meta.worker?.placement).toBe('grid');
    expect(meta.worker?.edge).toBe(true);
    // The export descriptor is propagated so a vendored app is indistinguishable
    // from the compiled one in the catalog (exportable === true).
    expect(meta.export).toEqual({ workerDir: 'lpr-worker' });
    // Serializable marketplace view survives (no closure leaks).
    const view = toManifest(meta);
    expect(view.needsWorker).toBe(true);
    expect(view.exportable).toBe(true);
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  it('the synthesized spawn equals the interpreter output (worker source resolved under packageDir)', () => {
    const manifest = loadLpr();
    const meta = synthesizeMeta(manifest, { packageDir: '/vendor/lpr' });
    const ctx: PluginWorkerContext = {
      app: 'myapp',
      config: defaultConfig(meta),
      appDir: '/data/apps/myapp',
      dataDir: '/data',
      livekitUrl: 'wss://lk:7880',
    };
    const spec = meta.worker!.spawn(ctx);
    // workerDir resolves to packageDir/worker (manifest.worker.workerDir = 'worker').
    expect(spec.cwd).toBe(path.join('/vendor/lpr', 'worker'));
    const expected = interpretWorkerTemplate(manifest.worker!, ctx, {
      workerDir: path.join('/vendor/lpr', 'worker'),
    });
    expect(spec).toEqual(expected);
  });

  it('honors an absolute worker.workerDir and the explicit workerDir override', () => {
    const manifest = { ...loadLpr(), worker: { ...loadLpr().worker!, workerDir: '/abs/worker' } };
    const meta = synthesizeMeta(manifest as AppManifest, { packageDir: '/vendor/lpr' });
    const ctx: PluginWorkerContext = {
      app: 'a',
      config: defaultConfig(meta),
      appDir: '/d/apps/a',
      dataDir: '/d',
      livekitUrl: 'wss://lk',
    };
    expect(meta.worker!.spawn(ctx).cwd).toBe('/abs/worker');

    const override = synthesizeMeta(loadLpr(), { packageDir: '/vendor/lpr', workerDir: '/explicit' });
    expect(override.worker!.spawn(ctx).cwd).toBe('/explicit');
  });
});
