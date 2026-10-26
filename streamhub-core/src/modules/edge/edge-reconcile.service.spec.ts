/**
 * Unit specs for EdgeReconcileService — the generic per-stream reconcile.
 *
 * Covers the edge-node gate, the mirror of active streams onto edge assignments
 * (one per plugin × stream, with a config.room override), the dedupe against an
 * existing assignment, the revoke of a stale (ended-stream) assignment, and that
 * only INSTALLED + ENABLED + edge-capable plugins participate. Scheduler + repo +
 * gateway are jest mocks; the registry + install repo + DB are real (temp).
 */
import * as path from 'path';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { EdgeReconcileService } from './edge-reconcile.service';
import type { EdgeAssignment } from './edge.types';

const APP = 'live';
// The non-edge "never mirrored" case uses the synthetic `reftool` fixture (a
// worker app WITHOUT worker.edge) instead of a real shipping app that decouples.
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures', 'plugins');

function fakeAssignment(over: Partial<EdgeAssignment>): EdgeAssignment {
  return {
    id: 'x',
    nodeId: 'n1',
    app: APP,
    pluginId: 'refapp',
    streamId: 'gate',
    config: {},
    status: 'running',
    detail: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('EdgeReconcileService', () => {
  let ctx: UnitContext;
  let installs: AppPluginsRepository;
  let scheduler: { schedule: jest.Mock; revoke: jest.Mock };
  let assignments: { list: jest.Mock };
  let gateway: { isConnected: jest.Mock };
  let svc: EdgeReconcileService;
  const prevFixtureRoot = process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;

  beforeAll(() => {
    process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = FIXTURE_ROOT;
  });
  afterAll(() => {
    if (prevFixtureRoot === undefined) delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
    else process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = prevFixtureRoot;
  });

  function seedActiveStreams(rooms: string[]): void {
    const adb = ctx.db.appDb(APP);
    let i = 0;
    for (const room of rooms) {
      adb
        .prepare(
          "INSERT INTO streams (app_id, stream_id, type, room, status) VALUES (1, ?, 'rtmp', ?, 'active')",
        )
        .run(`s${i++}`, room);
    }
  }

  function seedEdgeNode(): void {
    ctx.db
      .global()
      .prepare("INSERT INTO nodes (id, name, type, status) VALUES ('n1','edge-1','edge','online')")
      .run();
  }

  beforeEach(() => {
    ctx = makeUnitContext();
    ctx.mocks.apps.list.mockResolvedValue([{ name: APP }] as never);

    installs = new AppPluginsRepository(ctx.db);
    installs.install(APP, 'refapp', { room: 'r0', confidence: 0.4 }, true); // edge-capable (fixture), enabled
    installs.install(APP, 'reftool', {}, true); // local-only worker (non-edge fixture)

    scheduler = { schedule: jest.fn(), revoke: jest.fn() };
    assignments = { list: jest.fn(() => [] as EdgeAssignment[]) };
    gateway = { isConnected: jest.fn(() => true) };
    const registry = new PluginRegistryService();
    registry.discover();

    svc = new EdgeReconcileService(
      scheduler as never,
      assignments as never,
      gateway as never,
      registry,
      installs,
      ctx.db,
      ctx.mocks.apps,
    );
  });

  afterEach(() => ctx.cleanup());

  it('does nothing when no edge node is connected', () => {
    seedActiveStreams(['gate']);
    // No edge node seeded → edgeNodeCount() === 0.
    svc.reconcileApp(APP);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('mirrors each active stream onto an edge assignment (edge plugin only)', () => {
    seedEdgeNode();
    seedActiveStreams(['gate', 'lobby']);
    svc.reconcileApp(APP);
    // occupancy (edge-capable) → one assignment per room; reftool skipped.
    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    expect(scheduler.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        app: APP,
        pluginId: 'refapp',
        streamId: 'gate',
        config: expect.objectContaining({ room: 'gate', confidence: 0.4 }),
      }),
    );
    // reftool is local-only — never mirrored.
    const ids = scheduler.schedule.mock.calls.map((c) => c[0].pluginId);
    expect(ids).not.toContain('reftool');
  });

  it('does not re-schedule a stream that already has an assignment', () => {
    seedEdgeNode();
    seedActiveStreams(['gate', 'lobby']);
    assignments.list.mockReturnValue([
      fakeAssignment({ pluginId: 'refapp', streamId: 'gate', status: 'running' }),
    ]);
    svc.reconcileApp(APP);
    expect(scheduler.schedule).toHaveBeenCalledTimes(1); // only 'lobby'
    expect(scheduler.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'lobby' }),
    );
  });

  it('revokes an assignment whose stream ended', () => {
    seedEdgeNode();
    seedActiveStreams(['gate']);
    assignments.list.mockReturnValue([
      fakeAssignment({ id: 'stale', pluginId: 'refapp', streamId: 'old', status: 'running' }),
    ]);
    svc.reconcileApp(APP);
    expect(scheduler.revoke).toHaveBeenCalledWith('stale');
  });
});
