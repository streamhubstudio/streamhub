/**
 * Unit — authz/AuthzService (Casbin RBAC-with-domains + tenant data-scope).
 *
 * `can()` answers role × resource × action from the static policy;
 * `appBelongsToTenant()` answers the data-scoping question. Superadmin bypass is
 * NOT here (it lives in the guard) — this spec confirms the enforcer verdicts and
 * the defensive fail-open behaviour.
 *
 * Owned by: auth-tenancy test agent.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AuthContext } from '../../shared/auth-context';
import { AuthzService } from './authz.service';
import type { Action, Resource } from './authz.constants';

/** STREAMHUB_AUTHZ_ENFORCE — flipped per-case to exercise fail-open vs fail-closed. */
const ENV = 'STREAMHUB_AUTHZ_ENFORCE';

function make(): { ctx: UnitContext; authz: AuthzService } {
  const ctx = makeUnitContext();
  const authz = ctx.newService(AuthzService, ctx.db);
  return { ctx, authz };
}

function ctxFor(
  role: AuthContext['role'],
  tenantId: string | null = 'tnt_a',
): AuthContext {
  return {
    userId: 'usr_1',
    tenantId,
    role,
    isSuperadmin: false,
    scope: 'user',
    via: 'user_jwt',
  };
}

describe('authz/AuthzService', () => {
  let ctx: UnitContext;
  let authz: AuthzService;

  beforeEach(async () => {
    ({ ctx, authz } = make());
    await authz.onModuleInit();
  });
  afterEach(() => ctx.cleanup());

  describe('can() — RBAC verdicts', () => {
    it('reports the enforcer ready after init', () => {
      expect(authz.ready).toBe(true);
    });

    it('owner: full control within their tenant', async () => {
      const owner = ctxFor('owner');
      for (const [res, act] of [
        ['app', 'create'],
        ['app', 'delete'],
        ['tenant', 'write'],
        ['token', 'delete'],
        ['recording', 'stop'],
      ] as [Resource, Action][]) {
        expect(await authz.can(owner, res, act)).toBe(true);
      }
    });

    it('viewer: read-only across every resource', async () => {
      const viewer = ctxFor('viewer');
      expect(await authz.can(viewer, 'app', 'read')).toBe(true);
      expect(await authz.can(viewer, 'usage', 'read')).toBe(true);
      for (const act of ['create', 'write', 'delete', 'start', 'stop'] as Action[]) {
        expect(await authz.can(viewer, 'app', act)).toBe(false);
      }
    });

    it('editor: operate media but NOT delete the app or touch tenant/token admin', async () => {
      const editor = ctxFor('editor');
      // allowed
      expect(await authz.can(editor, 'app', 'create')).toBe(true);
      expect(await authz.can(editor, 'app', 'write')).toBe(true);
      expect(await authz.can(editor, 'stream', 'start')).toBe(true);
      expect(await authz.can(editor, 'recording', 'start')).toBe(true);
      expect(await authz.can(editor, 'vod', 'delete')).toBe(true);
      expect(await authz.can(editor, 'usage', 'read')).toBe(true);
      // denied
      expect(await authz.can(editor, 'app', 'delete')).toBe(false);
      expect(await authz.can(editor, 'tenant', 'write')).toBe(false);
      expect(await authz.can(editor, 'token', 'delete')).toBe(false);
    });

    it('service machine role: broad allow (never trips an explicit enforce)', async () => {
      const svc = ctxFor('service', 'platform');
      expect(await authz.can(svc, 'app', 'delete')).toBe(true);
      expect(await authz.can(svc, 'tenant', 'write')).toBe(true);
    });

    it('superadmin role is NOT in the policy (it bypasses in the guard, not here)', async () => {
      // Documents the design: can() would DENY superadmin, but the guard never
      // calls can() for a superadmin principal.
      expect(await authz.can(ctxFor('superadmin', 'platform'), 'app', 'read')).toBe(
        false,
      );
    });

    it('role capabilities are tenant-independent (domain "*")', async () => {
      const ownerA = ctxFor('owner', 'tnt_a');
      const ownerB = ctxFor('owner', 'tnt_b');
      expect(await authz.can(ownerA, 'app', 'create')).toBe(true);
      expect(await authz.can(ownerB, 'app', 'create')).toBe(true);
    });

    it('enforcer never initialised → fail-OPEN in log/off, fail-CLOSED in on (M3)', async () => {
      const prev = process.env[ENV];
      const fresh = make();
      // onModuleInit NOT called → enforcer undefined.
      expect(fresh.authz.ready).toBe(false);
      try {
        process.env[ENV] = 'log';
        expect(await fresh.authz.can(ctxFor('viewer'), 'app', 'delete')).toBe(true);
        process.env[ENV] = 'off';
        expect(await fresh.authz.can(ctxFor('viewer'), 'app', 'delete')).toBe(true);
        // Secure-by-default: a dead enforcer must NOT silently allow when enforcing.
        process.env[ENV] = 'on';
        expect(await fresh.authz.can(ctxFor('viewer'), 'app', 'delete')).toBe(false);
      } finally {
        if (prev === undefined) delete process.env[ENV];
        else process.env[ENV] = prev;
        fresh.ctx.cleanup();
      }
    });

    it('enforce() throws → fail-OPEN in log, fail-CLOSED in on (M3)', async () => {
      const prev = process.env[ENV];
      const boom = jest
        .spyOn(
          (authz as unknown as { enforcer: { enforce: jest.Mock } }).enforcer,
          'enforce',
        )
        .mockRejectedValue(new Error('boom'));
      try {
        process.env[ENV] = 'log';
        expect(await authz.can(ctxFor('owner'), 'app', 'read')).toBe(true);
        process.env[ENV] = 'on';
        expect(await authz.can(ctxFor('owner'), 'app', 'read')).toBe(false);
      } finally {
        boom.mockRestore();
        if (prev === undefined) delete process.env[ENV];
        else process.env[ENV] = prev;
      }
    });
  });

  describe('appBelongsToTenant() — data scope', () => {
    function seedApp(name: string, tenantId: string | null): void {
      ctx.db
        .global()
        .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)')
        .run(name, tenantId);
    }

    it('true when the app is owned by the caller tenant', () => {
      seedApp('mine', 'tnt_a');
      expect(authz.appBelongsToTenant(ctxFor('owner', 'tnt_a'), 'mine')).toBe(true);
    });

    it('false when the app belongs to another tenant', () => {
      seedApp('theirs', 'tnt_b');
      expect(authz.appBelongsToTenant(ctxFor('owner', 'tnt_a'), 'theirs')).toBe(
        false,
      );
    });

    it('superadmin passes any app', () => {
      seedApp('theirs', 'tnt_b');
      const su = { ...ctxFor('superadmin', 'platform'), isSuperadmin: true };
      expect(authz.appBelongsToTenant(su, 'theirs')).toBe(true);
    });

    it('unscoped (no tenantId) credential is not blocked', () => {
      seedApp('any', 'tnt_b');
      expect(authz.appBelongsToTenant(ctxFor('service', null), 'any')).toBe(true);
    });

    it('unknown app → do not block (handler 404s normally)', () => {
      expect(authz.appBelongsToTenant(ctxFor('owner', 'tnt_a'), 'ghost')).toBe(true);
    });

    it('app with NULL tenant (unassigned) → not blocked', () => {
      seedApp('legacy', null);
      expect(authz.appBelongsToTenant(ctxFor('owner', 'tnt_a'), 'legacy')).toBe(
        true,
      );
    });
  });
});
