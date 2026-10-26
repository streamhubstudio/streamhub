/**
 * Unit specs for PluginVersionService — pin / rollback / history + the
 * delete-refusal-when-pinned scan, against a REAL app.db (pin column + history
 * table) and a REAL seeded appstore. The worker manager is stubbed (we assert it
 * is restarted, not that a process spawns).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { makeUnitContext, type UnitContext } from '../../../../test/helpers';
import { AppPluginsRepository } from '../app-plugins.repository';
import {
  composePluginBundle,
  packTarGz,
} from '../plugin-export.service';
import { PluginManifest, PluginMeta, toManifest } from '../plugin.contract';
import { PluginRegistryService } from '../plugin-registry.service';
import { PluginWorkerManager } from '../plugin-worker.manager';
import { AppstoreService } from './appstore.service';
import { PluginVersionHistoryRepository } from './plugin-version-history.repository';
import { PluginVersionService } from './plugin-version.service';

const APP = 'live';

const META: PluginMeta = {
  id: 'demo',
  name: 'Demo App',
  description: 'versionable demo',
  category: 'processor',
  ui: 'app-tab',
  version: '1.0.0',
  kind: 'app',
  needsWorker: true,
  export: { workerDir: 'demo-worker' },
  configSchema: [{ key: 'room', type: 'string', label: 'Room', default: '' }],
  worker: {
    spawn: (ctx) => ({
      command: 'python3',
      args: ['-m', 'demo_worker', '--app', ctx.app],
      cwd: '/whatever/demo-worker',
      env: { PYTHONPATH: '/whatever/demo-worker' },
    }),
  },
};

function fakeRegistry(): PluginRegistryService {
  return {
    listManifests: (): PluginManifest[] => [toManifest(META)],
    getMeta: (id: string): PluginMeta | undefined =>
      id === META.id ? META : undefined,
  } as unknown as PluginRegistryService;
}

describe('PluginVersionService', () => {
  let ctx: UnitContext;
  let svc: PluginVersionService;
  let appstore: AppstoreService;
  let repo: AppPluginsRepository;
  let workers: { isRunning: jest.Mock; stop: jest.Mock; start: jest.Mock };
  let callbacks: { dispatch: jest.Mock };
  let srcRoot: string;
  let prevSrcRoot: string | undefined;

  const seed = (version: string): void => {
    const gz = packTarGz(
      composePluginBundle(META, 'demo', path.join(srcRoot, 'demo-worker')),
    );
    appstore.saveUploaded('demo', version, gz);
  };

  beforeEach(() => {
    ctx = makeUnitContext();
    // Worker source so the appstore can pack/validate an upload.
    srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-src-'));
    const pkg = path.join(srcRoot, 'demo-worker', 'demo_worker');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, '__init__.py'), '# demo\n');
    prevSrcRoot = process.env.STREAMHUB_WORKER_SRC_ROOT;
    process.env.STREAMHUB_WORKER_SRC_ROOT = srcRoot;

    repo = new AppPluginsRepository(ctx.db);
    const history = new PluginVersionHistoryRepository(ctx.db);
    appstore = new AppstoreService(fakeRegistry(), ctx.config, ctx.mocks.logs);
    workers = { isRunning: jest.fn(() => false), stop: jest.fn(), start: jest.fn() };
    callbacks = { dispatch: jest.fn(async () => undefined) };
    ctx.mocks.apps.get.mockResolvedValue({ id: 1 } as never);
    ctx.mocks.apps.list.mockResolvedValue([{ name: APP }] as never);

    svc = new PluginVersionService(
      appstore,
      repo,
      history,
      workers as unknown as PluginWorkerManager,
      fakeRegistry(),
      ctx.mocks.apps,
      ctx.mocks.logs,
      callbacks as never,
    );

    repo.install(APP, 'demo', {}); // enabled by default
  });

  afterEach(() => {
    ctx.cleanup();
    fs.rmSync(srcRoot, { recursive: true, force: true });
    if (prevSrcRoot === undefined) delete process.env.STREAMHUB_WORKER_SRC_ROOT;
    else process.env.STREAMHUB_WORKER_SRC_ROOT = prevSrcRoot;
  });

  it('pins a version, records history + dispatches plugin.version_changed', async () => {
    seed('2.9.0');
    const view = await svc.pin(APP, 'demo', '2.9.0');
    expect(view.active).toBe('2.9.0');
    expect(repo.get(APP, 'demo')?.workerVersion).toBe('2.9.0');
    expect(view.history[0]).toMatchObject({ from: null, to: '2.9.0' });
    expect(callbacks.dispatch).toHaveBeenCalledWith(
      APP,
      'plugin.version_changed',
      expect.objectContaining({ plugin: 'demo', from: null, to: '2.9.0', action: 'pin' }),
    );
  });

  it('404s pinning a version that is not in the store', async () => {
    await expect(svc.pin(APP, 'demo', '9.9.9')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('is a no-op when pinning the already-active version', async () => {
    seed('2.9.0');
    await svc.pin(APP, 'demo', '2.9.0');
    callbacks.dispatch.mockClear();
    const view = await svc.pin(APP, 'demo', '2.9.0');
    expect(view.history).toHaveLength(1); // no second history row
    expect(callbacks.dispatch).not.toHaveBeenCalled();
  });

  it('rolls back to the version run before the last change', async () => {
    seed('2.9.0');
    await svc.pin(APP, 'demo', '2.9.0'); // null → 2.9.0
    const rolled = await svc.rollback(APP, 'demo'); // → back to null (builtin)
    expect(rolled.active).toBeNull();
    expect(repo.get(APP, 'demo')?.workerVersion).toBeNull();
    // history now: [ (2.9.0 → null), (null → 2.9.0) ]
    expect(rolled.history[0]).toMatchObject({ from: '2.9.0', to: null });
  });

  it('400s rollback when there is no history', async () => {
    await expect(svc.rollback(APP, 'demo')).rejects.toThrow(
      /nothing to roll back/,
    );
  });

  it('restarts a RUNNING worker on pin so the new version takes effect', async () => {
    seed('2.9.0');
    workers.isRunning.mockReturnValue(true);
    await svc.pin(APP, 'demo', '2.9.0');
    expect(workers.stop).toHaveBeenCalledWith(APP, 'demo');
    expect(workers.start).toHaveBeenCalled();
  });

  it('does NOT restart a stopped worker (pin applies on next start)', async () => {
    seed('2.9.0');
    workers.isRunning.mockReturnValue(false);
    await svc.pin(APP, 'demo', '2.9.0');
    expect(workers.stop).not.toHaveBeenCalled();
    expect(workers.start).not.toHaveBeenCalled();
  });

  describe('delete refusal when pinned', () => {
    it('refuses to delete a version an install pins (409)', async () => {
      seed('2.9.0');
      await svc.pin(APP, 'demo', '2.9.0');
      await expect(svc.deleteVersion('demo', '2.9.0')).rejects.toThrow(
        ConflictException,
      );
      expect(appstore.hasVersion('demo', '2.9.0')).toBe(true);
    });

    it('deletes an unpinned version', async () => {
      seed('2.9.0');
      seed('2.8.0');
      await svc.pin(APP, 'demo', '2.9.0'); // pins 2.9.0 only
      await svc.deleteVersion('demo', '2.8.0'); // 2.8.0 is free
      expect(appstore.hasVersion('demo', '2.8.0')).toBe(false);
    });
  });
});
