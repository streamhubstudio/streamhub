/**
 * Unit — auth/ResetService (password-reset by email).
 *
 * Real migrated SQLite DB (makeUnitContext) + real TenancyService underneath; a
 * fake EmailService captures the URL instead of dialing SMTP. Exercises:
 *   - token model: single-use, sha256-HASH at rest (plaintext only in the URL),
 *     30-min TTL, generic (non-enumerating) request result,
 *   - rate-limit per email + per IP,
 *   - request only for a RESETTABLE built-in user (unknown / superadmin / admin
 *     never dispatch, still generic),
 *   - reset: sets a new scrypt password (login now works with it), mints a JWT,
 *     rejects short passwords / expired / used / unknown / tampered tokens,
 *   - the emailed URL points at the public app /auth/reset.
 */
import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { verifyJwt } from '../../shared/auth';
import { TenancyService } from '../tenancy/tenancy.service';
import { EmailService, type SendResult } from '../email/email.service';
import { AuthService } from './auth.service';
import { ResetService } from './reset.service';
import { TotpService } from './totp.service';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';

interface Harness {
  ctx: UnitContext;
  tenancy: TenancyService;
  auth: AuthService;
  reset: ResetService;
  email: { sendPasswordReset: jest.Mock<Promise<SendResult>, [string, string]> };
  lastUrl: () => string;
  lastToken: () => string;
}

