/**
 * node:test — pure media formatting (duration/bitrate) + VOD field pickers.
 *
 * Locks the Grabaciones fixes: duration renders mm:ss / h:mm:ss from the
 * backend's `durationS`, the date comes from `startedAt`, and both tolerate
 * the legacy spellings (`durationSeconds` / `createdAt`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatBitrate,
  formatDateTime,
  formatDuration,
  vodDurationS,
  vodStartedAt,
} from './mediaFormat.ts'

test('formatDuration: mm:ss under an hour', () => {
  assert.equal(formatDuration(0), '—')
  assert.equal(formatDuration(5), '0:05')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(59.9), '0:59') // floors, never rounds up
  assert.equal(formatDuration(3599), '59:59')
})

test('formatDuration: h:mm:ss from one hour up', () => {
  assert.equal(formatDuration(3600), '1:00:00')
  assert.equal(formatDuration(3661), '1:01:01')
  assert.equal(formatDuration(7325.8), '2:02:05')
})

test('formatDuration: unknown/invalid → em dash', () => {
  assert.equal(formatDuration(undefined), '—')
  assert.equal(formatDuration(null), '—')
  assert.equal(formatDuration(-3), '—')
  assert.equal(formatDuration(Number.NaN), '—')
})

test('formatBitrate: bps → kbps → Mbps', () => {
  assert.equal(formatBitrate(undefined), '—')
  assert.equal(formatBitrate(0), '—')
  assert.equal(formatBitrate(500), '500 bps')
  assert.equal(formatBitrate(800_000), '800 kbps')
  assert.equal(formatBitrate(2_500_000), '2.5 Mbps')
  assert.equal(formatBitrate(12_000_000), '12 Mbps')
})

test('vodDurationS: prefers backend durationS, tolerates legacy spelling', () => {
  assert.equal(vodDurationS({ durationS: 12.5 }), 12.5)
  assert.equal(vodDurationS({ durationSeconds: 30 }), 30)
  assert.equal(vodDurationS({ durationS: 10, durationSeconds: 99 }), 10)
  assert.equal(vodDurationS({ durationS: null }), undefined)
  assert.equal(vodDurationS({}), undefined)
  assert.equal(vodDurationS({ durationS: 0 }), undefined) // 0 = unknown
})

test('vodStartedAt: startedAt wins, createdAt is the legacy fallback', () => {
  assert.equal(
    vodStartedAt({ startedAt: '2026-01-01T00:00:00Z' }),
    '2026-01-01T00:00:00Z',
  )
  assert.equal(
    vodStartedAt({ createdAt: '2025-12-31T00:00:00Z' }),
    '2025-12-31T00:00:00Z',
  )
  assert.equal(
    vodStartedAt({ startedAt: 'A', createdAt: 'B' }),
    'A',
  )
  assert.equal(vodStartedAt({}), undefined)
})

test('formatDateTime: dash when empty, verbatim when unparseable', () => {
  assert.equal(formatDateTime(undefined), '—')
  assert.equal(formatDateTime(''), '—')
  assert.equal(formatDateTime('not-a-date'), 'not-a-date')
  // A valid ISO date renders as *something* locale-dependent (non-dash).
  const out = formatDateTime('2026-01-01T10:00:00.000Z')
  assert.notEqual(out, '—')
  assert.ok(out.length > 5)
})
