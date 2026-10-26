/**
 * Unit specs for PluginRegistryService (auto-discovery).
 *
 * Two flavors:
 *  - default root → discovers the REAL shipped built-in plugins (proves the
 *    glob wiring maps to src/plugins under ts-jest).
 *  - a temp fixture root → covers malformed / duplicate / worker-less-worker
 *    handling WITHOUT crashing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginRegistryService } from './plugin-registry.service';
import { defaultConfig } from './plugin-config.util';

describe('PluginRegistryService — built-in discovery', () => {
  let registry: PluginRegistryService;
  const prevFixtureRoot = process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;

  beforeEach(() => {
    // This describe asserts the REAL shipped catalog EXACTLY (exportable list,
    // kind/edge lists). The synthetic test fixtures must never leak in from a
    // sibling suite that left STREAMHUB_PLUGIN_FIXTURE_ROOT set in a shared jest
    // worker — clear it so these assertions are deterministic.
    delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
    registry = new PluginRegistryService(); // default src/plugins root
    registry.discover();
  });
  afterAll(() => {
    if (prevFixtureRoot === undefined) delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
    else process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = prevFixtureRoot;
  });

  it('auto-discovers the shipped built-in plugins', () => {
    const ids = registry.listManifests().map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['stream-health', 'watermark', 'timestamp']));
  });

  it('manifests are serializable (worker closure stripped)', () => {
    // `stream-health` is a shipped needsWorker Studio App.
    const occupancy = registry.getManifest('stream-health');
    expect(occupancy?.needsWorker).toBe(true);
    // no `worker` function leaks onto the manifest
    expect((occupancy as Record<string, unknown>).worker).toBeUndefined();
    expect(() => JSON.stringify(occupancy)).not.toThrow();
  });

  it('keeps the worker closure on the full meta', () => {
    const meta = registry.getMeta('stream-health');
    expect(typeof meta?.worker?.spawn).toBe('function');
  });

  it('listManifests is sorted by name', () => {
    const names = registry.listManifests().map((m) => m.name);
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('every shipped plugin declares a valid semver version', () => {
    const SEMVER =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
    const manifests = registry.listManifests();
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) {
      expect(typeof m.version).toBe('string');
      expect(m.version).toMatch(SEMVER);
    }
  });

  it('classifies the built-ins into the Studio-App taxonomy (kind)', () => {
    const kind = new Map(registry.listManifests().map((m) => [m.id, m.kind]));
    // lpr AND deface are decoupled VENDORED apps now, not built-ins — each is
    // asserted separately in its own "composes the vendored … app identically
    // to the old built-in" case.
    for (const id of [
      'fleet',
      'cockpit',
    ]) {
      expect(kind.get(id)).toBe('app');
    }
    for (const id of [
      'scheduled-live',
      'quality',
      'streaming',
      'radio',
      'vidstack',
      'timestamp',
      'watermark',
    ]) {
      expect(kind.get(id)).toBe('plugin');
    }
  });

  it('marks exactly the worker-backed built-in apps exportable (none — all decoupled)', () => {
    // lpr and deface (decoupled VENDORED apps) are filtered out so this exact
    // list stays stable whether or not they are composed; their exportability
    // is asserted in each app's "composes the vendored … app identically to the
    // old built-in" case.
    const DECOUPLED = new Set([
      'lpr', 'deface', 'safety-ppe', 'people-counter', 'presence', 'perimeter', 'yolo',
      'occupancy', 'counting', 'crowd', 'demography',
    ]);
    const exportable = registry
      .listManifests()
      .filter((m) => m.exportable && !DECOUPLED.has(m.id))
      .map((m) => m.id)
      .sort();
    // EVERY worker-backed exportable app is decoupled now — the in-tree
    // exportable set is deliberately empty (each app's exportability is locked
    // in its composed witness).
    expect(exportable).toEqual([]);
  });

  it('declares each app-owned SQLite filename on the manifest storage', () => {
    const storage = new Map(
      registry.listManifests().map((m) => [m.id, m.storage]),
    );
    // Decoupled apps' storage (lpr/presence/perimeter/…) is asserted in each
    // vendored composed-witness case.
    expect(storage.get('fleet')).toEqual({ db: 'fleet.db' });
    // The vision model-apps' per-model dbs are asserted in their composed
    // witnesses (decoupled apps).
    // Apps without a declared DB (and every plugin) carry null. (yolo — also
    // storage-less — is a decoupled vendored app; asserted in its witness.)
    expect(storage.get('timestamp')).toBeNull();
  });

  it('surfaces edge-capability on the manifest (worker.edge)', () => {
    const edge = new Map(registry.listManifests().map((m) => [m.id, m.edge]));
    // The four vision apps + the distributable workers are edge-capable.
    // (lpr and deface — also edge-capable — are vendored apps; each asserted in
    // its own composed-witness case.)
    // Every edge-capable app is decoupled now; edge-capability is asserted in
    // each composed witness. In-tree, NOTHING is edge-capable:
    // Local-only workers + worker-less plugins are NOT edge-capable.
    // (transcription — also local-only — is a decoupled VENDORED app now; its
    // non-edge-ness is asserted in its composed-witness case.)
    for (const id of ['cockpit', 'fleet', 'timestamp', 'watermark']) {
      expect(edge.get(id)).toBe(false);
    }
  });

  it('vision-wave plugins are early (0.1.0); stable ones are 1.0.0', () => {
    const byId = new Map(registry.listManifests().map((m) => [m.id, m.version]));
    // (presence/perimeter/the vision 4 — all 0.1.0 — are decoupled vendored
    // apps now; each version is asserted in its composed-witness case.)
    // A stable, non-vision plugin stays at 1.0.0.
    expect(byId.get('watermark')).toBe('1.0.0');
  });

  // lpr is the DECOUPLED pilot — removed from src/plugins (F1 exodus), it joins
  // the catalog ONLY as a vendored release composed by scripts/apps-pull.mjs.
  // This locks that the vendored app is INDISTINGUISHABLE from the old built-in
  // (kind/exportable/edge/storage/version + a real worker spawn). Skips when the
  // app isn't composed (offline / no STREAMHUB_APPS_TOKEN); CI composes it first.
  const lprComposed = fs.existsSync(
    path.join(__dirname, '..', '..', 'plugins-vendor', 'lpr', 'streamhub.app.json'),
  );
  (lprComposed ? it : it.skip)(
    'composes the vendored lpr app identically to the old built-in',
    () => {
      const m = registry.getManifest('lpr');
      expect(m?.kind).toBe('app');
      expect(m?.exportable).toBe(true);
      expect(m?.edge).toBe(true);
      expect(m?.storage).toEqual({ db: 'lpr.db' });
      expect(m?.version).toBe('0.1.0');
      // The synthesized worker spawns the real python module (zero eval).
      const meta = registry.getMeta('lpr');
      const spec = meta!.worker!.spawn({
        app: 'parking',
        config: defaultConfig(meta!),
        appDir: '/data/apps/parking',
        dataDir: '/data',
        livekitUrl: 'wss://lk:7880',
      });
      expect(spec.args).toEqual(['-m', 'lpr_worker', '--app', 'parking']);
      expect(spec.env?.LPR_APP).toBe('parking');
      expect(spec.env?.LPR_DEVICE).toBe('cpu');
    },
  );

  // deface is the SECOND decoupled Studio App (F1) — removed from src/plugins,
  // it joins the catalog ONLY as a vendored release. Unlike lpr it keeps NO
  // SQLite state (obfuscation is client-side in the player overlay), so its
  // storage is null and it ships no migrations. This locks the vendored app as
  // INDISTINGUISHABLE from the old built-in. Skips when it isn't composed.
  const defaceComposed = fs.existsSync(
    path.join(__dirname, '..', '..', 'plugins-vendor', 'deface', 'streamhub.app.json'),
  );
  (defaceComposed ? it : it.skip)(
    'composes the vendored deface app identically to the old built-in',
    () => {
      const m = registry.getManifest('deface');
      expect(m?.kind).toBe('app');
      expect(m?.exportable).toBe(true);
      expect(m?.edge).toBe(true);
      expect(m?.storage).toBeNull(); // deface has no per-app DB
      expect(m?.version).toBe('0.1.0');
      // The synthesized worker spawns the real python module (zero eval); the
      // cuda toggle maps to the execution provider through the spawn template.
      const meta = registry.getMeta('deface');
      const spec = meta!.worker!.spawn({
        app: 'lobby',
        config: defaultConfig(meta!),
        appDir: '/data/apps/lobby',
        dataDir: '/data',
        livekitUrl: 'wss://lk:7880',
      });
      expect(spec.args).toEqual(['-m', 'deface_worker', '--app', 'lobby']);
      expect(spec.env?.DEFACE_APP).toBe('lobby');
      expect(spec.env?.DEFACE_EXECUTION_PROVIDER).toBe('cpu');
    },
  );

  // safety-ppe + people-counter are decoupled VENDORED apps (F1 batch). Unlike
  // deface they KEEP a per-app SQLite db (evidence / counts), so storage is a
  // real filename — the core owns the db, the app repo ships no migrations.
  // Each witness locks the vendored app as INDISTINGUISHABLE from the old
  // built-in; skips when it isn't composed.
  const safetyPpeComposed = fs.existsSync(
    path.join(__dirname, '..', '..', 'plugins-vendor', 'safety-ppe', 'streamhub.app.json'),
  );
  (safetyPpeComposed ? it : it.skip)(
    'composes the vendored safety-ppe app identically to the old built-in',
    () => {
      const m = registry.getManifest('safety-ppe');
      expect(m?.kind).toBe('app');
      expect(m?.exportable).toBe(true);
      expect(m?.edge).toBe(true);
      expect(m?.storage).toEqual({ db: 'safety-ppe.db' });
      expect(m?.version).toBe('0.1.0');
      const meta = registry.getMeta('safety-ppe');
      const spec = meta!.worker!.spawn({
        app: 'lobby',
        config: defaultConfig(meta!),
        appDir: '/data/apps/lobby',
        dataDir: '/data',
        livekitUrl: 'wss://lk:7880',
      });
      expect(spec.args).toEqual(['-m', 'safety_ppe_worker', '--app', 'lobby']);
      expect(spec.env?.SAFETY_PPE_APP).toBe('lobby');
    },
  );

  const peopleCounterComposed = fs.existsSync(
    path.join(__dirname, '..', '..', 'plugins-vendor', 'people-counter', 'streamhub.app.json'),
  );
  (peopleCounterComposed ? it : it.skip)(
    'composes the vendored people-counter app identically to the old built-in',
    () => {
      const m = registry.getManifest('people-counter');
      expect(m?.kind).toBe('app');
      expect(m?.exportable).toBe(true);
      expect(m?.edge).toBe(true);
      expect(m?.storage).toEqual({ db: 'people-counter.db' });
      expect(m?.version).toBe('0.1.0');
      const meta = registry.getMeta('people-counter');
      const spec = meta!.worker!.spawn({
        app: 'lobby',
        config: defaultConfig(meta!),
        appDir: '/data/apps/lobby',
        dataDir: '/data',
        livekitUrl: 'wss://lk:7880',
      });
      expect(spec.args).toEqual(['-m', 'people_counter_worker', '--app', 'lobby']);
      expect(spec.env?.PC_APP).toBe('lobby');
    },
  );

  // perimeter is a decoupled VENDORED app (Phase 2 batch). It keeps a per-app
  // SQLite (perimeter.db, alert queue) and is edge-capable + exportable.
  const perimeterComposed = fs.existsSync(
    path.join(__dirname, '..', '..', 'plugins-vendor', 'perimeter', 'streamhub.app.json'),
  );
  (perimeterComposed ? it : it.skip)(
    'composes the vendored perimeter app identically to the old built-in',
    () => {
      const m = registry.getManifest('perimeter');
      expect(m?.kind).toBe('app');
      expect(m?.exportable).toBe(true);
      expect(m?.edge).toBe(true);
      expect(m?.storage).toEqual({ db: 'perimeter.db' });
      expect(m?.version).toBe('0.1.0');
      const meta = registry.getMeta('perimeter');
      const spec = meta!.worker!.spawn({
        app: 'depot',
        config: defaultConfig(meta!),
        appDir: '/data/apps/depot',
        dataDir: '/data',
        livekitUrl: 'wss://lk:7880',
      });
      expect(spec.args).toEqual(['-m', 'perimeter_worker', '--app', 'depot']);
      expect(spec.env?.PERIMETER_APP).toBe('depot');
      expect(spec.env?.PERIMETER_DEVICE).toBe('cpu');
      expect(spec.env?.PERIMETER_MODEL).toBe('yolov8n');
      expect(spec.env?.PERIMETER_ARM_MODE).toBe('schedule');
    },
  );

  // yolo is a decoupled VENDORED app (Phase 2 batch) — the original GRID
  // reference. Exportable + edge-capable, keeps NO per-app SQLite (a detections
  // DB stayed a follow-up), stable 1.0.0.
  const yoloComposed = fs.existsSync(
    path.join(__dirname, '..', '..', 'plugins-vendor', 'yolo', 'streamhub.app.json'),
  );
  (yoloComposed ? it : it.skip)(
    'composes the vendored yolo app identically to the old built-in',
    () => {
      const m = registry.getManifest('yolo');
      expect(m?.kind).toBe('app');
      expect(m?.exportable).toBe(true);
      expect(m?.edge).toBe(true);
      expect(m?.storage).toBeNull();
      expect(m?.version).toBe('1.0.0');
      expect(m?.workerPlacement).toBe('grid');
      const meta = registry.getMeta('yolo');
      const spec = meta!.worker!.spawn({
        app: 'live',
        config: defaultConfig(meta!),
        appDir: '/data/apps/live',
        dataDir: '/data',
        livekitUrl: 'wss://lk:7880',
      });
      expect(spec.args).toEqual(['-m', 'yolo_worker', '--app', 'live']);
      expect(spec.env?.YOLO_APP).toBe('live');
      expect(spec.env?.YOLO_DEVICE).toBe('cpu');
      expect(spec.env?.YOLO_MODEL).toBe('yolov8n');
    },
  );

  // presence is a decoupled VENDORED app (Phase 2 batch). It keeps a per-app
  // SQLite (presence.db) and is edge-capable; its authored declarative manifest
  // predates the exodus (it was the original interpreter fidelity witness).
  const presenceComposed = fs.existsSync(
    path.join(__dirname, '..', '..', 'plugins-vendor', 'presence', 'streamhub.app.json'),
  );
  (presenceComposed ? it : it.skip)(
    'composes the vendored presence app identically to the old built-in',
    () => {
      const m = registry.getManifest('presence');
      expect(m?.kind).toBe('app');
      expect(m?.exportable).toBe(true);
      expect(m?.edge).toBe(true);
      expect(m?.storage).toEqual({ db: 'presence.db' });
      // 0.1.1: the 0.1.0 manifest missed `export` (pre-exodus authoring) — the
      // composed witness caught it and the app repo shipped the one-key fix.
      expect(m?.version).toBe('0.1.1');
      const meta = registry.getMeta('presence');
      const spec = meta!.worker!.spawn({
        app: 'office',
        config: defaultConfig(meta!),
        appDir: '/data/apps/office',
        dataDir: '/data',
        livekitUrl: 'wss://lk:7880',
      });
      expect(spec.args).toEqual(['-m', 'presence_worker', '--app', 'office']);
      expect(spec.env?.PRESENCE_APP).toBe('office');
      expect(spec.env?.PRESENCE_DEVICE).toBe('cpu');
      expect(spec.env?.PRESENCE_MODEL).toBe('yolov8n');
    },
  );

  // transcription is a decoupled VENDORED app (Phase 2). Unlike the others it is
  // NOT exportable (the worker exchanges FILE-based VOD jobs with the core, no
  // HTTP export plane) and NOT edge-capable (local-only), and keeps no per-app
  // SQLite (jobs/results are files). This locks the vendored app as
  // INDISTINGUISHABLE from the old built-in; skips when it isn't composed.
  const transcriptionComposed = fs.existsSync(
    path.join(__dirname, '..', '..', 'plugins-vendor', 'transcription', 'streamhub.app.json'),
  );
  (transcriptionComposed ? it : it.skip)(
    'composes the vendored transcription app identically to the old built-in',
    () => {
      const m = registry.getManifest('transcription');
      expect(m?.kind).toBe('app');
      expect(m?.exportable).toBe(false);
      expect(m?.edge).toBe(false);
      expect(m?.storage).toBeNull();
      expect(m?.version).toBe('1.0.0');
      const meta = registry.getMeta('transcription');
      const spec = meta!.worker!.spawn({
        app: 'lobby',
        config: defaultConfig(meta!),
        appDir: '/data/apps/lobby',
        dataDir: '/data',
        livekitUrl: 'wss://lk:7880',
      });
      expect(spec.args).toEqual(['-m', 'transcription_worker', '--app', 'lobby']);
      expect(spec.env?.TRANSCRIBE_APP).toBe('lobby');
      expect(spec.env?.TRANSCRIBE_DEVICE).toBe('auto');
    },
  );

  // The four VISION apps (occupancy/counting/crowd/demography) are decoupled
  // VENDORED apps from ONE shared repo (streamhub-app-vision) — 4 bundles per
  // release, each embedding the shared vision-edge runtime as its worker. The
  // UNIFIED spawn shape (one argv, env-driven mode) is locked per app.
  for (const visionId of ['occupancy', 'counting', 'crowd', 'demography'] as const) {
    const composed = fs.existsSync(
      path.join(__dirname, '..', '..', 'plugins-vendor', visionId, 'streamhub.app.json'),
    );
    (composed ? it : it.skip)(
      `composes the vendored ${visionId} app identically to the old built-in`,
      () => {
        const m = registry.getManifest(visionId);
        expect(m?.kind).toBe('app');
        expect(m?.exportable).toBe(true);
        expect(m?.edge).toBe(true);
        expect(m?.storage).toEqual({ db: `${visionId}.db` });
        // 0.1.1: the 0.1.0 manifests missed `export` (generation slip) — the
        // composed witnesses caught it and the app repo shipped the one-key fix.
        expect(m?.version).toBe('0.1.1');
        const meta = registry.getMeta(visionId);
        const spec = meta!.worker!.spawn({
          app: 'mall',
          config: defaultConfig(meta!),
          appDir: '/data/apps/mall',
          dataDir: '/data',
          livekitUrl: 'wss://lk:7880',
        });
        expect(spec.args).toEqual(['-m', 'vision_edge', '--model', visionId]);
        expect(spec.env?.VISION_APP).toBe('mall');
        expect(spec.env?.VISION_MODE).toBe('worker-manager');
        expect(spec.env?.VISION_DEVICE).toBe('cpu');
      },
    );
  }

});

describe('PluginRegistryService — fixture root', () => {
  let dir: string;

  const write = (folder: string, body: string): void => {
    const d = path.join(dir, folder);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'plugin.meta.js'), body);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-reg-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads valid plugins and skips malformed ones without throwing', () => {
    write(
      'good',
      `module.exports.default = { id:'good', name:'Good', description:'', category:'tool', ui:'panel', configSchema:[] };`,
    );
    // id !== folder → skipped
    write(
      'mismatch',
      `module.exports.default = { id:'other', name:'X', description:'', category:'tool', ui:'panel', configSchema:[] };`,
    );
    // bad category → skipped
    write(
      'badcat',
      `module.exports.default = { id:'badcat', name:'X', description:'', category:'nope', ui:'panel', configSchema:[] };`,
    );
    // needsWorker without worker.spawn → skipped
    write(
      'noworker',
      `module.exports.default = { id:'noworker', name:'X', description:'', category:'processor', ui:'player-overlay', needsWorker:true, configSchema:[] };`,
    );

    const registry = new PluginRegistryService(dir);
    expect(() => registry.discover()).not.toThrow();
    const ids = registry.listManifests().map((m) => m.id);
    expect(ids).toEqual(['good']);
  });

  it('validates version: accepts semver, skips malformed, allows absent', () => {
    // valid semver → discovered, version surfaced verbatim
    write(
      'okver',
      `module.exports.default = { id:'okver', name:'Ok', description:'', category:'tool', ui:'panel', version:'2.1.3', configSchema:[] };`,
    );
    // malformed version → skipped (like any other malformed field)
    write(
      'badver',
      `module.exports.default = { id:'badver', name:'Bad', description:'', category:'tool', ui:'panel', version:'v1.2', configSchema:[] };`,
    );
    // absent version → still discovered, resolves to '0.0.0' on the manifest
    write(
      'nover',
      `module.exports.default = { id:'nover', name:'No', description:'', category:'tool', ui:'panel', configSchema:[] };`,
    );

    const registry = new PluginRegistryService(dir);
    expect(() => registry.discover()).not.toThrow();

    const ids = registry.listManifests().map((m) => m.id).sort();
    expect(ids).toEqual(['nover', 'okver']); // badver skipped
    expect(registry.getManifest('okver')?.version).toBe('2.1.3');
    expect(registry.getManifest('nover')?.version).toBe('0.0.0');
  });

  it('rejects malformed Studio-App taxonomy fields (kind/export/storage)', () => {
    // bad kind → skipped
    write(
      'badkind',
      `module.exports.default = { id:'badkind', name:'X', description:'', category:'tool', ui:'panel', kind:'widget', configSchema:[] };`,
    );
    // export on a plugin (kind omitted → 'plugin') → skipped
    write(
      'exportonplugin',
      `module.exports.default = { id:'exportonplugin', name:'X', description:'', category:'tool', ui:'panel', export:{ workerDir:'x-worker' }, configSchema:[] };`,
    );
    // storage.db with a path separator → skipped
    write(
      'badstorage',
      `module.exports.default = { id:'badstorage', name:'X', description:'', category:'tool', ui:'panel', storage:{ db:'../etc/passwd' }, configSchema:[] };`,
    );
    // a well-formed app WITH export + storage → discovered
    write(
      'goodapp',
      `module.exports.default = { id:'goodapp', name:'Good App', description:'', category:'processor', ui:'app-tab', kind:'app', storage:{ db:'good.db' }, export:{ workerDir:'good-worker' }, configSchema:[] };`,
    );

    const registry = new PluginRegistryService(dir);
    expect(() => registry.discover()).not.toThrow();
    const ids = registry.listManifests().map((m) => m.id).sort();
    expect(ids).toEqual(['goodapp']);

    const app = registry.getManifest('goodapp');
    expect(app?.kind).toBe('app');
    expect(app?.storage).toEqual({ db: 'good.db' });
    expect(app?.exportable).toBe(true);
  });

  it('deduplicates by id (first wins, no crash)', () => {
    write(
      'dup',
      `module.exports.default = { id:'dup', name:'Dup', description:'', category:'tool', ui:'panel', configSchema:[] };`,
    );
    const registry = new PluginRegistryService(dir);
    registry.discover();
    expect(registry.has('dup')).toBe(true);
  });

  it('returns empty when the directory is missing', () => {
    const registry = new PluginRegistryService(path.join(dir, 'does-not-exist'));
    registry.discover();
    expect(registry.listManifests()).toEqual([]);
  });
});

describe('PluginRegistryService — vendored (declarative) app discovery', () => {
  let pluginsRoot: string;
  let vendorRoot: string;

  const validManifest = (id: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      manifestVersion: 1,
      id,
      name: `Vendored ${id}`,
      description: 'a decoupled package',
      category: 'processor',
      ui: 'app-tab',
      version: '1.2.0',
      kind: 'app',
      storage: { db: `${id}.db` },
      events: [`${id}.detected`],
      configSchema: [{ key: 'room', type: 'string', label: 'Room', default: '' }],
      worker: {
        needsWorker: true,
        entry: '{{pluginPython}} -m ' + id.replace(/-/g, '_') + '_worker --app {{app}}',
        cwd: '{{workerDir}}',
        placement: 'grid',
        grid: { capabilities: [id] },
        edge: true,
        env: { PYTHONPATH: '{{workerDir}}', APP: '{{app}}', DEVICE: '{{ config.cuda | ternary:cuda:cpu }}' },
      },
      ...extra,
    });

  const writeVendor = (folder: string, manifestJson: string): void => {
    const d = path.join(vendorRoot, folder);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'streamhub.app.json'), manifestJson);
  };
  const writeBuiltin = (folder: string, body: string): void => {
    const d = path.join(pluginsRoot, folder);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'plugin.meta.js'), body);
  };

  beforeEach(() => {
    pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-reg-b-'));
    vendorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-reg-v-'));
  });
  afterEach(() => {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
    fs.rmSync(vendorRoot, { recursive: true, force: true });
  });

  it('discovers a vendored package with NO executable JS (declarative only)', () => {
    writeVendor('radar', validManifest('radar'));
    const registry = new PluginRegistryService(pluginsRoot, vendorRoot);
    registry.discover();

    const manifest = registry.getManifest('radar');
    expect(manifest?.id).toBe('radar');
    expect(manifest?.kind).toBe('app');
    expect(manifest?.needsWorker).toBe(true);
    expect(manifest?.edge).toBe(true);
    expect(manifest?.storage).toEqual({ db: 'radar.db' });
    expect(manifest?.events).toEqual(['radar.detected']);

    // The synthesized worker spawns via the interpreter (workerDir under the
    // package dir), proving the template is wired without any eval.
    const meta = registry.getMeta('radar');
    const spec = meta!.worker!.spawn({
      app: 'live',
      config: { cuda: true },
      appDir: '/data/apps/live',
      dataDir: '/data',
      livekitUrl: 'wss://lk',
    });
    expect(spec.command).toBe('python3');
    expect(spec.args).toEqual(['-m', 'radar_worker', '--app', 'live']);
    expect(spec.cwd).toBe(path.join(vendorRoot, 'radar', 'worker'));
    expect(spec.env?.DEVICE).toBe('cuda');
  });

  it('skips a vendored package whose manifest is malformed (never crashes)', () => {
    writeVendor('goodv', validManifest('goodv'));
    writeVendor('badjson', '{ not json');
    writeVendor('badshape', JSON.stringify({ id: 'badshape', name: 'X' }));
    // id !== folder → rejected
    writeVendor('folder-mismatch', validManifest('otherid'));

    const registry = new PluginRegistryService(pluginsRoot, vendorRoot);
    expect(() => registry.discover()).not.toThrow();
    expect(registry.listManifests().map((m) => m.id)).toEqual(['goodv']);
  });

  it('an in-tree plugin WINS an id collision — the vendored copy is skipped', () => {
    writeBuiltin(
      'lpr',
      `module.exports.default = { id:'lpr', name:'In-tree LPR', description:'', category:'processor', ui:'app-tab', version:'0.1.0', configSchema:[] };`,
    );
    writeVendor('lpr', validManifest('lpr'));
    writeVendor('extra', validManifest('extra'));

    const registry = new PluginRegistryService(pluginsRoot, vendorRoot);
    registry.discover();

    // in-tree lpr kept (its name), vendored lpr shadowed, vendored extra added.
    expect(registry.getManifest('lpr')?.name).toBe('In-tree LPR');
    expect(registry.has('extra')).toBe(true);
    expect(registry.listManifests().map((m) => m.id).sort()).toEqual(['extra', 'lpr']);
  });

  it('a missing vendor dir is a silent no-op (clean checkout)', () => {
    writeBuiltin(
      'only',
      `module.exports.default = { id:'only', name:'Only', description:'', category:'tool', ui:'panel', configSchema:[] };`,
    );
    const registry = new PluginRegistryService(pluginsRoot, path.join(vendorRoot, 'nope'));
    registry.discover();
    expect(registry.listManifests().map((m) => m.id)).toEqual(['only']);
  });
});

describe('PluginRegistryService — STREAMHUB_PLUGINS_ENABLE=false (--no-plugins)', () => {
  const prev = process.env.STREAMHUB_PLUGINS_ENABLE;
  afterEach(() => {
    if (prev === undefined) delete process.env.STREAMHUB_PLUGINS_ENABLE;
    else process.env.STREAMHUB_PLUGINS_ENABLE = prev;
  });

  it('discovers nothing when the flag is explicitly falsy — empty catalog, no lookups', () => {
    for (const off of ['false', '0', 'off', 'no']) {
      process.env.STREAMHUB_PLUGINS_ENABLE = off;
      const registry = new PluginRegistryService(); // real src/plugins root
      registry.discover();
      expect(registry.listManifests()).toEqual([]);
      expect(registry.getMeta('watermark')).toBeUndefined();
      expect(registry.has('watermark')).toBe(false);
    }
  });

  it('stays enabled (default behaviour) when unset or truthy', () => {
    for (const on of [undefined, 'true', '1', 'on', 'anything']) {
      if (on === undefined) delete process.env.STREAMHUB_PLUGINS_ENABLE;
      else process.env.STREAMHUB_PLUGINS_ENABLE = on;
      const registry = new PluginRegistryService();
      registry.discover();
      expect(registry.listManifests().length).toBeGreaterThan(0);
    }
  });
});
