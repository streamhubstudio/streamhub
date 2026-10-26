/**
 * Unit specs for the Backups panel helpers (pure).
 * Run with Node's built-in runner: `npm run test` → `node --test src/**\/*.spec.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampSnapshotPage,
  restoreConfirmed,
  snapshotAgeDays,
  snapshotPageCount,
  snapshotsOnPage,
  sortDatabases,
  totalSnapshotBytes,
} from './backups.ts'

const DAY = 86_400_000

test('snapshotAgeDays: whole days relative to now, 0 for today/future, null for garbage', () => {
  const now = Date.parse('2026-07-06T12:00:00.000Z')
  assert.equal(snapshotAgeDays('2026-07-06T09:00:00.000Z', now), 0)
  assert.equal(snapshotAgeDays(new Date(now - 3 * DAY).toISOString(), now), 3)
  assert.equal(snapshotAgeDays(new Date(now - 6.9 * DAY).toISOString(), now), 6)
  // a clock-skewed "future" snapshot never renders a negative age
  assert.equal(snapshotAgeDays(new Date(now + DAY).toISOString(), now), 0)
  assert.equal(snapshotAgeDays('not-a-date', now), null)
})

test('totalSnapshotBytes sums sizes and ignores invalid entries', () => {
  assert.equal(totalSnapshotBytes([]), 0)
  assert.equal(
    totalSnapshotBytes([
      { createdAt: '', sizeBytes: 100 },
      { createdAt: '', sizeBytes: 250 },
      { createdAt: '', sizeBytes: Number.NaN },
      { createdAt: '', sizeBytes: -5 },
    ]),
    350,
  )
})

test('restoreConfirmed: the typed phrase gates the destructive button', () => {
  assert.equal(restoreConfirmed('RESTORE', 'RESTORE'), true)
  assert.equal(restoreConfirmed('  restore  ', 'RESTORE'), true) // trim + case-insensitive
  assert.equal(restoreConfirmed('restor', 'RESTORE'), false)
  assert.equal(restoreConfirmed('', 'RESTORE'), false)
  // non-empty phrase is required for the gate to ever pass
  assert.equal(restoreConfirmed('x', 'X'), true)
})

test('sortDatabases: global registry first, apps A-Z, orphaned dirs last', () => {
  const sorted = sortDatabases([
    { db: 'app-zulu', kind: 'app' as const },
    { db: 'app-old', kind: 'app' as const, orphaned: true },
    { db: 'streamhub', kind: 'global' as const },
    { db: 'app-alpha', kind: 'app' as const },
  ])
  assert.deepEqual(
    sorted.map((d) => d.db),
    ['streamhub', 'app-alpha', 'app-zulu', 'app-old'],
  )
  // input untouched (returns a copy)
  assert.equal(sorted === sortDatabases(sorted), false)
})

test('snapshotPageCount: ceil(total/pageSize), minimum 1', () => {
  assert.equal(snapshotPageCount(0, 10), 1)
  assert.equal(snapshotPageCount(1, 10), 1)
  assert.equal(snapshotPageCount(10, 10), 1)
  assert.equal(snapshotPageCount(11, 10), 2)
  assert.equal(snapshotPageCount(25, 10), 3)
  assert.equal(snapshotPageCount(5, 0), 1) // degenerate pageSize never divides by zero
})

test('clampSnapshotPage: clamps into [1, pageCount], tolerates garbage input', () => {
  assert.equal(clampSnapshotPage(1, 25, 10), 1)
  assert.equal(clampSnapshotPage(3, 25, 10), 3)
  assert.equal(clampSnapshotPage(9, 25, 10), 3) // stale page after the list shrank
  assert.equal(clampSnapshotPage(0, 25, 10), 1)
  assert.equal(clampSnapshotPage(-4, 25, 10), 1)
  assert.equal(clampSnapshotPage(Number.NaN, 25, 10), 1)
  assert.equal(clampSnapshotPage(2.9, 25, 10), 2) // floors, never rounds up
})

test('snapshotsOnPage: 1-based slice, clamped, pairs with <Pagination>', () => {
  const items = Array.from({ length: 25 }, (_, i) => i) // [0..24]
  assert.deepEqual(snapshotsOnPage(items, 1, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(snapshotsOnPage(items, 2, 10), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  assert.deepEqual(snapshotsOnPage(items, 3, 10), [20, 21, 22, 23, 24])
  // a stale/out-of-range page clamps to the last page instead of going empty
  assert.deepEqual(snapshotsOnPage(items, 99, 10), [20, 21, 22, 23, 24])
  assert.deepEqual(snapshotsOnPage([], 1, 10), [])
})
