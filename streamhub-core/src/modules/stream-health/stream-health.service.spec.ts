/**
 * Unit spec — StreamHealthService. Real store on a temp dir; the callbacks
 * funnel, APPS_SERVICE and the install repo are tiny fakes (no Nest DI, no
 * network). Locks the funnel-tap contract (subscribes on init, records ONLY
 * health.* events, never throws into the funnel, unsubscribes on destroy),
 * the overview projection (history rooms ∪ override rooms) and the settings
 * round-trip incl. the three-layer resolved view + validation errors.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CallbacksService, DispatchListener } from '../callbacks/callbacks.service';
import type { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { StreamHealthService } from './stream-health.service';
import { StreamHealthStore } from './stream-health.store';
import { HealthSettingsError } from './stream-health.thresholds';

class FakeFunnel {
  listeners = new Set<DispatchListener>();
  onDispatch(listener: DispatchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(app: string, event: string, payload: Record<string, unknown>): void {
    for (const l of this.listeners) l(app, event as never, payload);
  }
}

describe('StreamHealthService', () => {
  let dir: string;
  let store: StreamHealthStore;
  let funnel: FakeFunnel;
  let service: StreamHealthService;
  let installConfig: Record<string, unknown> | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-svc-'));
    store = new StreamHealthStore();
    funnel = new FakeFunnel();
    installConfig = { silence_db: -60 };
    const apps = { appDir: () => dir };
    const appPlugins = {
      get: () => (installConfig ? { config: installConfig } : null),
    };
    service = new StreamHealthService(
      store,
      funnel as unknown as CallbacksService,
      apps as never,
      appPlugins as unknown as AppPluginsRepository,
    );
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    store.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records health.* dispatches from the funnel into the per-app db', async () => {
    funnel.emit('live', 'health.audio_lost', {
      plugin: 'stream-health',
      room: 'cam-1',
      silenceDb: -72,
    });
    funnel.emit('live', 'vod_ready', { room: 'cam-1' }); // ignored family

    const events = await service.events('live', 10);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('health.audio_lost');
    expect(events[0].room).toBe('cam-1');
    expect(events[0].data.silenceDb).toBe(-72);
  });

  it('stops recording after destroy (unsubscribed from the funnel)', async () => {
    service.onModuleDestroy();
    funnel.emit('live', 'health.stalled', { room: 'cam-1' });
    expect(await service.events('live', 10)).toHaveLength(0);
    expect(funnel.listeners.size).toBe(0);
  });

  it('never throws into the funnel even when the store path explodes', () => {
    store.fileFor = () => {
      throw new Error('disk on fire');
    };
    expect(() =>
      funnel.emit('live', 'health.degraded', { room: 'cam-1' }),
    ).not.toThrow();
  });

  it('overview = events today + union of history rooms and override rooms', async () => {
    funnel.emit('live', 'health.degraded', { room: 'cam-1', status: 'degraded' });
    funnel.emit('live', 'health.recovered', { room: 'cam-1', status: 'healthy' });
    await service.putSettings('live', 'cam-9', { stall_sec: 30 });

    const ov = await service.overview('live');
    expect(ov.today).toBe(2);
    expect(ov.rooms).toEqual([
      expect.objectContaining({
        room: 'cam-1',
        lastEvent: 'health.recovered',
        hasOverride: false,
      }),
      expect.objectContaining({
        room: 'cam-9',
        lastEvent: null,
        hasOverride: true,
      }),
    ]);
  });

  it('settings round-trip resolves defaults ⊕ install config ⊕ override', async () => {
    // No override yet: install config layer visible, defaults elsewhere.
    let view = await service.getSettings('live', 'cam-1');
    expect(view.override).toEqual({});
    expect(view.updatedAt).toBeNull();
    expect(view.resolved.silence_db).toBe(-60); // install config
    expect(view.resolved.stall_sec).toBe(20); // default

    view = await service.putSettings('live', 'cam-1', {
      stall_sec: 60,
      silence_db: '-30',
    });
    expect(view.override).toEqual({ stall_sec: 60, silence_db: -30 });
    expect(view.resolved.stall_sec).toBe(60);
    expect(view.resolved.silence_db).toBe(-30); // override beats install config
    expect(view.updatedAt).toBeTruthy();

    // {} clears the override.
    view = await service.putSettings('live', 'cam-1', {});
    expect(view.override).toEqual({});
    expect(view.resolved.silence_db).toBe(-60);
  });

  it('resolves with pure defaults when the app never installed the plugin', async () => {
    installConfig = null;
    const view = await service.getSettings('live', 'cam-1');
    expect(view.resolved.silence_db).toBe(-50);
  });

  it('rejects an invalid override with HealthSettingsError', async () => {
    await expect(
      service.putSettings('live', 'cam-1', { nope: 1 }),
    ).rejects.toBeInstanceOf(HealthSettingsError);
    await expect(
      service.putSettings('live', 'cam-1', { silence_db: 40 }),
    ).rejects.toBeInstanceOf(HealthSettingsError);
  });
});
