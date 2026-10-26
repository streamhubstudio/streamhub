import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import Database from 'better-sqlite3';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { LOGS_SERVICE, LogsServiceContract } from '../../shared/contracts';
import { BackupSettings, resolveBackupSettings } from './backup-settings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A live SQLite database the backup system knows how to snapshot/restore. */
export interface BackupTarget {
  /** Stable id used in the API + on disk: `streamhub` or `app-<name>`. */
  db: string;
  kind: 'global' | 'app';
  /** App slug when kind === 'app'. */
  app?: string;
  /** Absolute path of the live DB file. */
  dbPath: string;
}

/** One snapshot file on disk. */
export interface SnapshotInfo {
  /** Target id the snapshot belongs to (`streamhub` | `app-<name>`). */
  db: string;
  /** Basename inside `<backupDir>/<db>/`, e.g. `2026-07-06T03-30-00-000Z.db.gz`. */
  file: string;
  sizeBytes: number;
  /** ISO timestamp parsed from the filename (fallback: file mtime). */
  createdAt: string;
  /** True for the automatic safety copy taken right before a restore. */
  preRestore: boolean;
}

export interface BackupDatabaseView {
  db: string;
  kind: 'global' | 'app';
  app?: string;
  dbPath: string;
  /** Size of the LIVE db file; null when the dir exists but the app is gone. */
  liveSizeBytes: number | null;
  /** True when snapshots exist but the target is no longer registered. */
  orphaned: boolean;
  snapshots: SnapshotInfo[];
}

export interface BackupsOverview {
  enabled: boolean;
  retentionDays: number;
  backupDir: string;
  schedule: string;
  databases: BackupDatabaseView[];
}

export interface BackupRunResult {
  ranAt: string;
  reason: string;
  snapshots: SnapshotInfo[];
  /** Per-target failures (the run continues past them). */
  errors: { db: string; error: string }[];
  prunedCount: number;
}

export interface RestoreResult {
  db: string;
  snapshot: string;
  /** The safety copy of the pre-restore live DB (same snapshot folder). */
  preRestoreSnapshot: string;
  integrity: 'ok';
  restored: true;
  /**
   * TRUE for the global DB: the SQLite handle is swapped atomically, but
   * long-lived in-memory state derived from it (casbin policies, caches)
   * refreshes only on process restart. See operations/BACKUPS.md.
   */
  restartRecommended: boolean;
}

/** `<ISO with : . replaced by ->.db.gz`, optionally marked `.pre-restore`. */
const SNAPSHOT_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(\.pre-restore)?\.db\.gz$/;

