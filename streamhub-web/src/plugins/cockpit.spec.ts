/**
 * Unit specs for the Cockpit plugin's PURE grid/paging/ordering/settings logic.
 *
 * Lives at src/plugins/cockpit.spec.ts (not under cockpit/) so the existing
 * `node --test "src/plugins/*.spec.ts"` runner picks it up with no central edit.
 * Only imports the pure module (grid.ts) — no React/DOM.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GRID,
  DEFAULT_SETTINGS,
  GRID_LAYOUTS,
  applyOrder,
  clampPage,
  clampRefresh,
  getLayout,
  moveOrder,
  normalizeSettings,
  pageCount,
  pageItems,
  reconcileOrder,
} from './cockpit/grid.ts'

// --- layouts ---------------------------------------------------------------

test('getLayout: known ids resolve; unknown falls back to default', () => {
  assert.equal(getLayout('2x2').cells, 4)
  assert.equal(getLayout('3x3').cells, 9)
  assert.equal(getLayout('4x3').cells, 12)
  assert.equal(getLayout('4x3').cols, 4)
  assert.equal(getLayout('bogus').id, DEFAULT_GRID)
  assert.equal(getLayout(undefined).id, DEFAULT_GRID)
})

test('GRID_LAYOUTS: cells always equal cols*rows', () => {
  for (const l of GRID_LAYOUTS) assert.equal(l.cells, l.cols * l.rows)
})

// --- pagination ------------------------------------------------------------

test('pageCount: at least one page, ceil division', () => {
  assert.equal(pageCount(0, 4), 1)
  assert.equal(pageCount(4, 4), 1)
  assert.equal(pageCount(5, 4), 2)
  assert.equal(pageCount(13, 12), 2)
  assert.equal(pageCount(10, 0), 1) // guard against perPage 0
})

test('clampPage: clamps into [0, pageCount-1]', () => {
  assert.equal(clampPage(-3, 20, 4), 0)
  assert.equal(clampPage(99, 20, 4), 4) // 20/4 = 5 pages -> last index 4
  assert.equal(clampPage(2, 20, 4), 2)
  assert.equal(clampPage(1.9, 20, 4), 1)
})

test('pageItems: returns the clamped page slice', () => {
  const items = Array.from({ length: 13 }, (_, i) => i)
  assert.deepEqual(pageItems(items, 0, 12), items.slice(0, 12))
  assert.deepEqual(pageItems(items, 1, 12), [12])
  // out-of-range page is clamped to the last page, not empty
  assert.deepEqual(pageItems(items, 9, 12), [12])
  assert.deepEqual(pageItems(items, 0, 0), [])
})

// --- ordering --------------------------------------------------------------

test('reconcileOrder: keeps saved order, drops gone, appends new last', () => {
  assert.deepEqual(reconcileOrder(['b', 'a'], ['a', 'b', 'c']), ['b', 'a', 'c'])
  assert.deepEqual(reconcileOrder(['a', 'x'], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(reconcileOrder([], ['a', 'b']), ['a', 'b'])
})

test('reconcileOrder: idempotent + de-dupes saved', () => {
  const once = reconcileOrder(['a', 'a', 'b'], ['a', 'b', 'c'])
  assert.deepEqual(once, ['a', 'b', 'c'])
  assert.deepEqual(reconcileOrder(once, ['a', 'b', 'c']), once)
})

test('applyOrder: sorts by order; unknown keys go last in original order', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  const out = applyOrder(items, ['c', 'a'], (x) => x.id)
  assert.deepEqual(out.map((x) => x.id), ['c', 'a', 'b', 'd'])
})

test('moveOrder: repositions active at over; no-ops are safe copies', () => {
  const order = ['a', 'b', 'c', 'd']
  assert.deepEqual(moveOrder(order, 'a', 'c'), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveOrder(order, 'd', 'a'), ['d', 'a', 'b', 'c'])
  assert.deepEqual(moveOrder(order, 'a', 'a'), order)
  assert.notEqual(moveOrder(order, 'a', 'a'), order) // returns a NEW array
  assert.deepEqual(moveOrder(order, 'a', 'zzz'), order) // missing over → unchanged
})

// --- settings --------------------------------------------------------------

test('clampRefresh: clamps into [3, 300]', () => {
  assert.equal(clampRefresh(1), 3)
  assert.equal(clampRefresh(9999), 300)
  assert.equal(clampRefresh(10), 10)
  assert.equal(clampRefresh(Number.NaN), DEFAULT_SETTINGS.refreshSeconds)
})

test('normalizeSettings: coerces + validates against base defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(
    normalizeSettings({
      gridSize: '2x2',
      autoPlay: 'false',
      showLabels: false,
      refreshSeconds: '600',
    }),
    { gridSize: '2x2', autoPlay: false, showLabels: false, refreshSeconds: 300 },
  )
  // invalid gridSize falls back to base
  assert.equal(normalizeSettings({ gridSize: 'nope' }).gridSize, DEFAULT_GRID)
})

test('normalizeSettings: base overrides the built-in defaults', () => {
  const base = { gridSize: '3x3', autoPlay: false, showLabels: false, refreshSeconds: 30 }
  const out = normalizeSettings({}, base)
  assert.deepEqual(out, base)
})
