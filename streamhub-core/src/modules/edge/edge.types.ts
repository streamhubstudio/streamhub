/**
 * VISION EDGE — shared domain types (leaf module, no imports).
 *
 * Kept dependency-free so the pure scheduler logic, the assignment repository,
 * the wire protocol helpers and the Nest services can all import these shapes
 * without creating an import cycle.
 */

/**
 * Lifecycle of one edge assignment (a worker workload placed on one node):
 *
 *   pending  — created but no eligible node yet; parked until one connects.
 *   offered  — pushed to a node over the WS channel, awaiting its ack.
 *   running  — the node reported the worker is up (`assignment_status`).
 *   stopped  — the worker exited cleanly (node-reported or operator revoke ack).
 *   failed   — the worker crashed / could not start (node-reported).
 *   revoked  — the operator deleted the assignment.
 */
export type EdgeAssignmentStatus =
  | 'pending'
  | 'offered'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'revoked';

/** Scheduler placement policy (per-assignment or the instance default). */
export type SchedulerPolicy = 'round_robin' | 'weighted';

/** A fully-resolved spawn spec the edge runtime executes for an assignment. */
export interface EdgeSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * APP VERSIONING — a pinned bundle reference carried on an `assign` frame when
 * the assignment's install pins a specific appstore version. The edge runtime
 * (Wave 3) fetches `url` over the cluster gate, VERIFIES `sha256`, caches +
 * extracts it under `~/.streamhub/appstore/<pluginId>/<version>/`, and spawns
 * from there instead of the frame's `spawn.cwd`/PYTHONPATH. OPTIONAL +
 * backward-compatible: absent → the runtime spawns from the built-in source as
 * today (an older runtime simply ignores the field).
 */
export interface EdgeBundleRef {
  pluginId: string;
  version: string;
  /** Hex SHA-256 the node must verify the fetched bundle against. */
  sha256: string;
  /** Master bundle endpoint: GET /api/v1/plugins/:id/versions/:v/bundle. */
  url: string;
}

/**
 * One row of the global `edge_assignments` table, enriched for callers:
 * `config` is the parsed user config (the raw `config_json` column) and the
 * spawn spec is resolved on the wire, never stored.
 */
export interface EdgeAssignment {
  id: string;
  nodeId: string;
  app: string;
  pluginId: string;
  streamId: string | null;
  config: Record<string, unknown>;
  status: EdgeAssignmentStatus;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * GPU capability block a node advertises inside its telemetry/heartbeat
 * `stats.grid` (mirrors the GRID convention in plugins/plugin-grid.service).
 * `vramFreeMb` drives the scheduler's VRAM capacity guard.
 */
export interface EdgeGridCaps {
  gpu: boolean;
  vramGb: number | null;
  vramFreeMb: number | null;
  gpuName: string | null;
  capabilities: string[];
}
