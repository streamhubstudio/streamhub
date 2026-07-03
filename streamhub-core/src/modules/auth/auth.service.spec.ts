/**
 * Unit — auth/AuthService (built-in auth + Bearer validation + token mgmt).
 *
 * Exercises the whole credential surface against a real migrated SQLite DB
 * (harness makeUnitContext) with a real TenancyService underneath:
 *   - signup/login (scrypt users + break-glass admin),
 *   - validate(): `sk_` API tokens (back-compat superadmin/global), user_jwt,
 *     admin_jwt, public-path bypass, IP/CIDR whitelist,
 *   - token CRUD (create/list/revoke) with hash-at-rest.
 *
 * Owned by: auth-tenancy test agent.
 */
import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { signJwt, verifyJwt } from '../../shared/auth';
import { getAuthCtx, PLATFORM_TENANT_ID } from '../../shared/auth-context';
import { ConfigService } from '../../shared/config/config.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';

interface Harness {
  ctx: UnitContext;
  tenancy: TenancyService;
  auth: AuthService;
  totp: TotpService;
}

/**
 * Build a real AuthService+TenancyService over a fresh temp DB. Signup is
 * enabled by default here (this suite exercises the open-signup behaviour);
 * the STREAMHUB_ALLOW_SIGNUP=off gate has its own spec (signup-flag).
 */
function makeAuth(overrides: Record<string, string> = {}): Harness {
  const ctx = makeUnitContext({
    ADMIN_USER: '',
    ADMIN_PASS: '',
    STREAMHUB_JWT_SECRET: SECRET,
    STREAMHUB_ALLOW_SIGNUP: '1',
    ...overrides,
  });
  const tenancy = ctx.newService(TenancyService, ctx.db, ctx.config);
  tenancy.onModuleInit();
  const totp = ctx.newService(TotpService, ctx.config, tenancy);
  const sessions = ctx.newService(SessionService, ctx.db);
  sessions.onModuleInit();
  const auth = ctx.newService(
    AuthService,
    ctx.db,
    ctx.config,
    tenancy,
    totp,
    sessions,
  );
  return { ctx, tenancy, auth, totp };
}

/** Minimal express Request stand-in for validate(). */
function makeReq(opts: {
  token?: string;
  path?: string;
  ip?: string;
  xff?: string;
} = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.xff) headers['x-forwarded-for'] = opts.xff;
  const ip = opts.ip ?? '203.0.113.10';
  return {
    headers,
    path: opts.path ?? '/api/v1/apps',
    url: opts.path ?? '/api/v1/apps',
    ip,
    socket: { remoteAddress: ip },
    params: {},
  } as unknown as Request;
}

/** Insert an app row directly and return its id (for app-scoped tokens). */
function seedApp(h: Harness, name: string, tenantId = 'tnt_x'): number {
  const res = h.ctx.db
    .global()
    .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)')
    .run(name, tenantId);
  return Number(res.lastInsertRowid);
}

