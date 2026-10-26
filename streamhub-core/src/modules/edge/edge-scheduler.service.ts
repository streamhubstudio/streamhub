import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
  Optional,
} from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { LOGS_SERVICE, LogsServiceContract } from '../../shared/contracts';
import type { PluginGridRequirements } from '../plugins/plugin.contract';
import { EdgeAssignmentsRepository } from './edge-assignments.repository';
import { EdgeCapacityAlerter } from './edge-capacity-alerter';
import { EdgeGateway } from './edge.gateway';
import {
  place,
  planFailover,
  type SchedulerNode,
} from './edge-scheduler.logic';
import { toAssignFrame } from './edge.protocol';
import type { EdgeAssignment, EdgeGridCaps, SchedulerPolicy } from './edge.types';

/** Grace (ms) a returning node waits after a flap before it is placeable again. */
export const FAILBACK_GRACE_MS = 60_000;

/** Input to schedule a new assignment. */
export interface ScheduleInput {
  app: string;
  pluginId: string;
  streamId?: string | null;
  config?: Record<string, unknown>;
  /** Override the instance default policy for this placement. */
  policy?: SchedulerPolicy;
  /** Hardware requirements (GRID-style) the workload declares. */
  req?: PluginGridRequirements;
}

/** Raw `nodes` row the scheduler reads. */
interface NodeStatsRow {
  id: string;
  name: string;
  region: string | null;
  type: string | null;
  weight: number | null;
  status: string;
  stats_json: string | null;
}

/**
 * VISION EDGE scheduler — thin service around the pure placement logic
 * (edge-scheduler.logic). Builds the {@link SchedulerNode} view of the cluster
 * from the `nodes` table + the live WS connections ({@link EdgeGateway}) + the
 * current assignment load ({@link EdgeAssignmentsRepository}), then delegates the
 * decision to the pure functions. Failover is triggered by the watchdog on a
 * node that has been WS-down beyond the grace.
 */
@Injectable()
export class EdgeSchedulerService implements OnModuleInit, OnModuleDestroy {
  /** How often unplaced (pending) assignments are re-tried against the cluster. */
  private static readonly RETRY_PENDING_MS = 30_000;
  private retryTimer?: ReturnType<typeof setInterval>;

  onModuleInit(): void {
    // A pending assignment parks when nothing is eligible AT CREATE TIME (no
    // node yet, failback grace, capacity). Nothing re-fires those on its own —
    // found live: a healthy edge past its grace sat next to a forever-pending
    // assignment. This loop is the reconcile.
    this.retryTimer = setInterval(
      () => this.retryPending(),
      EdgeSchedulerService.RETRY_PENDING_MS,
    );
    this.retryTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  /** Re-place every unplaced pending assignment; offer what now fits. */
  retryPending(): number {
    let placed = 0;
    let stillPending = 0;
    try {
      for (const a of this.assignments.pendingUnplaced()) {
        const nodes = this.nodeViews();
        const { nodeId, cursor } = place(nodes, {
          policy: this.defaultPolicy(),
          allowCommon: this.allowCommon(),
          cursor: this.rrCursor,
          rand: Math.random,
        });
        this.rrCursor = cursor;
        if (!nodeId) {
          stillPending += 1;
          continue;
        }
        this.assignments.reassign(a.id, nodeId, 'offered');
        const pushed = this.gateway.send(nodeId, toAssignFrame({ ...a, nodeId }));
        if (pushed) {
          placed += 1;
          this.logEvent('info', `re-offered ${a.app}/${a.pluginId} → ${nodeId}`, {
            assignmentId: a.id,
            app: a.app,
            pluginId: a.pluginId,
            nodeId,
          });
        } else {
          this.assignments.updateStatus(a.id, 'pending', 'push failed');
          stillPending += 1;
        }
      }
    } catch {
      /* reconcile is best-effort; next tick retries */
    }
    // Work is still parked with nothing to take it — one rate-limited alert so
    // the 30s retry loop never spams (the alerter cools down for 300s).
    if (stillPending > 0) {
      this.capacity?.alert('no-eligible-node', { pending: stillPending });
    }
    return placed;
  }
  private readonly logger = new Logger(EdgeSchedulerService.name);
  /** Monotonic round-robin cursor (persisted across placements in-memory). */
  private rrCursor = 0;

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly gateway: EdgeGateway,
    private readonly assignments: EdgeAssignmentsRepository,
    // Optional so bare unit specs (`new EdgeSchedulerService(db, cfg, gw, repo)`)
    // keep working; wired in production via EdgeModule.
    @Optional() private readonly capacity?: EdgeCapacityAlerter,
    @Optional()
    @Inject(LOGS_SERVICE)
    private readonly logs?: LogsServiceContract,
  ) {}

