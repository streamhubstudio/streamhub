/**
 * Unit — quotas/QuotasController: the superadmin tenant-administration surface
 * (GET /tenants, PATCH /tenants/:id/quotas) plus the existing per-tenant usage
 * data-scope guard.
 *
 *  - GET /tenants           → superadmin sees every tenant (shaped for the SPA);
 *                             a tenant-scoped principal / no ctx is 403.
 *  - PATCH /tenants/:id/quotas → superadmin patches plan + limits (partial body
 *                             merges); non-superadmin 403; unknown tenant 404.
 *  - UpdateQuotasDto        → class-validator rejects bad bodies (→ 400 at runtime).
 *
 * Real migrated SQLite DB (temp), no infra. Owned by: stabilization.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AuthContext } from '../../shared/auth-context';
import { UpdateQuotasDto } from './dto/update-quotas.dto';
import { QuotasController } from './quotas.controller';
import { QuotasService } from './quotas.service';

function make(): { ctx: UnitContext; controller: QuotasController } {
  const ctx = makeUnitContext();
  const service = ctx.newService(QuotasService, ctx.db);
  const controller = ctx.newService(QuotasController, service);
  return { ctx, controller };
}

/** Seed a tenant + explicit quota row (+ optional owned apps). */
function seedTenant(
  ctx: UnitContext,
  id: string,
  opts: {
    name?: string;
    plan?: string;
    quota?: Partial<{
      max_apps: number;
      max_concurrent_streams: number;
      max_recording_minutes_month: number;
      max_egress_gb_month: number;
      max_storage_gb: number;
    }>;
    apps?: string[];
  } = {},
): void {
  const q = {
    max_apps: 2,
    max_concurrent_streams: 2,
    max_recording_minutes_month: 300,
    max_egress_gb_month: 5,
    max_storage_gb: 5,
    ...(opts.quota ?? {}),
  };
  ctx.db
    .global()
    .prepare('INSERT INTO tenants (id,name,plan) VALUES (?,?,?)')
    .run(id, opts.name ?? id, opts.plan ?? 'free');
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
  const insApp = ctx.db
    .global()
    .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)');
  for (const a of opts.apps ?? []) insApp.run(a, id);
}

const superadmin: AuthContext = {
  userId: 'admin',
  tenantId: 'platform',
  role: 'superadmin',
  isSuperadmin: true,
  scope: 'global',
  via: 'admin_jwt',
};

const tenantOwner: AuthContext = {
  userId: 'usr_1',
  tenantId: 'tnt_a',
  role: 'owner',
  isSuperadmin: false,
  scope: 'user',
  via: 'user_jwt',
};

describe('quotas/QuotasController', () => {
  let ctx: UnitContext;
  let controller: QuotasController;
  beforeEach(() => ({ ctx, controller } = make()));
  afterEach(() => ctx.cleanup());

  // ===========================================================================
  // GET /tenants — superadmin list
  // ===========================================================================
  describe('list (GET /tenants)', () => {
    it('returns every tenant shaped for the SPA (plan, quotas, appCount)', () => {
      seedTenant(ctx, 'tnt_a', {
        name: 'Acme',
        plan: 'pro',
        quota: { max_apps: 7 },
        apps: ['a1', 'a2'],
      });
      seedTenant(ctx, 'tnt_b', { name: 'Beta' });

      const res = controller.list(superadmin);
      const byId = Object.fromEntries(res.data.map((t) => [t.id, t]));

      expect(res.error).toBeNull();
      // Both seeded tenants + the built-in `platform` tenant are visible.
      expect(byId['tnt_a']).toMatchObject({
        id: 'tnt_a',
        name: 'Acme',
        plan: 'pro',
        appCount: 2,
      });
      expect(byId['tnt_a'].quotas.maxApps).toBe(7);
      expect(typeof byId['tnt_a'].createdAt).toBe('string');
      expect(byId['tnt_b']).toMatchObject({ appCount: 0, plan: 'free' });
      expect(byId['platform']).toBeDefined();
    });

    it('is superadmin-gated: a tenant-scoped principal is 403', () => {
      seedTenant(ctx, 'tnt_a');
      expect(() => controller.list(tenantOwner)).toThrow(ForbiddenException);
    });

    it('is superadmin-gated: no auth context is 403', () => {
      expect(() => controller.list(undefined)).toThrow(ForbiddenException);
    });
  });

  // ===========================================================================
  // PATCH /tenants/:id/quotas — superadmin edit
  // ===========================================================================
  describe('updateQuotas (PATCH /tenants/:id/quotas)', () => {
    beforeEach(() => seedTenant(ctx, 'tnt_a', { plan: 'free', apps: ['a1'] }));

    it('updates plan + limits and returns the new effective quota', () => {
      const res = controller.updateQuotas(
        'tnt_a',
        { plan: 'pro', maxApps: 20, maxStorageGb: 100 },
        superadmin,
      );
      expect(res.data).toMatchObject({ id: 'tnt_a', plan: 'pro', appCount: 1 });
      expect(res.data.quotas.maxApps).toBe(20);
      expect(res.data.quotas.maxStorageGb).toBe(100);

      // Persisted: a fresh list reflects it.
      const again = controller.list(superadmin).data.find((t) => t.id === 'tnt_a');
      expect(again).toMatchObject({ plan: 'pro' });
      expect(again!.quotas.maxApps).toBe(20);
    });

    it('is a partial merge: unnamed limits keep their previous value', () => {
      const res = controller.updateQuotas('tnt_a', { maxApps: 9 }, superadmin);
      expect(res.data.quotas.maxApps).toBe(9);
      // maxConcurrentStreams was seeded at 2 and not in the patch → unchanged.
      expect(res.data.quotas.maxConcurrentStreams).toBe(2);
      // plan omitted → unchanged.
      expect(res.data.plan).toBe('free');
    });

    it('accepts -1 (unlimited)', () => {
      const res = controller.updateQuotas('tnt_a', { maxApps: -1 }, superadmin);
      expect(res.data.quotas.maxApps).toBe(-1);
    });

    it('is superadmin-gated: a tenant-scoped principal is 403', () => {
      expect(() =>
        controller.updateQuotas('tnt_a', { maxApps: 9 }, tenantOwner),
      ).toThrow(ForbiddenException);
    });

    it('unknown tenant → 404', () => {
      expect(() =>
        controller.updateQuotas('tnt_missing', { maxApps: 9 }, superadmin),
      ).toThrow(NotFoundException);
    });
  });

  // ===========================================================================
  // UpdateQuotasDto — validation (drives the runtime 400)
  // ===========================================================================
  describe('UpdateQuotasDto validation', () => {
    const errs = (obj: Record<string, unknown>) =>
      validate(plainToInstance(UpdateQuotasDto, obj));

    it('accepts a valid partial body', async () => {
      expect(await errs({ plan: 'pro', maxApps: 10 })).toHaveLength(0);
      expect(await errs({})).toHaveLength(0); // empty patch is a valid no-op
    });

    it('rejects a limit below -1', async () => {
      expect((await errs({ maxApps: -2 })).length).toBeGreaterThan(0);
    });

    it('rejects a non-integer limit', async () => {
      expect((await errs({ maxStorageGb: 1.5 })).length).toBeGreaterThan(0);
    });

    it('rejects a non-string plan', async () => {
      expect((await errs({ plan: 123 })).length).toBeGreaterThan(0);
    });
  });
});
