/**
 * Unit specs for LogsService (module logs).
 *
 * Runs against a REAL migrated, isolated SQLite DB (the global streamhub.db) via
 * the harness (makeUnitContext → createTestDb). Covers:
 *   - per-app attribution from `meta.app` (resolve + cache, explicit id wins,
 *     unknown app → NULL),
 *   - the `source`/`q` read filters (incl. LIKE escaping),
 *   - age-based retention purge of `server_logs` (LOG_RETENTION_DAYS, 0 = off).
 *
 * No infra: pino writes to fd 1, the rotating file to the temp DATA_DIR.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { LogsService } from './logs.service';

/** Register an app in the global registry and return its id. */
function seedApp(ctx: UnitContext, name: string): number {
  const info = ctx.db
    .global()
    .prepare('INSERT INTO apps (name) VALUES (?)')
    .run(name);
  return Number(info.lastInsertRowid);
}

/** Newest `server_logs` row. */
function latestRow(
  ctx: UnitContext,
): { app_id: number | null; message: string; source: string } {
  return ctx.db
    .global()
    .prepare(
      'SELECT app_id, message, source FROM server_logs ORDER BY id DESC LIMIT 1',
    )
    .get() as { app_id: number | null; message: string; source: string };
}

/** Insert a raw row with an explicit timestamp (for retention tests). */
function insertAt(
  ctx: UnitContext,
  ts: string,
  message: string,
  appId: number | null = null,
): void {
  ctx.db
    .global()
    .prepare(
      `INSERT INTO server_logs (ts, level, source, app_id, message, meta_json)
       VALUES (?, 'info', 'seed', ?, ?, NULL)`,
    )
    .run(ts, appId, message);
}

describe('LogsService', () => {
  let ctx: UnitContext;
  let svc: LogsService;

  /** Fresh service bound to a temp DB with a pinned retention window. */
  function boot(retentionDays = 30): void {
    ctx = makeUnitContext({ LOG_RETENTION_DAYS: String(retentionDays) });
    svc = ctx.newService(LogsService, ctx.config, ctx.db);
  }

  afterEach(() => {
    try {
      svc?.onModuleDestroy();
    } catch {
      /* already closed */
    }
    ctx.cleanup();
    delete process.env.LOG_RETENTION_DAYS;
  });

  // ---- per-app attribution ------------------------------------------------
  describe('write() attribution', () => {
    it('resolves meta.app → app_id and caches the lookup', () => {
      boot();
      const liveId = seedApp(ctx, 'live');
      const gdb = ctx.db.global();
      const prepareSpy = jest.spyOn(gdb, 'prepare');

      svc.write('info', 'test', 'first', { app: 'live' });
      expect(latestRow(ctx).app_id).toBe(liveId);

      svc.write('info', 'test', 'second', { app: 'live' });
      expect(latestRow(ctx).app_id).toBe(liveId);

      const lookups = prepareSpy.mock.calls.filter(([sql]) =>
        String(sql).includes('SELECT id FROM apps WHERE name'),
      );
      expect(lookups).toHaveLength(1); // second write hit the cache
    });

    it('lets an explicit appId win over meta.app', () => {
      boot();
      seedApp(ctx, 'live'); // id 1
      const otherId = seedApp(ctx, 'other'); // id 2

      svc.write('info', 'test', 'm', { app: 'live' }, otherId);
      expect(latestRow(ctx).app_id).toBe(otherId);
    });

    it('attributes an unknown meta.app to NULL and caches the miss', () => {
      boot();
      const gdb = ctx.db.global();
      const prepareSpy = jest.spyOn(gdb, 'prepare');

      svc.write('info', 'test', 'one', { app: 'ghost' });
      expect(latestRow(ctx).app_id).toBeNull();

      svc.write('info', 'test', 'two', { app: 'ghost' });
      expect(latestRow(ctx).app_id).toBeNull();

      const lookups = prepareSpy.mock.calls.filter(([sql]) =>
        String(sql).includes('SELECT id FROM apps WHERE name'),
      );
      expect(lookups).toHaveLength(1); // miss cached as null
    });

    it('leaves app_id NULL when there is no meta.app', () => {
      boot();
      svc.write('info', 'test', 'no app here');
      expect(latestRow(ctx).app_id).toBeNull();
    });
  });

  // ---- read filters -------------------------------------------------------
  describe('query() filters', () => {
    it('filters by exact source', async () => {
      boot();
      svc.write('info', 'alpha', 'from alpha');
      svc.write('info', 'beta', 'from beta');

      const rows = await svc.query({ source: 'alpha' });
      expect(rows).toHaveLength(1);
      expect(rows[0].message).toBe('from alpha');
    });

    it('filters by free-text q and escapes LIKE metacharacters', async () => {
      boot();
      svc.write('info', 'test', 'progress 100% done');
      svc.write('info', 'test', 'progress 1000 done');

      const hits = await svc.query({ q: '100%' });
      expect(hits).toHaveLength(1);
      expect(hits[0].message).toBe('progress 100% done');
    });

    it('combines source + q + level', async () => {
      boot();
      svc.write('error', 'egress', 'egress_ended room=a');
      svc.write('error', 'egress', 'egress_started room=a');
      svc.write('info', 'egress', 'egress_ended room=b');

      const rows = await svc.query({ source: 'egress', q: 'ended', level: 'error' });
      expect(rows.map((r) => r.message)).toEqual(['egress_ended room=a']);
    });
  });

  // ---- retention ----------------------------------------------------------
  describe('purgeOldLogs()', () => {
    it('deletes rows older than the retention window, keeps recent', () => {
      boot(30);
      insertAt(ctx, '2000-01-01T00:00:00.000Z', 'old row 1');
      insertAt(ctx, '2000-06-01T00:00:00.000Z', 'old row 2');
      svc.write('info', 'test', 'recent row');

      const deleted = svc.purgeOldLogs();
      expect(deleted).toBe(2);

      const remaining = ctx.db
        .global()
        .prepare("SELECT COUNT(*) AS n FROM server_logs WHERE message LIKE 'old row%'")
        .get() as { n: number };
      expect(remaining.n).toBe(0);

      const recent = ctx.db
        .global()
        .prepare("SELECT COUNT(*) AS n FROM server_logs WHERE message = 'recent row'")
        .get() as { n: number };
      expect(recent.n).toBe(1);
    });

    it('is a no-op when retention is disabled (0)', () => {
      boot(0);
      insertAt(ctx, '2000-01-01T00:00:00.000Z', 'old row');

      expect(svc.purgeOldLogs()).toBe(0);

      const remaining = ctx.db
        .global()
        .prepare('SELECT COUNT(*) AS n FROM server_logs')
        .get() as { n: number };
      expect(remaining.n).toBe(1);
    });
  });
});