function makeReset(overrides: Record<string, string> = {}): Harness {
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

  const sendPasswordReset = jest
    .fn<Promise<SendResult>, [string, string]>()
    .mockResolvedValue({ ok: true, messageId: '<id>' });
  const email = { sendPasswordReset } as unknown as EmailService;

  const reset = ctx.newService(
    ResetService,
    ctx.db,
    ctx.config,
    tenancy,
    email,
  );
  reset.onModuleInit();

  const lastUrl = (): string =>
    sendPasswordReset.mock.calls[sendPasswordReset.mock.calls.length - 1]?.[1] ??
    '';
  const lastToken = (): string => {
    const u = new URL(lastUrl());
    return u.searchParams.get('token') ?? '';
  };

  return { ctx, tenancy, auth, reset, email: { sendPasswordReset }, lastUrl, lastToken };
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Seed a normal built-in user with a known password, return its id. */
async function seedUser(
  h: Harness,
  email: string,
  password = 'orig-passw0rd',
): Promise<string> {
  await h.auth.signup({ email, password });
  return h.tenancy.getUserByEmail(email)!.id;
}

describe('auth/ResetService', () => {
  // ===========================================================================
  // requestReset
  // ===========================================================================
  describe('requestReset', () => {
    let h: Harness;
    beforeEach(() => (h = makeReset()));
    afterEach(() => h.ctx.cleanup());

    it('mints a one-time token, stores only its HASH, and emails the link', async () => {
      await seedUser(h, 'alice@example.com');
      const res = await h.reset.requestReset('Alice@Example.com', '1.2.3.4');
      expect(res).toEqual({ dispatched: true });
      expect(h.email.sendPasswordReset).toHaveBeenCalledTimes(1);

      const [to, url] = h.email.sendPasswordReset.mock.calls[0];
      expect(to).toBe('alice@example.com'); // normalised
      expect(url).toContain('https://app.streamhub.studio/auth/reset?token=');

      const plaintext = h.lastToken();
      const row = h.ctx.db
        .global()
        .prepare('SELECT * FROM password_resets WHERE email = ?')
        .get('alice@example.com') as {
        token_hash: string;
        used: number;
        expires_at: string;
        user_id: string;
      };
      expect(row.token_hash).toBe(sha256(plaintext));
      expect(row.token_hash).not.toContain(plaintext);
      expect(row.used).toBe(0);
      // ~30 min TTL.
      const ttlMs = Date.parse(row.expires_at) - Date.now();
      expect(ttlMs).toBeGreaterThan(28 * 60_000);
      expect(ttlMs).toBeLessThanOrEqual(30 * 60_000 + 2_000);
    });

    it('returns a GENERIC result for an UNKNOWN email (no enumeration, no send)', async () => {
      const res = await h.reset.requestReset('nobody@x.com', '1.2.3.4');
      expect(res).toEqual({ dispatched: false, reason: 'no_such_user' });
      expect(h.email.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('returns a GENERIC result for an invalid email (no send)', async () => {
      const res = await h.reset.requestReset('not-an-email', '1.2.3.4');
      expect(res.reason).toBe('invalid_email');
      expect(h.email.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('never dispatches for a SUPERADMIN user (break-glass safety)', async () => {
      // The superadmin email maps to the mirrored `admin` principal.
      const h2 = makeReset({
        ADMIN_USER: 'root@corp.com',
        ADMIN_PASS: 'toor',
      });
      try {
        const res = await h2.reset.requestReset('root@corp.com', '1.2.3.4');
        expect(res).toEqual({ dispatched: false, reason: 'no_such_user' });
        expect(h2.email.sendPasswordReset).not.toHaveBeenCalled();
      } finally {
        h2.ctx.cleanup();
      }
    });

    it('never dispatches for an is_superadmin user row', async () => {
      const id = await seedUser(h, 'boss@x.com');
      h.ctx.db
        .global()
        .prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?')
        .run(id);
      const res = await h.reset.requestReset('boss@x.com', '1.2.3.4');
      expect(res).toEqual({ dispatched: false, reason: 'no_such_user' });
      expect(h.email.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('honours the App URL override in the emailed link', async () => {
      await seedUser(h, 'a@b.com');
      process.env.STREAMHUB_APP_URL = 'https://staging.example.com/';
      try {
        await h.reset.requestReset('a@b.com', '1.2.3.4');
        expect(h.lastUrl()).toContain(
          'https://staging.example.com/auth/reset?token=',
        );
      } finally {
        delete process.env.STREAMHUB_APP_URL;
      }
    });

    it('rate-limits per EMAIL after 3 requests in the window', async () => {
      await seedUser(h, 'spam@x.com');
      for (let i = 0; i < 3; i++) {
        const r = await h.reset.requestReset('spam@x.com', `9.9.9.${i}`);
        expect(r.dispatched).toBe(true);
      }
      const blocked = await h.reset.requestReset('spam@x.com', '9.9.9.99');
      expect(blocked).toEqual({ dispatched: false, reason: 'rate_limited' });
      expect(h.email.sendPasswordReset).toHaveBeenCalledTimes(3);
    });

    it('reports send_failed (still generic) when SMTP delivery fails', async () => {
      await seedUser(h, 'a@b.com');
      h.email.sendPasswordReset.mockResolvedValueOnce({ ok: false, error: 'boom' });
      const res = await h.reset.requestReset('a@b.com', '1.2.3.4');
      expect(res).toEqual({ dispatched: false, reason: 'send_failed' });
    });
  });

  // ===========================================================================
  // reset
  // ===========================================================================
  describe('reset', () => {
    let h: Harness;
    beforeEach(() => (h = makeReset()));
    afterEach(() => h.ctx.cleanup());

    async function issueToken(email: string, ip = '1.2.3.4'): Promise<string> {
      await h.reset.requestReset(email, ip);
      return h.lastToken();
    }

    it('sets the new password, mints a JWT, and the new password now logs in', async () => {
      const id = await seedUser(h, 'user@x.com', 'orig-passw0rd');
      const token = await issueToken('user@x.com');

      const { token: jwt } = await h.reset.reset(token, 'brand-new-pass');
      expect(verifyJwt(jwt, SECRET).sub).toBe(id);

      // Old password rejected, new one accepted.
      await expect(
        h.auth.login('user@x.com', 'orig-passw0rd'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      const { token: loginJwt } = await h.auth.login('user@x.com', 'brand-new-pass');
      expect(verifyJwt(loginJwt, SECRET).sub).toBe(id);
    });

    it('rejects a too-short password (min 8)', async () => {
      await seedUser(h, 'short@x.com');
      const token = await issueToken('short@x.com');
      await expect(h.reset.reset(token, 'short')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      // Token was NOT consumed by the rejected attempt.
      const { token: jwt } = await h.reset.reset(token, 'valid-pass-8');
      expect(jwt).toMatch(/\..+\./);
    });

    it('is SINGLE-USE: a second reset with the same token is rejected', async () => {
      await seedUser(h, 'once@x.com');
      const token = await issueToken('once@x.com');
      await h.reset.reset(token, 'first-new-pass');
      await expect(
        h.reset.reset(token, 'second-new-pass'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an EXPIRED token', async () => {
      await seedUser(h, 'exp@x.com');
      const token = await issueToken('exp@x.com');
      h.ctx.db
        .global()
        .prepare(`UPDATE password_resets SET expires_at = ? WHERE email = ?`)
        .run(new Date(Date.now() - 60_000).toISOString(), 'exp@x.com');
      await expect(h.reset.reset(token, 'whatever-8')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an unknown / tampered / empty token', async () => {
      await expect(
        h.reset.reset('totally-made-up', 'whatever-8'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(h.reset.reset('', 'whatever-8')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses to reset when STREAMHUB_JWT_SECRET is unset', async () => {
      const h2 = makeReset({ STREAMHUB_JWT_SECRET: '' });
      try {
        await expect(
          h2.reset.reset('anything', 'whatever-8'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      } finally {
        h2.ctx.cleanup();
      }
    });
  });
});
