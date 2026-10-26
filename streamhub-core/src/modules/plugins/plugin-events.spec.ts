/**
 * Unit specs for the plugin DOMAIN-EVENT channel (worker → core → app signed
 * callbacks) + the authenticated live-data read for app-tab panels:
 *
 *   - PluginWorkerManager: STREAMHUB_EVENTS_URL injected next to the ingest
 *     URL (same per-start token authenticates both channels).
 *   - PluginsService.ingestEvent: token auth, event name REQUIRED and gated
 *     by the manifest's declared `events` (spoof guard — a worker can never
 *     emit core events or another plugin's family), payload relayed through
 *     the callbacks funnel with plugin/room merged in, callbacks-less
 *     construction stays safe.
 *   - PluginsService.liveData: authenticated latest-payload read for ANY
 *     installed plugin (app-tab panels), 404 when not installed.
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
      cp.pid = 4243;
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
import { PluginLiveDataService } from './plugin-livedata.service';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginWorkerManager } from './plugin-worker.manager';
import { PluginsService } from './plugins.service';

const APP = 'parking';

function appRecord(): AppRecord {
  return {
    id: 1,
    name: APP,
    displayName: 'Parking',
    livekitRoomPrefix: 'parking',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    settingsJson: null,
  };
}

/** Fixture registry: a worker plugin declaring events, one declaring none. */
function writeFixtures(dir: string): void {
  const plates = path.join(dir, 'plates');
  fs.mkdirSync(plates, { recursive: true });
  fs.writeFileSync(
    path.join(plates, 'plugin.meta.js'),
    `module.exports.default = {
       id:'plates', name:'Plates', description:'', category:'processor',
       ui:'app-tab', needsWorker:true, configSchema:[],
       events:['plate.detected','plate.allowed','plate.denied'],
       worker:{ spawn(ctx){ return { command:'node', args:['-e','0'] }; } } };`,
  );
  const mute = path.join(dir, 'mute');
  fs.mkdirSync(mute, { recursive: true });
  fs.writeFileSync(
    path.join(mute, 'plugin.meta.js'),
    `module.exports.default = {
       id:'mute', name:'Mute', description:'', category:'processor',
       ui:'player-overlay', needsWorker:true, configSchema:[],
       worker:{ spawn(ctx){ return { command:'node', args:['-e','0'] }; } } };`,
  );
}

describe('plugin domain-event channel', () => {
  let ctx: UnitContext;
  let dir: string;
  let workers: PluginWorkerManager;
  let livedata: PluginLiveDataService;
  let svc: PluginsService;

  beforeEach(async () => {
    (spawn as jest.Mock).mockClear();
    ctx = makeUnitContext();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpr-events-'));
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
      undefined,
      ctx.mocks.callbacks,
    );
    await svc.install(APP, 'plates');
    await svc.patch(APP, 'plates', { enabled: true }); // reconcile spawns worker
  });

  afterEach(() => {
    workers.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
    ctx.cleanup();
  });

  it('injects STREAMHUB_EVENTS_URL next to the ingest URL (same token)', () => {
    const call = (spawn as jest.Mock).mock.calls.at(-1);
    const env = call?.[2]?.env as Record<string, string>;
    expect(env.STREAMHUB_EVENTS_URL).toBe(
      `http://127.0.0.1:${ctx.config.port}/api/v1/apps/${APP}/plugins/plates/events`,
    );
    expect(env.STREAMHUB_INGEST_URL).toBe(
      `http://127.0.0.1:${ctx.config.port}/api/v1/apps/${APP}/plugins/plates/live`,
    );
    expect(env.STREAMHUB_INGEST_TOKEN).toBe(workers.ingestToken(APP, 'plates'));
    expect(env.STREAMHUB_INGEST_TOKEN).toBeTruthy();
  });

  it('ingestEvent requires the CURRENT ingest token', async () => {
    await expect(
      svc.ingestEvent(APP, 'plates', undefined, { event: 'plate.detected' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      svc.ingestEvent(APP, 'plates', 'wrong', { event: 'plate.detected' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const token = workers.ingestToken(APP, 'plates')!;
    await expect(
      svc.ingestEvent(APP, 'plates', token, {
        event: 'plate.detected',
        room: 'gate',
        data: { plate: 'AB123CD' },
      }),
    ).resolves.toEqual({ ok: true, event: 'plate.detected' });
  });

  it('relays accepted events through the signed-callbacks funnel', async () => {
    const token = workers.ingestToken(APP, 'plates')!;
    await svc.ingestEvent(APP, 'plates', token, {
      event: 'plate.denied',
      room: 'gate',
      data: { plate: 'XX999XX', confidence: 0.91, snapshot: 'snap.jpg' },
    });
    expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(
      APP,
      'plate.denied',
      {
        plate: 'XX999XX',
        confidence: 0.91,
        snapshot: 'snap.jpg',
        plugin: 'plates',
        room: 'gate',
      },
    );
  });

  it('rejects undeclared event names (spoof guard) without dispatching', async () => {
    const token = workers.ingestToken(APP, 'plates')!;
    for (const event of ['vod_ready', 'plate.exploded', '']) {
      await expect(
        svc.ingestEvent(APP, 'plates', token, { event, data: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(ctx.mocks.callbacks.dispatch).not.toHaveBeenCalled();
  });

  it('rejects events from a plugin that declares no events', async () => {
    await svc.install(APP, 'mute');
    await svc.patch(APP, 'mute', { enabled: true });
    const token = workers.ingestToken(APP, 'mute')!;
    await expect(
      svc.ingestEvent(APP, 'mute', token, { event: 'plate.detected' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.mocks.callbacks.dispatch).not.toHaveBeenCalled();
  });

  it('stays safe when constructed WITHOUT a callbacks service', async () => {
    const registry = new PluginRegistryService(dir);
    registry.discover();
    const bare = new PluginsService(
      registry,
      new AppPluginsRepository(ctx.db),
      workers,
      ctx.mocks.apps,
      ctx.mocks.logs,
      livedata,
    );
    const token = workers.ingestToken(APP, 'plates')!;
    await expect(
      bare.ingestEvent(APP, 'plates', token, { event: 'plate.allowed' }),
    ).resolves.toEqual({ ok: true, event: 'plate.allowed' });
  });

  it('liveData serves app-tab plugins behind auth; 404 when not installed', async () => {
    const token = workers.ingestToken(APP, 'plates')!;
    const payload = {
      room: 'gate',
      last: { plate: 'AB123CD', confidence: 0.9 },
      recent: [{ plate: 'AB123CD' }],
    };
    await svc.ingestLive(APP, 'plates', token, payload);

    // The AUTHENTICATED read answers for an app-tab plugin…
    const view = await svc.liveData(APP, 'plates', 'gate');
    expect(view.payload).toEqual(payload);
    // …while the PUBLIC overlay read still refuses it (privacy gate intact).
    await expect(svc.liveOverlayData(APP, 'plates', 'gate')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // No data yet for another room → nulls, not a 404 (plugin IS installed).
    expect(await svc.liveData(APP, 'plates', 'other')).toEqual({
      ts: null,
      ageMs: null,
      payload: null,
    });
    // Not installed → 404.
    await expect(svc.liveData(APP, 'mute', 'gate')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.liveData(APP, 'ghost', 'gate')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
