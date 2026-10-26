/**
 * Unit spec for the VISION SINK TAP in PluginsService.ingestEvent.
 *
 * The optional VISION_EVENT_SINK is called AFTER a vision-family event
 * dispatches through the callbacks funnel — and NOT for a non-vision plugin's
 * event. Constructing without a sink keeps ingest working (proven elsewhere);
 * here we inject a fake sink and assert routing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter } = require('events');
  return {
    spawn: jest.fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cp: any = new EventEmitter();
      cp.pid = 5251;
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
import { PluginLiveDataService } from './plugin-livedata.service';
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

/** A fixture 'vision' plugin declaring the two families we assert on. */
function writeFixtures(dir: string): void {
  const vision = path.join(dir, 'vision');
  fs.mkdirSync(vision, { recursive: true });
  fs.writeFileSync(
    path.join(vision, 'plugin.meta.js'),
    `module.exports.default = {
       id:'vision', name:'Vision', description:'', category:'processor',
       ui:'app-tab', needsWorker:true, version:'0.1.0', configSchema:[],
       events:['count.in','demography.face'],
       worker:{ spawn(ctx){ return { command:'node', args:['-e','0'] }; } } };`,
  );
  // A non-vision worker plugin whose event must NOT hit the sink.
  const other = path.join(dir, 'plates');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(
    path.join(other, 'plugin.meta.js'),
    `module.exports.default = {
       id:'plates', name:'Plates', description:'', category:'processor',
       ui:'app-tab', needsWorker:true, version:'0.1.0', configSchema:[],
       events:['plate.detected'],
       worker:{ spawn(ctx){ return { command:'node', args:['-e','0'] }; } } };`,
  );
}

describe('PluginsService vision sink tap', () => {
  let ctx: UnitContext;
  let dir: string;
  let workers: PluginWorkerManager;
  let sink: { record: jest.Mock };
  let svc: PluginsService;

  beforeEach(async () => {
    ctx = makeUnitContext();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-tap-'));
    writeFixtures(dir);
    const registry = new PluginRegistryService(dir);
    registry.discover();
    workers = new PluginWorkerManager(ctx.config, ctx.mocks.logs);
    const repo = new AppPluginsRepository(ctx.db);
    ctx.mocks.apps.get.mockResolvedValue(appRecord());
    sink = { record: jest.fn() };
    svc = new PluginsService(
      registry,
      repo,
      workers,
      ctx.mocks.apps,
      ctx.mocks.logs,
      new PluginLiveDataService(),
      undefined,
      ctx.mocks.callbacks,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sink as any,
    );
    await svc.install(APP, 'vision');
    await svc.patch(APP, 'vision', { enabled: true });
    await svc.install(APP, 'plates');
    await svc.patch(APP, 'plates', { enabled: true });
  });

  afterEach(() => {
    workers.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
    ctx.cleanup();
  });

  it('taps a vision-family event into the sink (after dispatch)', async () => {
    const token = workers.ingestToken(APP, 'vision')!;
    await svc.ingestEvent(APP, 'vision', token, {
      event: 'count.in',
      room: 'gate',
      data: { line: 'l1', tag: 'door' },
    });
    expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(
      APP,
      'count.in',
      expect.objectContaining({ plugin: 'vision', room: 'gate' }),
    );
    expect(sink.record).toHaveBeenCalledWith(
      APP,
      'count.in',
      expect.objectContaining({ plugin: 'vision', room: 'gate', line: 'l1', tag: 'door' }),
    );
  });

  it('does NOT tap a non-vision plugin event', async () => {
    const token = workers.ingestToken(APP, 'plates')!;
    await svc.ingestEvent(APP, 'plates', token, {
      event: 'plate.detected',
      room: 'gate',
    });
    expect(sink.record).not.toHaveBeenCalled();
  });
});
