/**
 * VISION EDGE — WS wire protocol (frames + pure helpers).
 *
 * The edge control channel is a single held WebSocket at {@link EDGE_WS_PATH}
 * that carries JSON frames BOTH ways (see internal design notes §A):
 *
 *   edge → master : register · telemetry · assignment_status · cmd_result ·
 *                   log_tail_result · pong
 *   master → edge : assign · revoke · cmd · log_tail · ping
 *
 * These helpers keep the frame shapes + the (Wave-2) spawn-resolution seam in
 * one dependency-light place so the gateway and the scheduler build identical
 * `assign` frames (the gateway re-offers on reconnect; the scheduler on placement).
 */
import type { EdgeAssignment, EdgeBundleRef, EdgeSpawnSpec } from './edge.types';

/** Path of the edge control WebSocket on the core's HTTP server. */
export const EDGE_WS_PATH = '/api/v1/edge/ws';

/** Server → edge keepalive ping cadence. */
export const EDGE_PING_INTERVAL_MS = 15_000;
/** Missed pongs tolerated before the connection is considered dead. */
export const EDGE_MAX_MISSED_PONGS = 3;

/** Payload of an `assign` frame (a resolved workload for the edge runtime). */
export interface AssignFramePayload {
  id: string;
  app: string;
  pluginId: string;
  streamId: string | null;
  config: Record<string, unknown>;
  spawn: EdgeSpawnSpec;
  /**
   * APP VERSIONING (optional) — present ONLY when the assignment's install pins
   * an appstore version. The node fetches + verifies + extracts this bundle and
   * spawns from it. Absent → spawn from the built-in source (back-compat: an
   * older runtime ignores the field). See {@link EdgeBundleRef}.
   */
  bundle?: EdgeBundleRef;
}

/**
 * A pluggable spawn resolver — the seam's implementation surface. The in-core
 * `modules/edge` registers the {@link GenericSpawnResolver} (via
 * {@link setSpawnResolver}) that resolves EVERY edge-capable pluginId through its
 * own `worker.spawn(ctx)` (remote ctx) with the framework STREAMHUB_* edge env
 * injected — no per-plugin special-case. Kept as a registrable seam so the
 * gateway + scheduler never change — they still call {@link toAssignFrame} →
 * {@link resolveSpawnSpec}, which consults whatever resolver is active.
 */
export interface SpawnResolver {
  resolve(
    app: string,
    pluginId: string,
    config: Record<string, unknown>,
  ): EdgeSpawnSpec;
  /**
   * APP VERSIONING (optional) — the pinned bundle ref for this (app, plugin)
   * install, or null when it runs the built-in/latest. OPTIONAL on the seam so
   * the foundation default + existing fake resolvers (which don't implement it)
   * keep working; when absent, no `bundle` is attached to the frame.
   */
  resolveBundle?(app: string, pluginId: string): EdgeBundleRef | null;
}

/** The active resolver, or null (foundation default → empty spec). */
let activeResolver: SpawnResolver | null = null;

/**
 * Register (or clear, with `null`) the active spawn resolver. Idempotent; the
 * vision module sets it on init and clears it on destroy. Exported so a spec can
 * install a fake resolver and assert the frame it produces.
 */
export function setSpawnResolver(resolver: SpawnResolver | null): void {
  activeResolver = resolver;
}

/**
 * Resolve the spawn spec an edge runs for an assignment.
 *
 * WAVE-2 SEAM. When a resolver is registered ({@link setSpawnResolver}) it owns
 * the decision: the vision resolver builds `vision`'s spec and delegates all
 * other pluginIds to their `worker.spawn(ctx)`. With NO resolver (the Wave-1
 * foundation, and every edge/gateway/scheduler unit spec) it returns an EMPTY
 * spec — the channel, scheduler, watchdog and REST surface stay exercisable
 * without the plugin manager, and an assign frame still carries everything the
 * runtime needs (app / pluginId / config) to look the worker up itself.
 * Never throws: a resolver error falls back to the empty spec.
 */
export function resolveSpawnSpec(
  app: string,
  pluginId: string,
  config: Record<string, unknown>,
): EdgeSpawnSpec {
  if (activeResolver) {
    try {
      return activeResolver.resolve(app, pluginId, config);
    } catch {
      /* a resolver failure must not break assignment framing */
    }
  }
  return { command: '', args: [], env: {} };
}

/**
 * Resolve the pinned bundle ref for an assignment, or null. Consults the active
 * resolver's optional `resolveBundle`; never throws (a failure → null, so the
 * frame simply carries no bundle and the node runs the built-in).
 */
export function resolveBundleRef(
  app: string,
  pluginId: string,
): EdgeBundleRef | null {
  if (activeResolver?.resolveBundle) {
    try {
      return activeResolver.resolveBundle(app, pluginId);
    } catch {
      /* a resolver failure must not break assignment framing */
    }
  }
  return null;
}

/** Build the `assign` frame for an assignment (same on placement + re-offer). */
export function toAssignFrame(a: EdgeAssignment): {
  type: 'assign';
  assignment: AssignFramePayload;
} {
  const bundle = resolveBundleRef(a.app, a.pluginId);
  return {
    type: 'assign',
    assignment: {
      id: a.id,
      app: a.app,
      pluginId: a.pluginId,
      streamId: a.streamId,
      config: a.config,
      spawn: resolveSpawnSpec(a.app, a.pluginId, a.config),
      // Only carried for a pinned install (back-compat: omitted otherwise).
      ...(bundle ? { bundle } : {}),
    },
  };
}

/** A parsed inbound frame: `type` plus its arbitrary fields. */
export type InboundFrame = { type: string } & Record<string, unknown>;

/**
 * Parse a raw WS message into a typed-ish frame, or null when it is not a JSON
 * object with a string `type`. Never throws (bad frames are dropped).
 */
export function parseFrame(data: unknown): InboundFrame | null {
  try {
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data);
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const type = (obj as { type?: unknown }).type;
    if (typeof type !== 'string' || type.length === 0) return null;
    return obj as InboundFrame;
  } catch {
    return null;
  }
}

/** Read a string field off a frame (undefined when absent/not a string). */
export function frameStr(f: InboundFrame, key: string): string | undefined {
  const v = f[key];
  return typeof v === 'string' ? v : undefined;
}
