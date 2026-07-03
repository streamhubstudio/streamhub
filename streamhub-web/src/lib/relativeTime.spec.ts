/**
 * Unit specs for the relative-time bucketing helper (pure).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relativeTime } from './relativeTime.ts'

const NOW = Date.parse('2026-07-01T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

test('relativeTime: missing / invalid input flags invalid', () => {
  assert.deepEqual(relativeTime(null, NOW), { unit: 'now', count: 0, invalid: true })
  assert.deepEqual(relativeTime(undefined, NOW), { unit: 'now', count: 0, invalid: true })
  assert.deepEqual(relativeTime('not-a-date', NOW), { unit: 'now', count: 0, invalid: true })
})

test('relativeTime: under 10s reads as "now"', () => {
  assert.deepEqual(relativeTime(ago(0), NOW), { unit: 'now', count: 0, invalid: false })
  assert.deepEqual(relativeTime(ago(9_000), NOW), { unit: 'now', count: 0, invalid: false })
})

test('relativeTime: seconds / minutes / hours / days buckets', () => {
  assert.deepEqual(relativeTime(ago(30_000), NOW), { unit: 'seconds', count: 30, invalid: false })
  assert.deepEqual(relativeTime(ago(5 * 60_000), NOW), { unit: 'minutes', count: 5, invalid: false })
  assert.deepEqual(relativeTime(ago(3 * 3_600_000), NOW), { unit: 'hours', count: 3, invalid: false })
  assert.deepEqual(relativeTime(ago(2 * 86_400_000), NOW), { unit: 'days', count: 2, invalid: false })
})

test('relativeTime: future timestamps clamp to now', () => {
  assert.deepEqual(relativeTime(new Date(NOW + 60_000).toISOString(), NOW), {
    unit: 'now',
    count: 0,
    invalid: false,
  })
})

test('relativeTime: accepts Date and epoch millis too', () => {
  assert.equal(relativeTime(new Date(NOW - 120_000), NOW).unit, 'minutes')
  assert.equal(relativeTime(NOW - 120_000, NOW).count, 2)
})
