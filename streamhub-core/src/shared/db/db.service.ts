import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ConfigService } from '../config/config.service';
import {
  APP_MIGRATIONS,
  GLOBAL_COLUMN_ADDS,
  GLOBAL_MIGRATIONS,
  GLOBAL_TENANCY_BACKFILL,
} from './migrations';

export type Db = Database.Database;

/**
 * Owns all SQLite handles (SPEC §4).
 *
 * DECENTRALIZED SPLIT (AntMedia-style):
 *   - ONE global handle, data/streamhub.db — cross-cutting identity + routing
 *     only (tenants/users/memberships/api_tokens/quotas, the `apps` pointer,
 *     server_logs, nodes).
 *   - ONE per-app handle, apps/<name>/app.db — EVERYTHING app-scoped
 *     (streams, vods, ingress_auth …). Consolidates the legacy per-app
 *     `vods.db`, whose rows are imported on first open. Handles are cached.
 *
 * Migrations run on first open via `PRAGMA user_version`. better-sqlite3 is
 * synchronous, so callers don't await. `appDb(name)` is the canonical accessor;
 * `app(name)` is a deprecated alias kept so in-flight business services keep
 * compiling until they migrate to `appDb`.
 */
@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private globalDb?: Db;
  private globalFile?: string;
  private readonly appDbs = new Map<string, Db>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.global();
  }

  onModuleDestroy(): void {
    this.appDbs.forEach((db) => db.close());
    this.appDbs.clear();
    this.globalDb?.close();
    this.globalDb = undefined;
  }

  /** Global registry DB (data/streamhub.db). Opened+migrated lazily. */
  global(): Db {
    if (!this.globalDb) {
      const file = path.join(this.config.dataDir, 'data', 'streamhub.db');
      this.globalFile = file;
      this.globalDb = this.open(file, GLOBAL_MIGRATIONS, 'streamhub.db');
      // Tenancy adjuncts SQLite can't express via numbered DDL migrations
      // (no `ADD COLUMN IF NOT EXISTS`): add tenant_id/node_id to apps and
      // tenant_id to api_tokens, then backfill to the 'platform' tenant.
      // Idempotent — runs on every open.
      this.applyColumnAdds(this.globalDb, GLOBAL_COLUMN_ADDS, 'streamhub.db');
      this.runIdempotent(this.globalDb, GLOBAL_TENANCY_BACKFILL, 'streamhub.db');
      // One-shot, idempotent, non-destructive per-app data split.
      this.splitPerApp(this.globalDb, file);
    }
    return this.globalDb;
  }

  /**
   * Canonical per-app DB (apps/<name>/app.db). Created+migrated if missing,
   * consolidates the legacy vods.db on first open, and is cached.
   */
  appDb(appName: string): Db {
    const cached = this.appDbs.get(appName);
    if (cached) return cached;
    const file = path.join(this.config.dataDir, 'apps', appName, 'app.db');
    const db = this.open(file, APP_MIGRATIONS, `app.db[${appName}]`);
    this.importLegacyVods(appName, db);
    this.appDbs.set(appName, db);
    return db;
  }

  /**
   * @deprecated Use {@link appDb}. Retained as a thin alias so business
   * services still referencing the old name keep working during the migration.
   */
  app(appName: string): Db {
    return this.appDb(appName);
  }

  /** Absolute path of the global registry DB file (data/streamhub.db). */
  globalDbPath(): string {
    this.global(); // ensure opened + globalFile populated
    return this.globalFile as string;
  }

  /** Absolute path of an app's consolidated DB file (apps/<name>/app.db). */
  appDbPath(appName: string): string {
    return path.join(this.config.dataDir, 'apps', appName, 'app.db');
  }

  /**
   * Reopen the global handle after an out-of-band operation that requires a
   * fresh connection (e.g. VACUUM under WAL). VACUUM itself works on the live
   * better-sqlite3 handle, but exposing this keeps the maintenance service able
   * to force a clean reopen if ever needed. Safe to call anytime.
   */
  reopenGlobal(): Db {
    this.globalDb?.close();
    this.globalDb = undefined;
    return this.global();
  }

  /** Reopen a single app handle (drops + recreates the cached connection). */
  reopenApp(appName: string): Db {
    this.closeApp(appName);
    return this.appDb(appName);
  }

  /** Drop a cached app handle (e.g. on app delete). */
  closeApp(appName: string): void {
    const db = this.appDbs.get(appName);
    if (db) {
      db.close();
      this.appDbs.delete(appName);
    }
  }

  // ---------------------------------------------------------------------------
  // Migration internals
  // ---------------------------------------------------------------------------

  /** Add columns that are missing (SQLite has no ADD COLUMN IF NOT EXISTS). */
  private applyColumnAdds(
    db: Db,
    adds: { table: string; column: string; ddl: string }[],
    label: string,
  ): void {
    for (const { table, column, ddl } of adds) {
      try {
        const cols = db
          .prepare(`PRAGMA table_info(${table})`)
          .all() as { name: string }[];
        if (cols.some((c) => c.name === column)) continue;
        db.exec(ddl);
        this.logger.log(`migrated ${label}: added ${table}.${column}`);
      } catch (err) {
        this.logger.error(
          `column add ${table}.${column} on ${label} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Run idempotent post-migration statements (e.g. tenant backfill). */
  private runIdempotent(db: Db, statements: string[], label: string): void {
    for (const sql of statements) {
      try {
        db.exec(sql);
      } catch (err) {
        this.logger.error(
          `idempotent step on ${label} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Idempotent, NON-DESTRUCTIVE per-app split. Runs once per global DB (guarded
   * by a `_streamhub_meta` flag). For every registered app it:
   *   1. ensures apps/<name>/app.db exists (which also imports legacy vods.db),
   *   2. copies that app's `ingress_auth` rows from the global DB into app.db.
   * A single-file backup of the global DB is taken first. The global copies of
   * moved rows are LEFT INTACT (see migrations.ts note) so the yet-to-be-rewritten
   * ingress-auth service keeps working; app.db is the eventual source of truth.
   */
  private splitPerApp(db: Db, globalFile: string): void {
    try {
      if (this.getMeta(db, 'per_app_split_done') === '1') return;

      // 1) Backup the global DB before we touch anything (VACUUM INTO = a
      //    consistent single-file snapshot, WAL-safe). Best-effort.
      this.backupGlobal(db, globalFile);

      // 2) Per-app consolidation.
      const apps = db.prepare('SELECT name FROM apps').all() as {
        name: string;
      }[];
      for (const { name } of apps) {
        try {
          const adb = this.appDb(name); // creates app.db + imports vods.db
          this.copyIngressAuth(name, adb, globalFile);
        } catch (err) {
          this.logger.error(
            `per-app split for '${name}' failed: ${(err as Error).message}`,
          );
        }
      }

      this.setMeta(db, 'per_app_split_done', '1');
      this.logger.log(`per-app split complete for ${apps.length} app(s)`);
    } catch (err) {
      // Never let the split brick boot; it will retry next start.
      this.logger.error(`per-app split skipped: ${(err as Error).message}`);
    }
  }

  /** Take a one-shot consistent backup of the global DB next to it. */
  private backupGlobal(db: Db, globalFile: string): void {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = `${globalFile}.bak-${stamp}`;
      if (fs.existsSync(bak)) return;
      db.exec(`VACUUM INTO '${this.sqlPath(bak)}'`);
      this.setMeta(db, 'per_app_split_backup', bak);
      this.logger.log(`global DB backed up to ${bak}`);
    } catch (err) {
      this.logger.warn(
        `global DB backup failed (continuing): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Import legacy `apps/<name>/vods.db` rows (streams, vods) into app.db.
   * Idempotent (guarded by a per-app meta flag + INSERT OR IGNORE) and
   * non-destructive: the legacy vods.db file is left in place as a backup.
   */
  private importLegacyVods(appName: string, adb: Db): void {
    try {
      if (this.getMeta(adb, 'vods_import_done') === '1') return;
      const legacy = path.join(
        this.config.dataDir,
        'apps',
        appName,
        'vods.db',
      );
      if (fs.existsSync(legacy)) {
        adb.exec(`ATTACH '${this.sqlPath(legacy)}' AS legacy`);
        try {
          adb.exec(
            `INSERT OR IGNORE INTO streams
               (id, app_id, stream_id, type, room, participant, status,
                started_at, ended_at, last_stats_json)
             SELECT id, app_id, stream_id, type, room, participant, status,
                started_at, ended_at, last_stats_json
             FROM legacy.streams;
             INSERT OR IGNORE INTO vods
               (id, app_id, stream_id, room, name, file_key, s3_url, public_url,
                size_bytes, duration_s, width, height, format, status,
                local_path, started_at, ended_at, metatags_json, snapshot_key)
             SELECT id, app_id, stream_id, room, name, file_key, s3_url, public_url,
                size_bytes, duration_s, width, height, format, status,
                local_path, started_at, ended_at, metatags_json, snapshot_key
             FROM legacy.vods;`,
          );
        } finally {
          adb.exec('DETACH legacy');
        }
        this.logger.log(`imported legacy vods.db into app.db[${appName}]`);
      }
      this.setMeta(adb, 'vods_import_done', '1');
    } catch (err) {
      this.logger.error(
        `legacy vods import for '${appName}' failed: ${(err as Error).message}`,
      );
    }
  }

  /** Copy this app's ingress_auth rows from the global DB into its app.db. */
  private copyIngressAuth(appName: string, adb: Db, globalFile: string): void {
    if (this.getMeta(adb, 'ingress_import_done') === '1') return;
    adb.exec(`ATTACH '${this.sqlPath(globalFile)}' AS g`);
    try {
      adb
        .prepare(
          `INSERT OR IGNORE INTO ingress_auth
             (ingress_id, app, room, stream_key, password_hash, password_salt,
              requires_password, validated_at, created_at)
           SELECT ingress_id, app, room, stream_key, password_hash, password_salt,
              requires_password, validated_at, created_at
           FROM g.ingress_auth WHERE app = ?`,
        )
        .run(appName);
    } finally {
      adb.exec('DETACH g');
    }
    this.setMeta(adb, 'ingress_import_done', '1');
  }

  // ---------------------------------------------------------------------------
  // Meta key/value helpers (_streamhub_meta)
  // ---------------------------------------------------------------------------

  private getMeta(db: Db, key: string): string | undefined {
    try {
      const row = db
        .prepare('SELECT value FROM _streamhub_meta WHERE key = ?')
        .get(key) as { value: string } | undefined;
      return row?.value;
    } catch {
      return undefined; // table not created yet
    }
  }

  private setMeta(db: Db, key: string, value: string): void {
    db.prepare(
      `INSERT INTO _streamhub_meta (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at`,
    ).run(key, value);
  }

  /** Escape a filesystem path for use inside a single-quoted SQL string. */
  private sqlPath(p: string): string {
    return p.replace(/'/g, "''");
  }

  // ---------------------------------------------------------------------------
  // Open + migrate
  // ---------------------------------------------------------------------------

  private open(file: string, migrations: string[], label: string): Db {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    this.migrate(db, migrations, label);
    return db;
  }

  private migrate(db: Db, migrations: string[], label: string): void {
    const current = db.pragma('user_version', { simple: true }) as number;
    if (current >= migrations.length) return;
    const apply = db.transaction(() => {
      for (let i = current; i < migrations.length; i++) {
        db.exec(migrations[i]);
      }
      db.pragma(`user_version = ${migrations.length}`);
    });
    apply();
    this.logger.log(`migrated ${label}: ${current} -> ${migrations.length}`);
  }
}
