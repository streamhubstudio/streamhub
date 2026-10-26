/**
 * STREAM-HEALTH Studio App — service.
 *
 * Two jobs:
 *
 *  1. SINK: onModuleInit taps {@link CallbacksService.onDispatch} — the single
 *     funnel EVERY domain event converges on — and records each `health.*`
 *     dispatch into the per-app stream-health.db (bounded history). The worker
 *     emits through the generic plugin event channel, so by the time an event
 *     reaches the funnel it already carries `{ plugin, room }`; no second emit
 *     site and no PluginsService edit needed (same tap pattern as Streamflow).
 *
 *  2. READS + PER-ROOM THRESHOLDS for the monitor tab: overview tiles, recent
 *     transitions, and get/put of the per-room threshold overrides the worker
 *     re-reads (read-only) every sampling cycle — an override takes effect
 *     WITHOUT a worker restart.
 *
 * The LIVE per-room status snapshot is NOT served here: the worker pushes it
 * to the framework live-data channel (room 'overview') and the tab reads
 * `GET /apps/:app/plugins/stream-health/live/state?room=overview`.
 */
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import {
  APPS_SERVICE,
  AppsServiceContract,
} from '../../shared/contracts';
import { CallbacksService } from '../callbacks/callbacks.service';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import {
  HealthEventRow,
  StreamHealthStore,
} from './stream-health.store';
import {
  HealthThresholds,
  resolveThresholds,
  sanitizeOverride,
} from './stream-health.thresholds';

export const STREAM_HEALTH_PLUGIN_ID = 'stream-health';

/** Overview tiles for the monitor tab. */
export interface HealthOverview {
  /** health.* events recorded since local midnight. */
  today: number;
  /** Rooms with recent history and/or a stored override. */
  rooms: {
    room: string;
    lastEvent: string | null;
    lastTs: string | null;
    hasOverride: boolean;
  }[];
}

/** Per-room settings view (override + the resolved effective thresholds). */
export interface HealthSettingsView {
  room: string;
  override: Partial<HealthThresholds>;
  resolved: HealthThresholds;
  updatedAt: string | null;
}

@Injectable()
export class StreamHealthService implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;

  constructor(
    private readonly store: StreamHealthStore,
    private readonly callbacks: CallbacksService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    private readonly appPlugins: AppPluginsRepository,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.callbacks.onDispatch((app, event, payload) =>
      this.onEvent(app, event, payload),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Funnel tap — record health.* dispatches (best-effort, never throws). */
  onEvent(
    app: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    if (!event.startsWith('health.')) return;
    try {
      const appDir = this.apps.appDir(app);
      const room = typeof payload?.room === 'string' ? payload.room : '';
      this.store.record(app, appDir, room, event, payload ?? {});
    } catch {
      /* the sink must never break the dispatch funnel */
    }
  }

  // ---------------------------------------------------------------------------
  // Reads for the tab
  // ---------------------------------------------------------------------------

  async overview(app: string): Promise<HealthOverview> {
    const appDir = this.apps.appDir(app);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const since = midnight.toISOString();
    const dayAgo = new Date(Date.now() - 86400_000).toISOString();

    const overrides = new Map(
      this.store.listSettings(app, appDir).map((s) => [s.room, s]),
    );
    const rooms = new Map<
      string,
      { room: string; lastEvent: string | null; lastTs: string | null; hasOverride: boolean }
    >();
    for (const r of this.store.roomsSince(app, appDir, dayAgo)) {
      rooms.set(r.room, {
        room: r.room,
        lastEvent: r.lastEvent,
        lastTs: r.lastTs,
        hasOverride: overrides.has(r.room),
      });
    }
    for (const room of overrides.keys()) {
      if (!rooms.has(room)) {
        rooms.set(room, {
          room,
          lastEvent: null,
          lastTs: null,
          hasOverride: true,
        });
      }
    }
    return {
      today: this.store.countSince(app, appDir, since),
      rooms: [...rooms.values()].sort((a, b) => a.room.localeCompare(b.room)),
    };
  }

  async events(
    app: string,
    limit: number,
    room?: string,
  ): Promise<HealthEventRow[]> {
    return this.store.recentEvents(app, this.apps.appDir(app), limit, room);
  }

  // ---------------------------------------------------------------------------
  // Per-room threshold overrides
  // ---------------------------------------------------------------------------

  async getSettings(app: string, room: string): Promise<HealthSettingsView> {
    const appDir = this.apps.appDir(app);
    const row = this.store.getSetting(app, appDir, room);
    return this.view(app, room, row?.override ?? {}, row?.updatedAt ?? null);
  }

  /**
   * Replace a room's override (validated; unknown keys / out-of-range → 400
   * via {@link HealthSettingsError}). An empty object clears the override.
   */
  async putSettings(
    app: string,
    room: string,
    input: unknown,
  ): Promise<HealthSettingsView> {
    const override = sanitizeOverride(input);
    const appDir = this.apps.appDir(app);
    const row = this.store.putSetting(app, appDir, room, override);
    return this.view(app, room, row.override, row.updatedAt);
  }

  private view(
    app: string,
    room: string,
    override: Partial<HealthThresholds>,
    updatedAt: string | null,
  ): HealthSettingsView {
    let installConfig: Record<string, unknown> = {};
    try {
      installConfig =
        this.appPlugins.get(app, STREAM_HEALTH_PLUGIN_ID)?.config ?? {};
    } catch {
      /* uninstalled / repo trouble → defaults */
    }
    return {
      room,
      override,
      resolved: resolveThresholds(installConfig, override),
      updatedAt,
    };
  }
}
