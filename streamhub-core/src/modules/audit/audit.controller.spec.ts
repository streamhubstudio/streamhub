/**
 * Unit — audit/AuditController + ComplianceController (the /system/audit and
 * /system/compliance read surfaces).
 *
 * Invariants locked down:
 *  - GLOBAL scope only: an app-scoped, non-superadmin principal gets 403 on
 *    every route (same requireGlobal gate as /system/settings); superadmin,
 *    global tokens and the dev path (no ctx) pass,
 *  - the endpoints are READ-ONLY (there is no mutating route on the trail),
 *  - query params are parsed defensively (bad limit/result ignored),
 *  - responses use the { data, error: null } envelope.
 */
import { ForbiddenException } from '@nestjs/common';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AuthContext } from '../../shared/auth-context';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';

const superadminCtx: AuthContext = {
  userId: 'admin',
  tenantId: 'platform',
  role: 'superadmin',
  isSuperadmin: true,
  scope: 'global',
  via: 'admin_jwt',
};

const globalTokenCtx: AuthContext = {
  userId: 'token:1',
  tenantId: 'platform',
  role: 'service',
  isSuperadmin: true,
  scope: 'global',
  via: 'api_token',
};

/** An app-scoped, non-superadmin principal — must be rejected everywhere. */
const appCtx: AuthContext = {
  userId: 'token:2',
  tenantId: 't1',
  role: 'service',
  isSuperadmin: false,
  scope: 'app',
  via: 'api_token',
};

describe('audit/AuditController + ComplianceController', () => {
  let ctx: UnitContext;
  let audit: AuditService;
  let controller: AuditController;
  let complianceCtrl: ComplianceController;

  beforeEach(() => {
    ctx = makeUnitContext();
    audit = ctx.newService(AuditService, ctx.config, ctx.db);
    audit.onModuleInit();
    controller = ctx.newService(AuditController, audit);
    complianceCtrl = ctx.newService(
      ComplianceController,
      ctx.newService(ComplianceService, ctx.config, ctx.db, audit),
    );
  });

  afterEach(() => {
    audit.onModuleDestroy();
    ctx.cleanup();
  });

  describe('authz — global scope only', () => {
    it('rejects an app-scoped principal on every route (403)', () => {
      const call = () =>
        controller.list(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          appCtx,
        );
      expect(call).toThrow(ForbiddenException);
      expect(() => controller.verify(appCtx)).toThrow(ForbiddenException);
      expect(() => complianceCtrl.report(appCtx)).toThrow(ForbiddenException);
    });

    it('allows superadmin, a global token, and the dev path (no ctx)', () => {
      for (const c of [superadminCtx, globalTokenCtx, undefined]) {
        expect(() => controller.verify(c)).not.toThrow();
        expect(() => complianceCtrl.report(c)).not.toThrow();
      }
    });
  });

  describe('GET /system/audit', () => {
    beforeEach(() => {
      audit.record({ action: 'auth.login', actorId: 'alice', result: 'failure' });
      audit.record({ action: 'token.create', actorId: 'admin' });
    });

    it('returns the enveloped page with filters applied', () => {
      const out = controller.list(
        'auth.',
        undefined,
        'failure',
        undefined,
        undefined,
        '10',
        '0',
        superadminCtx,
      );
      expect(out.error).toBeNull();
      expect(out.data.total).toBe(1);
      expect(out.data.limit).toBe(10);
      expect(out.data.entries[0]).toMatchObject({
        action: 'auth.login',
        actorId: 'alice',
        result: 'failure',
      });
    });

    it('ignores an invalid result filter and a non-numeric limit', () => {
      const out = controller.list(
        undefined,
        undefined,
        'bogus',
        undefined,
        undefined,
        'NaN',
        undefined,
        superadminCtx,
      );
      expect(out.data.total).toBe(2);
      expect(out.data.limit).toBe(50); // service default
    });
  });

  describe('GET /system/audit/verify', () => {
    it('reports a clean chain over the recorded entries', () => {
      audit.record({ action: 'a.b' });
      const out = controller.verify(superadminCtx);
      expect(out.data.ok).toBe(true);
      expect(out.data.checked).toBeGreaterThanOrEqual(1);
      expect(out.data.brokenAt).toBeNull();
    });
  });

  describe('GET /system/compliance', () => {
    it('returns the enveloped posture report', () => {
      const out = complianceCtrl.report(superadminCtx);
      expect(out.error).toBeNull();
      expect(out.data.controls.length).toBeGreaterThanOrEqual(10);
      expect(out.data.summary).toBeDefined();
    });
  });
});
