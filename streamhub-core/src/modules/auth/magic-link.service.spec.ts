/**
 * Unit — auth/MagicLinkService (passwordless magic-link).
 *
 * Real migrated SQLite DB (makeUnitContext) + real TenancyService underneath; a
 * fake EmailService captures the URL instead of dialing SMTP. Exercises:
 *   - token model: single-use, sha256-HASH at rest (plaintext only in the URL),
 *     15-min TTL, generic (non-enumerating) request result,
 *   - rate-limit per email + per IP,
 *   - verify: create-on-first-use (owner team), existing user, superadmin email,
 *     reject expired / used / unknown / tampered tokens,
 *   - the emailed URL points at the public app.
 */
import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { authenticator } from 'otplib';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { verifyJwt } from '../../shared/auth';
import { TenancyService } from '../tenancy/tenancy.service';
import { EmailService, type SendResult } from '../email/email.service';
import { MagicLinkService } from './magic-link.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';

interface Harness {
  ctx: UnitContext;
  tenancy: TenancyService;
  magic: MagicLinkService;
  totp: TotpService;
  email: { sendMagicLink: jest.Mock<Promise<SendResult>, [string, string]> };
  /** Last URL captured by the fake EmailService. */
  lastUrl: () => string;
  /** Extract the `token` query param from the last emailed URL. */
  lastToken: () => string;
  /** Age every magic_tokens row of `email` by `seconds` (cooldown escape). */
  age: (email: string, seconds: number) => void;
}

