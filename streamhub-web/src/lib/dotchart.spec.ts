/**
 * Unit specs for the hand-rolled dot-chart math (pure).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dotChartGeometry, niceCeil, type DotPoint } from './dotchart.ts'

test('niceCeil rounds up to 1/2/5 × 10ⁿ', () => {
  assert.equal(niceCeil(0), 1)
  assert.equal(niceCeil(-5), 1)
  assert.equal(niceCeil(0.7), 1)
  assert.equal(niceCeil(1), 1)
  assert.equal(niceCeil(1.5), 2)
  assert.equal(niceCeil(4), 5)
  assert.equal(niceCeil(6), 10)
  assert.equal(niceCeil(42), 50)
  assert.equal(niceCeil(1200), 2000)
})

test('empty series → no dots, sane defaults', () => {
  const g = dotChartGeometry([], { width: 100, height: 50, yMax: 100 })
  assert.deepEqual(g.dots, [])
  assert.equal(g.yMax, 100)
  assert.equal(g.yMin, 0)
})

test('drops null / non-finite values (gaps, not fake zeros)', () => {
  const points: DotPoint[] = [
    { ts: 0, value: null },
    { ts: 1, value: 10 },
    { ts: 2, value: Number.NaN },
    { ts: 3, value: 20 },
  ]
  const g = dotChartGeometry(points, {
    width: 100,
    height: 100,
    yMax: 100,
    domain: { start: 0, end: 3 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  })
  assert.equal(g.dots.length, 2)
  assert.deepEqual(
    g.dots.map((d) => d.value),
    [10, 20],
  )
})

test('maps a fixed % domain onto the box (y inverted)', () => {
  const points: DotPoint[] = [
    { ts: 0, value: 0 },
    { ts: 10, value: 100 },
  ]
  const g = dotChartGeometry(points, {
    width: 100,
    height: 100,
    yMax: 100,
    yMin: 0,
    domain: { start: 0, end: 10 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  })
  // value 0 → bottom (y=100), value 100 → top (y=0).
  assert.deepEqual(g.dots[0], { x: 0, y: 100, ts: 0, value: 0 })
  assert.deepEqual(g.dots[1], { x: 100, y: 0, ts: 10, value: 100 })
})

test('x is linear over the time domain', () => {
  const points: DotPoint[] = [
    { ts: 0, value: 50 },
    { ts: 5, value: 50 },
    { ts: 10, value: 50 },
  ]
  const g = dotChartGeometry(points, {
    width: 100,
    height: 20,
    yMax: 100,
    domain: { start: 0, end: 10 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  })
  assert.deepEqual(
    g.dots.map((d) => d.x),
    [0, 50, 100],
  )
})

test('derives a nice yMax when none is given (open-ended series)', () => {
  const points: DotPoint[] = [
    { ts: 0, value: 300 },
    { ts: 1, value: 700 },
  ]
  const g = dotChartGeometry(points, { width: 100, height: 100 })
  assert.equal(g.yMax, 1000) // niceCeil(700)
})

test('respects padding — dots sit inside the plot rect', () => {
  const points: DotPoint[] = [{ ts: 0, value: 100 }]
  const g = dotChartGeometry(points, {
    width: 120,
    height: 60,
    yMax: 100,
    domain: { start: 0, end: 10 },
    padding: { top: 10, right: 10, bottom: 10, left: 20 },
  })
  assert.deepEqual(g.plot, { x: 20, y: 10, width: 90, height: 40 })
  // single ts with a real domain maps to the left edge of the plot.
  assert.equal(g.dots[0].x, 20)
  assert.equal(g.dots[0].y, 10) // value==yMax → top of plot
})

test('single point with no domain centres horizontally', () => {
  const g = dotChartGeometry([{ ts: 42, value: 5 }], {
    width: 100,
    height: 100,
    yMax: 10,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  })
  assert.equal(g.dots[0].x, 50) // tSpan 0 → centred
})

test('computes evenly spaced y ticks (ascending)', () => {
  const g = dotChartGeometry([], { width: 100, height: 100, yMax: 100, yTickCount: 4 })
  assert.deepEqual(g.yTicks, [0, 25, 50, 75, 100])
})

test('segments: one contiguous run with no gaps → a single segment', () => {
  const points: DotPoint[] = [
    { ts: 0, value: 10 },
    { ts: 1, value: 20 },
    { ts: 2, value: 30 },
  ]
  const g = dotChartGeometry(points, { width: 100, height: 100, yMax: 100 })
  assert.equal(g.segments.length, 1)
  assert.equal(g.segments[0].length, 3)
  assert.deepEqual(
    g.segments[0].map((d) => d.value),
    [10, 20, 30],
  )
})

test('segments: a null/NaN gap splits the line into separate runs', () => {
  const points: DotPoint[] = [
    { ts: 0, value: 10 },
    { ts: 1, value: 20 },
    { ts: 2, value: null },
    { ts: 3, value: Number.NaN },
    { ts: 4, value: 40 },
    { ts: 5, value: 50 },
  ]
  const g = dotChartGeometry(points, {
    width: 100,
    height: 100,
    yMax: 100,
    domain: { start: 0, end: 5 },
  })
  assert.equal(g.segments.length, 2)
  assert.deepEqual(
    g.segments.map((seg) => seg.map((d) => d.value)),
    [[10, 20], [40, 50]],
  )
  // The flat `dots` list still has every clean point, gap or not.
  assert.equal(g.dots.length, 4)
})

test('segments: a lone point between gaps forms a 1-point run (no line drawn)', () => {
  const points: DotPoint[] = [
    { ts: 0, value: null },
    { ts: 1, value: 10 },
    { ts: 2, value: null },
  ]
  const g = dotChartGeometry(points, { width: 100, height: 100, yMax: 100 })
  assert.equal(g.segments.length, 1)
  assert.equal(g.segments[0].length, 1)
})

test('segments: all gaps → no segments', () => {
  const points: DotPoint[] = [
    { ts: 0, value: null },
    { ts: 1, value: null },
  ]
  const g = dotChartGeometry(points, { width: 100, height: 100, yMax: 100 })
  assert.deepEqual(g.segments, [])
})
