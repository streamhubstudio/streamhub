/**
 * Unit — GRID worker placement contract (NEXTGEN-ADDONS).
 *
 * Locks down the backward-compatible placement extension end to end:
 *  - contract: toManifest defaults workerPlacement to 'local' (existing
 *    plugins untouched), passes 'grid' through; pluginDataTopic convention;
 *  - registry: placement/grid requirement fields are validated, malformed
 *    manifests are skipped without crashing;
 *  - shipped plugins: the grid-placed set (yolo — the original GRID reference —
 *    plus the other HLS-in/HTTP-out worker apps) is fully DECOUPLED now and
 *    validates when composed; every in-tree built-in stays 'local'.
 *    src/plugins/_templates/ is NEVER discovered, yet
 *    each of the 4 next-gen templates (vision/grid/babel/semantic-search) is a
 *    VALID manifest — promoting one by moving the folder up a level would
 *    register it as-is;
 *  - worker manager: a 'grid'-placed worker with no eligible node — or whose
 *    remote dispatch (GRID-1) fails — FALLS BACK to a local spawn, on record.
 */
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '../../shared/config/config.service';
import { mockLogsService } from '../../../test/helpers';
import type { GridNodeView, PluginGridService } from './plugin-grid.service';
import {
  PluginMeta,
  pluginDataTopic,
  toManifest,
} from './plugin.contract';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginWorkerManager } from './plugin-worker.manager';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeChild(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp: any = new EventEmitter();
  cp.pid = 4242;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = jest.fn(() => {
    cp.emit('exit', 0, 'SIGTERM');
    return true;
  });
  return cp;
}

const baseMeta = (over: Partial<PluginMeta>): PluginMeta => ({
  id: 'x',
  name: 'X',
  description: '',
  category: 'processor',
  ui: 'player-overlay',
  configSchema: [],
  ...over,
});

describe('plugin.contract — placement defaults', () => {
  it('toManifest defaults workerPlacement to local (worker-less plugin)', () => {
    expect(toManifest(baseMeta({ category: 'panel', ui: 'panel' }))).toMatchObject(
      { workerPlacement: 'local', needsWorker: false },
    );
  });

  it('toManifest defaults workerPlacement to local for a placement-less worker', () => {
    const m = baseMeta({
      needsWorker: true,
      worker: { spawn: () => ({ command: 'x' }) },
    });
    expect(toManifest(m).workerPlacement).toBe('local');
  });

  it('toManifest passes an explicit grid placement through', () => {
    const m = baseMeta({
      needsWorker: true,
      worker: {
        spawn: () => ({ command: 'x' }),
        placement: 'grid',
        grid: { gpu: true },
      },
    });
    expect(toManifest(m).workerPlacement).toBe('grid');
  });

  it('pluginDataTopic follows the plugin:<id> feed-back convention', () => {
    expect(pluginDataTopic('babel')).toBe('plugin:babel');
  });
});

describe('PluginRegistryService — placement validation (fixture root)', () => {
  let dir: string;

  const write = (folder: string, workerLiteral: string): void => {
    const d = path.join(dir, folder);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'plugin.meta.js'),
      `module.exports.default = { id:'${folder}', name:'X', description:'',` +
        ` category:'processor', ui:'player-overlay', needsWorker:true,` +
        ` configSchema:[], worker:${workerLiteral} };`,
    );
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-place-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const discovered = (): string[] => {
    const registry = new PluginRegistryService(dir);
    registry.discover();
    return registry.listManifests().map((m) => m.id);
  };

  it('accepts placement grid + requirements and serializes it', () => {
    write(
      'ok',
      `{ spawn:()=>({command:'x'}), placement:'grid',` +
        ` grid:{ gpu:true, minVramGb:8, capabilities:['cuda'], regions:['eu'] } }`,
    );
    const registry = new PluginRegistryService(dir);
    registry.discover();
    expect(registry.getManifest('ok')?.workerPlacement).toBe('grid');
  });

  it('skips an unknown placement value', () => {
    write('badplace', `{ spawn:()=>({command:'x'}), placement:'cloud' }`);
    expect(discovered()).toEqual([]);
  });

  it('skips grid requirements declared without placement grid', () => {
    write('orphangrid', `{ spawn:()=>({command:'x'}), grid:{ gpu:true } }`);
    expect(discovered()).toEqual([]);
  });

  it('skips malformed grid requirement shapes', () => {
    write(
      'badcaps',
      `{ spawn:()=>({command:'x'}), placement:'grid', grid:{ capabilities:'cuda' } }`,
    );
    write(
      'badvram',
      `{ spawn:()=>({command:'x'}), placement:'grid', grid:{ minVramGb:-1 } }`,
    );
    write(
      'badgpu',
      `{ spawn:()=>({command:'x'}), placement:'grid', grid:{ gpu:'yes' } }`,
    );
    expect(discovered()).toEqual([]);
  });
});

