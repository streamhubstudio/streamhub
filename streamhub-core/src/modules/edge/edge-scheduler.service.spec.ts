/**
 * Unit — edge/EdgeSchedulerService (thin service over the pure logic): schedule
 * places + persists + pushes; no eligible node parks the row pending; revoke
 * tells the node; handleNodeDown fails a down node's work over to a survivor.
 * Real DB + repo, fake gateway.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { EdgeAssignmentsRepository } from './edge-assignments.repository';
import { EdgeCapacityAlerter } from './edge-capacity-alerter';
import { EdgeSchedulerService } from './edge-scheduler.service';
import { EdgeGateway } from './edge.gateway';
import type { LogsServiceContract } from '../../shared/contracts';

function insertNode(
  ctx: UnitContext,
  id: string,
  type: 'edge' | 'common' = 'edge',
  statsJson: string | null = null,
): void {
  ctx.db
    .global()
    .prepare(
      "INSERT INTO nodes (id, name, type, status, last_seen_at, stats_json) " +
        "VALUES (?, ?, ?, 'active', datetime('now'), ?)",
    )
    .run(id, id, type, statsJson);
}

/** Fake gateway: a set of connected node ids + recorded sends. */
function fakeGateway(connectedIds: Set<string>): {
  gw: EdgeGateway;
  sent: { nodeId: string; frame: Record<string, unknown> }[];
  revoked: { nodeId: string; id: string }[];
} {
  const sent: { nodeId: string; frame: Record<string, unknown> }[] = [];
  const revoked: { nodeId: string; id: string }[] = [];
  const gw = {
    isConnected: (id: string) => connectedIds.has(id),
    lastDisconnectAt: () => null,
    connectedSince: (id: string) => (connectedIds.has(id) ? Date.now() : null),
    send: (nodeId: string, frame: Record<string, unknown>) => {
      sent.push({ nodeId, frame });
      return connectedIds.has(nodeId);
    },
    revoke: (nodeId: string, id: string) => {
      revoked.push({ nodeId, id });
      return connectedIds.has(nodeId);
    },
  } as unknown as EdgeGateway;
  return { gw, sent, revoked };
}