  /**
   * Schedule a new assignment: pick a node per the policy, persist the row
   * (offered when placed, pending when nothing is eligible), and push the
   * `assign` frame over the WS channel. Returns the created assignment.
   */
  schedule(input: ScheduleInput): EdgeAssignment {
    const policy = input.policy ?? this.defaultPolicy();
    const nodes = this.nodeViews();
    const { nodeId, cursor } = place(nodes, {
      policy,
      req: input.req,
      allowCommon: this.allowCommon(),
      cursor: this.rrCursor,
      rand: Math.random,
    });
    this.rrCursor = cursor;

    const assignment = this.assignments.create({
      nodeId: nodeId ?? '',
      app: input.app,
      pluginId: input.pluginId,
      streamId: input.streamId ?? null,
      config: input.config ?? {},
      status: nodeId ? 'offered' : 'pending',
    });

    if (nodeId) {
      const pushed = this.gateway.send(nodeId, toAssignFrame(assignment));
      if (!pushed) {
        // Eligible node vanished between selection and push — park it.
        this.assignments.updateStatus(assignment.id, 'pending', 'push failed');
        assignment.status = 'pending';
      }
      this.logger.log(
        `scheduled assignment ${assignment.id} (${input.app}/${input.pluginId}) ` +
          `→ ${nodeId} [${policy}]`,
      );
      this.logEvent('info', `scheduled ${input.app}/${input.pluginId} → ${nodeId}`, {
        assignmentId: assignment.id,
        app: input.app,
        pluginId: input.pluginId,
        nodeId,
        policy,
      });
    } else {
      this.logger.warn(
        `no eligible node for ${input.app}/${input.pluginId} — assignment ${assignment.id} pending`,
      );
      this.logEvent('warn', `no eligible node for ${input.app}/${input.pluginId}`, {
        assignmentId: assignment.id,
        app: input.app,
        pluginId: input.pluginId,
        policy,
      });
      this.capacity?.alert('no-eligible-node', {
        app: input.app,
        pluginId: input.pluginId,
      });
    }
    return this.assignments.get(assignment.id) ?? assignment;
  }

  /** Revoke an assignment: tell the owning node, then mark it revoked. */
  revoke(id: string): EdgeAssignment | null {
    const a = this.assignments.get(id);
    if (!a) return null;
    if (a.nodeId) this.gateway.revoke(a.nodeId, id);
    this.assignments.updateStatus(id, 'revoked');
    return this.assignments.get(id);
  }

  /**
   * A node is (considered) down: reassign its offered/running assignments across
   * the remaining eligible nodes (or park them pending). Called by the watchdog
   * once a node has been WS-disconnected past the failover grace.
   */
  handleNodeDown(nodeId: string): void {
    const orphaned = this.assignments.activeByNode(nodeId);
    if (orphaned.length === 0) return;

    const nodes = this.nodeViews();
    const { moves, cursor } = planFailover(
      orphaned.map((a) => a.id),
      nodes,
      {
        policy: this.defaultPolicy(),
        allowCommon: this.allowCommon(),
        cursor: this.rrCursor,
        rand: Math.random,
      },
    );
    this.rrCursor = cursor;

    let moved = 0;
    for (const { assignmentId, toNodeId } of moves) {
      if (toNodeId) {
        this.assignments.reassign(assignmentId, toNodeId, 'offered');
        const a = this.assignments.get(assignmentId);
        if (a && this.gateway.send(toNodeId, toAssignFrame(a))) moved += 1;
      } else {
        this.assignments.updateStatus(
          assignmentId,
          'pending',
          'no eligible node for failover',
        );
      }
    }
    const parked = orphaned.length - moved;
    this.logger.warn(
      `node ${nodeId} down — failed over ${orphaned.length} assignment(s) ` +
        `(${moved} placed, ${parked} parked)`,
    );
    this.logEvent('warn', `node ${nodeId} down — failover`, {
      nodeId,
      orphaned: orphaned.length,
      moved,
      parked,
    });
    // A GPU node fell and left no survivor for some of its work → no capacity.
    if (parked > 0) {
      this.capacity?.alert('failover-parked', { nodeId, parked });
    }
  }

