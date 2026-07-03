/**
 * Unit — auth/AccountService + TotpService ("Mi cuenta" + 2FA).
 *
 * Real migrated SQLite DB (makeUnitContext) + real TenancyService/TotpService.
 * Exercises:
 *   - GET/PATCH account: profile read, name/email update, email uniqueness,
 *     break-glass admin email is env-managed (rejected), api_token gets 403,
 *   - password change: requires the CURRENT password, min length, admin refused,
 *   - 2FA: setup stores the secret ENCRYPTED (never plaintext at rest), enable
 *     validates a live TOTP code, disable requires a code, login (password)
 *     enforces the code when enabled — and the break-glass admin path never does.
 */
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { authenticator } from 'otplib';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AuthContext } from '../../shared/auth-context';
import { TenancyService } from '../tenancy/tenancy.service';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password.util';
import { TotpService } from './totp.service';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';

interface Harness {
  ctx: UnitContext;
  tenancy: TenancyService;
  totp: TotpService;
  auth: AuthService;
  account: AccountService;
  /** Create an active user + owner team; returns its id + a user_jwt ctx. */
  seedUser: (email: string, password?: string) => { id: string; ctx: AuthContext };
}

function makeAccount(overrides: Record<string, string> = {}): Harness {
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
  const auth = ctx.newService(AuthService, ctx.db, ctx.config, tenancy, totp);
  const account = ctx.newService(AccountService, ctx.config, tenancy, totp);

  const seedUser = (email: string, password?: string) => {
    const id = tenancy.createUser({
      email,
      status: 'active',
      passwordHash: password ? hashPassword(password) : null,
    });
    const tenantId = tenancy.createTeam(`${email}'s team`);
    tenancy.addMembership(id, tenantId, 'owner');
    const authCtx: AuthContext = {
      userId: id,
      tenantId,
      role: 'owner',
      isSuperadmin: false,
      scope: 'user',
      via: 'user_jwt',
      email,
    };
    return { id, ctx: authCtx };
  };

  return { ctx, tenancy, totp, auth, account, seedUser };
}

const TOKEN_CTX: AuthContext = {
  userId: 'token:1',
  tenantId: 'platform',
  role: 'service',
  isSuperadmin: true,
  scope: 'global',
  via: 'api_token',
};