describe('edge/EdgeSchedulerService', () => {
  let ctx: UnitContext;
  afterEach(() => ctx.cleanup());

  it('schedules onto a connected edge node (offered + assign pushed)', () => {
    ctx = makeUnitContext();
    insertNode(ctx, 'e1', 'edge');
    const repo = new EdgeAssignmentsRepository(ctx.db);
    const { gw, sent } = fakeGateway(new Set(['e1']));
    const svc = new EdgeSchedulerService(ctx.db, ctx.config, gw, repo);

    const a = svc.schedule({ app: 'live', pluginId: 'yolo' });
    expect(a.nodeId).toBe('e1');
    expect(a.status).toBe('offered');
    expect(sent).toHaveLength(1);
    expect(sent[0].nodeId).toBe('e1');
    expect((sent[0].frame as { type: string }).type).toBe('assign');
  });

  it('parks the assignment pending when no node is eligible', () => {
    ctx = makeUnitContext();
    insertNode(ctx, 'c1', 'common'); // common node, allowCommon default off
    const repo = new EdgeAssignmentsRepository(ctx.db);
    const { gw, sent } = fakeGateway(new Set(['c1']));
    const svc = new EdgeSchedulerService(ctx.db, ctx.config, gw, repo);

    const a = svc.schedule({ app: 'live', pluginId: 'yolo' });
    expect(a.nodeId).toBe('');
    expect(a.status).toBe('pending');
    expect(sent).toHaveLength(0);
  });

  it('revoke tells the owning node and marks the row revoked', () => {
    ctx = makeUnitContext();
    insertNode(ctx, 'e1', 'edge');
    const repo = new EdgeAssignmentsRepository(ctx.db);
    const { gw, revoked } = fakeGateway(new Set(['e1']));
    const svc = new EdgeSchedulerService(ctx.db, ctx.config, gw, repo);

    const a = svc.schedule({ app: 'live', pluginId: 'yolo' });
    const out = svc.revoke(a.id);
    expect(out?.status).toBe('revoked');
    expect(revoked).toEqual([{ nodeId: 'e1', id: a.id }]);
  });

  it('handleNodeDown fails a down node’s running work over to a survivor', () => {
    ctx = makeUnitContext();
    insertNode(ctx, 'e1', 'edge');
    insertNode(ctx, 'e2', 'edge');
    const repo = new EdgeAssignmentsRepository(ctx.db);
    // e1 is DOWN (not in the connected set); e2 is up.
    const { gw, sent } = fakeGateway(new Set(['e2']));
    const svc = new EdgeSchedulerService(ctx.db, ctx.config, gw, repo);

    const a = repo.create({ nodeId: 'e1', app: 'live', pluginId: 'yolo', status: 'running' });
    svc.handleNodeDown('e1');

    const moved = repo.get(a.id)!;
    expect(moved.nodeId).toBe('e2');
    expect(moved.status).toBe('offered');
    expect(sent.some((s) => s.nodeId === 'e2')).toBe(true);
  });

  it('handleNodeDown parks orphans pending when no survivor is eligible', () => {
    ctx = makeUnitContext();
    insertNode(ctx, 'e1', 'edge');
    const repo = new EdgeAssignmentsRepository(ctx.db);
    const { gw } = fakeGateway(new Set()); // nobody connected
    const svc = new EdgeSchedulerService(ctx.db, ctx.config, gw, repo);

    const a = repo.create({ nodeId: 'e1', app: 'live', pluginId: 'yolo', status: 'running' });
    svc.handleNodeDown('e1');
    expect(repo.get(a.id)).toMatchObject({ status: 'pending' });
  });

  it('places onto a GPU node that clears the VRAM guard', () => {
    ctx = makeUnitContext();
    insertNode(
      ctx,
      'gpu1',
      'edge',
      JSON.stringify({ grid: { gpu: true, vramGb: 24, vramFreeMb: 20000, capabilities: ['cuda'] } }),
    );
    const repo = new EdgeAssignmentsRepository(ctx.db);
    const { gw } = fakeGateway(new Set(['gpu1']));
    const svc = new EdgeSchedulerService(ctx.db, ctx.config, gw, repo);

    const a = svc.schedule({ app: 'live', pluginId: 'yolo', req: { gpu: true, minVramGb: 16 } });
    expect(a.nodeId).toBe('gpu1');
    expect(a.status).toBe('offered');
  });
});

describe('retryPending — unplaced assignments are re-offered when a node becomes eligible', () => {
  let ctx: ReturnType<typeof makeUnitContext>;
  afterEach(() => ctx?.cleanup?.());

  it('places a parked pending assignment once an eligible node exists', () => {
    ctx = makeUnitContext();
    const repo = new EdgeAssignmentsRepository(ctx.db);
    // Park: no connected nodes at create time.
    const off = fakeGateway(new Set<string>());
    const svc = new EdgeSchedulerService(ctx.db, ctx.config, off.gw, repo);
    const parked = svc.schedule({ app: 'live', pluginId: 'vision' });
    expect(parked.status).toBe('pending');
    expect(parked.nodeId).toBe('');

    // Node registers + connects → the reconcile places the parked work.
    insertNode(ctx, 'e1', 'edge');
    const on = fakeGateway(new Set(['e1']));
    const svc2 = new EdgeSchedulerService(ctx.db, ctx.config, on.gw, repo);
    expect(svc2.retryPending()).toBe(1);
    const after = repo.list('live')[0];
    expect(after.status).toBe('offered');
    expect(after.nodeId).toBe('e1');
    expect(on.sent).toHaveLength(1);
    expect((on.sent[0].frame as { type: string }).type).toBe('assign');
  });

  it('leaves the assignment pending when still nothing is eligible', () => {
    ctx = makeUnitContext();
    const repo = new EdgeAssignmentsRepository(ctx.db);
    const off = fakeGateway(new Set<string>());
    const svc = new EdgeSchedulerService(ctx.db, ctx.config, off.gw, repo);
    svc.schedule({ app: 'live', pluginId: 'vision' });
    expect(svc.retryPending()).toBe(0);
    expect(repo.list('live')[0].status).toBe('pending');
  });
});

