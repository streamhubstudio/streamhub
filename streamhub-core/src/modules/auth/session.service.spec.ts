/**
 * Unit — auth/SessionService + AuthService session wiring (Active Sessions).
 *
 * Real migrated SQLite DB (makeUnitContext) + real TenancyService/AuthService.
 * Exercises the whole active-sessions contract:
 *   - a session row is created on login/magic and its id rides in the JWT `sid`,
 *   - listForUser surfaces ip + created date and flags the CURRENT session,
 *   - the auth validator REJECTS a token whose session was revoked,
 *   - a user can NEVER revoke another user's session (own-only predicate),
 *   - revokeOthers closes every session but the current one,
 *   - a legacy JWT with no `sid` is still accepted (grace, never mass-logout).
 */
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { signJwt, verifyJwt } from '../../shared/auth';
import { TenancyService } from '../tenancy/tenancy.service';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';

interface Harness {
  ctx: UnitContext;
  tenancy: TenancyService;
  auth: AuthService;
  sessions: SessionService;
}

function makeHarness(overrides: Record<string, string> = {}): Harness {
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
  return { ctx, tenancy, auth, sessions };
}

/** Minimal express Request stand-in carrying a Bearer token. */
function makeReq(token: string, xff?: string): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (xff) headers['x-forwarded-for'] = xff;
  return {
    headers,
    path: '/api/v1/apps',
    url: '/api/v1/apps',
    ip: '203.0.113.10',
    socket: { remoteAddress: '203.0.113.10' },
    params: {},
  } as unknown as Request;
}

function sidOf(token: string): string {
  return verifyJwt(token, SECRET).sid as string;
}

/** Sign up a user and return its id (also creates their first session). */
async function seedUser(h: Harness, email: string): Promise<string> {
  await h.auth.signup({ email, password: 'passw0rd!' });
  return h.tenancy.getUserByEmail(email)!.id;
}

