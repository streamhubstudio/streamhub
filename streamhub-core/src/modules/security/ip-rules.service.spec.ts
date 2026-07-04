/**
 * Unit — security/IpRulesService (global IP allow/blocklist over ip_rules).
 *
 * Invariants locked down:
 *  - idempotent schema bootstrap on the GLOBAL DB (mirrors sessions/magic_tokens),
 *  - add() validates + normalises CIDR (bare IP → /32 // /128) and rejects dups,
 *  - evaluate(): explicit allow WINS over explicit block; no match → 'none',
 *  - mutations reload the compiled in-memory cache immediately,
 *  - remove() 404s on unknown ids.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { IpRulesService } from './ip-rules.service';

describe('security/IpRulesService', () => {
  let ctx: UnitContext;
  let rules: IpRulesService;

  beforeEach(() => {
    ctx = makeUnitContext();
    rules = ctx.newService(IpRulesService, ctx.db);
    rules.onModuleInit();
  });

  afterEach(() => ctx.cleanup());

  it('bootstraps idempotently (onModuleInit twice is harmless)', () => {
    expect(() => rules.onModuleInit()).not.toThrow();
    expect(rules.list()).toEqual([]);
  });

  describe('add()', () => {
    it('normalises a bare IPv4 to /32 and IPv6 to /128', () => {
      expect(rules.add({ cidr: '203.0.113.9', action: 'block' }).cidr).toBe(
        '203.0.113.9/32',
      );
      expect(rules.add({ cidr: '2001:db8::1', action: 'block' }).cidr).toBe(
        '2001:db8::1/128',
      );
    });

    it('keeps note + created_by and stamps created_at', () => {
      const r = rules.add({
        cidr: '198.51.100.0/24',
        action: 'allow',
        note: 'office',
        createdBy: 'admin',
      });
      expect(r.note).toBe('office');
      expect(r.createdBy).toBe('admin');
      expect(r.createdAt).toBeTruthy();
    });

    it('rejects invalid CIDR with 400', () => {
      for (const bad of ['nope', '1.2.3.4/40', '2001:db8::/200', '']) {
        expect(() => rules.add({ cidr: bad, action: 'block' })).toThrow(
          BadRequestException,
        );
      }
    });

    it('rejects a duplicate cidr+action with 400', () => {
      rules.add({ cidr: '203.0.113.0/24', action: 'block' });
      expect(() =>
        rules.add({ cidr: '203.0.113.0/24', action: 'block' }),
      ).toThrow(BadRequestException);
      // Same cidr with the OTHER action is a distinct (if odd) rule.
      expect(() =>
        rules.add({ cidr: '203.0.113.0/24', action: 'allow' }),
      ).not.toThrow();
    });
  });

  describe('evaluate() — precedence', () => {
    it("no rules → 'none'", () => {
      expect(rules.evaluate('203.0.113.1')).toBe('none');
    });

    it('explicit block matches by CIDR (v4 + v6)', () => {
      rules.add({ cidr: '203.0.113.0/24', action: 'block' });
      rules.add({ cidr: '2001:db8::/32', action: 'block' });
      expect(rules.evaluate('203.0.113.77')).toBe('block');
      expect(rules.evaluate('2001:db8:beef::1')).toBe('block');
      expect(rules.evaluate('203.0.114.1')).toBe('none');
    });

    it('explicit allow WINS over an overlapping block', () => {
      rules.add({ cidr: '203.0.113.0/24', action: 'block' });
      rules.add({ cidr: '203.0.113.9/32', action: 'allow' });
      expect(rules.evaluate('203.0.113.9')).toBe('allow');
      expect(rules.evaluate('203.0.113.10')).toBe('block');
      // ...regardless of insertion order.
      rules.add({ cidr: '198.51.100.7/32', action: 'allow' });
      rules.add({ cidr: '198.51.100.0/24', action: 'block' });
      expect(rules.evaluate('198.51.100.7')).toBe('allow');
    });

    it("unparseable client IPs never match ('none')", () => {
      rules.add({ cidr: '0.0.0.0/0', action: 'block' });
      expect(rules.evaluate('garbage')).toBe('none');
    });

    it('isAllowlisted mirrors evaluate()===allow', () => {
      rules.add({ cidr: '198.51.100.0/24', action: 'allow' });
      expect(rules.isAllowlisted('198.51.100.20')).toBe(true);
      expect(rules.isAllowlisted('8.8.8.8')).toBe(false);
    });
  });

  describe('remove() + cache reload', () => {
    it('removing a rule takes effect immediately', () => {
      const r = rules.add({ cidr: '203.0.113.0/24', action: 'block' });
      expect(rules.evaluate('203.0.113.5')).toBe('block');
      rules.remove(r.id);
      expect(rules.evaluate('203.0.113.5')).toBe('none');
      expect(rules.list()).toEqual([]);
    });

    it('404 for an unknown id', () => {
      expect(() => rules.remove(999)).toThrow(NotFoundException);
    });
  });

  it('rules survive a service restart (compiled from the DB)', () => {
    rules.add({ cidr: '203.0.113.0/24', action: 'block' });
    const fresh = ctx.newService(IpRulesService, ctx.db);
    fresh.onModuleInit();
    expect(fresh.evaluate('203.0.113.42')).toBe('block');
  });

  it('counts() splits allow/block for /security/status', () => {
    rules.add({ cidr: '10.9.9.9/32', action: 'allow' });
    rules.add({ cidr: '203.0.113.0/24', action: 'block' });
    rules.add({ cidr: '198.51.100.0/24', action: 'block' });
    expect(rules.counts()).toEqual({ total: 3, allow: 1, block: 2 });
  });
});
