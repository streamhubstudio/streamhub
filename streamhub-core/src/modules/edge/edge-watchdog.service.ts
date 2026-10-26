import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

import { DbService } from '../../shared/db/db.service';
import { EDGE_NOTIFIER, EdgeNotifier } from './edge-notifier';
import { EdgeGateway } from './edge.gateway';
import { EdgeSchedulerService } from './edge-scheduler.service';

/** Reaper cadence. */
export const WATCHDOG_INTERVAL_MS = 20_000;
/** A node is stale (offline) once unseen for this long AND WS-disconnected. */
export const NODE_STALE_AFTER_MS = 90_000;
/** How long a node must be WS-down before its work is failed over. */
export const FAILOVER_GRACE_MS = 45_000;

/** Raw `nodes` row the watchdog reads. */
interface WatchdogNodeRow {
  id: string;
  name: string;
  type: string | null;
  last_seen_at: string | null;
}

/**
 * VISION EDGE watchdog — a periodic reaper (every 20s, unref'd so it never keeps
 * the process alive) that:
 *
 *   1. tracks each node's LIVENESS (connected over WS, or an HTTP heartbeat
 *      within the stale window) and fires `node.online`/`node.offline` through
 *      the {@link EDGE_NOTIFIER} seam on every flip;
 *   2. FAILS OVER a node's assignments once it has been WS-disconnected past the
 *      grace, by handing off to the scheduler.
 *
 * The first observation of a node seeds its baseline silently (no boot spam);
 * only genuine transitions notify.
 */
@Injectable()
export class EdgeWatchdogService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EdgeWatchdogService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** Last known liveness per node (absent = never observed). */
  private readonly liveness = new Map<string, boolean>();

  constructor(
    private readonly db: DbService,
    private readonly gateway: EdgeGateway,
    private readonly scheduler: EdgeSchedulerService,
    @Inject(EDGE_NOTIFIER) private readonly notifier: EdgeNotifier,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), WATCHDOG_INTERVAL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One reaper pass. Public + async so specs can await a single tick. Never throws. */
  async tick(): Promise<void> {
    let rows: WatchdogNodeRow[];
    try {
      rows = this.db
        .global()
        .prepare(
          "SELECT id, name, type, last_seen_at FROM nodes WHERE type IN ('common','edge')",
        )
        .all() as WatchdogNodeRow[];
    } catch (err) {
      this.logger.debug(`watchdog tick skipped: ${(err as Error).message}`);
      return;
    }

    const now = Date.now();
    for (const row of rows) {
      await this.reconcileLiveness(row, now);
      this.maybeFailover(row.id, now);
    }
  }

  /** Compare a node's current liveness to the last seen and notify on a flip. */
  private async reconcileLiveness(
    row: WatchdogNodeRow,
    now: number,
  ): Promise<void> {
    const online =
      this.gateway.isConnected(row.id) || this.seenWithin(row.last_seen_at, now);
    const prev = this.liveness.get(row.id);
    this.liveness.set(row.id, online);
    if (prev === undefined || prev === online) return; // baseline or no change

    const event = online ? 'node.online' : 'node.offline';
    try {
      await this.notifier.notify(event, {
        nodeId: row.id,
        name: row.name,
        type: row.type === 'edge' ? 'edge' : 'common',
        at: new Date(now).toISOString(),
      });
    } catch (err) {
      this.logger.debug(`notifier ${event} failed: ${(err as Error).message}`);
    }
  }

  /** Fail a node's work over once it has been WS-down past the grace. */
  private maybeFailover(nodeId: string, now: number): void {
    if (this.gateway.isConnected(nodeId)) return;
    const downSince = this.gateway.disconnectedSince(nodeId);
    if (downSince == null || now - downSince < FAILOVER_GRACE_MS) return;
    try {
      this.scheduler.handleNodeDown(nodeId);
    } catch (err) {
      this.logger.debug(`failover for ${nodeId} failed: ${(err as Error).message}`);
    }
  }

  private seenWithin(lastSeenAt: string | null, now: number): boolean {
    if (!lastSeenAt) return false;
    // SQLite datetime('now') is UTC without a zone marker — parse as UTC.
    const t = Date.parse(lastSeenAt.replace(' ', 'T') + 'Z');
    if (Number.isNaN(t)) return false;
    return now - t <= NODE_STALE_AFTER_MS;
  }
}
