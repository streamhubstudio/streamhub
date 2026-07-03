import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { DbService, Db } from './db.service';

/** Per-table row/size breakdown in a health report. */
export interface DbTableHealth {
  name: string;
  rows: number;
  /** Bytes occupied (data + indices) when the dbstat vtab is available. */
  bytes?: number;
}

/** SQLite health snapshot for one database file. */
export interface DbHealth {
  path: string;
  sizeBytes: number;
  walSizeBytes: number;
  pageCount: number;
  freelistCount: number;
  /** freelist_count / page_count * 100 — how much of the file is dead space. */
  fragmentationPct: number;
  tables: DbTableHealth[];
}

/** Before/after report returned by an optimize run. */
export interface DbOptimizeResult {
  path: string;
  steps: string[];
  before: { sizeBytes: number; walSizeBytes: number; freelistCount: number };
  after: { sizeBytes: number; walSizeBytes: number; freelistCount: number };
  reclaimedBytes: number;
}

/**
 * SQLite health / maintenance for the decentralized StreamHub databases
 * (the global data/streamhub.db and every per-app apps/<name>/app.db).
 *
 * Pure DB-side concerns only: PRAGMA-based health snapshots, optimize (ANALYZE
 * + REINDEX + VACUUM + wal_checkpoint) and low-level purges of app-scoped data
 * that has NO external side effects (streams rows, the app's server_logs). The
 * VOD purge (which must also drop S3 objects + local files) is orchestrated by
 * the db-admin controller reusing the recording service's per-VOD cascade — it
 * is NOT done here, because shared/ must not depend on a feature module.
 */
@Injectable()
export class DbMaintenanceService {
  private readonly logger = new Logger(DbMaintenanceService.name);

  constructor(private readonly db: DbService) {}

  // ---- health ----------------------------------------------------------

  /** Health of the global registry DB. */
  globalHealth(): DbHealth {
    return this.healthFor(this.db.global(), this.db.globalDbPath());
  }

  /** Health of an app's consolidated DB. */
  appHealth(appName: string): DbHealth {
    return this.healthFor(this.db.appDb(appName), this.db.appDbPath(appName));
  }

  private healthFor(handle: Db, filePath: string): DbHealth {
    const pageCount = this.pragmaInt(handle, 'page_count');
    const freelistCount = this.pragmaInt(handle, 'freelist_count');
    const fragmentationPct =
      pageCount > 0
        ? Math.round((freelistCount / pageCount) * 10000) / 100
        : 0;
    return {
      path: filePath,
      sizeBytes: this.fileSize(filePath),
      walSizeBytes: this.fileSize(`${filePath}-wal`),
      pageCount,
      freelistCount,
      fragmentationPct,
      tables: this.tableHealth(handle),
    };
  }

