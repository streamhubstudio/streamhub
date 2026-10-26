/**
 * Unit — backups/BackupsService (SQLite snapshot + retention + restore).
 *
 * Invariants locked down:
 *  - a backup run snapshots EVERY db (global + each registered app) via
 *    VACUUM INTO + gzip: the .db.gz decompresses to a real SQLite file that
 *    passes integrity_check and contains the live rows,
 *  - listing reports size + timestamp per snapshot, newest first,
 *  - retention prunes snapshots older than the window (default 7d, env
 *    override honoured, 0 disables pruning),
 *  - restore validates integrity BEFORE swapping and REFUSES a corrupt
 *    snapshot leaving the live DB untouched,
 *  - restore takes a .pre-restore safety snapshot of the current DB first,
 *  - restoring the global DB reopens the handle and flags
 *    restartRecommended; app restore does not,
 *  - unknown db / bad snapshot names are rejected (404/400, no traversal),
 *  - backup + restore are audit-logged via LOGS_SERVICE.
 */
import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync } from 'zlib';
import Database from 'better-sqlite3';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { BackupsService, type SnapshotInfo } from './backups.service';

const ENV_KEYS = [
  'STREAMHUB_BACKUPS_ENABLED',
  'STREAMHUB_BACKUP_RETENTION_DAYS',
  'STREAMHUB_BACKUP_DIR',
  'STREAMHUB_BACKUP_CRON',
];

