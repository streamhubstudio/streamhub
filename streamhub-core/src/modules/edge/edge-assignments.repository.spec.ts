/**
 * Unit — edge/EdgeAssignmentsRepository (CRUD + status transitions over the
 * global `edge_assignments` table, against a real migrated temp DB).
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { EdgeAssignmentsRepository } from './edge-assignments.repository';

describe('edge/EdgeAssignmentsRepository', () => {
  let ctx: UnitContext;
  let repo: EdgeAssignmentsRepository;

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = ctx.newService(EdgeAssignmentsRepository, ctx.db);
  });
  afterEach(() => ctx.cleanup());

  it('creates a pending assignment (uuid id) and round-trips config', () => {
    const a = repo.create({
      nodeId: 'n1',
      app: 'live',
      pluginId: 'yolo',
      streamId: 'cam1',
      config: { conf: 0.4 },
      status: 'pending',
    });
    expect(a.id).toMatch(/[0-9a-f-]{36}/i);
    expect(a.status).toBe('pending');
    expect(a.config).toEqual({ conf: 0.4 });
    expect(a.streamId).toBe('cam1');
    expect(repo.get(a.id)?.app).toBe('live');
  });

  it('walks the status transitions pending → offered → running → stopped', () => {
    const a = repo.create({ nodeId: 'n1', app: 'live', pluginId: 'yolo', status: 'pending' });
    repo.updateStatus(a.id, 'offered');
    expect(repo.get(a.id)?.status).toBe('offered');
    repo.updateStatus(a.id, 'running');
    expect(repo.get(a.id)?.status).toBe('running');
    repo.updateStatus(a.id, 'stopped', 'worker exited');
    const done = repo.get(a.id)!;
    expect(done.status).toBe('stopped');
    expect(done.detail).toBe('worker exited');
  });

  it('reassign moves a row to another node and clears detail', () => {
    const a = repo.create({ nodeId: 'n1', app: 'live', pluginId: 'yolo', status: 'running' });
    repo.updateStatus(a.id, 'failed', 'boom');
    repo.reassign(a.id, 'n2', 'offered');
    const moved = repo.get(a.id)!;
    expect(moved.nodeId).toBe('n2');
    expect(moved.status).toBe('offered');
    expect(moved.detail).toBeNull();
  });

  it('lists pending+offered and active(offered+running) by node, and counts active', () => {
    repo.create({ nodeId: 'n1', app: 'a', pluginId: 'p', status: 'pending' });
    repo.create({ nodeId: 'n1', app: 'a', pluginId: 'p', status: 'offered' });
    repo.create({ nodeId: 'n1', app: 'a', pluginId: 'p', status: 'running' });
    repo.create({ nodeId: 'n1', app: 'a', pluginId: 'p', status: 'stopped' });
    repo.create({ nodeId: 'n2', app: 'a', pluginId: 'p', status: 'running' });

    expect(repo.pendingOrOfferedByNode('n1').length).toBe(2);
    expect(repo.activeByNode('n1').length).toBe(2); // offered + running
    expect(repo.activeCountByNode('n1')).toBe(2);
    expect(repo.activeCountByNode('n2')).toBe(1);
  });

  it('lists all / by app', () => {
    repo.create({ nodeId: 'n1', app: 'alpha', pluginId: 'p', status: 'pending' });
    repo.create({ nodeId: 'n1', app: 'beta', pluginId: 'p', status: 'pending' });
    expect(repo.list().length).toBe(2);
    expect(repo.list('alpha').length).toBe(1);
    expect(repo.list('alpha')[0].app).toBe('alpha');
  });

  it('get returns null for an unknown id; updateStatus on unknown is a no-op', () => {
    expect(repo.get('nope')).toBeNull();
    expect(() => repo.updateStatus('nope', 'running')).not.toThrow();
  });
});
