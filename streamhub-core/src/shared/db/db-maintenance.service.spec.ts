/**
 * Unit specs for DbMaintenanceService (module db-health-maintenance).
 *
 * Runs against REAL migrated, isolated SQLite DBs (the global streamhub.db and
 * a per-app app.db) via the harness (makeUnitContext → createTestDb). Covers the
 * health snapshot shape (page/freelist counts, fragmentation %, per-table rows),
 * the optimize before/after report, and the non-cascading purges (streams rows +
 * the app's global server_logs).
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { DbMaintenanceService } from './db-maintenance.service';
import { VodsRepository, type VodInsert } from '../../modules/recording/vods.repository';

const APP = 'live';

function vodFixture(over: Partial<VodInsert> = {}): VodInsert {
  return {
    appId: 1,
    streamId: 'stream-a',
    room: 'room-a',
    name: 'rec.mp4',
    status: 'ready',
    localPath: '/data/apps/live/recordings/rec.mp4',
    startedAt: new Date().toISOString(),
    metatagsJson: '{}',
    ...over,
  };
}

/** Register an app in the global registry and return its id. */
function seedApp(db: UnitContext['db'], name: string): number {
  const info = db
    .global()
    .prepare('INSERT INTO apps (name) VALUES (?)')
    .run(name);
  return Number(info.lastInsertRowid);
}

describe('DbMaintenanceService', () => {
  let ctx: UnitContext;
  let svc: DbMaintenanceService;
  let repo: VodsRepository;

  beforeEach(() => {
    ctx = makeUnitContext();
    svc = new DbMaintenanceService(ctx.db);
    repo = new VodsRepository(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  // ---- health ----------------------------------------------------------
  describe('appHealth()', () => {
    it('reports path, sizes, page/freelist counts, fragmentation and tables', () => {
      repo.insert(APP, vodFixture());
      repo.insert(APP, vodFixture({ name: 'rec2.mp4' }));

      const h = svc.appHealth(APP);
      expect(h.path).toBe(ctx.db.appDbPath(APP));
      expect(h.path.endsWith('app.db')).toBe(true);
      expect(h.sizeBytes).toBeGreaterThan(0);
      expect(h.walSizeBytes).toBeGreaterThanOrEqual(0);
      expect(h.pageCount).toBeGreaterThan(0);
      expect(h.freelistCount).toBeGreaterThanOrEqual(0);
      expect(h.fragmentationPct).toBeGreaterThanOrEqual(0);
      expect(h.fragmentationPct).toBeLessThanOrEqual(100);

      const vods = h.tables.find((t) => t.name === 'vods');
      expect(vods?.rows).toBe(2);
      // streams table exists in app.db with zero rows.
      expect(h.tables.find((t) => t.name === 'streams')?.rows).toBe(0);
      // internal sqlite_* tables are excluded.
      expect(h.tables.some((t) => t.name.startsWith('sqlite_'))).toBe(false);
    });
  });

  describe('globalHealth()', () => {
    it('reports the global registry DB with its tables', () => {
      seedApp(ctx.db, 'a1');
      const h = svc.globalHealth();
      expect(h.path).toBe(ctx.db.globalDbPath());
      expect(h.path.endsWith('streamhub.db')).toBe(true);
      const apps = h.tables.find((t) => t.name === 'apps');
      expect(apps?.rows).toBe(1);
      expect(h.tables.some((t) => t.name === 'server_logs')).toBe(true);
    });
  });

  // ---- optimize --------------------------------------------------------
  describe('optimizeApp()', () => {
    it('runs the full tune-up and returns before/after sizes', () => {
      // Create then delete churn so VACUUM has freelist pages to reclaim.
      const ids: number[] = [];
      for (let i = 0; i < 50; i++) ids.push(repo.insert(APP, vodFixture({ name: `r${i}.mp4` })));
      for (const id of ids) repo.delete(APP, id);

      const res = svc.optimizeApp(APP);
      expect(res.path).toBe(ctx.db.appDbPath(APP));
      expect(res.steps).toEqual(
        expect.arrayContaining([
          'PRAGMA optimize',
          'ANALYZE',
          'REINDEX',
          'VACUUM',
          'wal_checkpoint(TRUNCATE)',
        ]),
      );
      expect(res.before.sizeBytes).toBeGreaterThan(0);
      expect(res.after.sizeBytes).toBeGreaterThan(0);
      expect(res.reclaimedBytes).toBeGreaterThanOrEqual(0);
      // After VACUUM + a TRUNCATE checkpoint the DB is still fully usable.
      expect(() => repo.list(APP)).not.toThrow();
    });
  });

  // ---- purge (non-cascading) ------------------------------------------
  describe('purgeAppStreams()', () => {
    it('deletes all streams rows and returns the count', () => {
      const adb = ctx.db.appDb(APP);
      const ins = adb.prepare(
        `INSERT INTO streams (app_id, stream_id, type, room, status)
           VALUES (1, ?, 'webrtc', 'room-a', 'ended')`,
      );
      ins.run('s1');
      ins.run('s2');
      expect(svc.purgeAppStreams(APP)).toBe(2);
      expect(
        (adb.prepare('SELECT COUNT(*) c FROM streams').get() as { c: number }).c,
      ).toBe(0);
    });
  });

  describe('purgeAppLogs()', () => {
    it("deletes only the app's server_logs rows (scoped by app_id)", () => {
      const appId = seedApp(ctx.db, APP);
      const otherId = seedApp(ctx.db, 'other');
      const gdb = ctx.db.global();
      const log = gdb.prepare(
        `INSERT INTO server_logs (level, source, app_id, message)
           VALUES ('info', 'test', ?, ?)`,
      );
      log.run(appId, 'a');
      log.run(appId, 'b');
      log.run(otherId, 'c');

      expect(svc.purgeAppLogs(APP)).toBe(2);
      const remaining = (
        gdb.prepare('SELECT COUNT(*) c FROM server_logs').get() as { c: number }
      ).c;
      expect(remaining).toBe(1); // the 'other' app's log survives
    });

    it('returns 0 for an unknown app', () => {
      expect(svc.purgeAppLogs('nope')).toBe(0);
    });
  });
});
