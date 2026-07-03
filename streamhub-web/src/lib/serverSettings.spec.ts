/**
 * Unit specs for the Server-settings pure helpers (badge tones + uptime).
 * Run with Node's built-in runner: `npm run test` → `node --test src/**\/*.spec.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authzTone, enforcementActive, setTone, formatUptime } from './serverSettings.ts'

test('authzTone: on→green, log→amber, off→red, unknown→amber', () => {
  assert.equal(authzTone('on'), 'green')
  assert.equal(authzTone('log'), 'amber')
  assert.equal(authzTone('off'), 'red')
  assert.equal(authzTone(undefined), 'amber')
  assert.equal(authzTone('weird'), 'amber')
})

test('enforcementActive: true only for "on"', () => {
  assert.equal(enforcementActive('on'), true)
  assert.equal(enforcementActive('log'), false)
  assert.equal(enforcementActive('off'), false)
  assert.equal(enforcementActive(undefined), false)
})

test('setTone: configured→green, unset→red', () => {
  assert.equal(setTone(true), 'green')
  assert.equal(setTone(false), 'red')
})

test('formatUptime: invalid inputs render placeholder', () => {
  assert.equal(formatUptime(undefined), '—')
  assert.equal(formatUptime(null), '—')
  assert.equal(formatUptime(-1), '—')
  assert.equal(formatUptime(Number.NaN), '—')
})

test('formatUptime: two most-significant units', () => {
  assert.equal(formatUptime(0), '0s')
  assert.equal(formatUptime(45), '45s')
  assert.equal(formatUptime(90), '1m 30s')
  assert.equal(formatUptime(3661), '1h 1m')
  assert.equal(formatUptime(90061), '1d 1h')
  // seconds are dropped once days/hours lead
  assert.equal(formatUptime(86400), '1d')
})
