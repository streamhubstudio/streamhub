/**
 * CLUSTER metrics — pure, defensive projection of the master's `nodes` +
 * `edge_assignments` tables onto the Prometheus gauges exported by
 * {@link MetricsService}. No Nest, no I/O, no throws.
 *
 * Edge nodes sit behind NAT and cannot be scraped directly, so the master is
 * the ONLY place their telemetry lives (it is persisted to `nodes.stats_json`
 * on every heartbeat / WS telemetry frame). These helpers turn that per-node
 * blob into numbers Prometheus can read off the master's own /metrics.
 *
 * `stats_json` is an operator/edge-fed blob (≤4KB) — every field is parsed
 * defensively (a missing/garbage value degrades to `null`, never an exception),
 * mirroring the same tolerance the scheduler (`parseGrid`) and the cluster
 * service (`parseStats`) already apply to the exact same blob.
 */

/**
 * Node liveness threshold. A node is "up" when its last heartbeat is within this
 * window — the SAME rule the cluster service derives `stale` from
 * (`NODE_STALE_AFTER_SECONDS = 90`) and the watchdog uses for liveness
 * (`NODE_STALE_AFTER_MS = 90_000`). WS telemetry and HTTP heartbeats both bump
 * `last_seen_at`, so heartbeat age reflects WS liveness too.
 */
export const NODE_UP_WITHIN_MS = 90_000;

/** Raw `nodes` row this projection reads (subset of the table). */
export interface RawClusterNodeRow {
  name: string;
  type: string | null;
  weight: number | null;
  status: string;
  last_seen_at: string | null;
  stats_json: string | null;
}

/** The per-node numbers the exporter publishes as labelled gauges. */
export interface NodeMetrics {
  /** `node` label — the registry node name. */
  node: string;
  /** `type` label — normalized to the two kinds the scheduler distinguishes. */
  type: 'edge' | 'common';
  /** 1 when the last heartbeat is within {@link NODE_UP_WITHIN_MS}, else 0. */
  up: number;
  /** load1/cores ratio, or null when telemetry has not reported it. */
  cpuRatio: number | null;
  memUsedRatio: number | null;
  diskUsedRatio: number | null;
  /** 1 when the node advertises a usable GPU, else 0. */
  gpu: number;
  vramFreeMb: number | null;
  weight: number;
  /** Operator status is `active` (placeable) — drives the eligibility gauge. */
  active: boolean;
}

/** Parse a stored stats blob into an object; corrupt/absent/array → null. */
export function parseStatsBlob(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** SQLite `datetime('now')` is UTC without a zone marker — parse as UTC. */
export function nodeUp(lastSeenAt: string | null, nowMs: number): boolean {
  if (!lastSeenAt) return false;
  const t = Date.parse(lastSeenAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return false;
  return nowMs - t <= NODE_UP_WITHIN_MS;
}

/** A finite number, or null (guards against NaN/Infinity/non-number blobs). */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Project one raw node row onto its metrics. Never throws. */
export function nodeMetrics(row: RawClusterNodeRow, nowMs: number): NodeMetrics {
  const stats = parseStatsBlob(row.stats_json) ?? {};
  const grid =
    stats.grid && typeof stats.grid === 'object' && !Array.isArray(stats.grid)
      ? (stats.grid as Record<string, unknown>)
      : {};
  const disk =
    stats.disk && typeof stats.disk === 'object' && !Array.isArray(stats.disk)
      ? (stats.disk as Record<string, unknown>)
      : {};
  return {
    node: row.name,
    type: row.type === 'edge' ? 'edge' : 'common',
    up: nodeUp(row.last_seen_at, nowMs) ? 1 : 0,
    cpuRatio: num(stats.cpu),
    memUsedRatio: num(stats.memUsedRatio),
    diskUsedRatio: num(disk.usedRatio),
    gpu: grid.gpu === true ? 1 : 0,
    vramFreeMb: num(grid.vramFreeMb),
    weight: num(row.weight) ?? 100,
    active: row.status === 'active',
  };
}

/** GPU-split count of nodes the scheduler could currently place work on. */
export interface EligibleCounts {
  /** Up + active + placeable-type nodes that advertise a GPU. */
  gpuTrue: number;
  /** Up + active + placeable-type nodes without a GPU. */
  gpuFalse: number;
}

/**
 * Master-side APPROXIMATION of the scheduler's eligible set (it cannot see live
 * WS state or per-assignment requirements from here): a node counts when it is
 * up, operator-`active`, and of a placeable type — `edge`, or `common` when
 * `allowCommon` is on (mirrors `STREAMHUB_EDGE_ALLOW_COMMON`). Split by whether
 * it advertises a GPU so the "no GPU capacity" alert can read `{gpu="true"}==0`.
 */
export function eligibleCounts(
  nodes: NodeMetrics[],
  allowCommon: boolean,
): EligibleCounts {
  let gpuTrue = 0;
  let gpuFalse = 0;
  for (const n of nodes) {
    if (n.up !== 1 || !n.active) continue;
    if (n.type !== 'edge' && !(allowCommon && n.type === 'common')) continue;
    if (n.gpu === 1) gpuTrue += 1;
    else gpuFalse += 1;
  }
  return { gpuTrue, gpuFalse };
}

/** Assignment counts grouped by status, plus the pending scalar. */
export interface AssignmentCounts {
  byStatus: Record<string, number>;
  pending: number;
}

/** Tally `edge_assignments` rows by status. Unknown/blank status → 'unknown'. */
export function assignmentCounts(
  rows: readonly { status: string | null }[],
): AssignmentCounts {
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    const s = r.status || 'unknown';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return { byStatus, pending: byStatus.pending ?? 0 };
}
