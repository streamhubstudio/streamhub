/**
 * Unit specs for the STREAM-AWARE plugin resolution in PluginsService — the
 * per-stream opt-out feature end-to-end at the service layer.
 *
 * Two player-overlay plugins ('ov-a', 'ov-b') are installed + enabled on the
 * app. Stream `room1/cam` opts OUT of 'ov-a'; stream `room2/cam` opts out of
 * nothing. Asserts:
 *  - DEFAULT (no scope): every app-enabled overlay applies → both returned,
 *    the app-level `list()` is unchanged.
 *  - stream/room scope: the opted-out overlay is subtracted for THAT stream /
 *    room only; other streams and rooms are unaffected.
 *
 * PluginsService is constructed WITH the real StreamPluginOverridesService over
 * the same migrated temp app.db the repo writes to, so installs + stream rows
 * share one database (mirrors the DI wiring).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AppRecord } from '../../shared/contracts';
import { AppPluginsRepository } from './app-plugins.repository';
import { PluginLiveDataService } from './plugin-livedata.service';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginWorkerManager } from './plugin-worker.manager';
import { PluginsService } from './plugins.service';
import { StreamPluginOverridesService } from '../streams/stream-plugins.service';

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
  for (const id of ['ov-a', 'ov-b']) {
    const p = path.join(dir, id);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(
      path.join(p, 'plugin.meta.js'),
      `module.exports.default = {
         id:'${id}', name:'Overlay ${id}', description:'', category:'tool',
         ui:'player-overlay', icon:'clock',
         configSchema:[{ key:'label', type:'string', label:'L', default:'x' }] };`,
    );
  }
}

describe('PluginsService — per-stream plugin opt-out resolution', () => {
  let ctx: UnitContext;
  let dir: string;
  let svc: PluginsService;
  let workers: PluginWorkerManager;

  function insertStream(streamId: string, room: string): void {
    ctx.db
      .appDb(APP)
      .prepare(
        `INSERT INTO streams (app_id, stream_id, type, room, participant, status)
         VALUES (1, ?, 'webrtc', ?, 'cam', 'active')`,
      )
      .run(streamId, room);
  }

  beforeEach(async () => {
    ctx = makeUnitContext();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-stream-'));
    writeFixtures(dir);
    const registry = new PluginRegistryService(dir);
    registry.discover();
    workers = new PluginWorkerManager(ctx.config, ctx.mocks.logs);
    const repo = new AppPluginsRepository(ctx.db);
    ctx.mocks.apps.get.mockResolvedValue(appRecord() as AppRecord);
    const streamPlugins = new StreamPluginOverridesService(ctx.db);
    svc = new PluginsService(
      registry,
      repo,
      workers,
      ctx.mocks.apps,
      ctx.mocks.logs,
      new PluginLiveDataService(),
      streamPlugins,
    );

    // Both overlays installed + enabled on the app.
    await svc.install(APP, 'ov-a');
    await svc.patch(APP, 'ov-a', { enabled: true });
    await svc.install(APP, 'ov-b');
    await svc.patch(APP, 'ov-b', { enabled: true });

    // Two live streams; cam in room1 opts out of ov-a only.
    insertStream('room1/cam', 'room1');
    insertStream('room2/cam', 'room2');
    streamPlugins.setForStream(APP, 'room1/cam', ['ov-a']);
  });

  afterEach(() => {
    workers.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
    ctx.cleanup();
  });

  it('DEFAULT (no scope): both app-enabled overlays apply', async () => {
    const overlays = await svc.publicOverlays(APP);
    expect(overlays.map((o) => o.id).sort()).toEqual(['ov-a', 'ov-b']);
  });

  it('stream scope subtracts that stream’s opted-out overlay only', async () => {
    const r1 = await svc.publicOverlays(APP, { stream: 'room1/cam' });
    expect(r1.map((o) => o.id)).toEqual(['ov-b']); // ov-a removed

    // The other stream is unaffected.
    const r2 = await svc.publicOverlays(APP, { stream: 'room2/cam' });
    expect(r2.map((o) => o.id).sort()).toEqual(['ov-a', 'ov-b']);
  });

  it('room scope subtracts the room’s active-stream opt-outs', async () => {
    const r1 = await svc.publicOverlays(APP, { room: 'room1' });
    expect(r1.map((o) => o.id)).toEqual(['ov-b']);

    const r2 = await svc.publicOverlays(APP, { room: 'room2' });
    expect(r2.map((o) => o.id).sort()).toEqual(['ov-a', 'ov-b']);
  });

  it('app-level list() is UNCHANGED without a scope', async () => {
    const list = await svc.list(APP);
    const byId = Object.fromEntries(list.map((v) => [v.manifest.id, v.enabled]));
    expect(byId['ov-a']).toBe(true);
    expect(byId['ov-b']).toBe(true);
  });

  it('scoped list() reports the opted-out plugin as enabled:false for that stream', async () => {
    const scoped = await svc.list(APP, { room: 'room1' });
    const byId = Object.fromEntries(
      scoped.map((v) => [v.manifest.id, v.enabled]),
    );
    expect(byId['ov-a']).toBe(false); // opted out for room1
    expect(byId['ov-b']).toBe(true);

    // A different stream keeps both enabled.
    const other = await svc.list(APP, { stream: 'room2/cam' });
    const otherById = Object.fromEntries(
      other.map((v) => [v.manifest.id, v.enabled]),
    );
    expect(otherById['ov-a']).toBe(true);
    expect(otherById['ov-b']).toBe(true);
  });
});
