/**
 * Unit specs for the CIDR/IP form validator (pure — mirrors the backend
 * parser's accept/reject surface for POST /security/ip-rules).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidCidr, normalizeIp } from './cidr.ts'

test('isValidCidr: accepts bare IPv4 and IPv4 CIDRs', () => {
  for (const ok of ['203.0.113.9', '10.0.0.0/8', '0.0.0.0/0', '192.168.1.1/32']) {
    assert.equal(isValidCidr(ok), true, ok)
  }
})

test('isValidCidr: accepts bare IPv6 and IPv6 CIDRs', () => {
  for (const ok of ['::1', '2001:db8::/32', 'fe80::1/10', '::/0', '2001:db8::1/128', '::ffff:1.2.3.4']) {
    assert.equal(isValidCidr(ok), true, ok)
  }
})

test('isValidCidr: rejects malformed input', () => {
  for (const bad of [
    '',
    '   ',
    'not-an-ip',
    '1.2.3',
    '1.2.3.4.5',
    '256.0.0.1',
    '1.2.3.4/33',
    '1.2.3.4/-1',
    '1.2.3.4/x',
    '2001:db8::/129',
    '2001:db8:::1',
    'g001::1',
    '/24',
  ]) {
    assert.equal(isValidCidr(bad), false, bad)
  }
})

test('isValidCidr: prefix boundaries are inclusive (0..32 / 0..128)', () => {
  assert.equal(isValidCidr('1.2.3.4/0'), true)
  assert.equal(isValidCidr('1.2.3.4/32'), true)
  assert.equal(isValidCidr('::1/0'), true)
  assert.equal(isValidCidr('::1/128'), true)
})

test('normalizeIp: strips mapped prefix, zone index and whitespace', () => {
  assert.equal(normalizeIp('::ffff:9.9.9.9'), '9.9.9.9')
  assert.equal(normalizeIp('fe80::1%en0'), 'fe80::1')
  assert.equal(normalizeIp('  8.8.8.8  '), '8.8.8.8')
})
