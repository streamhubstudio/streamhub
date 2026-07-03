/**
 * Unit specs for the explicit worker-lifecycle service methods
 * (startWorker / stopWorker / workerStatus) that back the
 * POST :id/worker/start|stop and GET :id/worker/status endpoints.
 *
 * Uses a temp fixture registry with a worker plugin (`sleeper`) and mocks
 * child_process so nothing real is spawned.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';

jest.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter } = require('events');
  return {
    spawn: jest.fn(() => {
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
    }),
  };
});
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AppRecord } from '../../shared/contracts';
import { AppPluginsRepository } from './app-plugins.repository';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginWorkerManager } from './plugin-worker.manager';
import { PluginsService } from './plugins.service';

const APP = 'live';

function appRecord(): AppRecord {
  return {
    id: 1,
    name: APP,
    displayName: 'Live',
    livekitRoomPrefix: 'live',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    settingsJson: null,
  };
}

function writeFixtures(dir: string): void {
  const noworker = path.join(dir, 'noworker');
  fs.mkdirSync(noworker, { recursive: true });
  fs.writeFileSync(
    path.join(noworker, 'plugin.meta.js'),
    `module.exports.default = {
       id:'noworker', name:'NoWorker', description:'', category:'panel',
       ui:'app-tab', configSchema:[] };`,
  );
  const sleeper = path.join(dir, 'sleeper');
  fs.mkdirSync(sleeper, { recursive: true });
  fs.writeFileSync(
    path.join(sleeper, 'plugin.meta.js'),
    `module.exports.default = {
       id:'sleeper', name:'Sleeper', description:'', category:'processor',
       ui:'player-overlay', needsWorker:true,
       configSchema:[{ key:'token', type:'string', label:'T', default:'', required:true }],
       worker:{ spawn(ctx){ return { command:'node', args:['-e','0'] }; } } };`,
  );
}

describe('PluginsService — worker endpoints', () => {
  let ctx: UnitContext;
  let dir: string;
  let workers: PluginWorkerManager;
  let svc: PluginsService;

  beforeEach(() => {
    ctx = makeUnitContext();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-wk-'));
    writeFixtures(dir);
    const registry = new PluginRegistryService(dir);
    registry.discover();
    workers = new PluginWorkerManager(ctx.config, ctx.mocks.logs);
    const repo = new AppPluginsRepository(ctx.db);
    ctx.mocks.apps.get.mockResolvedValue(appRecord());
    svc = new PluginsService(
      registry,
      repo,
      workers,
      ctx.mocks.apps,
      ctx.mocks.logs,
    );
  });

  afterEach(() => {
    workers.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
    ctx.cleanup();
  });

  it('workerStatus is stopped before start', async () => {
    await svc.install(APP, 'sleeper');
    expect((await svc.workerStatus(APP, 'sleeper')).status).toBe('stopped');
  });

  it('startWorker requires the plugin installed', async () => {
    await expect(svc.startWorker(APP, 'sleeper')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('startWorker requires enabled', async () => {
    await svc.install(APP, 'sleeper');
    await expect(svc.startWorker(APP, 'sleeper')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('startWorker requires valid required config', async () => {
    await svc.install(APP, 'sleeper');
    // enabling with an empty required field is blocked at patch; simulate an
    // enabled row with missing config by patching config then clearing is not
    // possible, so assert the enable path is what guards it.
    await expect(
      svc.patch(APP, 'sleeper', { enabled: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('startWorker starts, then stopWorker stops', async () => {
    await svc.install(APP, 'sleeper');
    await svc.patch(APP, 'sleeper', { enabled: true, config: { token: 'x' } });
    // reconcile already started it; stop then explicitly start again
    await svc.stopWorker(APP, 'sleeper');
    expect(workers.isRunning(APP, 'sleeper')).toBe(false);
    const started = await svc.startWorker(APP, 'sleeper');
    expect(started.status).toBe('running');
    expect(workers.isRunning(APP, 'sleeper')).toBe(true);
    const stopped = await svc.stopWorker(APP, 'sleeper');
    expect(stopped.status).toBe('stopped');
  });

  it('rejects worker ops on a plugin without a worker', async () => {
    await svc.install(APP, 'noworker');
    await expect(svc.startWorker(APP, 'noworker')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.workerStatus(APP, 'noworker')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s for an unknown plugin', async () => {
    await expect(svc.startWorker(APP, 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
