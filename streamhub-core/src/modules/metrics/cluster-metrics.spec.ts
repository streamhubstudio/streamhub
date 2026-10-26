/**
 * Unit — metrics/cluster-metrics (pure projection of nodes + edge_assignments).
 *
 * Locks the invariants the exporter relies on: liveness by heartbeat age, GPU/
 * VRAM/cpu/mem/disk extraction from the telemetry blob, GPU-split eligibility,
 * assignment tallying — and, above all, that a GARBAGE `stats_json` never throws
 * (it is an operator/edge-fed blob) but degrades to null/absent fields.
 */
import {
  assignmentCounts,
  eligibleCounts,
  nodeMetrics,
  nodeUp,
  parseStatsBlob,
  type NodeMetrics,
  type RawClusterNodeRow,
} from './cluster-metrics';

const NOW = Date.parse('2026-07-11T12:00:00Z');

/** A telemetry blob shaped like the edge runtime's collect_stats output. */
function fullStats(): string {
  return JSON.stringify({
    role: 'edge',
    cores: 8,
    loadavg1: 2,
    cpu: 0.25,
    memTotal: 16_000,
    memFree: 4_000,
    memUsedRatio: 0.75,
    disk: { total: 100, free: 20, usedRatio: 0.8 },
    grid: { gpu: true, vramGb: 24, vramFreeMb: 20_000, gpuName: 'T4', capabilities: ['vision'] },
  });
}

function row(over: Partial<RawClusterNodeRow> = {}): RawClusterNodeRow {
  return {
    name: 'edge-1',
    type: 'edge',
    weight: 100,
    status: 'active',
    last_seen_at: '2026-07-11 11:59:30',
    stats_json: fullStats(),
    ...over,
  };
}

describe('metrics/cluster-metrics — parseStatsBlob', () => {
  it('parses an object blob; rejects arrays/garbage/empty → null', () => {
    expect(parseStatsBlob('{"a":1}')).toEqual({ a: 1 });
    expect(parseStatsBlob('[1,2,3]')).toBeNull();
    expect(parseStatsBlob('not json {{{')).toBeNull();
    expect(parseStatsBlob('')).toBeNull();
    expect(parseStatsBlob(null)).toBeNull();
    expect(parseStatsBlob('42')).toBeNull();
  });
});

describe('metrics/cluster-metrics — nodeUp', () => {
  it('is up within the 90s window and down past it (UTC parse of SQLite ts)', () => {
    expect(nodeUp('2026-07-11 11:59:30', NOW)).toBe(true); // 30s ago
    expect(nodeUp('2026-07-11 11:58:00', NOW)).toBe(false); // 120s ago
    expect(nodeUp(null, NOW)).toBe(false);
    expect(nodeUp('garbage', NOW)).toBe(false);
  });
});

describe('metrics/cluster-metrics — nodeMetrics', () => {
  it('extracts every field from a full telemetry blob', () => {
    const m = nodeMetrics(row(), NOW);
    expect(m).toMatchObject({
      node: 'edge-1',
      type: 'edge',
      up: 1,
      cpuRatio: 0.25,
      memUsedRatio: 0.75,
      diskUsedRatio: 0.8,
      gpu: 1,
      vramFreeMb: 20_000,
      weight: 100,
      active: true,
    });
  });

  it('NEVER throws on a garbage stats_json — degrades to null fields, gpu 0', () => {
    const m = nodeMetrics(row({ stats_json: '<<not json>>' }), NOW);
    expect(m.cpuRatio).toBeNull();
    expect(m.memUsedRatio).toBeNull();
    expect(m.diskUsedRatio).toBeNull();
    expect(m.vramFreeMb).toBeNull();
    expect(m.gpu).toBe(0);
    expect(m.up).toBe(1); // liveness comes from last_seen_at, not the blob
  });

  it('tolerates partial blobs (grid/disk missing, non-number values)', () => {
    const m = nodeMetrics(
      row({ stats_json: JSON.stringify({ cpu: 'high', grid: [1, 2], disk: null }) }),
      NOW,
    );
    expect(m.cpuRatio).toBeNull(); // non-number
    expect(m.gpu).toBe(0); // grid is an array → ignored
    expect(m.diskUsedRatio).toBeNull();
    expect(m.vramFreeMb).toBeNull();
  });

  it('defaults weight to 100 and normalizes an unknown type to common', () => {
    const m = nodeMetrics(row({ weight: null, type: 'origin' }), NOW);
    expect(m.weight).toBe(100);
    expect(m.type).toBe('common');
  });

  it('marks a node down when its heartbeat is stale', () => {
    const m = nodeMetrics(row({ last_seen_at: '2026-07-11 11:00:00' }), NOW);
    expect(m.up).toBe(0);
  });
});

describe('metrics/cluster-metrics — eligibleCounts', () => {
  function m(over: Partial<NodeMetrics>): NodeMetrics {
    return {
      node: 'n',
      type: 'edge',
      up: 1,
      cpuRatio: null,
      memUsedRatio: null,
      diskUsedRatio: null,
      gpu: 0,
      vramFreeMb: null,
      weight: 100,
      active: true,
      ...over,
    };
  }

  it('counts up+active edge nodes split by GPU; excludes down/inactive', () => {
    const nodes = [
      m({ node: 'g1', gpu: 1 }),
      m({ node: 'c1', gpu: 0 }),
      m({ node: 'down', up: 0, gpu: 1 }),
      m({ node: 'drain', active: false, gpu: 1 }),
    ];
    expect(eligibleCounts(nodes, false)).toEqual({ gpuTrue: 1, gpuFalse: 1 });
  });

  it('excludes common nodes unless allowCommon is on', () => {
    const nodes = [m({ node: 'c', type: 'common', gpu: 1 })];
    expect(eligibleCounts(nodes, false)).toEqual({ gpuTrue: 0, gpuFalse: 0 });
    expect(eligibleCounts(nodes, true)).toEqual({ gpuTrue: 1, gpuFalse: 0 });
  });
});

describe('metrics/cluster-metrics — assignmentCounts', () => {
  it('tallies by status and surfaces the pending scalar', () => {
    const counts = assignmentCounts([
      { status: 'pending' },
      { status: 'pending' },
      { status: 'running' },
      { status: 'offered' },
      { status: null },
    ]);
    expect(counts.byStatus).toEqual({ pending: 2, running: 1, offered: 1, unknown: 1 });
    expect(counts.pending).toBe(2);
  });

  it('reports zero pending when there are none', () => {
    expect(assignmentCounts([{ status: 'running' }]).pending).toBe(0);
    expect(assignmentCounts([]).pending).toBe(0);
  });
});