describe('auth/SessionService', () => {
  let h: Harness;
  beforeEach(() => (h = makeHarness()));
  afterEach(() => h.ctx.cleanup());

  // ===========================================================================
  // Created on sign-in
  // ===========================================================================
  it('creates a session on password login and embeds its id as JWT `sid`', async () => {
    const id = await seedUser(h, 'alice@x.com');
    const { token } = await h.auth.login('alice@x.com', 'passw0rd!', undefined, {
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0 TestBrowser',
    });

    const sid = sidOf(token);
    expect(typeof sid).toBe('string');
    expect(sid.length).toBeGreaterThan(0);

    const list = h.sessions.listForUser(id, sid);
    const current = list.find((s) => s.id === sid)!;
    expect(current).toBeDefined();
    expect(current.current).toBe(true);
    expect(current.ip).toBe('1.2.3.4');
    expect(current.userAgent).toBe('Mozilla/5.0 TestBrowser');
    expect(Date.parse(current.createdAt)).not.toBeNaN();
  });

  it('a session is created on signup too (immediate sign-in)', async () => {
    const { token } = await h.auth.signup(
      { email: 'fresh@x.com', password: 'passw0rd!' },
      { ip: '9.9.9.9', userAgent: 'UA' },
    );
    const id = h.tenancy.getUserByEmail('fresh@x.com')!.id;
    const list = h.sessions.listForUser(id, sidOf(token));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ip: '9.9.9.9', current: true });
  });

  // ===========================================================================
  // list surfaces ip + date + current flag
  // ===========================================================================
  it('lists the user own live sessions newest-first with ip + date', async () => {
    const id = await seedUser(h, 'bob@x.com'); // session #1 (signup)
    const login2 = await h.auth.login('bob@x.com', 'passw0rd!', undefined, {
      ip: '5.6.7.8',
      userAgent: null,
    });
    const sid2 = sidOf(login2.token);

    const list = h.sessions.listForUser(id, sid2);
    expect(list.length).toBe(2);
    // Exactly one is flagged current (the sid we passed).
    expect(list.filter((s) => s.current)).toHaveLength(1);
    for (const s of list) {
      expect(Date.parse(s.createdAt)).not.toBeNaN();
      expect(s).toHaveProperty('ip');
      expect(s).toHaveProperty('lastSeen');
    }
  });

  // ===========================================================================
  // revoked session → JWT rejected by the validator
  // ===========================================================================
  it('the validator ACCEPTS a live session then REJECTS it once revoked', async () => {
    const id = await seedUser(h, 'carol@x.com');
    const { token } = await h.auth.login('carol@x.com', 'passw0rd!', undefined, {
      ip: null,
      userAgent: null,
    });
    const sid = sidOf(token);

    // Live → validate resolves.
    await expect(h.auth.validate(makeReq(token))).resolves.toBeDefined();

    // Revoke, then the SAME token is rejected.
    expect(h.sessions.revoke(id, sid)).toBe(true);
    await expect(h.auth.validate(makeReq(token))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a JWT whose `sid` never existed (unknown session)', async () => {
    await seedUser(h, 'dan@x.com');
    const uid = h.tenancy.getUserByEmail('dan@x.com')!.id;
    const forged = signJwt({ sub: uid, sid: 'nope-nope-nope' }, SECRET, 3600);
    await expect(h.auth.validate(makeReq(forged))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('still ACCEPTS a legacy JWT with no `sid` (grace path)', async () => {
    await seedUser(h, 'eve@x.com');
    const uid = h.tenancy.getUserByEmail('eve@x.com')!.id;
    const legacy = signJwt({ sub: uid }, SECRET, 3600); // no sid
    await expect(h.auth.validate(makeReq(legacy))).resolves.toBeDefined();
  });

  // ===========================================================================
  // ownership: a user can only revoke THEIR OWN sessions
  // ===========================================================================
  it("cannot revoke ANOTHER user's session", async () => {
    const aliceId = await seedUser(h, 'a@x.com');
    await seedUser(h, 'b@x.com');
    const bLogin = await h.auth.login('b@x.com', 'passw0rd!', undefined, {
      ip: null,
      userAgent: null,
    });
    const bSid = sidOf(bLogin.token);

    // Alice tries to close Bob's session → refused, Bob stays live.
    expect(h.sessions.revoke(aliceId, bSid)).toBe(false);
    expect(h.sessions.isActive(bSid)).toBe(true);
    await expect(h.auth.validate(makeReq(bLogin.token))).resolves.toBeDefined();
  });

  it('revoke returns false for an unknown / already-revoked session', async () => {
    const id = await seedUser(h, 'f@x.com');
    const { token } = await h.auth.login('f@x.com', 'passw0rd!', undefined, {
      ip: null,
      userAgent: null,
    });
    const sid = sidOf(token);
    expect(h.sessions.revoke(id, 'does-not-exist')).toBe(false);
    expect(h.sessions.revoke(id, sid)).toBe(true);
    expect(h.sessions.revoke(id, sid)).toBe(false); // already revoked
  });

  // ===========================================================================
  // revokeOthers keeps only the current session
  // ===========================================================================
  it('revokeOthers closes every session but the current one', async () => {
    const id = await seedUser(h, 'g@x.com'); // session #1
    await h.auth.login('g@x.com', 'passw0rd!', undefined, {
      ip: null,
      userAgent: null,
    }); // #2
    const keep = await h.auth.login('g@x.com', 'passw0rd!', undefined, {
      ip: null,
      userAgent: null,
    }); // #3 — the one to keep
    const keepSid = sidOf(keep.token);

    const closed = h.sessions.revokeOthers(id, keepSid);
    expect(closed).toBe(2);

    const remaining = h.sessions.listForUser(id, keepSid);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(keepSid);
    // The kept token still authenticates.
    await expect(h.auth.validate(makeReq(keep.token))).resolves.toBeDefined();
  });
});
