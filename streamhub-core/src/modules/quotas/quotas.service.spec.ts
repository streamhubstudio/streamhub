/**
 * Unit — quotas/QuotasService (per-tenant accounting + phased enforcement).
 *
 * Enforcement is gated by STREAMHUB_AUTHZ_ENFORCE exactly like authz:
 * 'off' skips, 'log' only warns, 'on' rejects with 429. Superadmin / api_token /
 * unscoped callers are NEVER quota-limited. Counting degrades to 0/unlimited
 * when the schema is absent.
 *
 * Owned by: auth-tenancy test agent.
 */
import { HttpException, HttpStatus } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AuthContext } from '../../shared/auth-context';
import { QuotasService } from './quotas.service';

const ENV = 'STREAMHUB_AUTHZ_ENFORCE';

function make(): { ctx: UnitContext; quotas: QuotasService } {
  const ctx = makeUnitContext();
  const quotas = ctx.newService(QuotasService, ctx.db);
  return { ctx, quotas };
}

/** Seed a tenant with an explicit quota row. */
function seedTenant(
  ctx: UnitContext,
  id: string,
  quota: Partial<{
    max_apps: number;
    max_concurrent_streams: number;
    max_recording_minutes_month: number;
    max_egress_gb_month: number;
    max_storage_gb: number;
  }> = {},
): void {
  const q = {
    max_apps: 2,
    max_concurrent_streams: 2,
    max_recording_minutes_month: 300,
    max_egress_gb_month: 5,
    max_storage_gb: 5,
    ...quota,
  };
  ctx.db.global().prepare("INSERT INTO tenants (id,name,plan) VALUES (?,?,'free')").run(id, id);
  ctx.db
    .global()
    .prepare(
      `INSERT INTO quotas (tenant_id,max_apps,max_concurrent_streams,
         max_recording_minutes_month,max_egress_gb_month,max_storage_gb)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      id,
      q.max_apps,
      q.max_concurrent_streams,
      q.max_recording_minutes_month,
      q.max_egress_gb_month,
      q.max_storage_gb,
    );
}

function seedApps(ctx: UnitContext, tenantId: string, names: string[]): void {
  const stmt = ctx.db
    .global()
    .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)');
  for (const n of names) stmt.run(n, tenantId);
}

const userCtx = (tenantId: string | null): AuthContext => ({
  userId: 'usr_1',
  tenantId,
  role: 'owner',
  isSuperadmin: false,
  scope: 'user',
  via: 'user_jwt',
});

describe('quotas/QuotasService', () => {
  let ctx: UnitContext;
  let quotas: QuotasService;
  const prev = process.env[ENV];

  beforeEach(() => ({ ctx, quotas } = make()));
  afterEach(() => {
    ctx.cleanup();
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  });

  // ===========================================================================
  // enforceCreateApp — the phased flag
  // ===========================================================================
  describe('enforceCreateApp', () => {
    beforeEach(() => {
      seedTenant(ctx, 'tnt_a', { max_apps: 2 });
      seedApps(ctx, 'tnt_a', ['a1', 'a2']); // already AT the limit
    });

    it('mode=on: rejects with 429 when at/over the app quota', async () => {
      process.env[ENV] = 'on';
      try {
        await quotas.enforceCreateApp(userCtx('tnt_a'));
        throw new Error('expected a 429');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(
          HttpStatus.TOO_MANY_REQUESTS,
        );
        expect((err as HttpException).getResponse()).toMatchObject({
          error: 'quota_exceeded',
          metric: 'maxApps',
          limit: 2,
          used: 2,
        });
      }
    });

    it('mode=log: over-quota is allowed (only logged)', async () => {
      process.env[ENV] = 'log';
      await expect(
        quotas.enforceCreateApp(userCtx('tnt_a')),
      ).resolves.toBeUndefined();
    });

    it('mode=off: not checked at all', async () => {
      process.env[ENV] = 'off';
      await expect(
        quotas.enforceCreateApp(userCtx('tnt_a')),
      ).resolves.toBeUndefined();
    });

    it('mode=on: allowed while strictly under the limit', async () => {
      process.env[ENV] = 'on';
      seedTenant(ctx, 'tnt_b', { max_apps: 5 });
      seedApps(ctx, 'tnt_b', ['b1']);
      await expect(
        quotas.enforceCreateApp(userCtx('tnt_b')),
      ).resolves.toBeUndefined();
    });

    it('unlimited quota (-1) never blocks', async () => {
      process.env[ENV] = 'on';
      seedTenant(ctx, 'tnt_u', { max_apps: -1 });
      seedApps(ctx, 'tnt_u', ['u1', 'u2', 'u3', 'u4']);
      await expect(
        quotas.enforceCreateApp(userCtx('tnt_u')),
      ).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // CRITICAL INVARIANT — never quota-limit the platform owner / tokens
  // ===========================================================================
  describe('INVARIANT: superadmin / api_token / unscoped never quota-limited', () => {
    beforeEach(() => {
      process.env[ENV] = 'on';
      seedTenant(ctx, 'tnt_a', { max_apps: 1 });
      seedApps(ctx, 'tnt_a', ['a1', 'a2', 'a3']); // way over
    });

    it('superadmin bypasses', async () => {
      const su: AuthContext = { ...userCtx('tnt_a'), isSuperadmin: true, role: 'superadmin' };
      await expect(quotas.enforceCreateApp(su)).resolves.toBeUndefined();
    });

    it('api_token bypasses (even app-scoped, non-superadmin)', async () => {
      const tok: AuthContext = { ...userCtx('tnt_a'), via: 'api_token', role: 'service' };
      await expect(quotas.enforceCreateApp(tok)).resolves.toBeUndefined();
    });

    it('unscoped credential (no tenantId) bypasses', async () => {
      await expect(quotas.enforceCreateApp(userCtx(null))).resolves.toBeUndefined();
    });

    it('missing context bypasses', async () => {
      await expect(quotas.enforceCreateApp(undefined)).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // enforceConcurrentStreams (per-app vods.db counting)
  // ===========================================================================
  describe('enforceConcurrentStreams', () => {
    it('mode=on: rejects when active streams reach the limit', async () => {
      process.env[ENV] = 'on';
      seedTenant(ctx, 'tnt_a', { max_concurrent_streams: 1 });
      seedApps(ctx, 'tnt_a', ['live']);
      // one active stream in the app's app.db
      ctx.db
        .appDb('live')
        .prepare(
          "INSERT INTO streams (app_id, stream_id, type, room, status) VALUES (1, 's1', 'webrtc', 'r1', 'active')",
        )
        .run();
      await expect(
        quotas.enforceConcurrentStreams(userCtx('tnt_a')),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('does not count ended streams toward the limit', async () => {
      process.env[ENV] = 'on';
      seedTenant(ctx, 'tnt_a', { max_concurrent_streams: 1 });
      seedApps(ctx, 'tnt_a', ['live']);
      ctx.db
        .appDb('live')
        .prepare(
          "INSERT INTO streams (app_id, stream_id, type, room, status) VALUES (1, 's1', 'webrtc', 'r1', 'ended')",
        )
        .run();
      await expect(
        quotas.enforceConcurrentStreams(userCtx('tnt_a')),
      ).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // getUsage report
  // ===========================================================================
  describe('getUsage', () => {
    it('reports limits, counts and per-metric exceeded flags', () => {
      seedTenant(ctx, 'tnt_a', { max_apps: 2 });
      seedApps(ctx, 'tnt_a', ['a1', 'a2']);
      const report = quotas.getUsage('tnt_a');
      expect(report).toMatchObject({
        tenantId: 'tnt_a',
        plan: 'free',
        quotas: { maxApps: 2 },
        usage: { apps: 2 },
      });
      // at the limit → mirrors enforcement (would-deny next create)
      expect(report.exceeded.apps).toBe(true);
    });

    it('falls back to default quotas for an unknown tenant (no rows)', () => {
      const report = quotas.getUsage('tnt_ghost');
      expect(report.quotas).toMatchObject({
        maxApps: 2,
        maxConcurrentStreams: 2,
        maxRecordingMinutesMonth: 300,
      });
      expect(report.usage.apps).toBe(0);
      expect(report.exceeded.apps).toBe(false);
    });

    it('honours an unlimited (-1) quota in the report', () => {
      seedTenant(ctx, 'tnt_u', { max_apps: -1 });
      seedApps(ctx, 'tnt_u', ['u1', 'u2', 'u3']);
      const report = quotas.getUsage('tnt_u');
      expect(report.quotas.maxApps).toBe(-1);
      expect(report.usage.apps).toBe(3);
      expect(report.exceeded.apps).toBe(false); // -1 is never "over"
    });
  });

  // ===========================================================================
  // "Broadcaster / linear" plan preset (endless-radio Tier 1, QW-3)
  // ===========================================================================
  describe('broadcaster/linear plan preset', () => {
    /** Seed N active streams into the app's app.db. */
    function seedActiveStreams(app: string, n: number): void {
      const stmt = ctx.db
        .appDb(app)
        .prepare(
          "INSERT INTO streams (app_id, stream_id, type, room, status) VALUES (1, ?, 'webrtc', 'r', 'active')",
        );
      for (let i = 0; i < n; i++) stmt.run(`s${i}`);
    }

    it('assigning plan=broadcaster applies unlimited concurrent streams (-1)', () => {
      seedTenant(ctx, 'tnt_bc', { max_concurrent_streams: 1 }); // starts capped
      quotas.setQuotas('tnt_bc', { plan: 'broadcaster' });
      const report = quotas.getUsage('tnt_bc');
      expect(report.plan).toBe('broadcaster');
      expect(report.quotas.maxConcurrentStreams).toBe(-1);
      expect(report.quotas.maxApps).toBe(50); // generous app allowance
    });

    it('enforceConcurrentStreams never throws for a broadcaster tenant, regardless of active count', async () => {
      process.env[ENV] = 'on';
      seedTenant(ctx, 'tnt_bc', { max_concurrent_streams: 1 });
      quotas.setQuotas('tnt_bc', { plan: 'broadcaster' });
      seedApps(ctx, 'tnt_bc', ['live']);
      seedActiveStreams('live', 25); // way over any finite cap

      await expect(
        quotas.enforceConcurrentStreams(userCtx('tnt_bc')),
      ).resolves.toBeUndefined();
    });

    it('an explicit per-metric override in the same patch still wins over the preset', () => {
      seedTenant(ctx, 'tnt_bc', { max_concurrent_streams: 1 });
      quotas.setQuotas('tnt_bc', {
        plan: 'broadcaster',
        maxConcurrentStreams: 5,
      });
      expect(quotas.getUsage('tnt_bc').quotas.maxConcurrentStreams).toBe(5);
    });

    it('an unknown plan label leaves the current limits untouched', () => {
      seedTenant(ctx, 'tnt_x', { max_concurrent_streams: 3 });
      quotas.setQuotas('tnt_x', { plan: 'mystery' });
      expect(quotas.getUsage('tnt_x').quotas.maxConcurrentStreams).toBe(3);
    });
  });

  // ===========================================================================
  // Per-APP and per-STREAM quotas (default unlimited)
  // ===========================================================================
  describe('enforceAppConcurrentStreams (per-app quota)', () => {
    const seedActive = (app: string, n: number): void => {
      const stmt = ctx.db
        .appDb(app)
        .prepare(
          "INSERT INTO streams (app_id, stream_id, type, room, status) VALUES (1, ?, 'webrtc', 'r', 'active')",
        );
      for (let i = 0; i < n; i++) stmt.run(`s${i}`);
    };

    it('is UNLIMITED by default: limit <= 0 never throws, even at high usage', async () => {
      process.env[ENV] = 'on';
      seedActive('live', 5);
      await expect(quotas.enforceAppConcurrentStreams('live', -1, userCtx('t'))).resolves.toBeUndefined();
      await expect(quotas.enforceAppConcurrentStreams('live', 0, userCtx('t'))).resolves.toBeUndefined();
    });

    it('mode=on: rejects 429 app_quota_exceeded at the app limit', async () => {
      process.env[ENV] = 'on';
      seedActive('live', 2);
      await expect(quotas.enforceAppConcurrentStreams('live', 2, userCtx('t'))).rejects.toBeInstanceOf(HttpException);
      try {
        await quotas.enforceAppConcurrentStreams('live', 2, userCtx('t'));
      } catch (e) {
        const body = (e as HttpException).getResponse() as Record<string, unknown>;
        expect(body).toMatchObject({ error: 'app_quota_exceeded', scope: 'app', limit: 2, used: 2 });
        expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
    });

    it('mode=off / mode=log never throws', async () => {
      seedActive('live', 5);
      process.env[ENV] = 'off';
      await expect(quotas.enforceAppConcurrentStreams('live', 1, userCtx('t'))).resolves.toBeUndefined();
      process.env[ENV] = 'log';
      await expect(quotas.enforceAppConcurrentStreams('live', 1, userCtx('t'))).resolves.toBeUndefined();
    });

    it('superadmin + api_token bypass the per-app quota', async () => {
      process.env[ENV] = 'on';
      seedActive('live', 5);
      await expect(
        quotas.enforceAppConcurrentStreams('live', 1, { ...userCtx('t'), isSuperadmin: true }),
      ).resolves.toBeUndefined();
      await expect(
        quotas.enforceAppConcurrentStreams('live', 1, { ...userCtx('t'), via: 'api_token' }),
      ).resolves.toBeUndefined();
    });

    it('stays under the limit → passes', async () => {
      process.env[ENV] = 'on';
      seedActive('live', 1);
      await expect(quotas.enforceAppConcurrentStreams('live', 5, userCtx('t'))).resolves.toBeUndefined();
    });
  });

  describe('enforceStreamViewers (per-stream quota)', () => {
    it('is UNLIMITED by default (limit <= 0)', async () => {
      process.env[ENV] = 'on';
      await expect(quotas.enforceStreamViewers(-1, 999, userCtx('t'))).resolves.toBeUndefined();
    });

    it('mode=on: rejects 429 stream_quota_exceeded when viewers reach the cap', async () => {
      process.env[ENV] = 'on';
      await expect(quotas.enforceStreamViewers(10, 10, userCtx('t'))).rejects.toBeInstanceOf(HttpException);
      await expect(quotas.enforceStreamViewers(10, 3, userCtx('t'))).resolves.toBeUndefined();
    });
  });
});
