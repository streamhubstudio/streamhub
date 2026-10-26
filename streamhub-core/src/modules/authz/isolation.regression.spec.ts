/**
 * Regression spec — the multi-tenant isolation P0 that was closed in Fase-0
 * (security fix P0-4). These cases exist so the fix can NEVER silently reopen;
 * if any of them fails, an isolation guarantee regressed — do not "fix" the
 * test, fix the code.
 *
 * Locks, in one focused place:
 *   1. ORDER: `crossAppViolation` runs BEFORE the api_token RBAC bypass —
 *      a per-app `sk_` token for app A is 403 on app B's routes (tokens /
 *      config / s3 / purge-shaped permissions) even though `via:'api_token'`
 *      would pass RBAC one line later; Casbin is never even consulted.
 *   2. The documented fail-SAFE branches stay fail-safe (unknown token app /
 *      unknown route app do not block) without weakening #1.
 *   3. `createToken()` persists `tenant_id` on the api_tokens ROW (app-scoped
 *      → the app's tenant; global → platform) — the "createToken() no setea
 *      tenant_id" finding.
 *   4. `STREAMHUB_AUTHZ_ENFORCE` resolves to 'on' when unset or garbage —
 *      secure-by-default can't be lost to a typo'd env.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import {
  AuthContext,
  PLATFORM_TENANT_ID,
  RequestWithAuthCtx,
  setAuthCtx,
} from '../../shared/auth-context';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { TotpService } from '../auth/totp.service';
import { TenancyService } from '../tenancy/tenancy.service';
import {
  AUTHZ_ENFORCE_ENV,
  enforcementMode,
  isEnforcing,
} from './authz.constants';
import { AuthzService } from './authz.service';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from './permission.decorator';
import { PermissionGuard } from './permission.guard';

// ---------------------------------------------------------------------------
// PermissionGuard harness (same shape as permission.guard.spec.ts)
// ---------------------------------------------------------------------------

interface GuardHarness {
  ctx: UnitContext;
  authz: AuthzService;
  guard: PermissionGuard;
}

async function makeGuard(): Promise<GuardHarness> {
  const ctx = makeUnitContext();
  const authz = ctx.newService(AuthzService, ctx.db);
  await authz.onModuleInit();
  const guard = new PermissionGuard(new Reflector(), authz);
  return { ctx, authz, guard };
}

function execContext(
  required: RequiredPermission,
  req: Partial<RequestWithAuthCtx>,
): ExecutionContext {
  const handler = (): void => undefined;
  Reflect.defineMetadata(REQUIRE_PERMISSION_KEY, required, handler);
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

/** A per-app `sk_` token request: authCtx (scope:'app') + legacy req.auth.appId. */
function appTokenReq(
  tokenAppId: number | null,
  params: Record<string, string>,
): Partial<RequestWithAuthCtx> {
  const ctx: AuthContext = {
    userId: `token:${tokenAppId ?? 'x'}`,
    tenantId: 'tnt_a',
    role: 'service',
    isSuperadmin: false,
    scope: 'app',
    via: 'api_token',
  };
  const req: Partial<RequestWithAuthCtx> = { params };
  setAuthCtx(req as RequestWithAuthCtx, ctx);
  (req as unknown as { auth: unknown }).auth = {
    tokenId: 1,
    scope: 'app',
    appId: tokenAppId,
  };
  return req;
}