describe('PluginRegistryService — shipped plugins & _templates', () => {
  // Asserts the REAL shipped catalog's placement — the synthetic test fixtures
  // (refapp is grid-placed) must never leak in from a sibling suite sharing a
  // jest worker, or the "everything else stays local" loop would trip.
  const prevFixtureRoot = process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
  beforeEach(() => {
    delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
  });
  afterAll(() => {
    if (prevFixtureRoot === undefined) delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
    else process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = prevFixtureRoot;
  });

  it('only the declared GRID plugins request grid; everything else stays local', () => {
    // The DELIBERATE grid set — a new plugin declaring 'grid' must be added
    // here consciously. safety-ppe gates dispatch on the opt-in 'ppe' capability.
    // lpr, people-counter and safety-ppe are decoupled VENDORED apps, so their
    // presence is composition-dependent (asserted in
    // plugin-registry.service.spec.ts); they stay in the set so the loop below
    // still validates their 'grid' placement WHEN composed.
    // Every member of the grid set is a DECOUPLED vendored app now (yolo — the
    // original grid reference — decoupled last); each is present only when
    // composed, and this loop validates its 'grid' placement then. Hermetic
    // runs still lock that every in-tree built-in stays 'local'.
    const GRID_PLUGINS = new Set(['yolo', 'lpr', 'people-counter', 'safety-ppe', 'perimeter', 'presence']);
    const registry = new PluginRegistryService();
    registry.discover();
    const manifests = registry.listManifests();
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) {
      expect(m.workerPlacement).toBe(GRID_PLUGINS.has(m.id) ? 'grid' : 'local');
    }
  });

  it('never discovers the _templates folder', () => {
    const registry = new PluginRegistryService();
    registry.discover();
    // `vision` was split into four first-class Studio Apps (Edge-as-capability),
    // so the old monolithic `vision` id is RETIRED from the shipped catalog (its
    // skeleton stays template-only, like grid/babel/semantic-search).
    for (const id of ['grid', 'babel', 'semantic-search', 'vision']) {
      expect(registry.has(id)).toBe(false);
    }
    // The four vision apps are DECOUPLED vendored apps now — present only when
    // composed (their witnesses live in plugin-registry.service.spec.ts).
  });

  it('the 4 next-gen templates are valid manifests when promoted', () => {
    // Point the registry AT the templates dir: each folder then looks like a
    // regular plugin folder — exactly what "move it up one level" produces.
    const registry = new PluginRegistryService(
      path.resolve(__dirname, '..', '..', 'plugins', '_templates'),
    );
    registry.discover();
    const ids = registry.listManifests().map((m) => m.id).sort();
    expect(ids).toEqual(['babel', 'grid', 'semantic-search', 'vision']);

    // The three processors request GRID placement; the console panel doesn't.
    for (const id of ['vision', 'babel', 'semantic-search']) {
      const m = registry.getManifest(id);
      expect(m?.needsWorker).toBe(true);
      expect(m?.workerPlacement).toBe('grid');
      expect(typeof registry.getMeta(id)?.worker?.spawn).toBe('function');
    }
    expect(registry.getManifest('grid')).toMatchObject({
      needsWorker: false,
      workerPlacement: 'local',
    });

    // Contract invariant: every config field carries a default.
    for (const m of registry.listManifests()) {
      for (const f of m.configSchema) {
        expect(f.default).not.toBeUndefined();
      }
    }
  });
});