describe('edge/EdgeSchedulerService — capacity alerts + central events', () => {
  let ctx: ReturnType<typeof makeUnitContext>;
  let capacity: { alert: jest.Mock };
  let logs: { write: jest.Mock; query: jest.Mock };
  afterEach(() => ctx?.cleanup?.());

  function make(connected: Set<string>): EdgeSchedulerService {
    const repo = new EdgeAssignmentsRepository(ctx.db);
    const { gw } = fakeGateway(connected);
    capacity = { alert: jest.fn() };
    logs = { write: jest.fn(), query: jest.fn() };
    return new EdgeSchedulerService(
      ctx.db,
      ctx.config,
      gw,
      repo,
      capacity as unknown as EdgeCapacityAlerter,
      logs as unknown as LogsServiceContract,
    );
  }

  it('fires a no-eligible-node capacity alert + warn log when a schedule parks', () => {
    ctx = makeUnitContext();
    const svc = make(new Set());
    svc.schedule({ app: 'live', pluginId: 'yolo' });
    expect(capacity.alert).toHaveBeenCalledWith(
      'no-eligible-node',
      expect.objectContaining({ app: 'live', pluginId: 'yolo' }),
    );
    expect(logs.write).toHaveBeenCalledWith(
      'warn',
      'edge',
      expect.stringContaining('no eligible node'),
      expect.any(Object),
    );
  });

  it('logs an info event (source edge) on a successful placement', () => {
    ctx = makeUnitContext();
    insertNode(ctx, 'e1', 'edge');
    const svc = make(new Set(['e1']));
    svc.schedule({ app: 'live', pluginId: 'yolo' });
    expect(logs.write).toHaveBeenCalledWith(
      'info',
      'edge',
      expect.stringContaining('scheduled'),
      expect.objectContaining({ nodeId: 'e1' }),
    );
    expect(capacity.alert).not.toHaveBeenCalled();
  });

  it('retryPending fires one no-eligible-node alert while work stays parked', () => {
    ctx = makeUnitContext();
    const svc = make(new Set());
    svc.schedule({ app: 'live', pluginId: 'yolo' }); // parks (and alerts once)
    capacity.alert.mockClear();
    expect(svc.retryPending()).toBe(0);
    expect(capacity.alert).toHaveBeenCalledTimes(1);
    expect(capacity.alert).toHaveBeenCalledWith(
      'no-eligible-node',
      expect.objectContaining({ pending: 1 }),
    );
  });

  it('fires a failover-parked alert when a down node leaves orphans with no survivor', () => {
    ctx = makeUnitContext();
    insertNode(ctx, 'e1', 'edge');
    const svc = make(new Set()); // nobody connected → orphan cannot move
    const repo = new EdgeAssignmentsRepository(ctx.db);
    repo.create({ nodeId: 'e1', app: 'live', pluginId: 'yolo', status: 'running' });
    svc.handleNodeDown('e1');
    expect(capacity.alert).toHaveBeenCalledWith(
      'failover-parked',
      expect.objectContaining({ nodeId: 'e1', parked: 1 }),
    );
  });

  it('does NOT alert on failover when every orphan finds a survivor', () => {
    ctx = makeUnitContext();
    insertNode(ctx, 'e1', 'edge');
    insertNode(ctx, 'e2', 'edge');
    const svc = make(new Set(['e2']));
    const repo = new EdgeAssignmentsRepository(ctx.db);
    repo.create({ nodeId: 'e1', app: 'live', pluginId: 'yolo', status: 'running' });
    svc.handleNodeDown('e1');
    expect(capacity.alert).not.toHaveBeenCalled();
  });
});
