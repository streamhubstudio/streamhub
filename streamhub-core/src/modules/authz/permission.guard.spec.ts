/**
 * Unit — authz/PermissionGuard (phased RBAC enforcement + hard bypasses).
 *
 * The guard composes Casbin RBAC + tenant data-scope and gates on
 * STREAMHUB_AUTHZ_ENFORCE (off / log / on). Critical invariant under test:
 * `isSuperadmin` and `via:'api_token'` principals ALWAYS pass, in EVERY mode.
 *
 * Owned by: auth-tenancy test agent.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import {
  AuthContext,
  RequestWithAuthCtx,
  setAuthCtx,
} from '../../shared/auth-context';
import { AuthzService } from './authz.service';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from './permission.decorator';
import { PermissionGuard } from './permission.guard';

const ENV = 'STREAMHUB_AUTHZ_ENFORCE';

interface Harness {
  ctx: UnitContext;
  authz: AuthzService;
  guard: PermissionGuard;
}

async function make(): Promise<Harness> {
  const ctx = makeUnitContext();
  const authz = ctx.newService(AuthzService, ctx.db);
  await authz.onModuleInit();
  const guard = new PermissionGuard(new Reflector(), authz);
  return { ctx, authz, guard };
}

/** Fabricate an ExecutionContext carrying `required` metadata + a request. */
function execContext(
  required: RequiredPermission | undefined,
  req: Partial<RequestWithAuthCtx>,
): ExecutionContext {
  const handler = (): void => undefined;
  if (required) Reflect.defineMetadata(REQUIRE_PERMISSION_KEY, required, handler);
  const request = {
    method: 'POST',
    url: '/api/v1/apps',
    originalUrl: '/api/v1/apps',
    params: {},
    ...req,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class Dummy {},
  } as unknown as ExecutionContext;
}

function reqWith(ctx: AuthContext, params: Record<string, string> = {}): Partial<RequestWithAuthCtx> {
  const req: Partial<RequestWithAuthCtx> = { params };
  setAuthCtx(req as RequestWithAuthCtx, ctx);
  return req;
}

const viewer: AuthContext = {
  userId: 'usr_v',
  tenantId: 'tnt_a',
  role: 'viewer',
  isSuperadmin: false,
  scope: 'user',
  via: 'user_jwt',
};

