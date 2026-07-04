/**
 * Unit — network-security offense WIRING (the real failure sites).
 *
 * Locks down that the existing auth surfaces report offenses to
 * IpReputationService.recordOffense with the right kind — and ONLY on failure:
 *  - AuthService.login (bad password / unknown user)        → 'login_failed'
 *  - AuthService.validate (unknown sk_ token / invalid JWT) → 'invalid_token'
 *  - MagicLinkService.verify (bogus/expired/used token)     → 'magic_verify_failed'
 *  - the shared auth rate limiter's 429 handler             → reporter hook
 * Successful requests never record anything, and the wiring is optional (an
 * AuthService built WITHOUT the reputation service keeps working).
 */
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import express from 'express';
import request from 'supertest';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import {
  createAuthRateLimiter,
  setRateLimitOffenseReporter,
} from '../../shared/http/auth-rate-limit';
import { AuthService } from '../auth/auth.service';
import { MagicLinkService } from '../auth/magic-link.service';
import { SessionService } from '../auth/session.service';
import { TotpService } from '../auth/totp.service';
import { EmailService } from '../email/email.service';
import { TenancyService } from '../tenancy/tenancy.service';
import type { IpReputationService } from './ip-reputation.service';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';
const IP = '203.0.113.77';

interface Harness {
  ctx: UnitContext;
  auth: AuthService;
  magic: MagicLinkService;
  recordOffense: jest.Mock;
}

function makeHarness(withReputation = true): Harness {
  const ctx = makeUnitContext({
    ADMIN_USER: '',
    ADMIN_PASS: '',
    STREAMHUB_JWT_SECRET: SECRET,
    STREAMHUB_ALLOW_SIGNUP: '1',
  });
  const tenancy = ctx.newService(TenancyService, ctx.db, ctx.config);
  tenancy.onModuleInit();
  const totp = ctx.newService(TotpService, ctx.config, tenancy);
  const sessions = ctx.newService(SessionService, ctx.db);
  sessions.onModuleInit();

  const recordOffense = jest.fn();
  const reputation = withReputation
    ? ({ recordOffense } as unknown as IpReputationService)
    : undefined;

  const auth = new AuthService(
    ctx.db,
    ctx.config,
    tenancy,
    totp,
    sessions,
    reputation,
  );
  const email = { sendMagicLink: jest.fn() } as unknown as EmailService;
  const magic = new MagicLinkService(
    ctx.db,
    ctx.config,
    tenancy,
    email,
    totp,
    sessions,
    reputation,
  );
  magic.onModuleInit();
  return { ctx, auth, magic, recordOffense };
}

