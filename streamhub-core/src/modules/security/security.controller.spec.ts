/**
 * Unit — security/SecurityController (the /security/* admin surface).
 *
 * Invariants locked down:
 *  - EVERY endpoint is GLOBAL-scope only: an app-scoped, non-superadmin
 *    principal gets 403 (same requireGlobal gate as /cluster + /system);
 *    superadmin and the dev path (no ctx bound) pass,
 *  - status reflects mode/flags/counts,
 *  - rule create/delete round-trips (400 invalid CIDR, 404 unknown id),
 *  - bans list + unban round-trip (404 for an unknown ban).
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AuthContext } from '../../shared/auth-context';
import { IpRulesService } from './ip-rules.service';
import { IpReputationService } from './ip-reputation.service';
import { SecurityController } from './security.controller';

const ENV_KEYS = [
  'STREAMHUB_IP_ACCESS_MODE',
  'STREAMHUB_IP_ALLOWLIST_ONLY',
  'STREAMHUB_AUTOBAN_ENABLED',
  'STREAMHUB_AUTOBAN_MAX_OFFENSES',
  'STREAMHUB_AUTOBAN_WINDOW_S',
  'STREAMHUB_AUTOBAN_BASE_TTL_S',
  'STREAMHUB_AUTOBAN_404_ENABLED',
];

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

describe('security/SecurityController', () => {
  let ctx: UnitContext;
  let rules: IpRulesService;
  let rep: IpReputationService;
  let controller: SecurityController;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
  });

  beforeEach(() => {
    ctx = makeUnitContext({
      STREAMHUB_IP_ACCESS_MODE: 'enforce',
      STREAMHUB_IP_ALLOWLIST_ONLY: '',
      STREAMHUB_AUTOBAN_ENABLED: 'true',
      STREAMHUB_AUTOBAN_MAX_OFFENSES: '2',
      STREAMHUB_AUTOBAN_WINDOW_S: '60',
      STREAMHUB_AUTOBAN_BASE_TTL_S: '900',
      STREAMHUB_AUTOBAN_404_ENABLED: '',
    });
    rules = ctx.newService(IpRulesService, ctx.db);
    rules.onModuleInit();
    rep = ctx.newService(IpReputationService, ctx.db, ctx.config, rules);
    rep.onModuleInit();
    controller = ctx.newService(SecurityController, ctx.config, rules, rep);
  });

  afterEach(() => {
    rep.onModuleDestroy();
    ctx.cleanup();
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  describe('authz — global scope only', () => {
    it('rejects an app-scoped principal on EVERY endpoint (403)', () => {
      expect(() => controller.status(appCtx)).toThrow(ForbiddenException);
      expect(() => controller.listRules(appCtx)).toThrow(ForbiddenException);
      expect(() =>
        controller.addRule({ cidr: '1.2.3.4', action: 'block' }, appCtx),
      ).toThrow(ForbiddenException);
      expect(() => controller.removeRule(1, appCtx)).toThrow(
        ForbiddenException,
      );
      expect(() => controller.bans(appCtx)).toThrow(ForbiddenException);
      expect(() => controller.unban('1.2.3.4', appCtx)).toThrow(
        ForbiddenException,
      );
      expect(() => controller.offenses(appCtx)).toThrow(ForbiddenException);
    });

    it('allows superadmin, a global token, and the dev path (no ctx)', () => {
      expect(() => controller.status(superadminCtx)).not.toThrow();
      expect(() => controller.status(globalTokenCtx)).not.toThrow();
      expect(() => controller.status(undefined)).not.toThrow();
    });
  });

  describe('GET /security/status', () => {
    it('reports mode, autoban config and live counts', () => {
      rules.add({ cidr: '203.0.113.0/24', action: 'block' });
      rules.add({ cidr: '198.51.100.1/32', action: 'allow' });
      const out = controller.status(superadminCtx);
      expect(out.error).toBeNull();
      expect(out.data.mode).toBe('enforce');
      expect(out.data.allowlistOnly).toBe(false);
      expect(out.data.autoban).toEqual({
        enabled: true,
        maxOffenses: 2,
        windowS: 60,
        baseTtlS: 900,
        track404: false,
      });
      expect(out.data.counts).toMatchObject({
        rules: 2,
        allowRules: 1,
        blockRules: 1,
        activeBans: 0,
      });
    });
  });

  describe('/security/ip-rules', () => {
    it('create → list → delete round-trip', () => {
      const created = controller.addRule(
        { cidr: '203.0.113.0/24', action: 'block', note: 'scanner' },
        superadminCtx,
      );
      expect(created.data.cidr).toBe('203.0.113.0/24');
      expect(created.data.createdBy).toBe('admin');

      const listed = controller.listRules(superadminCtx);
      expect(listed.data).toHaveLength(1);

      const removed = controller.removeRule(created.data.id, superadminCtx);
      expect(removed.data).toEqual({ id: created.data.id, deleted: true });
      expect(controller.listRules(superadminCtx).data).toEqual([]);
    });

    it('400 on an invalid CIDR, 404 on an unknown rule id', () => {
      expect(() =>
        controller.addRule({ cidr: 'bogus', action: 'block' }, superadminCtx),
      ).toThrow(BadRequestException);
      expect(() => controller.removeRule(42, superadminCtx)).toThrow(
        NotFoundException,
      );
    });
  });

  describe('/security/bans + /security/offenses', () => {
    it('lists an active ban and lifts it via unban', () => {
      rep.recordOffense('203.0.113.9', 'login_failed');
      rep.recordOffense('203.0.113.9', 'login_failed'); // threshold 2 → ban
      const bans = controller.bans(superadminCtx);
      expect(bans.data.active.map((b) => b.ip)).toEqual(['203.0.113.9']);

      const out = controller.unban('203.0.113.9', superadminCtx);
      expect(out.data).toEqual({ ip: '203.0.113.9', unbanned: true });
      expect(controller.bans(superadminCtx).data.active).toEqual([]);
    });

    it('404 when unbanning an IP with no ban record', () => {
      expect(() => controller.unban('8.8.8.8', superadminCtx)).toThrow(
        NotFoundException,
      );
    });

    it('surfaces recent offenders with counts', () => {
      rep.recordOffense('198.51.100.77', 'invalid_token');
      const out = controller.offenses(superadminCtx);
      expect(out.data[0]).toMatchObject({ ip: '198.51.100.77', count: 1 });
    });
  });
});
