/**
 * Unit — security/SecurityMiddleware (the single early enforcement hook).
 *
 * Invariants locked down:
 *  - `off` mode + autoban off → pure pass-through (fully dormant),
 *  - loopback/private ALWAYS pass, in every mode, even when 0.0.0.0/0 is
 *    blocked and the IP is "banned" (the lock-out guarantee / liveness),
 *  - enforce: blocklisted → 403, banned → 429 — both with SMALL GENERIC JSON
 *    bodies that never leak which rule/ban matched,
 *  - log: would-block requests pass but are annotated (req.ipAccess),
 *  - allowlist-only: non-allowlisted public IPs are rejected, allowlisted pass,
 *  - explicit allow beats explicit block AND an active ban.
 */
import type { Request, Response } from 'express';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { IpRulesService } from './ip-rules.service';
import { IpReputationService } from './ip-reputation.service';
import { SecurityMiddleware, type RequestWithIpAccess } from './security.middleware';

const ENV_KEYS = [
  'STREAMHUB_IP_ACCESS_MODE',
  'STREAMHUB_IP_ALLOWLIST_ONLY',
  'STREAMHUB_AUTOBAN_ENABLED',
  'STREAMHUB_AUTOBAN_MAX_OFFENSES',
  'STREAMHUB_AUTOBAN_WINDOW_S',
  'STREAMHUB_AUTOBAN_BASE_TTL_S',
  'STREAMHUB_AUTOBAN_404_ENABLED',
];

const PUBLIC_IP = '203.0.113.5';

interface Harness {
  ctx: UnitContext;
  rules: IpRulesService;
  rep: IpReputationService;
  mw: SecurityMiddleware;
}

function make(env: Record<string, string> = {}): Harness {
  const ctx = makeUnitContext({
    STREAMHUB_IP_ACCESS_MODE: 'enforce',
    STREAMHUB_IP_ALLOWLIST_ONLY: '',
    STREAMHUB_AUTOBAN_ENABLED: 'true',
    STREAMHUB_AUTOBAN_MAX_OFFENSES: '3',
    STREAMHUB_AUTOBAN_WINDOW_S: '60',
    STREAMHUB_AUTOBAN_BASE_TTL_S: '900',
    ...env,
  });
  const rules = ctx.newService(IpRulesService, ctx.db);
  rules.onModuleInit();
  const rep = ctx.newService(IpReputationService, ctx.db, ctx.config, rules);
  rep.onModuleInit();
  const mw = ctx.newService(SecurityMiddleware, ctx.config, rules, rep);
  return { ctx, rules, rep, mw };
}

