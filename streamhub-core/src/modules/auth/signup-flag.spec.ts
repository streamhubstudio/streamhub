/**
 * Unit — auth/AuthService signup (public registration) gate.
 *
 * Canonical flag STREAMHUB_PUBLIC_REGISTRATION (default OFF); legacy alias
 * STREAMHUB_ALLOW_SIGNUP. The flag decides whether PUBLIC self-signup exists:
 *   - ON  → POST /auth/signup creates user + tenant + owner membership,
 *   - OFF → a brand-new email is refused (403 signup_disabled)… but an INVITED
 *     pending user may still complete signup (that finishes their invite),
 *   - GET /auth/config surfaces the flag so the SPA shows/hides "Create account".
 */
import { ForbiddenException } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { verifyJwt } from '../../shared/auth';
import { TenancyService } from '../tenancy/tenancy.service';
import { AuthService } from './auth.service';
import { LoginController } from './login.controller';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';

interface Harness {
  ctx: UnitContext;
  tenancy: TenancyService;
  auth: AuthService;
}

function makeAuth(allowSignup: string): Harness {
  const ctx = makeUnitContext({
    ADMIN_USER: '',
    ADMIN_PASS: '',
    STREAMHUB_JWT_SECRET: SECRET,
    STREAMHUB_ALLOW_SIGNUP: allowSignup,
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
  return { ctx, tenancy, auth };
}

/**
 * Build the harness with explicit env overrides. Both signup flags start empty
 * so a test controls exactly which one is set (used to prove the canonical
 * STREAMHUB_PUBLIC_REGISTRATION flag works and takes precedence over the alias).
 */
function makeAuthEnv(env: Record<string, string>): Harness {
  const ctx = makeUnitContext({
    ADMIN_USER: '',
    ADMIN_PASS: '',
    STREAMHUB_JWT_SECRET: SECRET,
    STREAMHUB_ALLOW_SIGNUP: '',
    STREAMHUB_PUBLIC_REGISTRATION: '',
    ...env,
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
  return { ctx, tenancy, auth };
}

describe('auth/signup gate (STREAMHUB_ALLOW_SIGNUP)', () => {
  it('ON: signup creates user + tenant + owner membership', async () => {
    const h = makeAuth('1');
    try {
      const { token } = await h.auth.signup({
        email: 'open@x.com',
        password: 'passw0rd!',
        teamName: 'Open Co',
      });
      const user = h.tenancy.getUserByEmail('open@x.com')!;
      expect(verifyJwt(token, SECRET).sub).toBe(user.id);
      const membership = h.tenancy.primaryMembership(user.id)!;
      expect(membership.role).toBe('owner');
      expect(h.tenancy.getTenant(membership.tenantId)!.name).toBe('Open Co');
      expect(h.auth.allowSignup).toBe(true);
    } finally {
      h.ctx.cleanup();
    }
  });

  it('OFF: a brand-new email is refused with 403 signup_disabled (nothing created)', async () => {
    const h = makeAuth('');
    try {
      expect(h.auth.allowSignup).toBe(false);
      await expect(
        h.auth.signup({ email: 'stranger@x.com', password: 'passw0rd!' }),
      ).rejects.toThrow(ForbiddenException);
      expect(h.tenancy.getUserByEmail('stranger@x.com')).toBeNull();
    } finally {
      h.ctx.cleanup();
    }
  });

  it('OFF: an INVITED pending user may still complete signup (invite path stays open)', async () => {
    const h = makeAuth('0');
    try {
      const tenantId = h.tenancy.createTeam('Team');
      const uid = h.tenancy.createUser({ email: 'invited@x.com', status: 'pending' });
      h.tenancy.addMembership(uid, tenantId, 'editor');

      const { token } = await h.auth.signup({
        email: 'invited@x.com',
        password: 'passw0rd!',
      });
      expect(verifyJwt(token, SECRET).sub).toBe(uid);
      const user = h.tenancy.getUser(uid)!;
      expect(user.status).toBe('active');
      expect(user.password_hash).toMatch(/^scrypt\$/);
      // They keep their invited membership — no extra tenant is created.
      expect(h.tenancy.primaryMembership(uid)).toEqual({
        tenantId,
        role: 'editor',
      });
    } finally {
      h.ctx.cleanup();
    }
  });

  it('GET /auth/config surfaces the flag (controller passthrough)', () => {
    const on = makeAuth('true');
    try {
      // No NodeRoleService injected → defaults to a standalone node (login on).
      const controller = new LoginController(on.auth);
      expect(controller.config()).toEqual({
        data: {
          allowSignup: true,
          nodeRole: 'standalone',
          masterUrl: null,
          loginEnabled: true,
          appVersion: expect.any(String),
        },
      });
    } finally {
      on.ctx.cleanup();
    }
    const off = makeAuth('0');
    try {
      const controller = new LoginController(off.auth);
      expect(controller.config()).toEqual({
        data: {
          allowSignup: false,
          nodeRole: 'standalone',
          masterUrl: null,
          loginEnabled: true,
          appVersion: expect.any(String),
        },
      });
    } finally {
      off.ctx.cleanup();
    }
  });
});

describe('auth/signup gate (STREAMHUB_PUBLIC_REGISTRATION canonical flag)', () => {
  it('ON: STREAMHUB_PUBLIC_REGISTRATION enables signup + config surfaces it', async () => {
    const h = makeAuthEnv({ STREAMHUB_PUBLIC_REGISTRATION: 'on' });
    try {
      expect(h.auth.allowSignup).toBe(true);
      const { token } = await h.auth.signup({
        email: 'new@x.com',
        password: 'passw0rd!',
      });
      const user = h.tenancy.getUserByEmail('new@x.com')!;
      expect(verifyJwt(token, SECRET).sub).toBe(user.id);
      expect(new LoginController(h.auth).config().data.allowSignup).toBe(true);
    } finally {
      h.ctx.cleanup();
    }
  });

  it('OFF (default): both flags unset → brand-new email refused 403 + config false', async () => {
    const h = makeAuthEnv({});
    try {
      expect(h.auth.allowSignup).toBe(false);
      await expect(
        h.auth.signup({ email: 'stranger@x.com', password: 'passw0rd!' }),
      ).rejects.toThrow(ForbiddenException);
      expect(h.tenancy.getUserByEmail('stranger@x.com')).toBeNull();
      expect(new LoginController(h.auth).config().data.allowSignup).toBe(false);
    } finally {
      h.ctx.cleanup();
    }
  });

  it('canonical flag wins: PUBLIC_REGISTRATION=0 overrides legacy ALLOW_SIGNUP=1', () => {
    const h = makeAuthEnv({
      STREAMHUB_PUBLIC_REGISTRATION: '0',
      STREAMHUB_ALLOW_SIGNUP: '1',
    });
    try {
      expect(h.auth.allowSignup).toBe(false);
    } finally {
      h.ctx.cleanup();
    }
  });

  it('legacy alias still works when the canonical flag is unset (ALLOW_SIGNUP=1)', () => {
    const h = makeAuthEnv({ STREAMHUB_ALLOW_SIGNUP: '1' });
    try {
      expect(h.auth.allowSignup).toBe(true);
    } finally {
      h.ctx.cleanup();
    }
  });
});