describe('auth/AccountService', () => {
  let h: Harness;
  beforeEach(() => (h = makeAccount()));
  afterEach(() => h.ctx.cleanup());

  // ===========================================================================
  // Profile (GET/PATCH /account)
  // ===========================================================================
  describe('profile', () => {
    it('returns my own profile + tenant + security flags', () => {
      const { ctx } = h.seedUser('alice@x.com', 'passw0rd!');
      const info = h.account.getAccount(ctx);
      expect(info.user).toMatchObject({
        email: 'alice@x.com',
        name: null,
        hasPassword: true,
        twoFactorEnabled: false,
        status: 'active',
      });
      expect(info.tenant).toMatchObject({ role: 'owner', plan: 'free' });
    });

    it('updates the display name and email (normalised lower-case)', () => {
      const { id, ctx } = h.seedUser('bob@x.com');
      const info = h.account.updateAccount(ctx, {
        name: '  Bob Dev ',
        email: 'Bobby@X.com',
      });
      expect(info.user.name).toBe('Bob Dev');
      expect(info.user.email).toBe('bobby@x.com');
      expect(h.tenancy.getUser(id)!.email).toBe('bobby@x.com');
    });

    it('rejects an email already used by another account', () => {
      h.seedUser('taken@x.com');
      const { ctx } = h.seedUser('me@x.com');
      expect(() => h.account.updateAccount(ctx, { email: 'taken@x.com' })).toThrow(
        BadRequestException,
      );
    });

    it('refuses to change the break-glass admin email (env-managed)', () => {
      const h2 = makeAccount({ ADMIN_USER: 'root@corp.com', ADMIN_PASS: 'pw' });
      try {
        h2.tenancy.onModuleInit(); // mirrors the admin row
        const adminCtx: AuthContext = {
          userId: TenancyService.ADMIN_USER_ID,
          tenantId: 'platform',
          role: 'superadmin',
          isSuperadmin: true,
          scope: 'global',
          via: 'admin_jwt',
        };
        expect(() =>
          h2.account.updateAccount(adminCtx, { email: 'else@x.com' }),
        ).toThrow(BadRequestException);
        // Name-only updates are fine for the admin.
        const info = h2.account.updateAccount(adminCtx, { name: 'Root' });
        expect(info.user.name).toBe('Root');
      } finally {
        h2.ctx.cleanup();
      }
    });

    it('rejects api_token principals (machines have no account)', () => {
      expect(() => h.account.getAccount(TOKEN_CTX)).toThrow(ForbiddenException);
    });
  });

  // ===========================================================================
  // Password change (POST /account/password)
  // ===========================================================================
  describe('changePassword', () => {
    it('changes the password when the current one verifies (login works after)', async () => {
      const { ctx } = h.seedUser('pw@x.com', 'old-password');
      h.account.changePassword(ctx, 'old-password', 'new-password-9');
      const { token } = await h.auth.login('pw@x.com', 'new-password-9');
      expect(token).toMatch(/\..+\./);
      await expect(h.auth.login('pw@x.com', 'old-password')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a wrong current password / too-short new password', () => {
      const { ctx } = h.seedUser('pw2@x.com', 'old-password');
      expect(() =>
        h.account.changePassword(ctx, 'WRONG', 'new-password-9'),
      ).toThrow(ForbiddenException);
      expect(() => h.account.changePassword(ctx, 'old-password', 'short')).toThrow(
        BadRequestException,
      );
    });
  });

  // ===========================================================================
  // 2FA (TOTP)
  // ===========================================================================
  describe('2FA', () => {
    it('setup mints a base32 secret, stores it ENCRYPTED (pending), returns otpauth + QR', async () => {
      const { id, ctx } = h.seedUser('2fa@x.com');
      const res = await h.account.setupTwoFa(ctx);

      expect(res.secret).toMatch(/^[A-Z2-7]+=*$/i); // base32
      expect(res.otpauthUri).toContain('otpauth://totp/');
      expect(res.otpauthUri).toContain('issuer=StreamHub');
      expect(res.qrDataUri).toMatch(/^data:image\/png;base64,/);

      // At rest: encrypted (aesgcm$…), NEVER the plaintext secret; not enabled yet.
      const state = h.tenancy.getTotpState(id);
      expect(state.enabled).toBe(false);
      expect(state.pendingSecret).toMatch(/^aesgcm\$/);
      expect(state.pendingSecret).not.toContain(res.secret);
    });

    it('enable validates a live code and activates; disable requires a code', async () => {
      const { id, ctx } = h.seedUser('2fb@x.com');
      const { secret } = await h.account.setupTwoFa(ctx);

      // Wrong code → still disabled.
      expect(() => h.account.enableTwoFa(ctx, '000000')).toThrow(
        BadRequestException,
      );
      expect(h.totp.isEnabled(id)).toBe(false);

      h.account.enableTwoFa(ctx, authenticator.generate(secret));
      expect(h.totp.isEnabled(id)).toBe(true);
      expect(h.account.getAccount(ctx).user.twoFactorEnabled).toBe(true);

      // Disable: wrong code refused, valid code wipes the secrets.
      expect(() => h.account.disableTwoFa(ctx, '000000')).toThrow(
        BadRequestException,
      );
      h.account.disableTwoFa(ctx, authenticator.generate(secret));
      expect(h.totp.isEnabled(id)).toBe(false);
      expect(h.tenancy.getTotpState(id)).toMatchObject({
        secret: null,
        pendingSecret: null,
      });
    });

    it('password login ENFORCES the TOTP code when 2FA is enabled', async () => {
      const { ctx } = h.seedUser('2fc@x.com', 'passw0rd!');
      const { secret } = await h.account.setupTwoFa(ctx);
      h.account.enableTwoFa(ctx, authenticator.generate(secret));

      // No code → 401 totp_required; wrong code → 401 totp_invalid.
      await expect(h.auth.login('2fc@x.com', 'passw0rd!')).rejects.toMatchObject(
        { message: 'totp_required' },
      );
      await expect(
        h.auth.login('2fc@x.com', 'passw0rd!', '000000'),
      ).rejects.toMatchObject({ message: 'totp_invalid' });

      // Valid code → session.
      const { token } = await h.auth.login(
        '2fc@x.com',
        'passw0rd!',
        authenticator.generate(secret),
      );
      expect(token).toMatch(/\..+\./);

      // A wrong PASSWORD stays a generic 401 (2FA leaks nothing about it).
      await expect(
        h.auth.login('2fc@x.com', 'WRONG', authenticator.generate(secret)),
      ).rejects.toMatchObject({ message: 'Invalid username or password' });
    });

    it('NEVER gates the break-glass admin login (env credentials bypass 2FA)', async () => {
      const h2 = makeAccount({ ADMIN_USER: 'root', ADMIN_PASS: 'root-pass' });
      try {
        h2.tenancy.onModuleInit();
        // Even with 2FA enabled on the mirrored admin row…
        const adminCtx: AuthContext = {
          userId: TenancyService.ADMIN_USER_ID,
          tenantId: 'platform',
          role: 'superadmin',
          isSuperadmin: true,
          scope: 'global',
          via: 'admin_jwt',
        };
        const { secret } = await h2.account.setupTwoFa(adminCtx);
        h2.account.enableTwoFa(adminCtx, authenticator.generate(secret));

        // …the env break-glass path still logs in with NO code.
        const { token } = await h2.auth.login('root', 'root-pass');
        expect(token).toMatch(/\..+\./);
      } finally {
        h2.ctx.cleanup();
      }
    });

    it('setup is refused while 2FA is already enabled (disable first)', async () => {
      const { ctx } = h.seedUser('2fd@x.com');
      const { secret } = await h.account.setupTwoFa(ctx);
      h.account.enableTwoFa(ctx, authenticator.generate(secret));
      await expect(h.account.setupTwoFa(ctx)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