describe('PluginWorkerManager — grid placement falls back to local spawn', () => {
  const APP = 'live';
  const gridMeta: PluginMeta = baseMeta({
    id: 'wk',
    needsWorker: true,
    worker: {
      spawn: (ctx) => ({ command: 'the-cmd', args: ['--app', ctx.app] }),
      placement: 'grid',
      grid: { gpu: true },
    },
  });

  let logs: ReturnType<typeof mockLogsService>;
  let child: ReturnType<typeof fakeChild>;

  beforeEach(() => {
    logs = mockLogsService();
    child = fakeChild();
    (spawn as jest.Mock).mockReturnValue(child);
  });

  const systemLines = (mgr: PluginWorkerManager): string[] =>
    mgr
      .logs(APP, 'wk')
      .filter((l) => l.stream === 'system')
      .map((l) => l.line);

  it('without a grid service: spawns locally and records the fall-back', () => {
    const mgr = new PluginWorkerManager(new ConfigService(), logs);
    const state = mgr.start(gridMeta, APP, '/apps/live', {}, null);
    expect(state.status).toBe('running');
    expect(state.placement).toBe('local'); // effective placement
    expect(spawn).toHaveBeenCalledWith(
      'the-cmd',
      ['--app', APP],
      expect.objectContaining({ cwd: '/apps/live' }),
    );
    expect(
      systemLines(mgr).some((l) =>
        l.includes('no eligible grid node registered'),
      ),
    ).toBe(true);
    mgr.onModuleDestroy();
  });

  it('with a node picked: dispatches remotely, then falls back to local on failure', async () => {
    const pick: GridNodeView = {
      id: 'gpu1',
      name: 'gpu-1',
      url: 'https://gpu1.example.com',
      region: 'eu',
      gpu: true,
      vramGb: 24,
      capabilities: ['cuda'],
    };
    const grid = {
      selectNode: jest.fn(() => pick),
      dispatch: jest.fn().mockResolvedValue({
        dispatched: false,
        node: pick,
        reason: 'agent returned HTTP 500',
      }),
      stopRemote: jest.fn().mockResolvedValue(true),
    } as unknown as PluginGridService;

    const mgr = new PluginWorkerManager(
      new ConfigService(),
      logs,
      undefined,
      grid,
    );
    const state = mgr.start(gridMeta, APP, '/apps/live', {}, null);
    expect(state.status).toBe('starting'); // async dispatch in flight
    await new Promise((r) => setImmediate(r));

    expect(grid.selectNode).toHaveBeenCalledWith({ gpu: true });
    expect(grid.dispatch).toHaveBeenCalledTimes(1);
    const s = mgr.status(APP, 'wk');
    expect(s.status).toBe('running');
    expect(s.placement).toBe('local'); // fell back
    expect(spawn).toHaveBeenCalled();
    expect(
      systemLines(mgr).some((l) => l.includes('falling back to local spawn')),
    ).toBe(true);
    mgr.onModuleDestroy();
  });

  it('with a node picked and dispatch OK: runs on the node, no local spawn', async () => {
    const pick: GridNodeView = {
      id: 'gpu1',
      name: 'gpu-1',
      url: 'https://gpu1.example.com',
      region: 'eu',
      gpu: true,
      vramGb: 24,
      capabilities: ['cuda'],
    };
    const grid = {
      selectNode: jest.fn(() => pick),
      dispatch: jest.fn().mockResolvedValue({
        dispatched: true,
        node: pick,
        remoteId: 'remote-7',
      }),
      stopRemote: jest.fn().mockResolvedValue(true),
    } as unknown as PluginGridService;

    const mgr = new PluginWorkerManager(
      new ConfigService(),
      logs,
      undefined,
      grid,
    );
    mgr.start(gridMeta, APP, '/apps/live', {}, null);
    await new Promise((r) => setImmediate(r));

    const s = mgr.status(APP, 'wk');
    expect(s.status).toBe('running');
    expect(s.placement).toBe('grid');
    expect(s.remoteId).toBe('remote-7');
    expect(spawn).not.toHaveBeenCalled();
    mgr.onModuleDestroy();
  });

  it('a local worker never touches the grid seam', () => {
    const grid = {
      selectNode: jest.fn(),
      dispatch: jest.fn(),
    } as unknown as PluginGridService;
    const localMeta = baseMeta({
      id: 'wk',
      needsWorker: true,
      worker: { spawn: () => ({ command: 'the-cmd' }) },
    });
    const mgr = new PluginWorkerManager(
      new ConfigService(),
      logs,
      undefined,
      grid,
    );
    const state = mgr.start(localMeta, APP, '/apps/live', {}, null);
    expect(state.status).toBe('running');
    expect(state.placement).toBe('local');
    expect(grid.selectNode).not.toHaveBeenCalled();
    expect(grid.dispatch).not.toHaveBeenCalled();
    mgr.onModuleDestroy();
  });
});
