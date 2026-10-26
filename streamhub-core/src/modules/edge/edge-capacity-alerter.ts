/**
 * VISION EDGE — "no capacity" alerter.
 *
 * The scheduler parks work when nothing is eligible (nothing connected, VRAM
 * exhausted, a GPU node fell and left no GPU survivor). That is an operational
 * condition an operator must SEE, but the scheduler retries pending work every
 * 30s — so a naive emit would spam. This seam fires ONE `cluster.capacity`
 * event per reason per {@link COOLDOWN_MS} window, through:
 *
 *   1. the central log ({@link LogsServiceContract}, source `edge`, level warn)
 *      → queryable via `GET /logs?source=edge` + the cluster-logs dashboard;
 *   2. the {@link EDGE_NOTIFIER} seam (notifyGlobal + per-app fan-out for apps
 *      with `cluster.notify`), exactly like the node online/offline flips.
 *
 * Never throws — a notification failure can never break a placement decision.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { LOGS_SERVICE, LogsServiceContract } from '../../shared/contracts';
import { EDGE_NOTIFIER, EdgeNotifier } from './edge-notifier';

/** Minimum gap between two alerts of the SAME reason. */
export const COOLDOWN_MS = 300_000;

/** The distinct capacity conditions, each rate-limited on its own key. */
export type CapacityReason = 'no-eligible-node' | 'failover-parked';

@Injectable()
export class EdgeCapacityAlerter {
  private readonly logger = new Logger(EdgeCapacityAlerter.name);
  private readonly lastEmitted = new Map<CapacityReason, number>();
  private readonly clock: () => number;

  constructor(
    @Optional()
    @Inject(EDGE_NOTIFIER)
    private readonly notifier?: EdgeNotifier,
    @Optional()
    @Inject(LOGS_SERVICE)
    private readonly logs?: LogsServiceContract,
    // Injectable clock (undefined under DI → wall clock); tests pass a fake.
    @Optional() clock?: () => number,
  ) {
    this.clock = clock ?? (() => Date.now());
  }

  /**
   * Fire a capacity alert for `reason`, unless one fired for the same reason
   * within the cooldown. Returns true when it actually emitted (for tests).
   */
  alert(reason: CapacityReason, payload: Record<string, unknown> = {}): boolean {
    const now = this.clock();
    const last = this.lastEmitted.get(reason);
    if (last !== undefined && now - last < COOLDOWN_MS) return false;
    this.lastEmitted.set(reason, now);

    const detail = { reason, ...payload };
    try {
      this.logs?.write('warn', 'edge', `cluster capacity: ${reason}`, detail);
    } catch {
      /* logging must never break the scheduler */
    }
    // Fan-out is async + best-effort; the scheduler does not await it.
    void Promise.resolve()
      .then(() => this.notifier?.notify('cluster.capacity', detail))
      .catch((err) =>
        this.logger.debug(
          `cluster.capacity notify failed: ${(err as Error).message}`,
        ),
      );
    return true;
  }
}
