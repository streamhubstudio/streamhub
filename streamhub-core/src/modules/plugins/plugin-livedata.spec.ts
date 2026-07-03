/**
 * Unit specs for the plugin LIVE-DATA channel (worker → core → player overlay):
 *
 *   - PluginLiveDataService: latest-only store, size cap, key-space eviction.
 *   - PluginWorkerManager: per-start ingest token minted + STREAMHUB_INGEST_*
 *     env injected into every spawned worker; token dies with the worker.
 *   - PluginsService.ingestLive / liveOverlayData: token auth, room required,
 *     enabled player-overlay gating for the public read.
 *
 * child_process is mocked — nothing real is spawned.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

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
import { spawn } from 'child_process';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AppRecord } from '../../shared/contracts';
import { AppPluginsRepository } from './app-plugins.repository';
import {
  MAX_LIVE_KEYS,
  MAX_LIVE_PAYLOAD_BYTES,
  PluginLiveDataService,
} from './plugin-livedata.service';
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

/** Fixture registry: one worker overlay plugin (facer), one plain panel. */
function writeFixtures(dir: string): void {
  const facer = path.join(dir, 'facer');
  fs.mkdirSync(facer, { recursive: true });
  fs.writeFileSync(
    path.join(facer, 'plugin.meta.js'),
    `module.exports.default = {
       id:'facer', name:'Facer', description:'', category:'processor',
       ui:'player-overlay', needsWorker:true, configSchema:[],
       worker:{ spawn(ctx){ return { command:'node', args:['-e','0'] }; } } };`,
  );
  const panel = path.join(dir, 'panel');
  fs.mkdirSync(panel, { recursive: true });
  fs.writeFileSync(
    path.join(panel, 'plugin.meta.js'),
    `module.exports.default = {
       id:'panel', name:'Panel', description:'', category:'panel',
       ui:'app-tab', configSchema:[] };`,
  );
}

describe('PluginLiveDataService (store)', () => {
  it('keeps the LATEST payload per (app, plugin, room) with freshness', () => {
    const store = new PluginLiveDataService();
    let t = 1_000;
    store.now = () => t;

    expect(store.latest(APP, 'facer', 'main')).toBeNull();
    expect(store.push(APP, 'facer', 'main', { room: 'main', n: 1 })).toBe(true);
    t = 1_250;
    expect(store.push(APP, 'facer', 'main', { room: 'main', n: 2 })).toBe(true);
    t = 1_400;

    const view = store.latest(APP, 'facer', 'main');
    expect(view).toEqual({
      ts: 1_250,
      ageMs: 150,
      payload: { room: 'main', n: 2 },
    });
    // Different room = different feed.
    expect(store.latest(APP, 'facer', 'other')).toBeNull();
  });

  it('rejects payloads over the size cap', () => {
    const store = new PluginLiveDataService();
    const fat = { room: 'main', blob: 'x'.repeat(MAX_LIVE_PAYLOAD_BYTES) };
    expect(store.push(APP, 'facer', 'main', fat)).toBe(false);
    expect(store.latest(APP, 'facer', 'main')).toBeNull();
  });

  it('evicts the OLDEST key once the key space is full', () => {
    const store = new PluginLiveDataService();
    let t = 0;
    store.now = () => ++t;
    for (let i = 0; i < MAX_LIVE_KEYS; i++) {
      store.push(APP, 'facer', `room-${i}`, { i });
    }
    store.push(APP, 'facer', 'one-more', { i: -1 });
    expect(store.latest(APP, 'facer', 'room-0')).toBeNull(); // oldest gone
    expect(store.latest(APP, 'facer', 'room-1')).not.toBeNull();
    expect(store.latest(APP, 'facer', 'one-more')).not.toBeNull();
  });

  it('clear() drops every room feed of one plugin only', () => {
    const store = new PluginLiveDataService();
    store.push(APP, 'facer', 'a', { room: 'a' });
    store.push(APP, 'facer', 'b', { room: 'b' });
    store.push(APP, 'other', 'a', { room: 'a' });
    store.clear(APP, 'facer');
    expect(store.latest(APP, 'facer', 'a')).toBeNull();
    expect(store.latest(APP, 'facer', 'b')).toBeNull();
    expect(store.latest(APP, 'other', 'a')).not.toBeNull();
  });
});

