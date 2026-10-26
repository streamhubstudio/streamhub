/**
 * EDGE RECONCILE — generalized out of the old vision.service reconcile.
 *
 * For each app × INSTALLED + ENABLED edge-capable plugin (meta.worker.edge), when
 * ≥1 edge node is connected, mirror the app's ACTIVE streams onto edge
 * assignments: one row per (plugin × stream) with a `config.room` override, so a
 * single-room worker (lpr / yolo / a vision model / …) runs N times — once per
 * stream — distributed across nodes. Streams that ended (or a plugin that was
 * disabled) get their stale assignments revoked.
 *
 * Gate: only runs when an edge node is registered + connected — otherwise the
 * co-located worker-hook already covers the app and creating edge assignments
 * would just park them pending. Best-effort: never throws (a bad app/plugin is
 * skipped). A 30s timer sweeps every app; tests drive `reconcileApp` directly.
 * (The scheduler's own 30s `retryPending` loop — re-placing PARKED assignments —
 * stays intact; this loop creates/revokes the desired SET.)
 */
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';

import { DbService } from '../../shared/db/db.service';
import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { validateConfig } from '../plugins/plugin-config.util';
import { EdgeAssignmentsRepository } from './edge-assignments.repository';
import { EdgeGateway } from './edge.gateway';
import { EdgeSchedulerService } from './edge-scheduler.service';

@Injectable()
export class EdgeReconcileService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  /** How often every app's edge desired-set is reconciled. */
  private static readonly RECONCILE_MS = 30_000;
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(EdgeReconcileService.name);

  constructor(
    private readonly scheduler: EdgeSchedulerService,
    private readonly assignments: EdgeAssignmentsRepository,
    private readonly gateway: EdgeGateway,
    private readonly registry: PluginRegistryService,
    private readonly installs: AppPluginsRepository,
    private readonly db: DbService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(
      () => void this.reconcileAll(),
      EdgeReconcileService.RECONCILE_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Reconcile every registered app. Best-effort. */
  async reconcileAll(): Promise<void> {
    if (this.edgeNodeCount() === 0) return; // no edge → nothing to mirror
    let apps: { name: string }[] = [];
    try {
      apps = await this.apps.list();
    } catch {
      return;
    }
    for (const { name } of apps) {
      try {
        this.reconcileApp(name);
      } catch (err) {
        this.logger.debug(`edge reconcile ${name} failed: ${String(err)}`);
      }
    }
  }

  /**
   * Reconcile ONE app: mirror active streams onto edge for every installed +
   * enabled edge-capable plugin. No-op when no edge node is connected.
   */
  reconcileApp(app: string): void {
    if (this.edgeNodeCount() === 0) return;
    const rooms = this.activeRooms(app);
    for (const row of this.installs.list(app)) {
      if (!row.enabled) continue;
      const meta = this.registry.getMeta(row.pluginId);
      if (meta?.worker?.edge !== true) continue;
      let config: Record<string, unknown>;
      try {
        config = validateConfig(meta, row.config, true);
      } catch {
        continue; // missing required config → don't schedule a crash-loop
      }
      this.reconcilePlugin(app, row.pluginId, rooms, config);
    }
  }

  /** Mirror one plugin's active-stream set to edge assignments. */
  private reconcilePlugin(
    app: string,
    pluginId: string,
    rooms: string[],
    config: Record<string, unknown>,
  ): void {
    const existing = this.assignments
      .list(app)
      .filter(
        (a) =>
          a.pluginId === pluginId &&
          a.status !== 'revoked' &&
          a.status !== 'stopped',
      );
    const wanted = new Set(rooms);
    for (const room of rooms) {
      if (existing.some((a) => a.streamId === room)) continue;
      this.scheduler.schedule({
        app,
        pluginId,
        streamId: room,
        config: { ...config, room },
      });
    }
    // Revoke assignments whose stream ended.
    for (const a of existing) {
      if (a.streamId && !wanted.has(a.streamId)) this.scheduler.revoke(a.id);
    }
  }

  // ---------------------------------------------------------------------------

  /** Count of connected edge nodes (type 'edge' + live WS). */
  private edgeNodeCount(): number {
    let rows: { id: string; type: string | null }[] = [];
    try {
      rows = this.db
        .global()
        .prepare('SELECT id, type FROM nodes')
        .all() as { id: string; type: string | null }[];
    } catch {
      return 0;
    }
    return rows.filter((r) => r.type === 'edge' && this.gateway.isConnected(r.id))
      .length;
  }

  /** Distinct rooms with ≥1 active stream (per-app db; failure-proof). */
  private activeRooms(app: string): string[] {
    try {
      const rows = this.db
        .appDb(app)
        .prepare(
          "SELECT DISTINCT room FROM streams WHERE status = 'active' AND room IS NOT NULL AND room != '' ORDER BY room ASC",
        )
        .all() as { room: string }[];
      return rows.map((r) => r.room);
    } catch {
      return [];
    }
  }
}
