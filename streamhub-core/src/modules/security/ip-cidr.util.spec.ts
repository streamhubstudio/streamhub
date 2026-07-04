/**
 * Unit — security/ip-cidr.util (pure IPv4/IPv6 + CIDR matching).
 *
 * Locks down the matching primitives everything else in the network-security
 * module builds on: v4/v6 parsing, CIDR boundary conditions, IPv4-mapped v6
 * folding, and the private/loopback ranges behind the lock-out guarantee.
 */
import {
  clientIpOf,
  ipMatchesCidr,
  isPrivateOrLoopbackIp,
  normalizeIp,
  parseCidr,
  parseIp,
} from './ip-cidr.util';
import type { Request } from 'express';

describe('security/ip-cidr.util', () => {
  describe('parseIp', () => {
    it('parses IPv4', () => {
      expect(parseIp('203.0.113.7')).toEqual({
        version: 4,
        value: BigInt(0xcb00_7107),
      });
    });

    it('parses IPv6 (:: compression + full form)', () => {
      expect(parseIp('::1')).toEqual({ version: 6, value: 1n });
      expect(parseIp('2001:db8::5')?.version).toBe(6);
      expect(
        parseIp('2001:0db8:0000:0000:0000:0000:0000:0005')?.value,
      ).toBe(parseIp('2001:db8::5')?.value);
    });

    it('folds IPv4-mapped IPv6 to plain v4', () => {
      expect(parseIp('::ffff:192.0.2.9')).toEqual(parseIp('192.0.2.9'));
    });

    it('strips zone indexes', () => {
      expect(parseIp('fe80::1%eth0')?.version).toBe(6);
    });

    it('rejects garbage', () => {
      for (const bad of [
        '',
        'not-an-ip',
        '1.2.3',
        '1.2.3.4.5',
        '256.1.1.1',
        '1.2.3.-4',
        '2001:db8:::5',
        'g001:db8::1',
        '1:2:3:4:5:6:7:8:9',
      ]) {
        expect(parseIp(bad)).toBeNull();
      }
    });
  });

  describe('parseCidr', () => {
    it('accepts bare IPs as /32 and /128', () => {
      expect(parseCidr('10.1.2.3')?.prefix).toBe(32);
      expect(parseCidr('2001:db8::1')?.prefix).toBe(128);
    });

    it('zeroes host bits (10.0.0.5/8 → network 10.0.0.0)', () => {
      const c = parseCidr('10.0.0.5/8');
      expect(c?.network).toBe(BigInt(0x0a00_0000));
      expect(c?.cidr).toBe('10.0.0.5/8');
    });

    it('rejects invalid prefixes and shapes', () => {
      for (const bad of ['1.2.3.4/33', '::1/129', '1.2.3.4/-1', '1.2.3.4/x', '/24', 'foo/8']) {
        expect(parseCidr(bad)).toBeNull();
      }
    });
  });

  describe('ipMatchesCidr — boundaries', () => {
    it('IPv4 /24 boundaries', () => {
      expect(ipMatchesCidr('203.0.113.0', '203.0.113.0/24')).toBe(true);
      expect(ipMatchesCidr('203.0.113.255', '203.0.113.0/24')).toBe(true);
      expect(ipMatchesCidr('203.0.114.0', '203.0.113.0/24')).toBe(false);
      expect(ipMatchesCidr('203.0.112.255', '203.0.113.0/24')).toBe(false);
    });

    it('IPv4 /32 exact and /0 catch-all', () => {
      expect(ipMatchesCidr('198.51.100.1', '198.51.100.1/32')).toBe(true);
      expect(ipMatchesCidr('198.51.100.2', '198.51.100.1/32')).toBe(false);
      expect(ipMatchesCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    });

    it('IPv6 /64 boundaries and /0', () => {
      expect(ipMatchesCidr('2001:db8:1:2::1', '2001:db8:1:2::/64')).toBe(true);
      expect(
        ipMatchesCidr('2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'),
      ).toBe(true);
      expect(ipMatchesCidr('2001:db8:1:3::', '2001:db8:1:2::/64')).toBe(false);
      expect(ipMatchesCidr('::1', '::/0')).toBe(true);
    });

    it('never cross-matches families', () => {
      expect(ipMatchesCidr('10.0.0.1', '::/0')).toBe(false);
      expect(ipMatchesCidr('2001:db8::1', '0.0.0.0/0')).toBe(false);
    });

    it('matches a v4 rule against an IPv4-mapped v6 client', () => {
      expect(ipMatchesCidr('::ffff:10.0.0.1', '10.0.0.0/8')).toBe(true);
    });
  });

  describe('isPrivateOrLoopbackIp — the lock-out guarantee ranges', () => {
    it('true for loopback / RFC1918 / link-local / ULA', () => {
      for (const ip of [
        '127.0.0.1',
        '127.255.255.254',
        '10.0.0.1',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.50',
        '169.254.10.10',
        '::1',
        'fc00::1',
        'fdab::99',
        'fe80::1',
        '::ffff:192.168.0.7',
      ]) {
        expect(isPrivateOrLoopbackIp(ip)).toBe(true);
      }
    });

    it('false for public v4/v6 and for the RFC1918 fringes', () => {
      for (const ip of [
        '8.8.8.8',
        '203.0.113.1',
        '172.15.255.255',
        '172.32.0.1',
        '11.0.0.1',
        '2001:db8::1',
        'not-an-ip',
      ]) {
        expect(isPrivateOrLoopbackIp(ip)).toBe(false);
      }
    });
  });

  describe('normalizeIp / clientIpOf', () => {
    it('normalizes mapped + zoned addresses', () => {
      expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
      expect(normalizeIp('fe80::1%en0')).toBe('fe80::1');
      expect(normalizeIp('  8.8.8.8 ')).toBe('8.8.8.8');
    });

    it('prefers the first X-Forwarded-For hop, then the socket', () => {
      const req = (h: Record<string, unknown>, ip?: string): Request =>
        ({ headers: h, ip, socket: { remoteAddress: '127.0.0.1' } }) as unknown as Request;
      expect(clientIpOf(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
      expect(clientIpOf(req({ 'x-forwarded-for': ['198.51.100.3'] }))).toBe('198.51.100.3');
      expect(clientIpOf(req({}, '::ffff:9.9.9.9'))).toBe('9.9.9.9');
      expect(clientIpOf(req({}))).toBe('127.0.0.1');
    });
  });
});