describe('live-data channel (manager + service)', () => {
  let ctx: UnitContext;
  let dir: string;
  let workers: PluginWorkerManager;
  let livedata: PluginLiveDataService;
  let svc: PluginsService;

  beforeEach(async () => {
    (spawn as jest.Mock).mockClear();
    ctx = makeUnitContext();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deface-live-'));
    writeFixtures(dir);
    const registry = new PluginRegistryService(dir);
    registry.discover();
    workers = new PluginWorkerManager(ctx.config, ctx.mocks.logs);
    livedata = new PluginLiveDataService();
    const repo = new AppPluginsRepository(ctx.db);
    ctx.mocks.apps.get.mockResolvedValue(appRecord());
    svc = new PluginsService(
      registry,
      repo,
      workers,
      ctx.mocks.apps,
      ctx.mocks.logs,
      livedata,
    );
    await svc.install(APP, 'facer');
    await svc.patch(APP, 'facer', { enabled: true }); // reconcile spawns worker
  });

  afterEach(() => {
    workers.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
    ctx.cleanup();
  });

  it('injects STREAMHUB_INGEST_URL/_TOKEN env into the spawned worker', () => {
    const call = (spawn as jest.Mock).mock.calls.at(-1);
    const env = call?.[2]?.env as Record<string, string>;
    expect(env.STREAMHUB_APP).toBe(APP);
    expect(env.STREAMHUB_PLUGIN_ID).toBe('facer');
    expect(env.STREAMHUB_INGEST_URL).toBe(
      `http://127.0.0.1:${ctx.config.port}/api/v1/apps/${APP}/plugins/facer/live`,
    );
    expect(env.STREAMHUB_INGEST_TOKEN).toBe(workers.ingestToken(APP, 'facer'));
    expect(env.STREAMHUB_INGEST_TOKEN).toBeTruthy();
  });

  it('token is per-start and dies with the worker', async () => {
    const first = workers.ingestToken(APP, 'facer');
    expect(first).toBeTruthy();
    await svc.stopWorker(APP, 'facer');
    expect(workers.ingestToken(APP, 'facer')).toBeUndefined();
    await svc.startWorker(APP, 'facer');
    const second = workers.ingestToken(APP, 'facer');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('ingestLive requires the CURRENT ingest token', async () => {
    await expect(
      svc.ingestLive(APP, 'facer', undefined, { room: 'main' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      svc.ingestLive(APP, 'facer', 'wrong-token', { room: 'main' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const token = workers.ingestToken(APP, 'facer')!;
    await expect(
      svc.ingestLive(APP, 'facer', token, { room: 'main', faces: [] }),
    ).resolves.toEqual({ ok: true });
  });

  it('ingestLive validates the payload (object with a room)', async () => {
    const token = workers.ingestToken(APP, 'facer')!;
    await expect(
      svc.ingestLive(APP, 'facer', token, { faces: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.ingestLive(APP, 'panel', token, { room: 'main' }),
    ).rejects.toBeInstanceOf(BadRequestException); // no worker → no ingest
  });

  it('round-trips worker payloads to the public overlay read', async () => {
    const token = workers.ingestToken(APP, 'facer')!;
    const payload = {
      room: 'main',
      ts: 12.5,
      maskScale: 1.3,
      faces: [{ bbox: [0.1, 0.2, 0.3, 0.4], score: 0.91 }],
    };
    await svc.ingestLive(APP, 'facer', token, payload);

    const view = await svc.liveOverlayData(APP, 'facer', 'main');
    expect(view.payload).toEqual(payload);
    expect(typeof view.ts).toBe('number');
    expect((view.ageMs ?? -1) >= 0).toBe(true);

    // No data yet for another room → nulls, not a 404 (plugin IS enabled).
    expect(await svc.liveOverlayData(APP, 'facer', 'other')).toEqual({
      ts: null,
      ageMs: null,
      payload: null,
    });
  });

  it('liveOverlayData 404s for disabled installs and non-overlay plugins', async () => {
    await svc.install(APP, 'panel');
    await expect(svc.liveOverlayData(APP, 'panel', 'main')).rejects.toBeInstanceOf(
      NotFoundException, // app-tab ui → never public
    );
    await svc.patch(APP, 'facer', { enabled: false });
    await expect(svc.liveOverlayData(APP, 'facer', 'main')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.liveOverlayData(APP, 'ghost', 'main')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('uninstall clears the live feed', async () => {
    const token = workers.ingestToken(APP, 'facer')!;
    await svc.ingestLive(APP, 'facer', token, { room: 'main', faces: [] });
    await svc.remove(APP, 'facer');
    await svc.install(APP, 'facer');
    await svc.patch(APP, 'facer', { enabled: true });
    const view = await svc.liveOverlayData(APP, 'facer', 'main');
    expect(view.payload).toBeNull();
  });
});
