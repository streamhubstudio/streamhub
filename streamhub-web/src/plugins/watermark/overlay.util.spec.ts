/**
 * Unit specs for the Watermark overlay helpers (pure).
 * Run with Node's built-in runner (see package.json "test").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_OPACITY,
  DEFAULT_POSITION,
  DEFAULT_TEXT,
  MAX_TEXT_LEN,
  clampOpacity,
  positionClasses,
  resolvePosition,
  resolveSettings,
  resolveText,
} from './overlay.util.ts'

test('resolveText: trims, falls back to the brand default when empty/non-string', () => {
  assert.equal(resolveText('ACME TV'), 'ACME TV')
  assert.equal(resolveText('  padded  '), 'padded')
  assert.equal(resolveText(''), DEFAULT_TEXT)
  assert.equal(resolveText('   '), DEFAULT_TEXT)
  assert.equal(resolveText(undefined), DEFAULT_TEXT)
  assert.equal(resolveText(42), DEFAULT_TEXT)
})

test('resolveText: caps runaway length', () => {
  const long = 'x'.repeat(500)
  assert.equal(resolveText(long).length, MAX_TEXT_LEN)
})

test('resolvePosition: narrows to a known corner, else default', () => {
  assert.equal(resolvePosition('top-left'), 'top-left')
  assert.equal(resolvePosition('bottom-right'), 'bottom-right')
  assert.equal(resolvePosition('middle'), DEFAULT_POSITION)
  assert.equal(resolvePosition(42), DEFAULT_POSITION)
  assert.equal(resolvePosition(undefined), DEFAULT_POSITION)
})

test('clampOpacity: coerces numbers/strings and clamps to [0,1]', () => {
  assert.equal(clampOpacity(0.3), 0.3)
  assert.equal(clampOpacity('0.8'), 0.8)
  assert.equal(clampOpacity(-1), 0)
  assert.equal(clampOpacity(5), 1)
  assert.equal(clampOpacity('nope'), DEFAULT_OPACITY)
  assert.equal(clampOpacity(''), DEFAULT_OPACITY)
  assert.equal(clampOpacity(undefined), DEFAULT_OPACITY)
  assert.equal(clampOpacity(NaN), DEFAULT_OPACITY)
})

test('positionClasses: each corner maps to Tailwind anchors', () => {
  assert.equal(positionClasses('top-left'), 'top-0 left-0')
  assert.equal(positionClasses('top-right'), 'top-0 right-0')
  assert.equal(positionClasses('bottom-left'), 'bottom-0 left-0')
  assert.equal(positionClasses('bottom-right'), 'bottom-0 right-0')
})

test('resolveSettings: folds a raw config bag into safe defaults', () => {
  assert.deepEqual(resolveSettings({}), {
    text: DEFAULT_TEXT,
    position: DEFAULT_POSITION,
    opacity: DEFAULT_OPACITY,
  })
  assert.deepEqual(
    resolveSettings({ text: 'Live', position: 'top-left', opacity: 0.25 }),
    { text: 'Live', position: 'top-left', opacity: 0.25 },
  )
  // Hostile values are sanitised, not trusted.
  assert.deepEqual(
    resolveSettings({ text: '  ', position: 'nope', opacity: 99 }),
    { text: DEFAULT_TEXT, position: DEFAULT_POSITION, opacity: 1 },
  )
})
