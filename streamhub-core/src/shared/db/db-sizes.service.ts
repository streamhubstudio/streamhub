import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { DbService } from './db.service';

/** VOD storage rollup (bytes + item count) for one app or the whole server. */
export interface VodTotals {
  /** Sum of `size_bytes` across the scope's VOD rows (nulls counted as 0). */
  vodTotalBytes: number;
  /** Number of VOD rows in scope. */
  vodCount: number;
}

/** DB + VOD sizes for a single app. */
export interface AppSizes extends VodTotals {
  app: string;
  /** Bytes on disk for apps/<app>/app.db (incl. its -wal / -shm sidecars). */
  dbSizeBytes: number;
}

/** Server-wide DB + VOD size rollup (drives the Dashboard cards). */
export interface ServerSizes extends VodTotals {
  /** Global registry DB — data/streamhub.db (+ sidecars). */
  dbSizeBytes: number;
  /** Sum of every per-app app.db (+ sidecars). */
  appsDbSizeBytes: number;
  /** dbSizeBytes + appsDbSizeBytes — every SQLite file StreamHub owns. */
  totalDbSizeBytes: number;
  /** Per-app breakdown (each app's app.db size + its VOD totals). */
  apps: AppSizes[];
}

/**
 * On-disk footprint of the decentralized StreamHub databases plus the VOD
 * storage rollup (SUM of `vods.size_bytes`) per app and server-wide.
 *
 * Pure read-only, side-effect-free reporting: it stats the SQLite files
 * (main + -wal + -shm sidecars) and runs a single aggregate query per app.
 * Lives in shared/ and depends ONLY on DbService — no feature-module edges — so
 * both HealthService (/stats) and the apps controller (/apps/:app/sizes) can
 * consume it via the @Global DbModule with zero extra wiring.
 */
@Injectable()
export class DbSizesService {
  private readonly logger = new Logger(DbSizesService.name);

  constructor(private readonly db: DbService) {}

  /** DB + VOD sizes for one app. */
  appSizes(appName: string): AppSizes {
    return {
      app: appName,
      dbSizeBytes: this.dbFileGroupSize(this.db.appDbPath(appName)),
      ...this.appVodTotals(appName),
    };
  }

  /** Server-wide rollup: global DB, per-app DBs and all VOD storage. */
  serverSizes(): ServerSizes {
    const dbSizeBytes = this.dbFileGroupSize(this.db.globalDbPath());
    const apps = this.appNames().map((name) => this.appSizes(name));

    let appsDbSizeBytes = 0;
    let vodTotalBytes = 0;
    let vodCount = 0;
    for (const a of apps) {
      appsDbSizeBytes += a.dbSizeBytes;
      vodTotalBytes += a.vodTotalBytes;
      vodCount += a.vodCount;
    }

    return {
      dbSizeBytes,
      appsDbSizeBytes,
      totalDbSizeBytes: dbSizeBytes + appsDbSizeBytes,
      vodTotalBytes,
      vodCount,
      apps,
    };
  }

  /** SUM(size_bytes) + COUNT(*) over an app's `vods` table. Never throws. */
  appVodTotals(appName: string): VodTotals {
    try {
      const row = this.db
        .appDb(appName)
        .prepare(
          `SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS count
             FROM vods`,
        )
        .get() as { bytes: number | null; count: number };
      return {
        vodTotalBytes: Number(row?.bytes) || 0,
        vodCount: Number(row?.count) || 0,
      };
    } catch (err) {
      this.logger.debug(`vod totals for '${appName}' failed: ${String(err)}`);
      return { vodTotalBytes: 0, vodCount: 0 };
    }
  }

  /** Registered app names from the global registry (empty on failure). */
  private appNames(): string[] {
    try {
      return (
        this.db.global().prepare('SELECT name FROM apps').all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    } catch (err) {
      this.logger.warn(`app enumeration failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Bytes on disk for a SQLite database: the main file plus its WAL/SHM
   * sidecars (a checkpoint may keep a large -wal), so the number reflects the
   * real footprint. Missing files count as 0.
   */
  private dbFileGroupSize(file: string): number {
    return (
      this.fileSize(file) +
      this.fileSize(`${file}-wal`) +
      this.fileSize(`${file}-shm`)
    );
  }

  private fileSize(p: string): number {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0; // file absent (e.g. no -wal after a checkpoint)
    }
  }
}
