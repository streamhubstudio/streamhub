import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as path from 'path';

import { ConfigService } from '../../shared/config/config.service';
import {
  APPS_SERVICE,
  AppsServiceContract,
  LIVEKIT_SERVICE,
  LiveKitServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import { HlsService } from './hls.service';
import { StreamsService } from './streams.service';
import { pruneDvrDir, safeRoomSlug } from './hls-dvr-janitor';

/** Default reconciliation cadence (seconds). */
const DEFAULT_INTERVAL_S = 30;

/** One always-on room to reconcile (a live stream of a linear-channel app). */
interface WatchedRoom {
  streamId: string;
  room: string;
}

/** Outcome of one reconciliation pass (returned for tests/observability). */
export interface ReconcileResult {
  /** Distinct rooms inspected across all always-on/DVR apps. */
  checked: number;
  /** HLS egresses relaunched because none was active (QW-2). */
  relaunched: number;
  /** `.ts` segments pruned by the DVR janitor (QW-4). */
  pruned: number;
}

/**
 * Auto-HLS watchdog + DVR janitor for 24/7 linear channels (endless-radio
 * Tier 1, QW-2/QW-4).
 *
 * Every `intervalSeconds` it reconciles apps whose `features.linear` opts into
 * always-on HLS and/or DVR:
 *  - **alwaysOnHls**: for each active room with NO active HLS egress it calls the
 *    idempotent `HlsService.start` exactly once, so a crashed/ended egress is
 *    relaunched without ever double-launching a live one.
 *  - **dvr**: it prunes `.ts` segments older than the DVR window from the room's
 *    on-disk HLS dir, never one still referenced by the live playlist.
 *
 * Infra-free/testable: the timer just calls `reconcileOnce()`, which tests drive
 * directly. Never throws — a per-app/per-room failure is logged and the pass
 * continues.
 */
@Injectable()
export class HlsWatchdogService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly config: ConfigService,
    private readonly streams: StreamsService,
    private readonly hls: HlsService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LIVEKIT_SERVICE) private readonly livekit: LiveKitServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
  ) {}

  onModuleInit(): void {
    // Disabled by env (STREAMHUB_HLS_WATCHDOG=off) or under tests, so a spec
    // never spins the timer. Unit specs construct the service directly and drive
    // reconcileOnce() themselves.
    if (this.config.nodeEnv === 'test') return;
    if ((this.config.env('STREAMHUB_HLS_WATCHDOG') || 'on') === 'off') return;
    const intervalMs = this.intervalSeconds() * 1000;
    this.timer = setInterval(() => void this.reconcileOnce(), intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private intervalSeconds(): number {
    const raw = Number(this.config.env('STREAMHUB_HLS_WATCHDOG_INTERVAL_S'));
    return Number.isFinite(raw) && raw >= 5 ? Math.floor(raw) : DEFAULT_INTERVAL_S;
  }

  /**
   * One reconciliation pass over every always-on/DVR app. Public for tests;
   * never throws and never overlaps a slow pass.
   */
  async reconcileOnce(now: number = Date.now()): Promise<ReconcileResult> {
    const result: ReconcileResult = { checked: 0, relaunched: 0, pruned: 0 };
    if (this.ticking) return result;
    this.ticking = true;
    try {
      let apps: Array<{ name: string }>;
      try {
        apps = await this.apps.list();
      } catch (err) {
        this.warn(null, 'app list failed', err);
        return result;
      }
      for (const app of apps) {
        await this.reconcileApp(app.name, now, result);
      }
    } finally {
      this.ticking = false;
    }
    return result;
  }

  private async reconcileApp(
    appName: string,
    now: number,
    result: ReconcileResult,
  ): Promise<void> {
    let linear;
    try {
      linear = (await this.apps.getConfig(appName)).features.linear;
    } catch {
      return; // app vanished / unreadable config mid-pass
    }
    if (!linear || (!linear.alwaysOnHls && !linear.dvr)) return;

    const rooms = await this.activeRooms(appName);
    const seen = new Set<string>();
    for (const { streamId, room } of rooms) {
      if (seen.has(room)) continue; // one action per distinct room
      seen.add(room);
      result.checked++;

      if (linear.alwaysOnHls && !(await this.hasActiveHls(room))) {
        try {
          await this.hls.start(appName, streamId, this.baseUrl());
          result.relaunched++;
          this.logs.write('info', 'hls-watchdog', 'relaunched dead HLS egress', {
            app: appName,
            room,
            streamId,
          });
        } catch (err) {
          this.warn(appName, 'hls relaunch failed', err);
        }
      }

      if (linear.dvr) {
        result.pruned += this.pruneRoom(
          appName,
          room,
          linear.dvrWindowSeconds,
          now,
        );
      }
    }
  }

  /** Active (streamId, room) pairs of an app. Never throws. */
  private async activeRooms(appName: string): Promise<WatchedRoom[]> {
    try {
      const rows = await this.streams.list(appName);
      return rows
        .filter((s) => s.status === 'active' && !!s.room)
        .map((s) => ({ streamId: s.streamId, room: s.room }));
    } catch (err) {
      this.warn(appName, 'active-room lookup failed', err);
      return [];
    }
  }

  /** True when a live HLS egress exists for the room. Errs on the safe side. */
  private async hasActiveHls(room: string): Promise<boolean> {
    try {
      const list = await this.livekit.listHlsEgress(room);
      return list.some((e) => e.roomName === room);
    } catch (err) {
      // Can't tell → assume alive so we never double-launch on a transient
      // LiveKit hiccup.
      this.warn(null, 'listHlsEgress failed', err);
      return true;
    }
  }

  /** Prune expired DVR segments for one room; returns the delete count. */
  private pruneRoom(
    appName: string,
    room: string,
    windowSeconds: number,
    now: number,
  ): number {
    try {
      const dir = path.join(
        this.apps.appDir(appName),
        'hls',
        safeRoomSlug(room),
      );
      const { deleted } = pruneDvrDir(dir, windowSeconds, { now });
      if (deleted.length) {
        this.logs.write('info', 'hls-watchdog', 'pruned DVR segments', {
          app: appName,
          room,
          deleted: deleted.length,
          windowSeconds,
        });
      }
      return deleted.length;
    } catch (err) {
      this.warn(appName, 'DVR prune failed', err);
      return 0;
    }
  }

  /** Public origin for playlist URLs; empty → relative (fine, informational). */
  private baseUrl(): string {
    return (this.config.publicBaseUrl || '').replace(/\/+$/, '');
  }

  private warn(appName: string | null, message: string, err: unknown): void {
    try {
      this.logs.write('warn', 'hls-watchdog', message, {
        ...(appName ? { app: appName } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* never throw */
    }
  }
}
