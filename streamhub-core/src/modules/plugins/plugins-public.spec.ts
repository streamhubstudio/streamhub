/**
 * Unit specs for PluginsService.publicOverlays() — the PUBLIC (no-auth) view
 * consumed by the anonymous /play and /embed players.
 *
 * Uses a temp FIXTURE registry with four plugins:
 *   - `ov-secret`   player-overlay carrying a secret + a callback/webhook URL,
 *   - `ov-plain`    player-overlay with only render-safe fields,
 *   - `pl-provider` player (swappable media-player provider, e.g. Vidstack),
 *   - `tab`         app-tab (must never appear in the public view).
 *
 * Asserts the endpoint (a) returns ONLY enabled player-slot plugins (overlays
 * AND providers), (b) strips secrets + callback/webhook URLs, and (c) shapes
 * each entry as { id, manifest:{name,ui,configSchema,icon}, config }.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotFoundException } from '@nestjs/common';

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
  const ovSecret = path.join(dir, 'ov-secret');
  fs.mkdirSync(ovSecret, { recursive: true });
  fs.writeFileSync(
    path.join(ovSecret, 'plugin.meta.js'),
    `module.exports.default = {
       id:'ov-secret', name:'Overlay Secret', description:'', category:'tool',
       ui:'player-overlay', icon:'shield',
       configSchema:[
         { key:'label', type:'string', label:'Label', default:'Cam' },
         { key:'color', type:'string', label:'Colour', default:'#fff' },
         { key:'apiToken', type:'secret', label:'Token', default:'' },
         { key:'callbackUrl', type:'string', label:'Callback', default:'' },
         { key:'webhookUrl', type:'string', label:'Webhook', default:'' }
       ] };`,
  );
  const ovPlain = path.join(dir, 'ov-plain');
  fs.mkdirSync(ovPlain, { recursive: true });
  fs.writeFileSync(
    path.join(ovPlain, 'plugin.meta.js'),
    `module.exports.default = {
       id:'ov-plain', name:'Overlay Plain', description:'', category:'tool',
       ui:'player-overlay', icon:'clock',
       configSchema:[{ key:'interval', type:'number', label:'I', default:1000 }] };`,
  );
  const plProvider = path.join(dir, 'pl-provider');
  fs.mkdirSync(plProvider, { recursive: true });
  fs.writeFileSync(
    path.join(plProvider, 'plugin.meta.js'),
    `module.exports.default = {
       id:'pl-provider', name:'Player Provider', description:'', category:'tool',
       ui:'player', icon:'play',
       configSchema:[
         { key:'theme', type:'select', label:'Theme', default:'auto',
           options:[{value:'auto',label:'Auto'},{value:'dark',label:'Dark'}] },
         { key:'apiToken', type:'secret', label:'Token', default:'' }
       ] };`,
  );
  const tab = path.join(dir, 'tab');
  fs.mkdirSync(tab, { recursive: true });
  fs.writeFileSync(
    path.join(tab, 'plugin.meta.js'),
    `module.exports.default = {
       id:'tab', name:'Tab', description:'', category:'panel', ui:'app-tab',
       configSchema:[{ key:'name', type:'string', label:'N', default:'x' }] };`,
  );
}

describe('PluginsService.publicOverlays', () => {
  let ctx: UnitContext;
  let dir: string;
  let svc: PluginsService;
  let workers: PluginWorkerManager;

  beforeEach(() => {
    ctx = makeUnitContext();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-pub-'));
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

  it('404s for an unknown app', async () => {
    ctx.mocks.apps.get.mockResolvedValue(null);
    await expect(svc.publicOverlays(APP)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('is empty when no overlay is installed/enabled', async () => {
    expect(await svc.publicOverlays(APP)).toEqual([]);
    // installed-but-disabled is still excluded
    await svc.install(APP, 'ov-plain');
    expect(await svc.publicOverlays(APP)).toEqual([]);
  });

  it('returns ONLY enabled player-overlays (no app-tab, no disabled)', async () => {
    await svc.install(APP, 'ov-plain');
    await svc.patch(APP, 'ov-plain', { enabled: true });
    await svc.install(APP, 'tab');
    await svc.patch(APP, 'tab', { enabled: true }); // app-tab → excluded
    await svc.install(APP, 'ov-secret'); // overlay but left disabled → excluded

    const overlays = await svc.publicOverlays(APP);
    expect(overlays.map((o) => o.id)).toEqual(['ov-plain']);
    expect(overlays[0].manifest).toEqual({
      name: 'Overlay Plain',
      ui: 'player-overlay',
      icon: 'clock',
      configSchema: expect.any(Array),
    });
    expect(overlays[0].config).toEqual({ interval: 1000 });
  });

  it('includes an enabled `player` provider (so anonymous players resolve it), secret-stripped', async () => {
    await svc.install(APP, 'pl-provider');
    await svc.patch(APP, 'pl-provider', {
      enabled: true,
      config: { theme: 'dark', apiToken: 'sk_should_not_leak' },
    });

    const rows = await svc.publicOverlays(APP);
    expect(rows.map((o) => o.id)).toEqual(['pl-provider']);
    expect(rows[0].manifest).toEqual({
      name: 'Player Provider',
      ui: 'player',
      icon: 'play',
      configSchema: expect.any(Array),
    });
    // render-safe config kept, the secret dropped entirely
    expect(rows[0].config).toEqual({ theme: 'dark' });
    expect(JSON.stringify(rows[0])).not.toContain('sk_should_not_leak');
  });

  it('strips secrets AND callback/webhook URLs from the config', async () => {
    await svc.install(APP, 'ov-secret');
    await svc.patch(APP, 'ov-secret', {
      enabled: true,
      config: {
        label: 'Front',
        color: '#00ff00',
        apiToken: 'sk_live_should_not_leak',
        callbackUrl: 'https://hooks.example.com/yolo',
        webhookUrl: 'https://hooks.example.com/wh',
      },
    });

    const [overlay] = await svc.publicOverlays(APP);
    // render-safe fields kept…
    expect(overlay.config).toEqual({ label: 'Front', color: '#00ff00' });
    // …sensitive ones gone entirely (not masked, absent)
    expect(overlay.config).not.toHaveProperty('apiToken');
    expect(overlay.config).not.toHaveProperty('callbackUrl');
    expect(overlay.config).not.toHaveProperty('webhookUrl');
    // no secret sentinel leaked either
    expect(JSON.stringify(overlay)).not.toContain('sk_live_should_not_leak');
    expect(JSON.stringify(overlay)).not.toContain('hooks.example.com');
  });
});