function makeMagic(overrides: Record<string, string> = {}): Harness {
  const ctx = makeUnitContext({
    ADMIN_USER: '',
    ADMIN_PASS: '',
    STREAMHUB_JWT_SECRET: SECRET,
    ...overrides,
  });
  const tenancy = ctx.newService(TenancyService, ctx.db, ctx.config);
  tenancy.onModuleInit();
  const totp = ctx.newService(TotpService, ctx.config, tenancy);

  const sendMagicLink = jest
    .fn<Promise<SendResult>, [string, string]>()
    .mockResolvedValue({ ok: true, messageId: '<id>' });
  const email = { sendMagicLink } as unknown as EmailService;

  const sessions = ctx.newService(SessionService, ctx.db);
  sessions.onModuleInit();
  const magic = ctx.newService(
    MagicLinkService,
    ctx.db,
    ctx.config,
    tenancy,
    email,
    totp,
    sessions,
  );
  magic.onModuleInit();

  const lastUrl = (): string =>
    sendMagicLink.mock.calls[sendMagicLink.mock.calls.length - 1]?.[1] ?? '';
  const lastToken = (): string => {
    const u = new URL(lastUrl());
    return u.searchParams.get('token') ?? '';
  };
  const age = (addr: string, seconds: number): void => {
    const rows = ctx.db
      .global()
      .prepare('SELECT id, created_at FROM magic_tokens WHERE email = ?')
      .all(addr) as { id: number; created_at: string }[];
    const upd = ctx.db
      .global()
      .prepare('UPDATE magic_tokens SET created_at = ? WHERE id = ?');
    for (const r of rows) {
      const t = Date.parse(r.created_at) - seconds * 1000;
      upd.run(new Date(t).toISOString(), r.id);
    }
  };

  return {
    ctx,
    tenancy,
    magic,
    totp,
    email: { sendMagicLink },
    lastUrl,
    lastToken,
    age,
  };
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('auth/MagicLinkService', () => {
  // ===========================================================================
  // requestMagicLink
  // ===========================================================================
  describe('requestMagicLink', () => {
    let h: Harness;
    beforeEach(() => (h = makeMagic()));
    afterEach(() => h.ctx.cleanup());

    it('mints a one-time token, stores only its HASH, and emails the link', async () => {
      const res = await h.magic.requestMagicLink('Alice@Example.com', '1.2.3.4');
      expect(res).toEqual({ dispatched: true });
      expect(h.email.sendMagicLink).toHaveBeenCalledTimes(1);

      // email normalised, URL points at the public app + carries the token.
      const [to, url] = h.email.sendMagicLink.mock.calls[0];
      expect(to).toBe('alice@example.com');
      expect(url).toContain('https://app.streamhub.studio/auth/magic?token=');

      // Only the HASH is at rest — plaintext token never stored.
      const plaintext = h.lastToken();
      const row = h.ctx.db
        .global()
        .prepare('SELECT * FROM magic_tokens WHERE email = ?')
        .get('alice@example.com') as {
        token_hash: string;
        used: number;
        expires_at: string;
      };
      expect(row.token_hash).toBe(sha256(plaintext));
      expect(row.token_hash).not.toContain(plaintext);
      expect(row.used).toBe(0);
      // ~15 min TTL.
      const ttlMs = Date.parse(row.expires_at) - Date.now();
      expect(ttlMs).toBeGreaterThan(13 * 60_000);
      expect(ttlMs).toBeLessThanOrEqual(15 * 60_000 + 2_000);
    });

    it('returns a GENERIC result for an invalid email (no enumeration, no send)', async () => {
      const res = await h.magic.requestMagicLink('not-an-email', '1.2.3.4');
      expect(res.dispatched).toBe(false);
      expect(res.reason).toBe('invalid_email');
      expect(h.email.sendMagicLink).not.toHaveBeenCalled();
    });

    it('honours the App URL override in the emailed link', async () => {
      process.env.STREAMHUB_APP_URL = 'https://staging.example.com/';
      try {
        await h.magic.requestMagicLink('a@b.com', '1.2.3.4');
        expect(h.lastUrl()).toContain(
          'https://staging.example.com/auth/magic?token=',
        );
      } finally {
        delete process.env.STREAMHUB_APP_URL;
      }
    });

    it('rate-limits per EMAIL after 3 requests in the window', async () => {
      for (let i = 0; i < 3; i++) {
        const r = await h.magic.requestMagicLink('spam@x.com', `9.9.9.${i}`);
        expect(r.dispatched).toBe(true);
        // Step past the 60s resend cooldown (still inside the 15-min window)
        // so THIS test exercises the window limit, not the cooldown.
        h.age('spam@x.com', 61);
      }
      const blocked = await h.magic.requestMagicLink('spam@x.com', '9.9.9.99');
      expect(blocked).toEqual({ dispatched: false, reason: 'rate_limited' });
      expect(h.email.sendMagicLink).toHaveBeenCalledTimes(3);
    });

    it('COOLDOWN: a 2nd request for the same email within 60s is refused with the remaining seconds', async () => {
      const first = await h.magic.requestMagicLink('again@x.com', '1.2.3.4');
      expect(first.dispatched).toBe(true);

      const second = await h.magic.requestMagicLink('again@x.com', '1.2.3.4');
      expect(second.dispatched).toBe(false);
      expect(second.reason).toBe('cooldown');
      expect(second.retryAfterSeconds).toBeGreaterThan(0);
      expect(second.retryAfterSeconds).toBeLessThanOrEqual(
        MagicLinkService.RESEND_COOLDOWN_SECONDS,
      );
      // No second email left the building.
      expect(h.email.sendMagicLink).toHaveBeenCalledTimes(1);
    });

    it('COOLDOWN: after >60s the same email may request again (2nd link sent)', async () => {
      await h.magic.requestMagicLink('later@x.com', '1.2.3.4');
      h.age('later@x.com', 61);
      const again = await h.magic.requestMagicLink('later@x.com', '1.2.3.4');
      expect(again).toEqual({ dispatched: true });
      expect(h.email.sendMagicLink).toHaveBeenCalledTimes(2);
    });

    it('COOLDOWN: does not block a DIFFERENT email (per-address, no cross-talk)', async () => {
      await h.magic.requestMagicLink('one@x.com', '1.2.3.4');
      const other = await h.magic.requestMagicLink('two@x.com', '1.2.3.4');
      expect(other).toEqual({ dispatched: true });
    });

    it('COOLDOWN: an owner-issued INVITE link neither consumes nor trips the cooldown', async () => {
      // Invite first — the invitee can still self-request a login link at once.
      h.magic.issueInviteLink('invitee@x.com');
      const res = await h.magic.requestMagicLink('invitee@x.com', '1.2.3.4');
      expect(res).toEqual({ dispatched: true });
    });

    it('rate-limits per IP after 10 requests in the window (different emails)', async () => {
      for (let i = 0; i < 10; i++) {
        const r = await h.magic.requestMagicLink(`u${i}@x.com`, '5.5.5.5');
        expect(r.dispatched).toBe(true);
      }
      const blocked = await h.magic.requestMagicLink('u10@x.com', '5.5.5.5');
      expect(blocked).toEqual({ dispatched: false, reason: 'rate_limited' });
    });

    it('reports send_failed (still generic) when SMTP delivery fails', async () => {
      h.email.sendMagicLink.mockResolvedValueOnce({
        ok: false,
        error: 'boom',
      });
      const res = await h.magic.requestMagicLink('a@b.com', '1.2.3.4');
      expect(res).toEqual({ dispatched: false, reason: 'send_failed' });
    });
  });

  // ===========================================================================
  // verify
  // ===========================================================================
  describe('verify', () => {
    let h: Harness;
    beforeEach(() => (h = makeMagic()));
    afterEach(() => h.ctx.cleanup());

    async function issueToken(email: string, ip = '1.2.3.4'): Promise<string> {
      await h.magic.requestMagicLink(email, ip);
      return h.lastToken();
    }

    it('creates a NEW user + owner team on first sign-in and mints a session JWT', async () => {
      const token = await issueToken('newuser@x.com');
      const { token: jwt } = await h.magic.verify(token);

      const user = h.tenancy.getUserByEmail('newuser@x.com')!;
      expect(user).not.toBeNull();
      expect(verifyJwt(jwt, SECRET).sub).toBe(user.id);
      const membership = h.tenancy.primaryMembership(user.id)!;
      expect(membership.role).toBe('owner');
      expect(h.tenancy.getTenant(membership.tenantId)!.plan).toBe('free');
    });

    it('seeds a RANDOM scrypt password on the new user (password login disabled by default)', async () => {
      const token = await issueToken('random-pw@x.com');
      await h.magic.verify(token);
      const user = h.tenancy.getUserByEmail('random-pw@x.com')!;
      // Not NULL: a real scrypt hash is stored, but nobody knows the plaintext.
      expect(user.password_hash).toMatch(/^scrypt\$/);
    });

    it('resolves an EXISTING user to their own id', async () => {
      // Seed an existing user + team.
      const tenantId = h.tenancy.createTeam('Acme');
      const uid = h.tenancy.createUser({ email: 'exists@x.com', status: 'active' });
      h.tenancy.addMembership(uid, tenantId, 'owner');

      const token = await issueToken('exists@x.com');
      const { token: jwt } = await h.magic.verify(token);
      expect(verifyJwt(jwt, SECRET).sub).toBe(uid);
    });

    it('promotes a PENDING invited user to active on first magic sign-in', async () => {
      const tenantId = h.tenancy.createTeam('T');
      const uid = h.tenancy.createUser({ email: 'inv@x.com', status: 'pending' });
      h.tenancy.addMembership(uid, tenantId, 'editor');

      await h.magic.verify(await issueToken('inv@x.com'));
      const user = h.tenancy.getUser(uid)!;
      expect(user.status).toBe('active');
      expect(h.tenancy.primaryMembership(uid)).toEqual({
        tenantId,
        role: 'editor',
      });
    });

    it('INVITE links verify like login links (pending → active, membership kept)', async () => {
      const tenantId = h.tenancy.createTeam('Inviting Co');
      const uid = h.tenancy.createUser({ email: 'joe@x.com', status: 'pending' });
      h.tenancy.addMembership(uid, tenantId, 'editor');

      const url = h.magic.issueInviteLink('joe@x.com');
      const token = new URL(url).searchParams.get('token')!;
      const { token: jwt } = await h.magic.verify(token);
      expect(verifyJwt(jwt, SECRET).sub).toBe(uid);
      expect(h.tenancy.getUser(uid)!.status).toBe('active');
      expect(h.tenancy.primaryMembership(uid)).toEqual({
        tenantId,
        role: 'editor',
      });
    });

    it('2FA: requires a TOTP code when the account has 2FA enabled — WITHOUT burning the link', async () => {
      // Seed an enrolled user (setup → enable with a freshly computed code).
      const uid = h.tenancy.createUser({ email: '2fa@x.com', status: 'active' });
      h.tenancy.addMembership(uid, h.tenancy.createTeam('T2'), 'owner');
      const { secret } = h.totp.setup(uid, '2fa@x.com');
      h.totp.enable(uid, authenticator.generate(secret));

      const token = await issueToken('2fa@x.com');

      // No code → 401 totp_required; the token is NOT consumed.
      await expect(h.magic.verify(token)).rejects.toMatchObject({
        message: 'totp_required',
      });
      // Wrong code → 401 totp_invalid; still not consumed.
      await expect(h.magic.verify(token, '000000')).rejects.toMatchObject({
        message: 'totp_invalid',
      });
      // Correct code → session for the SAME (unburnt) token.
      const { token: jwt } = await h.magic.verify(
        token,
        authenticator.generate(secret),
      );
      expect(verifyJwt(jwt, SECRET).sub).toBe(uid);
    });

    it('makes the SUPERADMIN email the superadmin principal (sub=admin, is_superadmin)', async () => {
      const token = await issueToken('info@streamhub.studio');
      const { token: jwt } = await h.magic.verify(token);
      expect(verifyJwt(jwt, SECRET).sub).toBe(TenancyService.ADMIN_USER_ID);
      expect(h.tenancy.isSuperadmin(TenancyService.ADMIN_USER_ID)).toBe(true);
    });

    it('honours a custom superadmin email override', async () => {
      const h2 = makeMagic({ STREAMHUB_SUPERADMIN_EMAIL: 'boss@corp.com' });
      try {
        await h2.magic.requestMagicLink('boss@corp.com', '1.1.1.1');
        const { token: jwt } = await h2.magic.verify(h2.lastToken());
        expect(verifyJwt(jwt, SECRET).sub).toBe(TenancyService.ADMIN_USER_ID);
      } finally {
        h2.ctx.cleanup();
        delete process.env.STREAMHUB_SUPERADMIN_EMAIL;
      }
    });

    it('is SINGLE-USE: a second verify of the same token is rejected', async () => {
      const token = await issueToken('once@x.com');
      await h.magic.verify(token);
      await expect(h.magic.verify(token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an EXPIRED token', async () => {
      const token = await issueToken('exp@x.com');
      // Force expiry in the DB (ISO-8601 UTC, matching how the service stores it).
      h.ctx.db
        .global()
        .prepare(`UPDATE magic_tokens SET expires_at = ? WHERE email = ?`)
        .run(new Date(Date.now() - 60_000).toISOString(), 'exp@x.com');
      await expect(h.magic.verify(token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an unknown / tampered token', async () => {
      await expect(h.magic.verify('totally-made-up')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(h.magic.verify('')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses to verify when STREAMHUB_JWT_SECRET is unset', async () => {
      const h2 = makeMagic({ STREAMHUB_JWT_SECRET: '' });
      try {
        await expect(h2.magic.verify('anything')).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      } finally {
        h2.ctx.cleanup();
      }
    });
  });
});