describe('P0-4 regression — app-scoped token isolation can never reopen', () => {
  let h: GuardHarness;
  const prevEnv = process.env[AUTHZ_ENFORCE_ENV];

  beforeEach(async () => {
    h = await makeGuard();
    process.env[AUTHZ_ENFORCE_ENV] = 'on';
  });
  afterEach(() => {
    h.ctx.cleanup();
    if (prevEnv === undefined) delete process.env[AUTHZ_ENFORCE_ENV];
    else process.env[AUTHZ_ENFORCE_ENV] = prevEnv;
  });

  function seedApp(name: string, tenant = 'tnt_a'): number {
    const res = h.ctx.db
      .global()
      .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)')
      .run(name, tenant);
    return Number(res.lastInsertRowid);
  }

  // The exact permission surface the P0 report called out: mint tokens, read/
  // write config, read S3 creds, purge the app — appA's token against appB.
  it.each([
    ['token', 'create'],
    ['config', 'read'],
    ['config', 'write'],
    ['s3', 'read'],
    ['s3', 'write'],
    ['app', 'delete'], // purge-shaped
    ['stream', 'write'],
  ] as const)(
    'DENIES appA token on appB for %s:%s BEFORE the api_token bypass (Casbin never consulted)',
    async (resource, action) => {
      const appA = seedApp('app-a');
      seedApp('app-b'); // same tenant on purpose: isolation is by APP id
      const canSpy = jest.spyOn(h.authz, 'can');

      const ec = execContext(
        { resource, action } as RequiredPermission,
        appTokenReq(appA, { app: 'app-b' }),
      );
      await expect(h.guard.canActivate(ec)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // Ordering proof: via:'api_token' passes RBAC unconditionally at step 2,
      // so a 403 can ONLY come from the isolation check running FIRST — and
      // the RBAC engine must never have been asked.
      expect(canSpy).not.toHaveBeenCalled();
    },
  );

  it('DENIES on the :name param too (config/s3 controllers use :name)', async () => {
    const appA = seedApp('app-a');
    seedApp('app-b');
    const ec = execContext(
      { resource: 'config', action: 'write' },
      appTokenReq(appA, { name: 'app-b' }),
    );
    await expect(h.guard.canActivate(ec)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('still ALLOWS the token on its OWN app (no over-blocking)', async () => {
    const appA = seedApp('app-a');
    const ec = execContext(
      { resource: 'config', action: 'write' },
      appTokenReq(appA, { app: 'app-a' }),
    );
    await expect(h.guard.canActivate(ec)).resolves.toBe(true);
  });

  it('fail-SAFE branches: unknown token app / unknown route app do not block', async () => {
    const appA = seedApp('app-a');
    // Token whose app id could not be resolved → pass (documented fail-safe).
    const noTokenApp = execContext(
      { resource: 'stream', action: 'write' },
      appTokenReq(null, { app: 'app-a' }),
    );
    await expect(h.guard.canActivate(noTokenApp)).resolves.toBe(true);
    // Route app that does not exist → pass, the handler 404s.
    const ghostRoute = execContext(
      { resource: 'stream', action: 'write' },
      appTokenReq(appA, { app: 'ghost' }),
    );
    await expect(h.guard.canActivate(ghostRoute)).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createToken() persists tenant_id (the M2 finding) — checked on the ROW
// ---------------------------------------------------------------------------

describe('P0-4 regression — createToken() sets api_tokens.tenant_id', () => {
  let ctx: UnitContext;
  let auth: AuthService;

  beforeEach(() => {
    ctx = makeUnitContext({
      ADMIN_USER: '',
      ADMIN_PASS: '',
      STREAMHUB_JWT_SECRET: 'test-jwt-secret-do-not-use-in-prod',
    });
    const tenancy = ctx.newService(TenancyService, ctx.db, ctx.config);
    tenancy.onModuleInit();
    const totp = ctx.newService(TotpService, ctx.config, tenancy);
    const sessions = ctx.newService(SessionService, ctx.db);
    sessions.onModuleInit();
    auth = ctx.newService(AuthService, ctx.db, ctx.config, tenancy, totp, sessions);
  });
  afterEach(() => ctx.cleanup());

  function rowTenant(id: number): string | null {
    const row = ctx.db
      .global()
      .prepare('SELECT tenant_id FROM api_tokens WHERE id = ?')
      .get(id) as { tenant_id: string | null } | undefined;
    return row?.tenant_id ?? null;
  }

  it("an app-scoped token's ROW carries the app's tenant (not the column default)", async () => {
    const appId = Number(
      ctx.db
        .global()
        .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)')
        .run('shop', 'tnt_shop').lastInsertRowid,
    );
    const { id } = await auth.createToken({ name: 'k', scope: 'app', appId });
    expect(rowTenant(id)).toBe('tnt_shop');
  });

  it("a global token's ROW carries the platform tenant", async () => {
    const { id } = await auth.createToken({ name: 'g', scope: 'global' });
    expect(rowTenant(id)).toBe(PLATFORM_TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// STREAMHUB_AUTHZ_ENFORCE — secure-by-default resolution
// ---------------------------------------------------------------------------

describe('P0-4 regression — AUTHZ_ENFORCE defaults to on', () => {
  const prev = process.env[AUTHZ_ENFORCE_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[AUTHZ_ENFORCE_ENV];
    else process.env[AUTHZ_ENFORCE_ENV] = prev;
  });

  it("UNSET env resolves to 'on' (fresh installs enforce)", () => {
    delete process.env[AUTHZ_ENFORCE_ENV];
    expect(enforcementMode()).toBe('on');
    expect(isEnforcing()).toBe(true);
  });

  it.each(['', 'onn', 'true', '1', 'enforce', 'garbage'])(
    "unknown/typo value %p resolves to 'on', never fail-open",
    (v) => {
      process.env[AUTHZ_ENFORCE_ENV] = v;
      expect(enforcementMode()).toBe('on');
    },
  );

  it("explicit 'log' / 'off' / 'ON' are honoured (operator override wins)", () => {
    process.env[AUTHZ_ENFORCE_ENV] = 'log';
    expect(enforcementMode()).toBe('log');
    process.env[AUTHZ_ENFORCE_ENV] = 'off';
    expect(enforcementMode()).toBe('off');
    process.env[AUTHZ_ENFORCE_ENV] = ' ON ';
    expect(enforcementMode()).toBe('on');
  });
});
