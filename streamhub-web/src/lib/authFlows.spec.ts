/**
 * Unit specs for the auth-flow pure helpers (2FA step detection, magic-link
 * cooldown parsing, signup validation). Runs under node:test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cooldownSecondsFrom,
  DEFAULT_COOLDOWN_SECONDS,
  formatCooldown,
  isTotpInvalid,
  isTotpRequired,
  validateSignup,
} from './authFlows.ts'

function apiError(status: number, message: string, body?: unknown) {
  return { status, message, body: body ?? { message } }
}

test('isTotpRequired: only a 401 with the totp_required marker', () => {
  assert.equal(isTotpRequired(apiError(401, 'totp_required')), true)
  assert.equal(isTotpRequired(apiError(401, 'totp_invalid')), false)
  assert.equal(isTotpRequired(apiError(401, 'Invalid username or password')), false)
  assert.equal(isTotpRequired(apiError(403, 'totp_required')), false)
  assert.equal(isTotpRequired(new Error('totp_required')), false) // no status
  assert.equal(isTotpRequired(null), false)
  assert.equal(isTotpRequired('totp_required'), false)
})

test('isTotpRequired: reads the marker from the response body too', () => {
  const err = { status: 401, message: 'HTTP 401', body: { message: 'totp_required' } }
  assert.equal(isTotpRequired(err), true)
})

test('isTotpInvalid: only a 401 with the totp_invalid marker', () => {
  assert.equal(isTotpInvalid(apiError(401, 'totp_invalid')), true)
  assert.equal(isTotpInvalid(apiError(401, 'totp_required')), false)
  assert.equal(isTotpInvalid(undefined), false)
})

test('cooldownSecondsFrom: reads retryAfterSeconds out of a 429 body', () => {
  const err = apiError(429, 'wait', { retryAfterSeconds: 42 })
  assert.equal(cooldownSecondsFrom(err), 42)
})

test('cooldownSecondsFrom: rounds up fractional seconds', () => {
  const err = apiError(429, 'wait', { retryAfterSeconds: 0.2 })
  assert.equal(cooldownSecondsFrom(err), 1)
})

test('cooldownSecondsFrom: a 429 without the field falls back to the default', () => {
  assert.equal(cooldownSecondsFrom(apiError(429, 'slow down', {})), DEFAULT_COOLDOWN_SECONDS)
  assert.equal(cooldownSecondsFrom(apiError(429, 'slow down', { retryAfterSeconds: -5 })), DEFAULT_COOLDOWN_SECONDS)
})

test('cooldownSecondsFrom: non-429 errors are not cooldowns', () => {
  assert.equal(cooldownSecondsFrom(apiError(500, 'boom')), null)
  assert.equal(cooldownSecondsFrom(apiError(401, 'nope')), null)
  assert.equal(cooldownSecondsFrom(null), null)
})

test('validateSignup: happy path', () => {
  assert.equal(
    validateSignup({ email: 'a@b.co', password: 'longenough', confirm: 'longenough' }),
    null,
  )
})

test('validateSignup: reports the FIRST problem', () => {
  assert.equal(
    validateSignup({ email: 'nope', password: 'longenough', confirm: 'longenough' }),
    'invalidEmail',
  )
  assert.equal(
    validateSignup({ email: 'a@b.co', password: 'short', confirm: 'short' }),
    'passwordTooShort',
  )
  assert.equal(
    validateSignup({ email: 'a@b.co', password: 'longenough', confirm: 'different!' }),
    'passwordMismatch',
  )
})

test('formatCooldown: clamps negatives and rounds up', () => {
  assert.equal(formatCooldown(60), '60s')
  assert.equal(formatCooldown(0.4), '1s')
  assert.equal(formatCooldown(-3), '0s')
})