  // ==========================================================================
  // internals
  // ==========================================================================

  /** Route a scheduler outcome to the central log (source `edge`). Never throws. */
  private logEvent(
    level: 'info' | 'warn',
    message: string,
    meta: Record<string, unknown>,
  ): void {
    try {
      this.logs?.write(level, 'edge', message, meta);
    } catch {
      /* central logging must never break a placement decision */
    }
  }

  /** Build the scheduler's view of every registered node. */
  nodeViews(): SchedulerNode[] {
    const rows = this.db
      .global()
      .prepare(
        'SELECT id, name, region, type, weight, status, stats_json FROM nodes',
      )
      .all() as NodeStatsRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      region: r.region,
      type: r.type === 'edge' ? 'edge' : 'common',
      weight: typeof r.weight === 'number' ? r.weight : 100,
      status: r.status,
      connected: this.eligibleConnected(r.id),
      grid: this.parseGrid(r.stats_json),
      load: this.assignments.activeCountByNode(r.id),
    }));
  }

  /**
   * Whether a node is connected AND past the failback grace. A node that flapped
   * (has a recorded disconnect) is held out for {@link FAILBACK_GRACE_MS} after
   * reconnecting so work doesn't bounce straight back; a node that never dropped
   * is placeable the moment it connects.
   */
  private eligibleConnected(nodeId: string): boolean {
    if (!this.gateway.isConnected(nodeId)) return false;
    const lastDrop = this.gateway.lastDisconnectAt(nodeId);
    if (lastDrop == null) return true; // never flapped → immediately eligible
    const since = this.gateway.connectedSince(nodeId);
    if (since == null) return false;
    return Date.now() - since >= FAILBACK_GRACE_MS;
  }

  /** Parse the advertised GPU `grid` block out of a node's stats blob. */
  private parseGrid(json: string | null): EdgeGridCaps | null {
    if (!json) return null;
    try {
      const stats = JSON.parse(json) as unknown;
      if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
      const grid = (stats as { grid?: unknown }).grid;
      if (!grid || typeof grid !== 'object' || Array.isArray(grid)) return null;
      const g = grid as Record<string, unknown>;
      return {
        gpu: g.gpu === true,
        vramGb: typeof g.vramGb === 'number' ? g.vramGb : null,
        vramFreeMb: typeof g.vramFreeMb === 'number' ? g.vramFreeMb : null,
        gpuName: typeof g.gpuName === 'string' ? g.gpuName : null,
        capabilities: Array.isArray(g.capabilities)
          ? g.capabilities.filter((c): c is string => typeof c === 'string')
          : [],
      };
    } catch {
      return null;
    }
  }

  /** Instance default policy (`STREAMHUB_EDGE_SCHEDULER_POLICY`, default RR). */
  private defaultPolicy(): SchedulerPolicy {
    return (this.config.env('STREAMHUB_EDGE_SCHEDULER_POLICY') ?? '')
      .trim()
      .toLowerCase() === 'weighted'
      ? 'weighted'
      : 'round_robin';
  }

  /** Whether `common` (full media) nodes may also receive assignments. */
  private allowCommon(): boolean {
    const raw = (this.config.env('STREAMHUB_EDGE_ALLOW_COMMON') ?? '')
      .trim()
      .toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
  }
}