describe('backups/BackupsService', () => {
  let ctx: UnitContext;
  let service: BackupsService;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    ctx = makeUnitContext();
    // Register one app in the global registry + open its app.db.
    ctx.db
      .global()
      .prepare('INSERT INTO apps (name, display_name) VALUES (?, ?)')
      .run('live', 'Live');
    ctx.db.appDb('live');
    service = newService();
  });

  afterEach(() => {
    ctx.cleanup();
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  function newService(): BackupsService {
    return ctx.newService(BackupsService, ctx.config, ctx.db, ctx.mocks.logs);
  }

  /** Decompress a snapshot and open it as a real SQLite DB. */
  function openSnapshot(snap: SnapshotInfo): Database.Database {
    const gz = path.join(service.settings.backupDir, snap.db, snap.file);
    const raw = gunzipSync(fs.readFileSync(gz));
    const tmp = path.join(ctx.dataDir, `inspect-${Date.now()}.db`);
    fs.writeFileSync(tmp, raw);
    return new Database(tmp, { readonly: true });
  }

  /** Plant a snapshot file with a filename stamp `agedDays` in the past. */
  function plantAgedSnapshot(db: string, agedDays: number): string {
    const when = new Date(Date.now() - agedDays * 24 * 60 * 60 * 1000);
    const file = `${when.toISOString().replace(/[:.]/g, '-')}.db.gz`;
    const dir = path.join(service.settings.backupDir, db);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'stale');
    return file;
  }

  // ---- targets ----------------------------------------------------------

  it('targets EVERY db: the global registry + each registered app', () => {
    expect(service.targets().map((t) => t.db)).toEqual([
      'streamhub',
      'app-live',
    ]);
    const app = service.targets().find((t) => t.db === 'app-live');
    expect(app?.kind).toBe('app');
    expect(app?.dbPath).toBe(path.join(ctx.dataDir, 'apps', 'live', 'app.db'));
  });

  // ---- backup -----------------------------------------------------------

  it('runBackup creates a valid gzipped snapshot of every db', async () => {
    ctx.db
      .global()
      .prepare('INSERT INTO apps (name) VALUES (?)')
      .run('marker-app');

    const run = await service.runBackup('manual', 'tester');

    expect(run.errors).toEqual([]);
    // marker-app had no app.db yet — targets() creates it via appDb().
    expect(run.snapshots.map((s) => s.db).sort()).toEqual([
      'app-live',
      'app-marker-app',
      'streamhub',
    ]);

    const globalSnap = run.snapshots.find((s) => s.db === 'streamhub')!;
    const file = path.join(
      service.settings.backupDir,
      'streamhub',
      globalSnap.file,
    );
    expect(fs.existsSync(file)).toBe(true);
    expect(globalSnap.sizeBytes).toBeGreaterThan(0);

    const snapDb = openSnapshot(globalSnap);
    expect(snapDb.pragma('integrity_check', { simple: true })).toBe('ok');
    const rows = snapDb
      .prepare('SELECT name FROM apps ORDER BY name')
      .all() as { name: string }[];
    snapDb.close();
    expect(rows.map((r) => r.name)).toEqual(['live', 'marker-app']);

    // audit-logged
    expect(ctx.mocks.logs.write).toHaveBeenCalledWith(
      'info',
      'backups',
      expect.stringContaining('backup run (manual)'),
      expect.objectContaining({ reason: 'manual', actor: 'tester' }),
    );
  });

  it('snapshots are safe hot-backups (VACUUM INTO), never raw copies: live WAL rows are included', async () => {
    // In WAL mode a raw file copy would MISS uncheckpointed rows. VACUUM INTO
    // reads through the WAL, so the snapshot must contain this fresh insert.
    ctx.db
      .global()
      .prepare('INSERT INTO apps (name) VALUES (?)')
      .run('fresh-in-wal');
    const snap = await service.backupTarget(
      service.targets().find((t) => t.db === 'streamhub')!,
    );
    const snapDb = openSnapshot(snap);
    const row = snapDb
      .prepare('SELECT name FROM apps WHERE name = ?')
      .get('fresh-in-wal');
    snapDb.close();
    expect(row).toBeDefined();
  });

  it('lists snapshots with size + timestamp, newest first, per db', async () => {
    await service.runBackup('manual');
    await service.runBackup('manual');

    const list = service.listSnapshots('streamhub');
    expect(list).toHaveLength(2);
    expect(Date.parse(list[0].createdAt)).toBeGreaterThanOrEqual(
      Date.parse(list[1].createdAt),
    );
    for (const s of list) {
      expect(s.sizeBytes).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(s.createdAt))).toBe(false);
      expect(s.preRestore).toBe(false);
    }

    const overview = service.overview();
    expect(overview.retentionDays).toBe(7);
    const global = overview.databases.find((d) => d.db === 'streamhub')!;
    expect(global.snapshots).toHaveLength(2);
    expect(global.liveSizeBytes).toBeGreaterThan(0);
    expect(global.orphaned).toBe(false);
  });

  // ---- retention --------------------------------------------------------

  it('prunes snapshots older than 7 days (default) and keeps fresh ones', async () => {
    const old = plantAgedSnapshot('streamhub', 8);
    const fresh = plantAgedSnapshot('streamhub', 6);

    const removed = service.prune();

    expect(removed).toBe(1);
    const files = service.listSnapshots('streamhub').map((s) => s.file);
    expect(files).toContain(fresh);
    expect(files).not.toContain(old);
  });

  it('honours STREAMHUB_BACKUP_RETENTION_DAYS override (and 0 = keep forever)', () => {
    process.env.STREAMHUB_BACKUP_RETENTION_DAYS = '2';
    let svc = newService();
    expect(svc.settings.retentionDays).toBe(2);
    const old = plantAgedSnapshot('streamhub', 3);
    plantAgedSnapshot('streamhub', 1);
    expect(svc.prune()).toBe(1);
    expect(svc.listSnapshots('streamhub').map((s) => s.file)).not.toContain(
      old,
    );

    process.env.STREAMHUB_BACKUP_RETENTION_DAYS = '0';
    svc = newService();
    plantAgedSnapshot('streamhub', 400);
    expect(svc.prune()).toBe(0);
  });

  it('a backup run prunes expired snapshots (incl. orphaned dirs of deleted apps)', async () => {
    plantAgedSnapshot('app-deleted-long-ago', 30);
    const run = await service.runBackup('scheduled');
    expect(run.prunedCount).toBe(1);
    expect(service.listSnapshots('app-deleted-long-ago')).toHaveLength(0);
  });

  // ---- restore ----------------------------------------------------------

  it('restores an app snapshot: integrity ok, safety copy first, data rolled back', async () => {
    const adb = ctx.db.appDb('live');
    adb
      .prepare(
        `INSERT INTO streams (app_id, stream_id, type, status)
         VALUES (1, 'keep-me', 'rtmp', 'ended')`,
      )
      .run();

    const snap = await service.backupTarget(
      service.targets().find((t) => t.db === 'app-live')!,
    );

    // Mutate AFTER the snapshot — the restore must roll this back.
    ctx.db
      .appDb('live')
      .prepare(
        `INSERT INTO streams (app_id, stream_id, type, status)
         VALUES (1, 'lose-me', 'rtmp', 'ended')`,
      )
      .run();

    const res = await service.restore('app-live', snap.file, 'tester');

    expect(res.restored).toBe(true);
    expect(res.integrity).toBe('ok');
    expect(res.restartRecommended).toBe(false);

    const ids = (
      ctx.db
        .appDb('live')
        .prepare('SELECT stream_id FROM streams ORDER BY stream_id')
        .all() as { stream_id: string }[]
    ).map((r) => r.stream_id);
    expect(ids).toEqual(['keep-me']);

    // The safety copy exists AND preserves the pre-restore state ('lose-me').
    const pre = service
      .listSnapshots('app-live')
      .find((s) => s.file === res.preRestoreSnapshot);
    expect(pre).toBeDefined();
    expect(pre!.preRestore).toBe(true);
    const preDb = openSnapshot(pre!);
    const preIds = (
      preDb
        .prepare('SELECT stream_id FROM streams ORDER BY stream_id')
        .all() as { stream_id: string }[]
    ).map((r) => r.stream_id);
    preDb.close();
    expect(preIds).toEqual(['keep-me', 'lose-me']);

    // audit-logged as a warn-level event with the actor.
    expect(ctx.mocks.logs.write).toHaveBeenCalledWith(
      'warn',
      'backups',
      expect.stringContaining('RESTORED app-live'),
      expect.objectContaining({ actor: 'tester', snapshot: snap.file }),
    );
  });

  it('restores the GLOBAL db, reopens the handle and recommends a restart', async () => {
    const snap = await service.backupTarget(
      service.targets().find((t) => t.db === 'streamhub')!,
    );
    ctx.db
      .global()
      .prepare('INSERT INTO apps (name) VALUES (?)')
      .run('added-after-snap');

    const res = await service.restore('streamhub', snap.file);

    expect(res.restartRecommended).toBe(true);
    // The reopened handle serves the RESTORED file: the row is gone and the
    // handle stays fully usable.
    const names = (
      ctx.db.global().prepare('SELECT name FROM apps ORDER BY name').all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(['live']);
    ctx.db.global().prepare('INSERT INTO apps (name) VALUES (?)').run('post');
    expect(
      ctx.db.global().prepare('SELECT COUNT(*) c FROM apps').get(),
    ).toEqual({ c: 2 });
  });

  it('REFUSES a corrupt snapshot: integrity gate fires before any swap', async () => {
    const good = await service.backupTarget(
      service.targets().find((t) => t.db === 'app-live')!,
    );
    // Plant a corrupt sibling: valid gzip, garbage payload (not SQLite).
    const dir = path.join(service.settings.backupDir, 'app-live');
    const corrupt = '2020-01-01T00-00-00-000Z.db.gz';
    const { gzipSync } = await import('zlib');
    fs.writeFileSync(
      path.join(dir, corrupt),
      gzipSync(Buffer.from('this is not a sqlite database at all')),
    );

    const before = fs.readFileSync(
      path.join(ctx.dataDir, 'apps', 'live', 'app.db'),
    );
    await expect(service.restore('app-live', corrupt)).rejects.toThrow(
      BadRequestException,
    );
    // Live DB untouched, byte for byte; no pre-restore copy was created.
    const after = fs.readFileSync(
      path.join(ctx.dataDir, 'apps', 'live', 'app.db'),
    );
    expect(after.equals(before)).toBe(true);
    expect(
      service.listSnapshots('app-live').filter((s) => s.preRestore),
    ).toHaveLength(0);
    // The good snapshot still restores fine afterwards.
    await expect(service.restore('app-live', good.file)).resolves.toMatchObject(
      { restored: true },
    );
  });

  it('rejects a snapshot that is not even gzip', async () => {
    const dir = path.join(service.settings.backupDir, 'streamhub');
    fs.mkdirSync(dir, { recursive: true });
    const bogus = '2020-01-01T00-00-00-000Z.db.gz';
    fs.writeFileSync(path.join(dir, bogus), 'plain text, no gzip magic');
    await expect(service.restore('streamhub', bogus)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects unknown databases and traversal-shaped snapshot names', async () => {
    await expect(service.restore('app-nope', 'x.db.gz')).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      service.restore('streamhub', '../../../etc/passwd'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.restore('streamhub', 'not-a-stamp.db.gz'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.restore('streamhub', '2099-01-01T00-00-00-000Z.db.gz'),
    ).rejects.toThrow(NotFoundException); // valid shape, missing file
  });

  // ---- misc -------------------------------------------------------------

  it('newestSnapshotAgeMs: Infinity when empty, then the freshest stamp wins', async () => {
    expect(service.newestSnapshotAgeMs()).toBe(Number.POSITIVE_INFINITY);
    await service.runBackup('manual');
    expect(service.newestSnapshotAgeMs()).toBeLessThan(60_000);
  });

  it('honours the STREAMHUB_BACKUP_DIR override', async () => {
    const custom = path.join(ctx.dataDir, 'elsewhere');
    process.env.STREAMHUB_BACKUP_DIR = custom;
    const svc = newService();
    expect(svc.settings.backupDir).toBe(custom);
    await svc.runBackup('manual');
    expect(fs.existsSync(path.join(custom, 'streamhub'))).toBe(true);
  });
});
