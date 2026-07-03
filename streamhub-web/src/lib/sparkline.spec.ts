/**
 * Unit specs for the hand-rolled sparkline math (pure).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushCapped, sparklineGeometry } from './sparkline.ts'

test('pushCapped: appends and keeps only the last N', () => {
  assert.deepEqual(pushCapped([], 1, 3), [1])
  assert.deepEqual(pushCapped([1, 2], 3, 3), [1, 2, 3])
  assert.deepEqual(pushCapped([1, 2, 3], 4, 3), [2, 3, 4])
  assert.deepEqual(pushCapped([1, 2, 3, 4, 5], 6, 3), [4, 5, 6])
})

test('sparklineGeometry: empty series → empty geometry', () => {
  const g = sparklineGeometry([], { width: 100, height: 20 })
  assert.equal(g.points, '')
  assert.deepEqual(g.coords, [])
})

test('sparklineGeometry: single point sits centred horizontally', () => {
  const g = sparklineGeometry([5], { width: 100, height: 20, padding: 0 })
  assert.equal(g.coords.length, 1)
  assert.equal(g.coords[0][0], 50) // innerW/2
})

test('sparklineGeometry: flat series pins to the vertical middle', () => {
  const g = sparklineGeometry([7, 7, 7], { width: 100, height: 20, padding: 0 })
  assert.equal(g.min, 7)
  assert.equal(g.max, 7)
  for (const [, y] of g.coords) assert.equal(y, 10) // height/2
})

test('sparklineGeometry: min maps to the bottom, max to the top (inverted y)', () => {
  const g = sparklineGeometry([0, 10], { width: 100, height: 20, padding: 0 })
  assert.deepEqual(g.coords[0], [0, 20]) // min → bottom
  assert.deepEqual(g.coords[1], [100, 0]) // max → top
  assert.equal(g.points, '0,20 100,0')
})

test('sparklineGeometry: evenly distributes x across the width', () => {
  const g = sparklineGeometry([1, 2, 3], { width: 100, height: 10, padding: 0 })
  assert.equal(g.coords[0][0], 0)
  assert.equal(g.coords[1][0], 50)
  assert.equal(g.coords[2][0], 100)
})

test('sparklineGeometry: respects padding on both axes', () => {
  const g = sparklineGeometry([0, 10], { width: 100, height: 20, padding: 2 })
  // x spans [padding, width-padding]; y spans [padding, height-padding].
  assert.deepEqual(g.coords[0], [2, 18])
  assert.deepEqual(g.coords[1], [98, 2])
})

test('sparklineGeometry: ignores non-finite samples', () => {
  const g = sparklineGeometry([NaN, 0, 10, Infinity], { width: 100, height: 20, padding: 0 })
  assert.equal(g.coords.length, 2)
})
