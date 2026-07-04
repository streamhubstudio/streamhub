/**
 * Unit — security/IpReputationService (in-app fail2ban).
 *
 * Invariants locked down:
 *  - threshold: N offenses inside the sliding window → ban; N-1 → no ban,
 *  - window: offenses older than AUTOBAN_WINDOW_S don't count,
 *  - ban expiry: a ban lapses after its TTL,
 *  - escalation: each repeat ban doubles the TTL (2^level),
 *  - NEVER bans loopback / RFC1918 / allowlisted IPs (offenses still counted),
 *  - persistence: active bans survive a service restart (ip_bans),
 *  - unban clears memory + resets escalation,
 *  - recordOffense is fire-and-forget (never throws, even on garbage input)
 *    and a no-op when STREAMHUB_AUTOBAN_ENABLED is off.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { IpRulesService } from './ip-rules.service';
import { IpReputationService } from './ip-reputation.service';

const ENV_KEYS = [
  'STREAMHUB_IP_ACCESS_MODE',
  'STREAMHUB_IP_ALLOWLIST_ONLY',
  'STREAMHUB_AUTOBAN_ENABLED',
  'STREAMHUB_AUTOBAN_MAX_OFFENSES',
  'STREAMHUB_AUTOBAN_WINDOW_S',
  'STREAMHUB_AUTOBAN_BASE_TTL_S',
  'STREAMHUB_AUTOBAN_404_ENABLED',
];

const IP = '203.0.113.66';

describe('security/IpReputationService', () => {
  let ctx: UnitContext;
  let rules: IpRulesService;
  let rep: IpReputationService;
  let nowSpy: jest.SpyInstance<number, []>;
  let now = 0;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
  });

  beforeEach(() => {
    now = 1_750_000_000_000; // fixed epoch base
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    rep?.onModuleDestroy();
    ctx?.cleanup();
    nowSpy.mockRestore();
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  function make(env: Record<string, string> = {}): void {
    ctx = makeUnitContext({
      STREAMHUB_AUTOBAN_ENABLED: 'true',
      STREAMHUB_AUTOBAN_MAX_OFFENSES: '3',
      STREAMHUB_AUTOBAN_WINDOW_S: '60',
      STREAMHUB_AUTOBAN_BASE_TTL_S: '100',
      ...env,
    });
    rules = ctx.newService(IpRulesService, ctx.db);
    rules.onModuleInit();
    rep = ctx.newService(IpReputationService, ctx.db, ctx.config, rules);
    rep.onModuleInit();
  }

  function offend(ip: string, times: number): void {
    for (let i = 0; i < times; i++) rep.recordOffense(ip, 'login_failed');
  }

  describe('threshold + window', () => {
    it('bans at MAX_OFFENSES within the window, not before', () => {
      make();
      offend(IP, 2);
      expect(rep.isBanned(IP)).toBe(false);
      offend(IP, 1);
      expect(rep.isBanned(IP)).toBe(true);
    });

    it('offenses outside the sliding window do not count', () => {
      make();
      offend(IP, 2);
      now += 61_000; // window is 60s — the first two just expired
      offend(IP, 2);
      expect(rep.isBanned(IP)).toBe(false);
      offend(IP, 1);
      expect(rep.isBanned(IP)).toBe(true);
    });

    it('recording is idempotent while banned (no re-ban / no TTL extension)', () => {
      make();
      offend(IP, 3);
      const until = rep.activeBans().find((b) => b.ip === IP)?.bannedUntil;
      now += 10_000;
      offend(IP, 10); // more offenses while banned
      expect(rep.activeBans().find((b) => b.ip === IP)?.bannedUntil).toBe(until);
      expect(rep.activeBans().find((b) => b.ip === IP)?.escalationLevel).toBe(0);
    });

    it('a ban expires after its TTL', () => {
      make();
      offend(IP, 3);
      expect(rep.isBanned(IP)).toBe(true);
      now += 99_000;
      expect(rep.isBanned(IP)).toBe(true);
      now += 2_000; // past the 100s base TTL
      expect(rep.isBanned(IP)).toBe(false);
    });
  });

  describe('escalation', () => {
    it('doubles the TTL on each repeat ban (2^level)', () => {
      make();
      offend(IP, 3); // level 0 → 100s
      now += 101_000;
      expect(rep.isBanned(IP)).toBe(false);

      offend(IP, 3); // level 1 → 200s
      const second = rep.activeBans().find((b) => b.ip === IP);
      expect(second?.escalationLevel).toBe(1);
      now += 101_000;
      expect(rep.isBanned(IP)).toBe(true); // still banned: TTL doubled
      now += 100_000;
      expect(rep.isBanned(IP)).toBe(false);

      offend(IP, 3); // level 2 → 400s
      expect(rep.activeBans().find((b) => b.ip === IP)?.escalationLevel).toBe(2);
    });
  });

  describe('never-ban guarantees', () => {
    it('never bans loopback / RFC1918 (offenses still visible)', () => {
      make();
      for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '::1']) {
        offend(ip, 20);
        expect(rep.isBanned(ip)).toBe(false);
      }
      // Still counted for the /offenses surface.
      expect(rep.offenders().find((o) => o.ip === '10.1.2.3')?.count).toBe(20);
    });

    it('never bans an explicitly allowlisted public IP', () => {
      make();
      rules.add({ cidr: '203.0.113.0/24', action: 'allow' });
      offend(IP, 20);
      expect(rep.isBanned(IP)).toBe(false);
    });
  });

  describe('persistence (ip_bans)', () => {
    it('an active ban survives a restart; an expired one does not', () => {
      make();
      offend(IP, 3);
      offend('198.51.100.9', 3);
      // Expire ONLY the second ban before "restarting".
      const banned = rep.activeBans().map((b) => b.ip).sort();
      expect(banned).toEqual(['198.51.100.9', IP].sort());
      rep.unban('198.51.100.9');

      const rep2 = ctx.newService(IpReputationService, ctx.db, ctx.config, rules);
      rep2.onModuleInit();
      expect(rep2.isBanned(IP)).toBe(true);
      expect(rep2.isBanned('198.51.100.9')).toBe(false);
      rep2.onModuleDestroy();
    });
  });

  describe('unban', () => {
    it('lifts the ban, clears offenses and resets escalation', () => {
      make();
      offend(IP, 3);
      expect(rep.isBanned(IP)).toBe(true);
      expect(rep.unban(IP)).toBe(true);
      expect(rep.isBanned(IP)).toBe(false);
      // Escalation was reset → the next ban is level 0 again.
      offend(IP, 3);
      expect(rep.activeBans().find((b) => b.ip === IP)?.escalationLevel).toBe(0);
    });

    it('returns false for an unknown IP', () => {
      make();
      expect(rep.unban('8.8.8.8')).toBe(false);
    });
  });

  describe('fire-and-forget + kill switch', () => {
    it('never throws on garbage input', () => {
      make();
      expect(() => rep.recordOffense(null, 'login_failed')).not.toThrow();
      expect(() => rep.recordOffense(undefined, 'invalid_token')).not.toThrow();
      expect(() => rep.recordOffense('', 'rate_limited')).not.toThrow();
      expect(() => rep.recordOffense('not-an-ip', 'not_found')).not.toThrow();
      expect(rep.counts().trackedOffenders).toBe(0);
    });

    it('is a complete no-op when STREAMHUB_AUTOBAN_ENABLED is off', () => {
      make({ STREAMHUB_AUTOBAN_ENABLED: 'false' });
      offend(IP, 50);
      expect(rep.isBanned(IP)).toBe(false);
      expect(rep.offenders()).toEqual([]);
      expect(rep.counts()).toEqual({ activeBans: 0, trackedOffenders: 0 });
    });
  });

  describe('offenders surface', () => {
    it('aggregates counts + kind breakdown, heaviest first', () => {
      make({ STREAMHUB_AUTOBAN_MAX_OFFENSES: '100' });
      rep.recordOffense(IP, 'login_failed');
      rep.recordOffense(IP, 'login_failed');
      rep.recordOffense(IP, 'invalid_token');
      rep.recordOffense('198.51.100.1', 'magic_verify_failed');
      const out = rep.offenders();
      expect(out[0]).toMatchObject({
        ip: IP,
        count: 3,
        kinds: { login_failed: 2, invalid_token: 1 },
      });
      expect(out[1]).toMatchObject({ ip: '198.51.100.1', count: 1 });
    });
  });
});
