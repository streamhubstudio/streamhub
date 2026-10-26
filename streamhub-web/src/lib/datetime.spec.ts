/**
 * node:test — the shared `formatDateTime` util (pure).
 *
 * Expected strings are built from local `Date` component constructors (not
 * hardcoded against a particular time zone) so the suite is deterministic
 * regardless of the machine/CI runner's local time zone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDateTime, isValidTimezone, listTimezones } from './datetime.ts'

test('formatDateTime: SQL-style local YYYY-MM-DD HH:mm:ss', () => {
  const d = new Date(2026, 0, 5, 9, 7, 3) // local: Jan 5 2026, 09:07:03
  assert.equal(formatDateTime(d), '2026-01-05 09:07:03')
})

test('formatDateTime: zero-pads month/day/hour/minute/second', () => {
  const d = new Date(2026, 0, 1, 0, 0, 0)
  assert.equal(formatDateTime(d), '2026-01-01 00:00:00')
})

test('formatDateTime: double-digit month/day/hour render unpadded-safe', () => {
  const d = new Date(2026, 11, 25, 23, 59, 9)
  assert.equal(formatDateTime(d), '2026-12-25 23:59:09')
})

test('formatDateTime: accepts an ISO string and epoch millis (same instant → same output)', () => {
  const d = new Date(2026, 5, 15, 14, 30, 45)
  assert.equal(formatDateTime(d.toISOString()), formatDateTime(d))
  assert.equal(formatDateTime(d.getTime()), formatDateTime(d))
})

test('formatDateTime: missing/empty → em dash', () => {
  assert.equal(formatDateTime(undefined), '—')
  assert.equal(formatDateTime(null), '—')
  assert.equal(formatDateTime(''), '—')
})

test('formatDateTime: unparseable string is returned verbatim (visible, not swallowed)', () => {
  assert.equal(formatDateTime('not-a-date'), 'not-a-date')
})

// ---------------------------------------------------------------------------
// Owner item 11 — per-app timezone
// ---------------------------------------------------------------------------

test('formatDateTime: renders a fixed instant in a given IANA timezone', () => {
  // 2026-06-15T12:00:00Z — a fixed UTC instant so the expected wall-times
  // below are deterministic regardless of the CI runner's own local tz.
  const instant = Date.UTC(2026, 5, 15, 12, 0, 0)
  assert.equal(formatDateTime(instant, 'UTC'), '2026-06-15 12:00:00')
  // Buenos Aires is UTC-3 (no DST) — always 3h behind.
  assert.equal(
    formatDateTime(instant, 'America/Argentina/Buenos_Aires'),
    '2026-06-15 09:00:00',
  )
  // Tokyo is UTC+9 (no DST).
  assert.equal(formatDateTime(instant, 'Asia/Tokyo'), '2026-06-15 21:00:00')
})

test('formatDateTime: an empty/omitted timezone keeps the pre-existing local-time behaviour', () => {
  const d = new Date(2026, 0, 5, 9, 7, 3)
  assert.equal(formatDateTime(d), formatDateTime(d, ''))
  assert.equal(formatDateTime(d), formatDateTime(d, undefined))
  assert.equal(formatDateTime(d), formatDateTime(d, null))
})

test('formatDateTime: an unrecognized timezone degrades to local time (never throws)', () => {
  const d = new Date(2026, 0, 5, 9, 7, 3)
  assert.equal(formatDateTime(d, 'Not/AZone'), formatDateTime(d))
})

test('formatDateTime: missing/empty input still short-circuits to em dash even with a timezone', () => {
  assert.equal(formatDateTime(undefined, 'UTC'), '—')
  assert.equal(formatDateTime('', 'America/Argentina/Buenos_Aires'), '—')
})

test('listTimezones: returns a non-empty, sorted, de-duplicated list containing UTC', () => {
  const zones = listTimezones()
  assert.ok(zones.length > 0)
  assert.ok(zones.includes('UTC'))
  assert.equal(new Set(zones).size, zones.length)
  assert.deepEqual(zones, [...zones].sort())
})

test('isValidTimezone: empty string is always valid (server default)', () => {
  assert.equal(isValidTimezone(''), true)
})

test('isValidTimezone: accepts real IANA zones, rejects garbage', () => {
  assert.equal(isValidTimezone('UTC'), true)
  assert.equal(isValidTimezone('America/Argentina/Buenos_Aires'), true)
  assert.equal(isValidTimezone('Asia/Tokyo'), true)
  assert.equal(isValidTimezone('Not/AZone'), false)
  assert.equal(isValidTimezone('literally anything'), false)
})