describe('auth/AuthService', () => {
  // ===========================================================================
  // signup
  // ===========================================================================
  describe('signup', () => {
    let h: Harness;
    beforeEach(() => (h = makeAuth()));
    afterEach(() => h.ctx.cleanup());

    it('creates a user + team + owner membership and mints a valid JWT', async () => {
      const { token } = await h.auth.signup({
        email: 'Alice@Example.com',
        password: 's3cret-passphrase',
        teamName: 'Acme',
      });
      const payload = verifyJwt(token, SECRET);
      expect(payload.sub).toMatch(/^usr_/);

      const user = h.tenancy.getUserByEmail('alice@example.com');
      expect(user).not.toBeNull();
      expect(user!.email).toBe('alice@example.com'); // normalised lower-case
      expect(user!.password_hash).toMatch(/^scrypt\$/);
      expect(user!.status).toBe('active');

      const membership = h.tenancy.primaryMembership(user!.id);
      expect(membership).toMatchObject({ role: 'owner' });
      const team = h.tenancy.getTenant(membership!.tenantId);
      expect(team).toMatchObject({ name: 'Acme', plan: 'free' });
      // Free plan quota was seeded for the new team.
      expect(h.tenancy.getQuota(membership!.tenantId)).toMatchObject({
        max_apps: 2,
      });
    });

    it('defaults the team name to the email when none is given', async () => {
      await h.auth.signup({ email: 'bob@x.com', password: 'passw0rd!' });
      const user = h.tenancy.getUserByEmail('bob@x.com')!;
      const team = h.tenancy.getTenant(
        h.tenancy.primaryMembership(user.id)!.tenantId,
      )!;
      expect(team.name).toBe('bob@x.com');
    });

    it('rejects a duplicate email (already has a password)', async () => {
      await h.auth.signup({ email: 'dup@x.com', password: 'passw0rd!' });
      await expect(
        h.auth.signup({ email: 'dup@x.com', password: 'other-pass' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects empty email/password', async () => {
      await expect(
        h.auth.signup({ email: '   ', password: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        h.auth.signup({ email: 'a@b.com', password: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets a PENDING invited user complete signup (sets password, keeps team)', async () => {
      // Simulate an invite: a pending user already attached to a team.
      const tenantId = h.tenancy.createTeam('Invited Team');
      const userId = h.tenancy.createUser({
        email: 'invitee@x.com',
        status: 'pending',
      });
      h.tenancy.addMembership(userId, tenantId, 'editor');

      const { token } = await h.auth.signup({
        email: 'invitee@x.com',
        password: 'now-i-have-a-pass',
      });
      expect(verifyJwt(token, SECRET).sub).toBe(userId); // same user, not a new one

      const user = h.tenancy.getUser(userId)!;
      expect(user.password_hash).toMatch(/^scrypt\$/);
      expect(user.status).toBe('active');
      // No second team was created; original editor membership preserved.
      const membership = h.tenancy.primaryMembership(userId)!;
      expect(membership).toEqual({ tenantId, role: 'editor' });
    });

    it('refuses when STREAMHUB_JWT_SECRET is not configured', async () => {
      const h2 = makeAuth({ STREAMHUB_JWT_SECRET: '' });
      await expect(
        h2.auth.signup({ email: 'a@b.com', password: 'passw0rd!' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      h2.ctx.cleanup();
    });
  });

  // ===========================================================================
  // signup vs the break-glass admin identity
  // ===========================================================================
  describe('signup — admin email collision', () => {
    it('rejects signing up as the configured ADMIN_USER email', async () => {
      const h = makeAuth({ ADMIN_USER: 'root@corp.com', ADMIN_PASS: 'toor' });
      await expect(
        h.auth.signup({ email: 'ROOT@corp.com', password: 'passw0rd!' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      h.ctx.cleanup();
    });
  });

  // ===========================================================================
  // login
  // ===========================================================================
  describe('login', () => {
    let h: Harness;
    beforeEach(async () => {
      h = makeAuth();
      await h.auth.signup({ email: 'user@x.com', password: 'passw0rd!' });
    });
    afterEach(() => h.ctx.cleanup());

    it('logs in a built-in user and returns a JWT for their id', async () => {
      const { token } = await h.auth.login('User@X.com', 'passw0rd!');
      const user = h.tenancy.getUserByEmail('user@x.com')!;
      expect(verifyJwt(token, SECRET).sub).toBe(user.id);
    });

    it('rejects a wrong password', async () => {
      await expect(h.auth.login('user@x.com', 'nope')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an unknown email', async () => {
      await expect(
        h.auth.login('ghost@x.com', 'passw0rd!'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a pending (invited, password-less) user', async () => {
      const tenantId = h.tenancy.createTeam('T');
      const uid = h.tenancy.createUser({
        email: 'pending@x.com',
        status: 'pending',
      });
      h.tenancy.addMembership(uid, tenantId, 'viewer');
      await expect(
        h.auth.login('pending@x.com', 'whatever'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('login — break-glass admin', () => {
    it('accepts ADMIN_USER/ADMIN_PASS and mints an admin JWT (sub=admin)', async () => {
      const h = makeAuth({ ADMIN_USER: 'root@corp.com', ADMIN_PASS: 'toor' });
      const { token } = await h.auth.login('root@corp.com', 'toor');
      expect(verifyJwt(token, SECRET).sub).toBe(TenancyService.ADMIN_USER_ID);
      h.ctx.cleanup();
    });

    it('rejects the admin with a wrong password', async () => {
      const h = makeAuth({ ADMIN_USER: 'root@corp.com', ADMIN_PASS: 'toor' });
      await expect(
        h.auth.login('root@corp.com', 'wrong'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      h.ctx.cleanup();
    });

    it('does not enable admin login when creds are unset', async () => {
      const h = makeAuth(); // ADMIN_USER/PASS empty
      await expect(h.auth.login('', '')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      h.ctx.cleanup();
    });
  });

  // ===========================================================================
  // validate() — API tokens (sk_)
  // ===========================================================================
  describe('validate — sk_ API tokens', () => {
    let h: Harness;
    beforeEach(() => (h = makeAuth()));
    afterEach(() => h.ctx.cleanup());

    it('accepts a GLOBAL token and marks it superadmin/global (back-compat)', async () => {
      const { token } = await h.auth.createToken({ name: 'ci', scope: 'global' });
      const req = makeReq({ token });
      const legacy = await h.auth.validate(req);
      expect(legacy).toEqual({ tokenId: expect.any(Number), scope: 'global', appId: null });

      const authCtx = getAuthCtx(req)!;
      expect(authCtx).toMatchObject({
        via: 'api_token',
        role: 'service',
        isSuperadmin: true,
        scope: 'global',
        tenantId: PLATFORM_TENANT_ID,
      });
    });

    it('accepts an APP-scoped token as a NON-superadmin service (scope=app)', async () => {
      const appId = seedApp(h, 'shop', 'tnt_shop');
      const { token } = await h.auth.createToken({
        name: 'shop-key',
        scope: 'app',
        appId,
      });
      const req = makeReq({ token });
      const legacy = await h.auth.validate(req);
      expect(legacy).toMatchObject({ scope: 'app', appId });

      const authCtx = getAuthCtx(req)!;
      expect(authCtx).toMatchObject({
        via: 'api_token',
        isSuperadmin: false,
        scope: 'app',
        // Fase-0 M2: createToken now pins tenant_id to the app's tenant, so the
        // resolved context is correctly scoped (previously wrongly 'platform').
        tenantId: 'tnt_shop',
      });
    });

    /**
     * Fase-0 M2 (fix of the "createToken() no setea tenant_id" finding).
     * AuthService.createToken() now writes `api_tokens.tenant_id` = the app's
     * tenant for an app-scoped token (it previously omitted the column and every
     * token inherited the DEFAULT 'platform'). validate() therefore resolves the
     * app-scoped token to its real tenant immediately — no restart/backfill.
     */
    it('app-scoped token tenantId equals the app tenant (M2 fix)', async () => {
      const appId = seedApp(h, 'shop2', 'tnt_shop2');
      const { token } = await h.auth.createToken({
        name: 'shop2-key',
        scope: 'app',
        appId,
      });
      const req = makeReq({ token });
      await h.auth.validate(req);
      expect(getAuthCtx(req)!.tenantId).toBe('tnt_shop2');
    });

    it('global token tenantId is the platform tenant (M2)', async () => {
      const { token } = await h.auth.createToken({ name: 'g', scope: 'global' });
      const req = makeReq({ token });
      await h.auth.validate(req);
      expect(getAuthCtx(req)!.tenantId).toBe(PLATFORM_TENANT_ID);
    });

    it('rejects an unknown token', async () => {
      await expect(
        h.auth.validate(makeReq({ token: 'sk_deadbeef' })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a revoked token', async () => {
      const { id, token } = await h.auth.createToken({ name: 'x', scope: 'global' });
      await h.auth.revokeToken(id);
      await expect(
        h.auth.validate(makeReq({ token })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a missing Bearer token', async () => {
      await expect(h.auth.validate(makeReq({}))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('touches last_used_at on a successful validate', async () => {
      const { id, token } = await h.auth.createToken({ name: 'x', scope: 'global' });
      await h.auth.validate(makeReq({ token }));
      const summary = (await h.auth.listTokens()).find((t) => t.id === id)!;
      expect(summary.lastUsedAt).not.toBeNull();
    });
  });

  // ===========================================================================
  // validate() — IP / CIDR whitelist
  // ===========================================================================
  describe('validate — IP whitelist', () => {
    let h: Harness;
    beforeEach(() => (h = makeAuth()));
    afterEach(() => h.ctx.cleanup());

    async function tokenWithIps(allowedIps: string[]): Promise<string> {
      const { token } = await h.auth.createToken({
        name: 'ip',
        scope: 'global',
        allowedIps,
      });
      return token;
    }

    it('allows an exact IP match', async () => {
      const token = await tokenWithIps(['203.0.113.10']);
      await expect(
        h.auth.validate(makeReq({ token, ip: '203.0.113.10' })),
      ).resolves.toBeDefined();
    });

    it('allows a CIDR match', async () => {
      const token = await tokenWithIps(['10.0.0.0/8']);
      await expect(
        h.auth.validate(makeReq({ token, ip: '10.9.9.9' })),
      ).resolves.toBeDefined();
    });

    it('rejects an IP outside the whitelist', async () => {
      const token = await tokenWithIps(['10.0.0.0/8']);
      await expect(
        h.auth.validate(makeReq({ token, ip: '192.168.1.1' })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('honours X-Forwarded-For (nginx) over socket ip', async () => {
      const token = await tokenWithIps(['203.0.113.10']);
      await expect(
        h.auth.validate(
          makeReq({ token, ip: '127.0.0.1', xff: '203.0.113.10, 10.0.0.1' }),
        ),
      ).resolves.toBeDefined();
    });

    it('normalises IPv4-mapped IPv6 (::ffff:1.2.3.4)', async () => {
      const token = await tokenWithIps(['1.2.3.4']);
      await expect(
        h.auth.validate(makeReq({ token, ip: '::ffff:1.2.3.4' })),
      ).resolves.toBeDefined();
    });

    it('treats an empty whitelist as no restriction', async () => {
      const { token } = await h.auth.createToken({ name: 'x', scope: 'global' });
      await expect(
        h.auth.validate(makeReq({ token, ip: '8.8.8.8' })),
      ).resolves.toBeDefined();
    });
  });

  // ===========================================================================
  // validate() — login JWTs (user_jwt / admin_jwt) + public paths
  // ===========================================================================
  describe('validate — login JWTs', () => {
    it('resolves a user JWT to their tenant + role (via user_jwt)', async () => {
      const h = makeAuth();
      const { token } = await h.auth.signup({
        email: 'owner@x.com',
        password: 'passw0rd!',
      });
      const req = makeReq({ token });
      await h.auth.validate(req);
      const user = h.tenancy.getUserByEmail('owner@x.com')!;
      expect(getAuthCtx(req)).toMatchObject({
        via: 'user_jwt',
        userId: user.id,
        role: 'owner',
        isSuperadmin: false,
        scope: 'user',
      });
      h.ctx.cleanup();
    });

    it('resolves the admin JWT (sub=admin) to a superadmin context (never lockable)', async () => {
      const h = makeAuth({ ADMIN_USER: 'root@corp.com', ADMIN_PASS: 'toor' });
      const token = signJwt(
        { sub: TenancyService.ADMIN_USER_ID },
        SECRET,
        3600,
      );
      const req = makeReq({ token });
      await h.auth.validate(req);
      expect(getAuthCtx(req)).toMatchObject({
        via: 'admin_jwt',
        isSuperadmin: true,
        role: 'superadmin',
        scope: 'global',
        tenantId: PLATFORM_TENANT_ID,
      });
      h.ctx.cleanup();
    });

    it('resolves the admin JWT even when ADMIN_USER is unset (sub=admin still superadmin)', async () => {
      const h = makeAuth(); // no admin configured / mirrored user
      const token = signJwt({ sub: TenancyService.ADMIN_USER_ID }, SECRET, 3600);
      const req = makeReq({ token });
      await h.auth.validate(req);
      expect(getAuthCtx(req)).toMatchObject({ isSuperadmin: true, via: 'admin_jwt' });
      h.ctx.cleanup();
    });

    it('rejects an expired JWT', async () => {
      const h = makeAuth();
      const token = signJwt({ sub: 'usr_whatever' }, SECRET, -10);
      await expect(
        h.auth.validate(makeReq({ token })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      h.ctx.cleanup();
    });

    it('rejects a JWT signed with the wrong secret', async () => {
      const h = makeAuth();
      const token = signJwt({ sub: 'usr_x' }, 'a-different-secret', 3600);
      await expect(
        h.auth.validate(makeReq({ token })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      h.ctx.cleanup();
    });

    it('rejects a valid JWT whose sub is an unknown/deleted user', async () => {
      const h = makeAuth();
      const token = signJwt({ sub: 'usr_ghost' }, SECRET, 3600);
      await expect(
        h.auth.validate(makeReq({ token })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      h.ctx.cleanup();
    });
  });

  describe('validate — public path bypass', () => {
    let h: Harness;
    beforeEach(() => (h = makeAuth()));
    afterEach(() => h.ctx.cleanup());

    it.each([
      '/api/v1/health',
      '/api/v1/health/ready',
      '/api/v1/docs',
      '/api/v1/openapi.json',
      '/api/v1/play/live/room',
      '/api/v1/assets/x.jpg',
    ])('bypasses auth for public path %s (no token required)', async (path) => {
      const ctx = await h.auth.validate(makeReq({ path }));
      expect(ctx).toEqual({ tokenId: 0, scope: 'global', appId: null });
    });

    it('does NOT treat a non-public path as public', async () => {
      await expect(
        h.auth.validate(makeReq({ path: '/api/v1/apps' })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  // ===========================================================================
  // Token management
  // ===========================================================================
  describe('token management', () => {
    let h: Harness;
    beforeEach(() => (h = makeAuth()));
    afterEach(() => h.ctx.cleanup());

    it('returns the plaintext ONCE and stores only a hash', async () => {
      const { id, token } = await h.auth.createToken({ name: 'ci', scope: 'global' });
      expect(token.startsWith('sk_')).toBe(true);
      const row = h.ctx.db
        .global()
        .prepare('SELECT token_hash FROM api_tokens WHERE id = ?')
        .get(id) as { token_hash: string };
      expect(row.token_hash).not.toContain(token);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    });

    it('requires appId when scope=app and rejects a non-existent app', async () => {
      await expect(
        h.auth.createToken({ name: 'x', scope: 'app' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        h.auth.createToken({ name: 'x', scope: 'app', appId: 9999 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects appId on a global token', async () => {
      const appId = seedApp(h, 'a1');
      await expect(
        h.auth.createToken({ name: 'x', scope: 'global', appId }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lists tokens as summaries (never the hash) with the revoked flag', async () => {
      const { id } = await h.auth.createToken({ name: 'keep', scope: 'global' });
      await h.auth.revokeToken(id);
      const summaries = await h.auth.listTokens();
      const s = summaries.find((t) => t.id === id)!;
      expect(s).toMatchObject({ name: 'keep', scope: 'global', revoked: true });
      expect(s).not.toHaveProperty('token_hash');
      expect(s).not.toHaveProperty('tokenHash');
    });

    it('rejects revoking a non-existent token', async () => {
      await expect(h.auth.revokeToken(123456)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

// Keep an explicit reference so unused-import lint never trips if the file is
// trimmed; ConfigService is used transitively via the harness.
void ConfigService;