const GLOBAL_DB = 'streamhub';
const APP_PREFIX = 'app-';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Versioned + compressed backups of every StreamHub SQLite DB (SPEC: in-app
 * backup system).
 *
 * Snapshot = SQLite-safe hot backup: `VACUUM INTO` a temp file (consistent
 * through WAL, never a raw copy of a live DB) → gzip → atomic rename to
 * `<backupDir>/<db>/<stamp>.db.gz`. Retention prunes snapshots older than
 * `retentionDays` after every run.
 *
 * Restore safety (destructive — mirrors the purge/destroy mindset):
 *   1. snapshot filename + target validated (no path traversal),
 *   2. gunzip to a temp file NEXT TO the live DB (same fs → atomic rename)
 *      and `PRAGMA integrity_check` BEFORE anything is touched,
 *   3. a fresh `.pre-restore` safety snapshot of the current live DB,
 *   4. wal_checkpoint(TRUNCATE) → close/rename/reopen — all synchronous in
 *      one event-loop tick, so no other request can interleave,
 *   5. audit-logged via LOGS_SERVICE.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);
  readonly settings: BackupSettings;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    @Optional()
    @Inject(LOGS_SERVICE)
    private readonly logs?: LogsServiceContract,
  ) {
    this.settings = resolveBackupSettings(config);
  }

  // ---- targets ----------------------------------------------------------

  /** Every live DB: the global registry + one per registered app. */
  targets(): BackupTarget[] {
    const out: BackupTarget[] = [
      { db: GLOBAL_DB, kind: 'global', dbPath: this.db.globalDbPath() },
    ];
    const apps = this.db
      .global()
      .prepare('SELECT name FROM apps ORDER BY name')
      .all() as { name: string }[];
    for (const { name } of apps) {
      out.push({
        db: `${APP_PREFIX}${name}`,
        kind: 'app',
        app: name,
        dbPath: this.db.appDbPath(name),
      });
    }
    return out;
  }

  private findTarget(dbId: string): BackupTarget | undefined {
    return this.targets().find((t) => t.db === dbId);
  }

  // ---- listing ----------------------------------------------------------

  /** Snapshot inventory per DB (known targets + orphaned snapshot dirs). */
  overview(): BackupsOverview {
    const targets = this.targets();
    const known = new Map(targets.map((t) => [t.db, t]));
    const databases: BackupDatabaseView[] = targets.map((t) => ({
      db: t.db,
      kind: t.kind,
      app: t.app,
      dbPath: t.dbPath,
      liveSizeBytes: this.fileSize(t.dbPath),
      orphaned: false,
      snapshots: this.listSnapshots(t.db),
    }));

    // Snapshot dirs whose target no longer exists (e.g. a deleted app): still
    // listed so the operator can see the files, but restore refuses them.
    for (const dir of this.snapshotDirs()) {
      if (known.has(dir)) continue;
      databases.push({
        db: dir,
        kind: dir.startsWith(APP_PREFIX) ? 'app' : 'global',
        app: dir.startsWith(APP_PREFIX)
          ? dir.slice(APP_PREFIX.length)
          : undefined,
        dbPath: '',
        liveSizeBytes: null,
        orphaned: true,
        snapshots: this.listSnapshots(dir),
      });
    }

    return {
      enabled: this.settings.enabled,
      retentionDays: this.settings.retentionDays,
      backupDir: this.settings.backupDir,
      schedule: this.settings.cron,
      databases,
    };
  }

  /** Snapshots of one DB, newest first. */
  listSnapshots(dbId: string): SnapshotInfo[] {
    const dir = path.join(this.settings.backupDir, dbId);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: SnapshotInfo[] = [];
    for (const file of entries) {
      const m = SNAPSHOT_RE.exec(file);
      if (!m) continue;
      const full = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      out.push({
        db: dbId,
        file,
        sizeBytes: stat.size,
        createdAt: this.stampToIso(m[1]) ?? stat.mtime.toISOString(),
        preRestore: m[2] !== undefined,
      });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  /** Milliseconds since the NEWEST snapshot of any DB; Infinity when none. */
  newestSnapshotAgeMs(now = Date.now()): number {
    let newest = 0;
    for (const dir of this.snapshotDirs()) {
      for (const s of this.listSnapshots(dir)) {
        const t = Date.parse(s.createdAt);
        if (!Number.isNaN(t) && t > newest) newest = t;
      }
    }
    return newest === 0 ? Number.POSITIVE_INFINITY : now - newest;
  }

  // ---- backup -----------------------------------------------------------

  /** Snapshot EVERY db (global + per-app), then prune. Never throws per-target. */
  async runBackup(reason: string, actor?: string): Promise<BackupRunResult> {
    const ranAt = new Date().toISOString();
    const snapshots: SnapshotInfo[] = [];
    const errors: { db: string; error: string }[] = [];

    for (const target of this.targets()) {
      try {
        snapshots.push(await this.backupTarget(target));
      } catch (err) {
        const msg = (err as Error).message;
        errors.push({ db: target.db, error: msg });
        this.logger.error(`backup of ${target.db} failed: ${msg}`);
      }
    }

    const prunedCount = this.prune();

    this.logs?.write(
      errors.length > 0 ? 'warn' : 'info',
      'backups',
      `backup run (${reason}): ${snapshots.length} snapshot(s), ` +
        `${errors.length} error(s), ${prunedCount} pruned`,
      { reason, actor: actor ?? null, errors },
    );

    return { ranAt, reason, snapshots, errors, prunedCount };
  }

  /**
   * Hot-backup ONE db: `VACUUM INTO` a temp file (safe on a live WAL db —
   * never a raw file copy), gzip it, and atomically rename into place.
   */
  async backupTarget(
    target: BackupTarget,
    opts: { preRestore?: boolean } = {},
  ): Promise<SnapshotInfo> {
    const dir = path.join(this.settings.backupDir, target.db);
    fs.mkdirSync(dir, { recursive: true });

    // Unique, filesystem-safe stamp (bump ms on collision).
    let when = new Date();
    let file = this.snapshotName(when, opts.preRestore === true);
    while (fs.existsSync(path.join(dir, file))) {
      when = new Date(when.getTime() + 1);
      file = this.snapshotName(when, opts.preRestore === true);
    }
    const final = path.join(dir, file);
    const tmpDb = path.join(dir, `.tmp-${process.pid}-${when.getTime()}.db`);
    const tmpGz = `${tmpDb}.gz`;

    const handle =
      target.kind === 'global'
        ? this.db.global()
        : this.db.appDb(target.app as string);

    try {
      handle.exec(`VACUUM INTO '${this.sqlPath(tmpDb)}'`);
      await pipeline(
        fs.createReadStream(tmpDb),
        createGzip(),
        fs.createWriteStream(tmpGz),
      );
      fs.renameSync(tmpGz, final); // atomic within the snapshot dir
    } finally {
      fs.rmSync(tmpDb, { force: true });
      fs.rmSync(tmpGz, { force: true });
    }

    const stat = fs.statSync(final);
    return {
      db: target.db,
      file,
      sizeBytes: stat.size,
      createdAt: when.toISOString(),
      preRestore: opts.preRestore === true,
    };
  }

  // ---- retention --------------------------------------------------------

  /**
   * Delete snapshots older than `retentionDays` across EVERY snapshot dir
   * (incl. dirs of deleted apps). `retentionDays === 0` disables pruning.
   */
  prune(now = Date.now()): number {
    const days = this.settings.retentionDays;
    if (days <= 0) return 0;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const dir of this.snapshotDirs()) {
      for (const snap of this.listSnapshots(dir)) {
        const t = Date.parse(snap.createdAt);
        if (Number.isNaN(t) || t >= cutoff) continue;
        try {
          fs.rmSync(path.join(this.settings.backupDir, dir, snap.file), {
            force: true,
          });
          removed += 1;
        } catch (err) {
          this.logger.warn(
            `prune of ${dir}/${snap.file} failed: ${(err as Error).message}`,
          );
        }
      }
    }
    if (removed > 0) this.logger.log(`pruned ${removed} expired snapshot(s)`);
    return removed;
  }

  // ---- restore ----------------------------------------------------------

  /**
   * Restore a snapshot over the live DB. Destructive — the controller
   * additionally requires `confirm: true`. Sequence: validate names →
   * gunzip to a temp copy → `PRAGMA integrity_check` (abort on anything but
   * `ok`) → pre-restore safety snapshot → synchronous checkpoint/swap/reopen.
   */
  async restore(
    dbId: string,
    snapshotFile: string,
    actor?: string,
  ): Promise<RestoreResult> {
    const target = this.findTarget(dbId);
    if (!target) {
      throw new NotFoundException(
        `unknown database '${dbId}' — restore only targets the global ` +
          `registry ('${GLOBAL_DB}') or a registered app ('${APP_PREFIX}<name>')`,
      );
    }
    if (!SNAPSHOT_RE.test(snapshotFile)) {
      throw new BadRequestException(
        `invalid snapshot name '${snapshotFile}'`,
      );
    }
    const snapshotPath = path.join(
      this.settings.backupDir,
      target.db,
      snapshotFile,
    );
    if (!fs.existsSync(snapshotPath)) {
      throw new NotFoundException(
        `snapshot '${snapshotFile}' not found for '${dbId}'`,
      );
    }

    // 1) Decompress NEXT TO the live DB (same filesystem → atomic rename).
    const liveDir = path.dirname(target.dbPath);
    fs.mkdirSync(liveDir, { recursive: true });
    const restoreTmp = path.join(
      liveDir,
      `.restore-${process.pid}-${Date.now()}.db`,
    );
    try {
      await pipeline(
        fs.createReadStream(snapshotPath),
        createGunzip(),
        fs.createWriteStream(restoreTmp),
      );
    } catch (err) {
      fs.rmSync(restoreTmp, { force: true });
      throw new BadRequestException(
        `snapshot '${snapshotFile}' is not a valid gzip file: ` +
          `${(err as Error).message}`,
      );
    }

    // 2) Integrity gate BEFORE touching the live DB.
    this.assertIntegrity(restoreTmp, snapshotFile);

    // 3) Fresh safety snapshot of the CURRENT live DB.
    const pre = await this.backupTarget(target, { preRestore: true });

    // 4) Swap. Everything below is synchronous — better-sqlite3 + fs sync
    //    calls in one event-loop tick, so no other request can observe or
    //    write through a half-swapped handle.
    try {
      if (target.kind === 'app') {
        const app = target.app as string;
        this.db.appDb(app).pragma('wal_checkpoint(TRUNCATE)');
        this.db.closeApp(app);
        this.removeWalShm(target.dbPath);
        fs.renameSync(restoreTmp, target.dbPath);
        this.db.appDb(app); // reopen + re-run migrations on the restored file
      } else {
        this.db.global().pragma('wal_checkpoint(TRUNCATE)');
        fs.renameSync(restoreTmp, target.dbPath);
        this.removeWalShm(target.dbPath);
        this.db.reopenGlobal(); // close old handle + open the restored file
      }
    } finally {
      fs.rmSync(restoreTmp, { force: true });
    }

    const restartRecommended = target.kind === 'global';
    this.logs?.write(
      'warn',
      'backups',
      `RESTORED ${target.db} from snapshot ${snapshotFile}`,
      {
        actor: actor ?? null,
        db: target.db,
        snapshot: snapshotFile,
        preRestoreSnapshot: pre.file,
        restartRecommended,
      },
    );
    this.logger.warn(
      `restored ${target.db} from ${snapshotFile} ` +
        `(safety copy: ${pre.file}, actor: ${actor ?? 'n/a'})`,
    );

    return {
      db: target.db,
      snapshot: snapshotFile,
      preRestoreSnapshot: pre.file,
      integrity: 'ok',
      restored: true,
      restartRecommended,
    };
  }

  /** Open the candidate read-only and require `PRAGMA integrity_check` = ok. */
  private assertIntegrity(file: string, label: string): void {
    let candidate: Database.Database | undefined;
    try {
      candidate = new Database(file, { readonly: true, fileMustExist: true });
      const result = candidate.pragma('integrity_check', {
        simple: true,
      }) as string;
      if (result !== 'ok') {
        throw new Error(`integrity_check reported: ${result}`);
      }
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw new BadRequestException(
        `snapshot '${label}' failed integrity validation — restore aborted, ` +
          `live DB untouched (${(err as Error).message})`,
      );
    } finally {
      candidate?.close();
    }
  }

  // ---- helpers ----------------------------------------------------------

  /** Subdirectories of the backup root (one per DB). */
  private snapshotDirs(): string[] {
    try {
      return fs
        .readdirSync(this.settings.backupDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  private snapshotName(when: Date, preRestore: boolean): string {
    const stamp = when.toISOString().replace(/[:.]/g, '-');
    return `${stamp}${preRestore ? '.pre-restore' : ''}.db.gz`;
  }

  /** `2026-07-06T03-30-00-000Z` → `2026-07-06T03:30:00.000Z`. */
  private stampToIso(stamp: string): string | null {
    const m =
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
    if (!m) return null;
    return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  }

  private fileSize(file: string): number | null {
    try {
      return fs.statSync(file).size;
    } catch {
      return null;
    }
  }

  /** Remove stale -wal/-shm siblings (they belong to the pre-swap inode). */
  private removeWalShm(dbPath: string): void {
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }

  /** Escape a filesystem path for use inside a single-quoted SQL string. */
  private sqlPath(p: string): string {
    return p.replace(/'/g, "''");
  }
}
