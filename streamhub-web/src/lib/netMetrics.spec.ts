/**
 * Unit specs for the dashboard net-metrics helpers (pure).
 * Run with Node's built-in runner: `npm run test` → `node --test src/lib/*.spec.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addWindows,
  aggregateSummaries,
  bucketTotals,
  mergeHistoryBuckets,
  sparklinePoints,
} from './netMetrics.ts'

const w = (i: number, o: number) => ({ in: i, out: o, total: i + o })

test('addWindows sums each field', () => {
  assert.deepEqual(addWindows(w(1, 2), w(10, 20)), { in: 11, out: 22, total: 33 })
})

test('aggregateSummaries folds windows and counts breaches', () => {
  const mk = (i: number, o: number, exceeded: boolean) => ({
    today: w(i, o),
    last24h: w(i, o),
    last7d: w(i, o),
    bySource: [],
    threshold: {
      gbPerDay: exceeded ? 1 : 0,
      thresholdBytes: 0,
      usage24hBytes: 0,
      percent: null,
      exceeded,
    },
  })
  const agg = aggregateSummaries([mk(1, 2, true), mk(3, 4, false), mk(5, 6, true)])
  assert.deepEqual(agg.today, { in: 9, out: 12, total: 21 })
  assert.deepEqual(agg.last7d, { in: 9, out: 12, total: 21 })
  assert.equal(agg.exceededCount, 2)
})

test('aggregateSummaries of an empty list is all-zero', () => {
  const agg = aggregateSummaries([])
  assert.deepEqual(agg.today, { in: 0, out: 0, total: 0 })
  assert.equal(agg.exceededCount, 0)
})

test('mergeHistoryBuckets sums per bucket and sorts ascending', () => {
  const merged = mergeHistoryBuckets([
    [
      { bucket: '2026-07-11T13', in: 5, out: 1 },
      { bucket: '2026-07-11T12', in: 2, out: 2 },
    ],
    [{ bucket: '2026-07-11T13', in: 10, out: 0 }],
  ])
  assert.deepEqual(merged, [
    { bucket: '2026-07-11T12', in: 2, out: 2 },
    { bucket: '2026-07-11T13', in: 15, out: 1 },
  ])
})

test('bucketTotals adds in+out per bucket', () => {
  assert.deepEqual(
    bucketTotals([
      { bucket: 'a', in: 1, out: 2 },
      { bucket: 'b', in: 3, out: 0 },
    ]),
    [3, 3],
  )
})

test('sparklinePoints maps values into the box, y inverted', () => {
  // max=10; first point at baseline (height), last at top (0).
  assert.equal(sparklinePoints([0, 5, 10], 100, 20), '0,20 50,10 100,0')
})

test('sparklinePoints returns empty for < 2 points or a zero box', () => {
  assert.equal(sparklinePoints([], 100, 20), '')
  assert.equal(sparklinePoints([5], 100, 20), '')
  assert.equal(sparklinePoints([1, 2], 0, 20), '')
})

test('sparklinePoints puts a flat series on the baseline', () => {
  assert.equal(sparklinePoints([0, 0, 0], 100, 20), '0,20 50,20 100,20')
})
