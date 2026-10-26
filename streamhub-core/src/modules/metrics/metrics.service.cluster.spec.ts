/**
 * Integration — MetricsService cluster gauges end to end: a real migrated DB with
 * node rows (incl. a garbage stats_json) + edge_assignments, scraped through the
 * public `scrape()` so the wiring (labels, reset, defensive parse) is exercised,
 * not just the pure collectors.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { EdgeAssignmentsRepository } from '../edge/edge-assignments.repository';
import { MetricsService } from './metrics.service';

function insertNode(
  ctx: UnitContext,
  id: string,
  type: 'edge' | 'common',
  status: string,
  ageSeconds: number,
  statsJson: string | null,
): void {
  ctx.db
    .global()
    .prepare(
      'INSERT INTO nodes (id, name, type, weight, status, last_seen_at, stats_json) ' +
        "VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?)",
    )
    .run(id, id, type, type === 'edge' ? 200 : 100, status, `-${ageSeconds} seconds`, statsJson);
}

describe('metrics/MetricsService — cluster gauges (scrape)', () => {
  let ctx: UnitContext;
  afterEach(() => ctx.cleanup());

  it('exports per-node + assignment gauges, and never throws on a garbage blob', async () => {
    ctx = makeUnitContext();
    const gpuStats = JSON.stringify({
      cpu: 0.25,
      memUsedRatio: 0.6,
      disk: { usedRatio: 0.4 },
      grid: { gpu: true, vramFreeMb: 20000 },
    });
    insertNode(ctx, 'edge-gpu', 'edge', 'active', 10, gpuStats); // up + eligible + gpu
    insertNode(ctx, 'edge-dead', 'edge', 'active', 600, null); // stale → down
    insertNode(ctx, 'edge-garbage', 'edge', 'draining', 5, '<<not json>>'); // fresh but not active

    const repo = new EdgeAssignmentsRepository(ctx.db);
    repo.create({ nodeId: '', app: 'live', pluginId: 'yolo', status: 'pending' });
    repo.create({ nodeId: 'edge-gpu', app: 'live', pluginId: 'yolo', status: 'running' });

    const metrics = new MetricsService(ctx.config, ctx.db);
    let out = '';
    await expect((async () => (out = await metrics.scrape()))()).resolves.toBeDefined();

    // Per-node liveness + resources.
    expect(out).toMatch(/streamhub_cluster_node_up\{node="edge-gpu",type="edge"\} 1/);
    expect(out).toMatch(/streamhub_cluster_node_up\{node="edge-dead",type="edge"\} 0/);
    expect(out).toMatch(/streamhub_cluster_node_cpu_ratio\{node="edge-gpu"\} 0\.25/);
    expect(out).toMatch(/streamhub_cluster_node_gpu\{node="edge-gpu"\} 1/);
    expect(out).toMatch(/streamhub_cluster_node_vram_free_mb\{node="edge-gpu"\} 20000/);
    expect(out).toMatch(/streamhub_cluster_node_weight\{node="edge-gpu"\} 200/);
    // Garbage blob → node still up (from last_seen), just no resource series / gpu 0.
    expect(out).toMatch(/streamhub_cluster_node_up\{node="edge-garbage",type="edge"\} 1/);
    expect(out).toMatch(/streamhub_cluster_node_gpu\{node="edge-garbage"\} 0/);

    // Scheduler state: one pending, one running; only edge-gpu is eligible (up+active).
    expect(out).toMatch(/streamhub_edge_assignments\{status="pending"\} 1/);
    expect(out).toMatch(/streamhub_edge_assignments\{status="running"\} 1/);
    expect(out).toMatch(/streamhub_edge_pending_assignments 1/);
    expect(out).toMatch(/streamhub_edge_eligible_nodes\{gpu="true"\} 1/);
    expect(out).toMatch(/streamhub_edge_eligible_nodes\{gpu="false"\} 0/);
  });

  it('reports zero pending when nothing is parked', async () => {
    ctx = makeUnitContext();
    const metrics = new MetricsService(ctx.config, ctx.db);
    const out = await metrics.scrape();
    expect(out).toMatch(/streamhub_edge_pending_assignments 0/);
  });
});
