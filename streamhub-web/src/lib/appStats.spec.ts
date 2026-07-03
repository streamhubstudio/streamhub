/**
 * Unit specs for the app-stats reductions (pure).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countProblemEvents, reduceVodStatus } from './appStats.ts'

test('reduceVodStatus: null / undefined → all zeroes', () => {
  const empty = { ready: 0, failed: 0, recording: 0, uploading: 0, total: 0, pending: 0 }
  assert.deepEqual(reduceVodStatus(null), empty)
  assert.deepEqual(reduceVodStatus(undefined), empty)
  assert.deepEqual(reduceVodStatus({}), empty)
})

test('reduceVodStatus: sums the four known buckets', () => {
  const s = reduceVodStatus({ ready: 10, failed: 2, recording: 1, uploading: 3 })
  assert.equal(s.ready, 10)
  assert.equal(s.failed, 2)
  assert.equal(s.total, 16)
  assert.equal(s.pending, 4) // recording + uploading
})

test('reduceVodStatus: tolerates partial maps and non-finite values', () => {
  const s = reduceVodStatus({ ready: 5, failed: undefined, uploading: Number.NaN })
  assert.equal(s.ready, 5)
  assert.equal(s.failed, 0)
  assert.equal(s.uploading, 0)
  assert.equal(s.total, 5)
})

test('reduceVodStatus: counts unknown extra buckets in the total', () => {
  const s = reduceVodStatus({ ready: 1, aborted: 4 } as never)
  assert.equal(s.total, 5)
  assert.equal(s.pending, 0)
})

test('countProblemEvents: error + warn, tolerant of gaps', () => {
  assert.equal(countProblemEvents({ error: 3, warn: 2 }), 5)
  assert.equal(countProblemEvents({ error: 3 }), 3)
  assert.equal(countProblemEvents({}), 0)
  assert.equal(countProblemEvents(null), 0)
})
