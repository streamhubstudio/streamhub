import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { APPS_SERVICE, AppsServiceContract, VodStatus } from '../../shared/contracts';
import { DbService } from '../../shared/db/db.service';
import { DbSizesService } from '../../shared/db/db-sizes.service';
import { AppLiveStats, StreamsService } from '../streams/streams.service';
import { VodsRepository } from './vods.repository';

/** Per-app operational stats surfaced by GET /apps/:app/stats. */
export interface AppStats {
  ts: string;
  app: { name: string; displayName: string };
  live: AppLiveStats;
  vods: {
    count: number;
    totalBytes: number;
    byStatus: Record<VodStatus, number>;
  };
  storage: { appDbBytes: number; vodBytes: number };
  ingress: { total: number; active: number };
  events24h: { error: number; warn: number; info: number };
}

/** How long a per-app stats snapshot is cached in memory. */
const CACHE_TTL_MS = 5000;

/**
 * Aggregates per-app stats for the dashboard: live streams/viewers (reusing
 * StreamsService), VOD counts/storage, per-app DB footprint, ingress counts and
 * a 24h log-level rollup. Cached 5s per app so a polling dashboard never hammers
 * LiveKit. Every sub-query is defensive — a gap in one block never fails the
 * whole endpoint.
 */
@Injectable()
export class AppStatsService {
  private readonly logger = new Logger(AppStatsService.name);
  private readonly cache = new Map<string, { at: number; value: AppStats }>();

  constructor(
    private readonly db: DbService,
    private readonly sizes: DbSizesService,
    private readonly vods: VodsRepository,
    private readonly streams: StreamsService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
  ) {}

  /** Stats for `appName`, served from a 5s in-memory cache when fresh. */
  async stats(appName: string): Promise<AppStats> {
    const cached = this.cache.get(appName);
    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
    const value = await this.build(appName);
    this.cache.set(appName, { at: now, value });
    return value;
  }

  private async build(appName: string): Promise<AppStats> {
    const app = await this.apps.get(appName);
    if (!app) throw new NotFoundException(`app '${appName}' not found`);

    const live = await this.streams.liveStats(appName);
    const sz = this.sizes.appSizes(appName);
    const byStatus = this.vods.countByStatus(appName);

    return {
      ts: new Date().toISOString(),
      app: { name: app.name, displayName: app.displayName },
      live,
      vods: { count: sz.vodCount, totalBytes: sz.vodTotalBytes, byStatus },
      storage: { appDbBytes: sz.dbSizeBytes, vodBytes: sz.vodTotalBytes },
      ingress: this.ingressCounts(appName),
      events24h: this.events24h(appName),
    };
  }

  /**
   * Ingress totals for the app, derived from the per-app `streams` table
   * (rtmp/whip/rtsp-typed rows). `active` counts those still live. This avoids
   * an extra LiveKit round-trip on every poll (the global /stats endpoint keeps
   * the LiveKit-sourced view).
   */
  private ingressCounts(appName: string): { total: number; active: number } {
    try {
      const adb = this.db.appDb(appName);
      const total = (
        adb
          .prepare(
            "SELECT COUNT(*) AS n FROM streams WHERE type IN ('rtmp','whip','rtsp')",
          )
          .get() as { n: number }
      ).n;
      const active = (
        adb
          .prepare(
            "SELECT COUNT(*) AS n FROM streams " +
              "WHERE type IN ('rtmp','whip','rtsp') AND status = 'active'",
          )
          .get() as { n: number }
      ).n;
      return { total: Number(total) || 0, active: Number(active) || 0 };
    } catch (err) {
      this.logger.debug(`ingress counts for '${appName}' failed: ${String(err)}`);
      return { total: 0, active: 0 };
    }
  }

  /**
   * COUNT of server_logs in the last 24h, grouped into error/warn/info for the
   * app. Attribution is by `app_id = (SELECT id FROM apps WHERE name = ?)` so it
   * stays correct independently of the log-attribution work in flight (returns
   * zeros today if rows are not yet attributed — no dependency on that code).
   * `ts` is compared against an ISO boundary (same format LogsService writes),
   * so the idx_server_logs_app_ts index is used.
   */
  private events24h(appName: string): {
    error: number;
    warn: number;
    info: number;
  } {
    const out = { error: 0, warn: 0, info: 0 };
    try {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const rows = this.db
        .global()
        .prepare(
          `SELECT level, COUNT(*) AS n FROM server_logs
             WHERE app_id = (SELECT id FROM apps WHERE name = ?) AND ts >= ?
             GROUP BY level`,
        )
        .all(appName, since) as { level: string; n: number }[];
      for (const r of rows) {
        const lvl = (r.level || '').toLowerCase();
        const n = Number(r.n) || 0;
        if (lvl === 'error' || lvl === 'fatal') out.error += n;
        else if (lvl === 'warn' || lvl === 'warning') out.warn += n;
        else if (lvl === 'info') out.info += n;
      }
    } catch (err) {
      this.logger.debug(`events24h for '${appName}' failed: ${String(err)}`);
    }
    return out;
  }
}
