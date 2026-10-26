/**
 * VISION EDGE — pure scheduler logic (no Nest, no I/O, fully unit-testable).
 *
 * The thin {@link EdgeSchedulerService} builds a {@link SchedulerNode} view of
 * the cluster (from the `nodes` table + the live WS connections + the current
 * assignment load) and hands it to these pure functions. Everything here is a
 * deterministic function of its inputs so the placement/capacity/failover
 * invariants can be locked down without a DB or a socket.
 *
 * GRID reuse: node ELIGIBILITY by hardware requirements (gpu / minVramGb /
 * capabilities) is delegated to `matchGridNode` from plugins/plugin-grid.service
 * — the same matcher the local GRID dispatch uses — so the two planes agree on
 * what "eligible" means. We only add the two things GRID doesn't model: a VRAM
 * capacity guard (how many streams a node can still take) and the RR/weighted
 * distribution policies.
 */
import type { PluginGridRequirements } from '../plugins/plugin.contract';
import {
  matchGridNode,
  type GridNodeView,
} from '../plugins/plugin-grid.service';
import type { EdgeGridCaps, SchedulerPolicy } from './edge.types';

/** VRAM held back per node before we count capacity (V1 formula). */
export const VRAM_RESERVE_MB = 500;
/** VRAM budget assumed per placed stream (V1 formula). */
export const VRAM_PER_STREAM_MB = 200;

/** A node as the scheduler sees it — registry identity + live state + load. */
export interface SchedulerNode {
  id: string;
  name: string;
  region: string | null;
  /** `edge` (worker node) or `common` (full media node). */
  type: 'edge' | 'common';
  /** Relative weight for the `weighted` policy (share ∝ weight/Σweights). */
  weight: number;
  /** Operator status (`active` is placeable; `draining`/`disabled` are not). */
  status: string;
  /**
   * Whether the node is usable RIGHT NOW: a live WS connection past any
   * failback grace. The service folds the flap/failback logic into this flag so
   * the pure layer stays about hardware + policy.
   */
  connected: boolean;
  /** Advertised GPU capabilities, or null for a CPU-only node. */
  grid: EdgeGridCaps | null;
  /** Assignments currently offered/running on this node (capacity numerator). */
  load: number;
}

/** Options that shape a placement decision. */
export interface PlaceOptions {
  policy: SchedulerPolicy;
  /** Hardware requirements the assignment declares (GRID-style). */
  req?: PluginGridRequirements;
  /** Allow `common` (full media) nodes to receive work, not just `edge`. */
  allowCommon?: boolean;
  /** Round-robin cursor (monotonic; the caller persists the returned value). */
  cursor?: number;
  /** Random source for the `weighted` policy (injectable for tests). */
  rand?: () => number;
}

/** Result of a placement: the chosen node id (or null) + the advanced cursor. */
export interface PlaceResult {
  nodeId: string | null;
  cursor: number;
}

/**
 * How many MORE streams a node can take given its advertised free VRAM.
 * A CPU-only node (no grid block, or no free-VRAM figure) is unbounded here —
 * the requirements filter already excludes it from GPU work.
 */
export function vramMaxStreams(node: SchedulerNode): number {
  const free = node.grid?.vramFreeMb;
  if (free == null) return Number.POSITIVE_INFINITY;
  return Math.floor((free - VRAM_RESERVE_MB) / VRAM_PER_STREAM_MB);
}

/** True when the node still has VRAM headroom for one more stream. */
export function hasCapacity(node: SchedulerNode): boolean {
  return node.load < vramMaxStreams(node);
}

/** Project a scheduler node onto the GRID matcher's node view. */
function toGridView(node: SchedulerNode): GridNodeView {
  return {
    id: node.id,
    name: node.name,
    url: null,
    region: node.region,
    gpu: node.grid?.gpu === true,
    vramGb: node.grid?.vramGb ?? null,
    capabilities: node.grid?.capabilities ?? [],
  };
}

