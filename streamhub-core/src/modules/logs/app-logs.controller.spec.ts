/**
 * Unit specs for AppLogsController (module logs).
 *
 * Two angles:
 *   - wiring/permission: the handler declares @RequirePermission('usage','read')
 *     and threads the path `:app` into the query/count envelope;
 *   - data-scope: over a real DB, one app's viewer only sees that app's logs
 *     (server_logs.app_id), so an `other`-scoped caller can't read `live`'s.
 */
import { Reflector } from '@nestjs/core';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AppLogsController } from './app-logs.controller';
import { LogsService } from './logs.service';
import { REQUIRE_PERMISSION_KEY } from '../authz/permission.decorator';

function seedApp(ctx: UnitContext, name: string): number {
  return Number(
    ctx.db.global().prepare('INSERT INTO apps (name) VALUES (?)').run(name)
      .lastInsertRowid,
  );
}

describe('AppLogsController', () => {
  it("declares the per-app 'usage:read' permission", () => {
    const meta = new Reflector().get(
      REQUIRE_PERMISSION_KEY,
      AppLogsController.prototype.query,
    );
    expect(meta).toEqual({ resource: 'usage', action: 'read' });
  });

  it('threads the path app + limit/offset into the envelope', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 1 }]);
    const count = jest.fn().mockResolvedValue(1);
    const logs = { query, count } as unknown as LogsService;
    const ctrl = new AppLogsController(logs);

    const res = await ctrl.query('live', { level: 'error' });

    expect(res).toEqual({ data: [{ id: 1 }], total: 1, limit: 100, offset: 0 });
    expect(query).toHaveBeenCalledWith({
      app: 'live',
      level: 'error',
      limit: 100,
      offset: 0,
    });
    expect(count).toHaveBeenCalledWith({
      app: 'live',
      level: 'error',
      limit: 100,
      offset: 0,
    });
  });

  describe('data-scope (real DB)', () => {
    let ctx: UnitContext;
    let svc: LogsService;
    let ctrl: AppLogsController;

    beforeEach(() => {
      ctx = makeUnitContext({ LOG_RETENTION_DAYS: '0' });
      svc = ctx.newService(LogsService, ctx.config, ctx.db);
      ctrl = new AppLogsController(svc);
      seedApp(ctx, 'live');
      seedApp(ctx, 'other');
      svc.write('info', 'stream', 'live event', { app: 'live' });
      svc.write('info', 'stream', 'other event', { app: 'other' });
      svc.write('info', 'stream', 'global event'); // no app → NULL
    });

    afterEach(() => {
      svc.onModuleDestroy();
      ctx.cleanup();
      delete process.env.LOG_RETENTION_DAYS;
    });

    it('returns only the requested app’s logs', async () => {
      const live = await ctrl.query('live', {});
      expect(live.total).toBe(1);
      expect(live.data.map((r) => r.message)).toEqual(['live event']);
    });

    it('does not leak another app’s (or global) logs', async () => {
      const other = await ctrl.query('other', {});
      expect(other.data.map((r) => r.message)).toEqual(['other event']);
      expect(other.data.some((r) => r.message === 'live event')).toBe(false);
      expect(other.data.some((r) => r.message === 'global event')).toBe(false);
    });
  });
});