describe('authz/PermissionGuard', () => {
  let h: Harness;
  const prev = process.env[ENV];

  beforeEach(async () => (h = await make()));
  afterEach(() => {
    h.ctx.cleanup();
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  });

  it('passes handlers with no @RequirePermission', async () => {
    process.env[ENV] = 'on';
    const ec = execContext(undefined, reqWith(viewer));
    await expect(h.guard.canActivate(ec)).resolves.toBe(true);
  });

  it('passes when req.authCtx is absent (pre-wiring back-compat)', async () => {
    process.env[ENV] = 'on';
    const ec = execContext({ resource: 'app', action: 'create' }, { params: {} });
    await expect(h.guard.canActivate(ec)).resolves.toBe(true);
  });

  describe('mode=off', () => {
    it('skips the check entirely (viewer create allowed)', async () => {
      process.env[ENV] = 'off';
      const ec = execContext(
        { resource: 'app', action: 'create' },
        reqWith(viewer),
      );
      await expect(h.guard.canActivate(ec)).resolves.toBe(true);
    });
  });

  describe('mode=log (default)', () => {
    it('allows a would-be denial but logs it (viewer create passes)', async () => {
      process.env[ENV] = 'log';
      const warn = jest
        .spyOn((h.guard as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);
      const ec = execContext(
        { resource: 'app', action: 'create' },
        reqWith(viewer),
      );
      await expect(h.guard.canActivate(ec)).resolves.toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('WOULD-DENY'));
    });
  });

  describe('mode=on', () => {
    beforeEach(() => (process.env[ENV] = 'on'));

    it('DENIES a viewer trying to create (403)', async () => {
      const ec = execContext(
        { resource: 'app', action: 'create' },
        reqWith(viewer),
      );
      await expect(h.guard.canActivate(ec)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('ALLOWS a viewer read', async () => {
      const ec = execContext({ resource: 'app', action: 'read' }, reqWith(viewer));
      await expect(h.guard.canActivate(ec)).resolves.toBe(true);
    });

    it('DENIES an owner when the :app is outside their tenant (data-scope)', async () => {
      h.ctx.db
        .global()
        .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)')
        .run('theirs', 'tnt_b');
      const owner: AuthContext = { ...viewer, role: 'owner' };
      const ec = execContext(
        { resource: 'app', action: 'write' },
        reqWith(owner, { app: 'theirs' }),
      );
      await expect(h.guard.canActivate(ec)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('ALLOWS an owner when the :app is in their tenant', async () => {
      h.ctx.db
        .global()
        .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)')
        .run('mine', 'tnt_a');
      const owner: AuthContext = { ...viewer, role: 'owner' };
      const ec = execContext(
        { resource: 'app', action: 'write' },
        reqWith(owner, { app: 'mine' }),
      );
      await expect(h.guard.canActivate(ec)).resolves.toBe(true);
    });
  });

  // ===========================================================================
  // CRITICAL INVARIANT — superadmin & api_token are NEVER blocked, any mode
  // ===========================================================================
  describe('INVARIANT: platform-owner credentials never blocked', () => {
    const superadmin: AuthContext = {
      userId: 'admin',
      tenantId: 'platform',
      role: 'superadmin',
      isSuperadmin: true,
      scope: 'global',
      via: 'admin_jwt',
    };
    const apiToken: AuthContext = {
      userId: 'token:1',
      tenantId: 'platform',
      role: 'service',
      isSuperadmin: true,
      scope: 'global',
      via: 'api_token',
    };
    it.each(['off', 'log', 'on'])(
      'superadmin passes a delete in mode=%s',
      async (mode) => {
        process.env[ENV] = mode;
        const ec = execContext(
          { resource: 'app', action: 'delete' },
          reqWith(superadmin, { app: 'anything' }),
        );
        await expect(h.guard.canActivate(ec)).resolves.toBe(true);
      },
    );

    it.each(['off', 'log', 'on'])(
      'global api_token passes a delete in mode=%s',
      async (mode) => {
        process.env[ENV] = mode;
        const ec = execContext(
          { resource: 'tenant', action: 'write' },
          reqWith(apiToken, { app: 'anything' }),
        );
        await expect(h.guard.canActivate(ec)).resolves.toBe(true);
      },
    );

  });

  // ===========================================================================
  // Fase-0 M2 — app-scoped token isolation (the blocker #1).
  //
  // NOTE: this REPLACES the previous "app-scoped api_token bypasses even a
  // cross-tenant app" case, which asserted the VULNERABLE fail-open behaviour (a
  // per-app token could act on any app). The correct behaviour is: an app-scoped
  // token may only touch its OWN app; a global/superadmin token still reaches
  // every app (golden rule). Isolation is by APP ID, not tenant, so it holds even
  // when two apps share a tenant.
  // ===========================================================================
  describe('M2 — app-scoped token isolation', () => {
    /** Seed an app and return its numeric id. */
    function seedApp(name: string, tenant = 'tnt_a'): number {
      const res = h.ctx.db
        .global()
        .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)')
        .run(name, tenant);
      return Number(res.lastInsertRowid);
    }

    /** A per-app `sk_` token request: authCtx (scope:'app') + legacy req.auth.appId. */
    function appTokenReq(
      tokenAppId: number,
      params: Record<string, string>,
    ): Partial<RequestWithAuthCtx> {
      const ctx: AuthContext = {
        userId: `token:${tokenAppId}`,
        tenantId: 'tnt_a',
        role: 'service',
        isSuperadmin: false,
        scope: 'app',
        via: 'api_token',
      };
      const req: Partial<RequestWithAuthCtx> = { params };
      setAuthCtx(req as RequestWithAuthCtx, ctx);
      (req as unknown as { auth: unknown }).auth = {
        tokenId: tokenAppId,
        scope: 'app',
        appId: tokenAppId,
      };
      return req;
    }

    it('mode=on: DENIES (403) a token acting on ANOTHER app (same tenant)', async () => {
      process.env[ENV] = 'on';
      const mine = seedApp('mine', 'tnt_a');
      seedApp('other', 'tnt_a'); // same tenant → proves appId-based isolation
      const ec = execContext(
        { resource: 'app', action: 'delete' },
        appTokenReq(mine, { app: 'other' }),
      );
      await expect(h.guard.canActivate(ec)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('mode=on: ALLOWS a token acting on its OWN app', async () => {
      process.env[ENV] = 'on';
      const mine = seedApp('mine');
      const ec = execContext(
        { resource: 'stream', action: 'write' },
        appTokenReq(mine, { app: 'mine' }),
      );
      await expect(h.guard.canActivate(ec)).resolves.toBe(true);
    });

    it('mode=on: isolation also covers the :name param (config/s3 routes)', async () => {
      process.env[ENV] = 'on';
      const mine = seedApp('mine');
      seedApp('other');
      const ec = execContext(
        { resource: 'config', action: 'write' },
        appTokenReq(mine, { name: 'other' }),
      );
      await expect(h.guard.canActivate(ec)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('mode=log: cross-app is only logged (WOULD-DENY) and allowed', async () => {
      process.env[ENV] = 'log';
      const mine = seedApp('mine');
      seedApp('other');
      const warn = jest
        .spyOn(
          (h.guard as unknown as { logger: { warn: jest.Mock } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      const ec = execContext(
        { resource: 'app', action: 'delete' },
        appTokenReq(mine, { app: 'other' }),
      );
      await expect(h.guard.canActivate(ec)).resolves.toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('WOULD-DENY'));
    });

    it('mode=on: unknown route app → not blocked (handler 404s normally)', async () => {
      process.env[ENV] = 'on';
      const mine = seedApp('mine');
      const ec = execContext(
        { resource: 'app', action: 'delete' },
        appTokenReq(mine, { app: 'ghost' }),
      );
      await expect(h.guard.canActivate(ec)).resolves.toBe(true);
    });

    it('mode=on: a GLOBAL api_token still reaches ANY app (golden rule)', async () => {
      process.env[ENV] = 'on';
      seedApp('other', 'tnt_zzz');
      const globalTok: AuthContext = {
        userId: 'token:1',
        tenantId: 'platform',
        role: 'service',
        isSuperadmin: true,
        scope: 'global',
        via: 'api_token',
      };
      const req: Partial<RequestWithAuthCtx> = { params: { app: 'other' } };
      setAuthCtx(req as RequestWithAuthCtx, globalTok);
      (req as unknown as { auth: unknown }).auth = {
        tokenId: 1,
        scope: 'global',
        appId: null,
      };
      const ec = execContext({ resource: 'app', action: 'delete' }, req);
      await expect(h.guard.canActivate(ec)).resolves.toBe(true);
    });
  });
});