/**
 * Whether a node satisfies an assignment's hardware requirements — delegated to
 * the shared GRID matcher so both planes agree (gpu / minVramGb / capabilities
 * are hard filters; regions are a soft preference the matcher ignores here).
 */
export function passesRequirements(
  node: SchedulerNode,
  req?: PluginGridRequirements,
): boolean {
  return matchGridNode([toGridView(node)], req) !== null;
}

/**
 * Every node that could take this assignment: connected + operator-active +
 * of an allowed type + meeting the hardware requirements + with VRAM headroom.
 * Returned sorted by id for deterministic policy behaviour.
 */
export function eligibleNodes(
  nodes: SchedulerNode[],
  opts: { req?: PluginGridRequirements; allowCommon?: boolean },
): SchedulerNode[] {
  return nodes
    .filter((n) => n.connected)
    .filter((n) => n.status === 'active')
    .filter((n) => n.type === 'edge' || (opts.allowCommon === true && n.type === 'common'))
    .filter((n) => passesRequirements(n, opts.req))
    .filter((n) => hasCapacity(n))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Round-robin pick over the (already sorted) eligible set. */
export function pickRoundRobin(
  eligible: SchedulerNode[],
  cursor: number,
): PlaceResult {
  if (eligible.length === 0) return { nodeId: null, cursor };
  const idx = ((cursor % eligible.length) + eligible.length) % eligible.length;
  return { nodeId: eligible[idx].id, cursor: cursor + 1 };
}

/**
 * Weighted pick: a node's chance ∝ its weight over the eligible set. Non-positive
 * weights are treated as 0; if every weight is 0 it degrades to a uniform pick.
 * `rand` returns [0,1) (defaults to Math.random) — inject it for deterministic
 * tests.
 */
export function pickWeighted(
  eligible: SchedulerNode[],
  rand: () => number = Math.random,
): string | null {
  if (eligible.length === 0) return null;
  const weights = eligible.map((n) => (n.weight > 0 ? n.weight : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return eligible[Math.floor(rand() * eligible.length) % eligible.length].id;
  }
  let r = rand() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i];
    if (r < 0) return eligible[i].id;
  }
  return eligible[eligible.length - 1].id;
}

/** Place one assignment onto a node per the policy, or null when none fit. */
export function place(nodes: SchedulerNode[], opts: PlaceOptions): PlaceResult {
  const cursor = opts.cursor ?? 0;
  const eligible = eligibleNodes(nodes, {
    req: opts.req,
    allowCommon: opts.allowCommon,
  });
  if (eligible.length === 0) return { nodeId: null, cursor };
  if (opts.policy === 'weighted') {
    return { nodeId: pickWeighted(eligible, opts.rand), cursor };
  }
  return pickRoundRobin(eligible, cursor);
}

/** One entry of a failover plan: where an orphaned assignment should move. */
export interface FailoverMove {
  assignmentId: string;
  /** Target node id, or null when nothing is eligible (assignment → pending). */
  toNodeId: string | null;
}

/** A failover plan plus the advanced round-robin cursor. */
export interface FailoverPlan {
  moves: FailoverMove[];
  cursor: number;
}

/**
 * Spread a down node's orphaned assignments across the remaining eligible nodes.
 * Pure: the down node is simply absent (or `connected:false`) in `nodes`. Each
 * placement increments a working copy of the chosen node's load so the moves
 * spread instead of piling onto one node, and honours the VRAM capacity guard.
 */
export function planFailover(
  assignmentIds: string[],
  nodes: SchedulerNode[],
  opts: PlaceOptions,
): FailoverPlan {
  const work: SchedulerNode[] = nodes.map((n) => ({ ...n }));
  let cursor = opts.cursor ?? 0;
  const moves: FailoverMove[] = [];
  for (const assignmentId of assignmentIds) {
    const res = place(work, { ...opts, cursor });
    cursor = res.cursor;
    if (res.nodeId) {
      const target = work.find((n) => n.id === res.nodeId);
      if (target) target.load += 1;
    }
    moves.push({ assignmentId, toNodeId: res.nodeId });
  }
  return { moves, cursor };
}
