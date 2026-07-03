/**
 * Unit specs for DbSizesService (shared/db).
 *
 * Runs against REAL migrated, isolated SQLite DBs (the global streamhub.db and
 * per-app app.db) via the harness (makeUnitContext → createTestDb). Covers the
 * per-app DB + VOD rollup (appSizes) and the server-wide aggregate
 * (serverSizes), including the SUM(size_bytes) VOD totals.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { DbSizesService } from './db-sizes.service';
import { VodsRepository, type VodInsert } from '../../modules/recording/vods.repository';

function vodFixture(over: Partial<VodInsert> = {}): VodInsert {
  return {
    appId: 1,
    streamId: 'stream-a',
    room: 'room-a',
    name: 'rec.mp4',
    status: 'ready',
    localPath: '/data/apps/x/recordings/rec.mp4',
    startedAt: new Date().toISOString(),
    metatagsJson: '{}',
    ...over,
  };
}

/** Register an app in the global registry and return its id. */
function seedApp(db: UnitContext['db'], name: string): number {
  const info = db.global().prepare('INSERT INTO apps (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

/** Insert a ready VOD with an explicit size (bytes). */
function seedVod(repo: VodsRepository, app: string, sizeBytes: number | null): void {
  const id = repo.insert(app, vodFixture());
  repo.update(app, id, { status: 'ready', sizeBytes });
}

describe('DbSizesService', () => {
  let ctx: UnitContext;
  let svc: DbSizesService;
  let repo: VodsRepository;

  beforeEach(() => {
    ctx = makeUnitContext();
    svc = new DbSizesService(ctx.db);
    repo = new VodsRepository(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  describe('appVodTotals()', () => {
    it('sums size_bytes and counts rows (nulls counted as 0)', () => {
      seedApp(ctx.db, 'live');
      seedVod(repo, 'live', 1000);
      seedVod(repo, 'live', 2500);
      seedVod(repo, 'live', null); // null size still counts as a row, 0 bytes

      const totals = svc.appVodTotals('live');
      expect(totals.vodTotalBytes).toBe(3500);
      expect(totals.vodCount).toBe(3);
    });

    it('returns zeros for an app with no VODs', () => {
      seedApp(ctx.db, 'empty');
      expect(svc.appVodTotals('empty')).toEqual({ vodTotalBytes: 0, vodCount: 0 });
    });
  });

  describe('appSizes()', () => {
    it('reports the app.db size (>0 once opened) plus VOD totals', () => {
      seedApp(ctx.db, 'live');
      seedVod(repo, 'live', 4096);

      const s = svc.appSizes('live');
      expect(s.app).toBe('live');
      expect(s.dbSizeBytes).toBeGreaterThan(0);
      expect(s.vodTotalBytes).toBe(4096);
      expect(s.vodCount).toBe(1);
    });
  });

  describe('serverSizes()', () => {
    it('aggregates the global DB, per-app DBs and every VOD', () => {
      seedApp(ctx.db, 'a1');
      seedApp(ctx.db, 'a2');
      seedVod(repo, 'a1', 1000);
      seedVod(repo, 'a2', 2000);
      seedVod(repo, 'a2', 3000);

      const s = svc.serverSizes();

      // Global registry DB is a real, migrated file.
      expect(s.dbSizeBytes).toBeGreaterThan(0);
      // Two app.db files, both opened → non-zero footprint.
      expect(s.appsDbSizeBytes).toBeGreaterThan(0);
      expect(s.totalDbSizeBytes).toBe(s.dbSizeBytes + s.appsDbSizeBytes);

      // VOD rollup across both apps.
      expect(s.vodTotalBytes).toBe(6000);
      expect(s.vodCount).toBe(3);

      // Per-app breakdown present and consistent.
      expect(s.apps.map((a) => a.app).sort()).toEqual(['a1', 'a2']);
      const a2 = s.apps.find((a) => a.app === 'a2');
      expect(a2?.vodTotalBytes).toBe(5000);
      expect(a2?.vodCount).toBe(2);
      // Sum of per-app db sizes equals the aggregate.
      const perApp = s.apps.reduce((n, a) => n + a.dbSizeBytes, 0);
      expect(perApp).toBe(s.appsDbSizeBytes);
    });

    it('handles a server with no apps (only the global DB)', () => {
      const s = svc.serverSizes();
      expect(s.apps).toEqual([]);
      expect(s.appsDbSizeBytes).toBe(0);
      expect(s.vodTotalBytes).toBe(0);
      expect(s.vodCount).toBe(0);
      expect(s.dbSizeBytes).toBeGreaterThan(0);
      expect(s.totalDbSizeBytes).toBe(s.dbSizeBytes);
    });
  });
});
