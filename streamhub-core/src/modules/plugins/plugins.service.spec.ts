/**
 * Unit specs for PluginsService — marketplace listing, install/patch/remove,
 * config validation and the worker reconcile path. Uses a temp FIXTURE plugin
 * registry (a no-worker `demo` + a worker `sleeper` that runs a harmless node
 * process) so nothing external is required.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';

// Mock child_process so the worker manager never spawns a real process — the
// fake child is a synchronous EventEmitter (deterministic, no orphaned procs).
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
  const demo = path.join(dir, 'demo');
  fs.mkdirSync(demo, { recursive: true });
  fs.writeFileSync(
    path.join(demo, 'plugin.meta.js'),
    `module.exports.default = {
       id:'demo', name:'Demo', description:'', category:'panel', ui:'app-tab',
       configSchema:[
         { key:'token', type:'secret', label:'Token', default:'', required:true },
         { key:'count', type:'number', label:'Count', default:5, min:0, max:10 }
       ]
     };`,
  );
  const sleeper = path.join(dir, 'sleeper');
  fs.mkdirSync(sleeper, { recursive: true });
  fs.writeFileSync(
    path.join(sleeper, 'plugin.meta.js'),
    `module.exports.default = {
       id:'sleeper', name:'Sleeper', description:'', category:'processor',
       ui:'player-overlay', needsWorker:true,
       configSchema:[{ key:'interval', type:'number', label:'I', default:1000 }],
       worker:{ spawn(ctx){ return { command: process.execPath,
         args:['-e','setInterval(()=>{},1000)'] }; } }
     };`,
  );
}

describe('PluginsService', () => {
  let ctx: UnitContext;
  let dir: string;
  let registry: PluginRegistryService;
  let workers: PluginWorkerManager;
  let svc: PluginsService;

  beforeEach(() => {
    ctx = makeUnitContext();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-svc-'));
    writeFixtures(dir);
    registry = new PluginRegistryService(dir);
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

  it('lists the catalog with all-not-installed initially', async () => {
    const list = await svc.list(APP);
    expect(list.map((v) => v.manifest.id).sort()).toEqual(['demo', 'sleeper']);
    expect(list.every((v) => v.installed === false)).toBe(true);
    // config shows defaults even before install
    const demo = list.find((v) => v.manifest.id === 'demo');
    expect(demo?.config).toEqual({ token: '', count: 5 });
  });

  it('404s for an unknown app', async () => {
    ctx.mocks.apps.get.mockResolvedValue(null);
    await expect(svc.list(APP)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s for an unknown plugin', async () => {
    await expect(svc.get(APP, 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('installs disabled with defaults (idempotent)', async () => {
    const v = await svc.install(APP, 'demo');
    expect(v.installed).toBe(true);
    expect(v.enabled).toBe(false);
    expect(v.config).toEqual({ token: '', count: 5 });
    // installing again keeps original config (edit while disabled is free)
    await svc.patch(APP, 'demo', { config: { count: 8 } });
    const again = await svc.install(APP, 'demo');
    expect(again.config.count).toBe(8);
  });

  it('validates config on patch and redacts secrets', async () => {
    await svc.install(APP, 'demo');
    const v = await svc.patch(APP, 'demo', {
      enabled: true,
      config: { token: 'abc', count: 2 },
    });
    expect(v.config.token).toBe('********');
    expect(v.config.count).toBe(2);
    expect(v.enabled).toBe(true);
  });

  it('rejects unknown config keys', async () => {
    await svc.install(APP, 'demo');
    await expect(
      svc.patch(APP, 'demo', { config: { nope: 1 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects out-of-bounds numbers', async () => {
    await svc.install(APP, 'demo');
    await expect(
      svc.patch(APP, 'demo', { config: { count: 99 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks enabling when a required field is empty', async () => {
    await svc.install(APP, 'demo'); // installed disabled, token empty
    await expect(
      svc.patch(APP, 'demo', { enabled: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // providing the token unblocks it
    const ok = await svc.patch(APP, 'demo', {
      enabled: true,
      config: { token: 'x' },
    });
    expect(ok.enabled).toBe(true);
  });

  it('patching a non-installed plugin is a 400', async () => {
    await expect(
      svc.patch(APP, 'demo', { enabled: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes an install', async () => {
    await svc.install(APP, 'demo');
    await svc.remove(APP, 'demo');
    expect((await svc.get(APP, 'demo')).installed).toBe(false);
  });

  describe('worker lifecycle', () => {
    it('does not start on install (installed disabled)', async () => {
      const v = await svc.install(APP, 'sleeper');
      expect(v.enabled).toBe(false);
      expect(v.worker?.status).toBe('stopped');
      expect(workers.isRunning(APP, 'sleeper')).toBe(false);
    });

    it('starts on enable and reports running', async () => {
      await svc.install(APP, 'sleeper');
      const v = await svc.patch(APP, 'sleeper', { enabled: true });
      expect(v.worker?.status).toBe('running');
      expect(workers.isRunning(APP, 'sleeper')).toBe(true);
    });

    it('stops the worker when disabled and on remove', async () => {
      await svc.install(APP, 'sleeper');
      await svc.patch(APP, 'sleeper', { enabled: true });
      expect(workers.isRunning(APP, 'sleeper')).toBe(true);
      await svc.patch(APP, 'sleeper', { enabled: false });
      expect(workers.isRunning(APP, 'sleeper')).toBe(false);
      await svc.patch(APP, 'sleeper', { enabled: true });
      expect(workers.isRunning(APP, 'sleeper')).toBe(true);
      await svc.remove(APP, 'sleeper');
      expect(workers.isRunning(APP, 'sleeper')).toBe(false);
    });

    it('surfaces worker + persisted logs', async () => {
      await svc.install(APP, 'sleeper');
      await svc.patch(APP, 'sleeper', { enabled: true });
      const logs = await svc.getLogs(APP, 'sleeper');
      expect(logs.pluginId).toBe('sleeper');
      expect(logs.worker?.status).toBe('running');
      expect(logs.workerLogs.some((l) => l.stream === 'system')).toBe(true);
    });
  });
});