function fakeReq(ip: string, path = '/api/v1/apps'): Request {
  return {
    headers: { 'x-forwarded-for': ip },
    method: 'GET',
    path,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

interface FakeRes {
  res: Response;
  statusCode: () => number | null;
  body: () => unknown;
  finish: () => void;
}

function fakeRes(): FakeRes {
  let code: number | null = null;
  let payload: unknown;
  const listeners: Record<string, () => void> = {};
  const res = {
    status(c: number) {
      code = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    on(event: string, cb: () => void) {
      listeners[event] = cb;
    },
    statusCode: 404,
  } as unknown as Response;
  return {
    res,
    statusCode: () => code,
    body: () => payload,
    finish: () => listeners['finish']?.(),
  };
}

function ban(h: Harness, ip: string): void {
  for (let i = 0; i < 3; i++) h.rep.recordOffense(ip, 'login_failed');
  expect(h.rep.isBanned(ip)).toBe(true);
}

describe('security/SecurityMiddleware', () => {
  let h: Harness;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
  });
  afterEach(() => {
    h?.rep.onModuleDestroy();
    h?.ctx.cleanup();
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('mode=off + autoban off → dormant pass-through', () => {
    h = make({ STREAMHUB_IP_ACCESS_MODE: 'off', STREAMHUB_AUTOBAN_ENABLED: '' });
    h.rules.add({ cidr: '0.0.0.0/0', action: 'block' });
    const { res, statusCode } = fakeRes();
    const next = jest.fn();
    h.mw.use(fakeReq(PUBLIC_IP), res, next);
    expect(next).toHaveBeenCalled();
    expect(statusCode()).toBeNull();
  });

  it('mode=off still enforces bans when autoban is on', () => {
    h = make({ STREAMHUB_IP_ACCESS_MODE: 'off' });
    ban(h, PUBLIC_IP);
    const { res, statusCode } = fakeRes();
    const next = jest.fn();
    h.mw.use(fakeReq(PUBLIC_IP), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(statusCode()).toBe(429);
  });

  describe('the lock-out guarantee (liveness)', () => {
    it.each(['127.0.0.1', '10.0.0.7', '192.168.1.1', '::1', 'fd00::5'])(
      'loopback/private %s passes even with 0.0.0.0/0 + ::/0 blocked in enforce mode',
      (ip) => {
        h = make();
        h.rules.add({ cidr: '0.0.0.0/0', action: 'block' });
        h.rules.add({ cidr: '::/0', action: 'block' });
        const { res, statusCode } = fakeRes();
        const next = jest.fn();
        h.mw.use(fakeReq(ip, '/api/v1/health'), res, next);
        expect(next).toHaveBeenCalled();
        expect(statusCode()).toBeNull();
      },
    );

    it('allowlist-only never rejects loopback (health check stays alive)', () => {
      h = make({ STREAMHUB_IP_ALLOWLIST_ONLY: 'true' });
      const { res } = fakeRes();
      const next = jest.fn();
      h.mw.use(fakeReq('127.0.0.1', '/api/v1/health'), res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('enforce mode', () => {
    it('blocklisted public IP → 403 with a generic body (no rule leak)', () => {
      h = make();
      h.rules.add({
        cidr: '203.0.113.0/24',
        action: 'block',
        note: 'SECRET-NOTE',
      });
      const { res, statusCode, body } = fakeRes();
      const next = jest.fn();
      h.mw.use(fakeReq(PUBLIC_IP), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(statusCode()).toBe(403);
      expect(body()).toEqual({
        data: null,
        error: { code: 'forbidden', message: 'Access denied' },
      });
      expect(JSON.stringify(body())).not.toContain('SECRET-NOTE');
      expect(JSON.stringify(body())).not.toContain('203.0.113');
    });

    it('banned IP → 429 with a generic body (no ban details leak)', () => {
      h = make();
      ban(h, PUBLIC_IP);
      const { res, statusCode, body } = fakeRes();
      const next = jest.fn();
      h.mw.use(fakeReq(PUBLIC_IP), res, next);
      expect(statusCode()).toBe(429);
      expect(body()).toEqual({
        data: null,
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Please retry later.',
        },
      });
      const s = JSON.stringify(body());
      expect(s).not.toMatch(/ban|offense|escalat/i);
    });

    it('explicit allow beats explicit block AND an active ban', () => {
      h = make();
      h.rules.add({ cidr: '203.0.113.0/24', action: 'block' });
      ban(h, '198.51.100.4');
      h.rules.add({ cidr: '203.0.113.5/32', action: 'allow' });
      h.rules.add({ cidr: '198.51.100.4/32', action: 'allow' });
      for (const ip of [PUBLIC_IP, '198.51.100.4']) {
        const { res } = fakeRes();
        const next = jest.fn();
        h.mw.use(fakeReq(ip), res, next);
        expect(next).toHaveBeenCalled();
      }
    });

    it('allowlist-only rejects unlisted public IPs, passes listed ones', () => {
      h = make({ STREAMHUB_IP_ALLOWLIST_ONLY: 'true' });
      h.rules.add({ cidr: '198.51.100.0/24', action: 'allow' });

      const denied = fakeRes();
      const nextDenied = jest.fn();
      h.mw.use(fakeReq(PUBLIC_IP), denied.res, nextDenied);
      expect(nextDenied).not.toHaveBeenCalled();
      expect(denied.statusCode()).toBe(403);

      const allowed = fakeRes();
      const nextAllowed = jest.fn();
      h.mw.use(fakeReq('198.51.100.10'), allowed.res, nextAllowed);
      expect(nextAllowed).toHaveBeenCalled();
    });
  });

  describe('log mode', () => {
    it('would-block requests pass but are annotated', () => {
      h = make({ STREAMHUB_IP_ACCESS_MODE: 'log' });
      h.rules.add({ cidr: '203.0.113.0/24', action: 'block' });
      const req = fakeReq(PUBLIC_IP);
      const { res, statusCode } = fakeRes();
      const next = jest.fn();
      h.mw.use(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(statusCode()).toBeNull();
      expect((req as RequestWithIpAccess).ipAccess).toBe('would_block');
    });

    it('non-matching requests are not annotated', () => {
      h = make({ STREAMHUB_IP_ACCESS_MODE: 'log' });
      const req = fakeReq(PUBLIC_IP);
      const next = jest.fn();
      h.mw.use(req, fakeRes().res, next);
      expect(next).toHaveBeenCalled();
      expect((req as RequestWithIpAccess).ipAccess).toBeUndefined();
    });
  });

  describe('404-storm tracking (opt-in)', () => {
    it('records not_found offenses on finish when enabled', () => {
      h = make({
        STREAMHUB_AUTOBAN_404_ENABLED: 'true',
        STREAMHUB_AUTOBAN_MAX_OFFENSES: '100',
      });
      const { res, finish } = fakeRes(); // statusCode preset to 404
      h.mw.use(fakeReq(PUBLIC_IP), res, jest.fn());
      finish();
      expect(
        h.rep.offenders().find((o) => o.ip === PUBLIC_IP)?.kinds.not_found,
      ).toBe(1);
    });

    it('does nothing when the flag is off (default)', () => {
      h = make();
      const { res, finish } = fakeRes();
      h.mw.use(fakeReq(PUBLIC_IP), res, jest.fn());
      finish();
      expect(h.rep.offenders()).toEqual([]);
    });
  });
});