function reqWithBearer(token?: string): Request {
  const headers: Record<string, string> = { 'x-forwarded-for': IP };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return {
    headers,
    path: '/api/v1/apps',
    url: '/api/v1/apps',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

describe('security offense wiring', () => {
  let h: Harness;
  afterEach(() => h?.ctx.cleanup());

  describe('AuthService.login', () => {
    it("records 'login_failed' with the session IP on bad credentials", async () => {
      h = makeHarness();
      await expect(
        h.auth.login('nobody@example.com', 'wrong', undefined, {
          ip: IP,
          userAgent: null,
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(h.recordOffense).toHaveBeenCalledTimes(1);
      expect(h.recordOffense).toHaveBeenCalledWith(IP, 'login_failed');
    });

    it('records NOTHING on a successful login', async () => {
      h = makeHarness();
      await h.auth.signup(
        { email: 'ok@example.com', password: 'hunter22' },
        { ip: IP, userAgent: null },
      );
      h.recordOffense.mockClear();
      await h.auth.login('ok@example.com', 'hunter22', undefined, {
        ip: IP,
        userAgent: null,
      });
      expect(h.recordOffense).not.toHaveBeenCalled();
    });

    it('still rejects cleanly when NO reputation service is wired', async () => {
      h = makeHarness(false);
      await expect(
        h.auth.login('nobody@example.com', 'wrong'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('AuthService.validate (the auth-guard delegate)', () => {
    it("records 'invalid_token' for an unknown sk_ token", async () => {
      h = makeHarness();
      await expect(
        h.auth.validate(reqWithBearer('sk_definitely_not_a_real_token')),
      ).rejects.toThrow(UnauthorizedException);
      expect(h.recordOffense).toHaveBeenCalledWith(IP, 'invalid_token');
    });

    it("records 'invalid_token' for a forged/expired JWT", async () => {
      h = makeHarness();
      await expect(
        h.auth.validate(reqWithBearer('eyJhbGciOi.not.a-real-jwt')),
      ).rejects.toThrow(UnauthorizedException);
      expect(h.recordOffense).toHaveBeenCalledWith(IP, 'invalid_token');
    });

    it('records NOTHING for a missing bearer (anonymous is not an offense)', async () => {
      h = makeHarness();
      await expect(h.auth.validate(reqWithBearer())).rejects.toThrow(
        UnauthorizedException,
      );
      expect(h.recordOffense).not.toHaveBeenCalled();
    });

    it('records NOTHING for a VALID sk_ token', async () => {
      h = makeHarness();
      const created = await h.auth.createToken({ name: 't', scope: 'global' });
      await h.auth.validate(reqWithBearer(created.token));
      expect(h.recordOffense).not.toHaveBeenCalled();
    });
  });

  describe('MagicLinkService.verify', () => {
    it("records 'magic_verify_failed' for a bogus token", async () => {
      h = makeHarness();
      await expect(
        h.magic.verify('bogus-token', undefined, { ip: IP, userAgent: null }),
      ).rejects.toThrow(UnauthorizedException);
      expect(h.recordOffense).toHaveBeenCalledWith(IP, 'magic_verify_failed');
    });

    it("records 'magic_verify_failed' when a used link is replayed", async () => {
      h = makeHarness();
      // Mint a real link, use it once, then replay it.
      const url = h.magic.issueInviteLink('invitee@example.com');
      const token = new URL(url).searchParams.get('token') as string;
      await h.magic.verify(token, undefined, { ip: IP, userAgent: null });
      expect(h.recordOffense).not.toHaveBeenCalled(); // first use is legit
      await expect(
        h.magic.verify(token, undefined, { ip: IP, userAgent: null }),
      ).rejects.toThrow(UnauthorizedException);
      expect(h.recordOffense).toHaveBeenCalledWith(IP, 'magic_verify_failed');
    });
  });

  describe('auth rate limiter 429 hook', () => {
    afterEach(() => setRateLimitOffenseReporter(null));

    it('reports the client IP once the limit trips (429 body unchanged)', async () => {
      const reported: string[] = [];
      setRateLimitOffenseReporter((ip) => reported.push(ip));
      const app = express();
      app.use('/api/v1/auth/login', createAuthRateLimiter({ limit: 2, windowMs: 60_000 }));
      app.post('/api/v1/auth/login', (_req, res) => {
        res.status(200).json({ ok: true });
      });
      await request(app).post('/api/v1/auth/login').expect(200);
      await request(app).post('/api/v1/auth/login').expect(200);
      const res = await request(app).post('/api/v1/auth/login').expect(429);
      expect(res.body?.error?.code).toBe('rate_limited');
      expect(reported).toHaveLength(1);
      expect(reported[0]).toBeTruthy();
    });

    it('a throwing reporter never breaks the 429 response', async () => {
      setRateLimitOffenseReporter(() => {
        throw new Error('reporter exploded');
      });
      const app = express();
      app.use('/api/v1/auth/login', createAuthRateLimiter({ limit: 1, windowMs: 60_000 }));
      app.post('/api/v1/auth/login', (_req, res) => {
        res.status(200).json({ ok: true });
      });
      await request(app).post('/api/v1/auth/login').expect(200);
      const res = await request(app).post('/api/v1/auth/login').expect(429);
      expect(res.body?.error?.code).toBe('rate_limited');
    });
  });
});
