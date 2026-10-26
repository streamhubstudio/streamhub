/**
 * Unit specs for the player quality/speaker helpers (pure).
 * Run with Node's built-in runner (see package.json "test").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isDegradedQuality,
  normalizeQuality,
  speakingRingClass,
} from './playerQuality.ts'

test('normalizeQuality folds enum strings and garbage to known names', () => {
  assert.equal(normalizeQuality('excellent'), 'excellent')
  assert.equal(normalizeQuality('good'), 'good')
  assert.equal(normalizeQuality('poor'), 'poor')
  assert.equal(normalizeQuality('lost'), 'lost')
  assert.equal(normalizeQuality('POOR'), 'poor') // case-insensitive
  assert.equal(normalizeQuality('meh'), 'unknown')
  assert.equal(normalizeQuality(undefined), 'unknown')
  assert.equal(normalizeQuality(42), 'unknown')
  assert.equal(normalizeQuality(null), 'unknown')
})

test('isDegradedQuality: only poor/lost trigger the banner', () => {
  assert.equal(isDegradedQuality('poor'), true)
  assert.equal(isDegradedQuality('lost'), true)
  assert.equal(isDegradedQuality('good'), false)
  assert.equal(isDegradedQuality('excellent'), false)
  // Pre-first-report state must never flash a warning.
  assert.equal(isDegradedQuality('unknown'), false)
  assert.equal(isDegradedQuality(undefined), false)
})

test('speakingRingClass swaps the accent ring on speaking', () => {
  assert.match(speakingRingClass(true), /ring-2/)
  assert.match(speakingRingClass(true), /primary/)
  assert.match(speakingRingClass(false), /ring-1/)
  assert.doesNotMatch(speakingRingClass(false), /primary/)
})