  /** Per-table row counts (+ byte sizes when dbstat is compiled in). */
  private tableHealth(handle: Db): DbTableHealth[] {
    let names: string[];
    try {
      names = (
        handle
          .prepare(
            `SELECT name FROM sqlite_master
               WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
               ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
    } catch (err) {
      this.logger.warn(`table enumeration failed: ${(err as Error).message}`);
      return [];
    }

    // dbstat is optional (needs SQLITE_ENABLE_DBSTAT_VTAB). Try once; on failure
    // report rows only. Aggregates data+index pages per table by name.
    const bytesByTable = this.tableBytes(handle);

    const out: DbTableHealth[] = [];
    for (const name of names) {
      let rows = 0;
      try {
        const row = handle
          .prepare(`SELECT COUNT(*) AS c FROM "${name}"`)
          .get() as { c: number };
        rows = Number(row.c) || 0;
      } catch (err) {
        this.logger.warn(
          `count on ${name} failed: ${(err as Error).message}`,
        );
      }
      const bytes = bytesByTable?.get(name);
      out.push(bytes === undefined ? { name, rows } : { name, rows, bytes });
    }
    return out;
  }

  /** Bytes-per-table via the dbstat vtab; null when unavailable. */
  private tableBytes(handle: Db): Map<string, number> | null {
    try {
      const rows = handle
        .prepare(
          `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`,
        )
        .all() as { name: string; bytes: number }[];
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.name, Number(r.bytes) || 0);
      return m;
    } catch {
      return null; // dbstat not compiled in — rows-only report
    }
  }

  // ---- optimize --------------------------------------------------------

  optimizeGlobal(): DbOptimizeResult {
    return this.optimize(this.db.global(), this.db.globalDbPath());
  }

  optimizeApp(appName: string): DbOptimizeResult {
    return this.optimize(this.db.appDb(appName), this.db.appDbPath(appName));
  }

  /**
   * Run the full SQLite tune-up on a live handle, in an order that leaves the
   * file compact and the query planner stats fresh:
   *   PRAGMA optimize → ANALYZE → REINDEX → VACUUM → wal_checkpoint(TRUNCATE).
   * VACUUM works on the open better-sqlite3 connection (no active statements),
   * so no close/reopen is needed; the checkpoint then shrinks the -wal file.
   */
  private optimize(handle: Db, filePath: string): DbOptimizeResult {
    const before = this.sizes(handle, filePath);
    const steps: string[] = [];

    this.step(steps, 'PRAGMA optimize', () => handle.pragma('optimize'));
    this.step(steps, 'ANALYZE', () => handle.exec('ANALYZE'));
    this.step(steps, 'REINDEX', () => handle.exec('REINDEX'));
    this.step(steps, 'VACUUM', () => handle.exec('VACUUM'));
    this.step(steps, 'wal_checkpoint(TRUNCATE)', () =>
      handle.pragma('wal_checkpoint(TRUNCATE)'),
    );

    const after = this.sizes(handle, filePath);
    return {
      path: filePath,
      steps,
      before,
      after,
      reclaimedBytes: Math.max(0, before.sizeBytes - after.sizeBytes),
    };
  }

  private step(steps: string[], label: string, fn: () => unknown): void {
    try {
      fn();
      steps.push(label);
    } catch (err) {
      this.logger.warn(`optimize step "${label}" failed: ${(err as Error).message}`);
      steps.push(`${label} (skipped: ${(err as Error).message})`);
    }
  }

  private sizes(
    handle: Db,
    filePath: string,
  ): { sizeBytes: number; walSizeBytes: number; freelistCount: number } {
    return {
      sizeBytes: this.fileSize(filePath),
      walSizeBytes: this.fileSize(`${filePath}-wal`),
      freelistCount: this.pragmaInt(handle, 'freelist_count'),
    };
  }

  // ---- purge (non-cascading, side-effect-free tables) ------------------

  /**
   * Delete every row from the app's `streams` table. Returns the count removed.
   * Purely local DB state (no S3/filesystem), so it is safe to do here.
   */
  purgeAppStreams(appName: string): number {
    const handle = this.db.appDb(appName);
    const info = handle.prepare('DELETE FROM streams').run();
    return Number(info.changes) || 0;
  }

  /**
   * Delete the app's operational log rows from the GLOBAL `server_logs` table
   * (there is no per-app log table; app-scoped logs live in the global DB keyed
   * by app_id). Resolves app_id by name. Returns the count removed.
   */
  purgeAppLogs(appName: string): number {
    const gdb = this.db.global();
    const app = gdb
      .prepare('SELECT id FROM apps WHERE name = ?')
      .get(appName) as { id: number } | undefined;
    if (!app) return 0;
    const info = gdb
      .prepare('DELETE FROM server_logs WHERE app_id = ?')
      .run(app.id);
    return Number(info.changes) || 0;
  }

  // ---- helpers ---------------------------------------------------------

  private pragmaInt(handle: Db, name: string): number {
    try {
      return Number(handle.pragma(name, { simple: true })) || 0;
    } catch {
      return 0;
    }
  }

  private fileSize(p: string): number {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0; // file absent (e.g. no -wal when checkpointed)
    }
  }
}
