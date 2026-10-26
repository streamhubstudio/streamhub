/**
 * Unit specs for the OS-tuning pure helpers.
 * Run with: `npm test` → node --test over src/lib/*.spec.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTuningSummary, tuningStatusTone } from './osTuning.ts'
import type { OsTuningKnob } from '../api/types.ts'

function knob(id: string, status: OsTuningKnob['status']): OsTuningKnob {
  return {
    id,
    label: id,
    source: 'sysctl',
    key: id,
    current: '1',
    recommended: '1',
    status,
    why: 'why',
    remedy: 'sysctl -w',
    optional: false,
  }
}

test('tuningStatusTone: applied→green, not-applied→amber, unknown→slate', () => {
  assert.equal(tuningStatusTone('applied'), 'green')
  assert.equal(tuningStatusTone('not-applied'), 'amber')
  assert.equal(tuningStatusTone('unknown'), 'slate')
})

test('tuningStatusTone: unexpected/undefined value degrades to slate', () => {
  assert.equal(tuningStatusTone('bogus'), 'slate')
  assert.equal(tuningStatusTone(undefined), 'slate')
})

test('computeTuningSummary: counts each status bucket', () => {
  const knobs: OsTuningKnob[] = [
    knob('a', 'applied'),
    knob('b', 'applied'),
    knob('c', 'not-applied'),
    knob('d', 'unknown'),
  ]
  assert.deepEqual(computeTuningSummary(knobs), {
    applied: 2,
    notApplied: 1,
    unknown: 1,
  })
})

test('computeTuningSummary: empty / undefined → all zeros', () => {
  assert.deepEqual(computeTuningSummary([]), { applied: 0, notApplied: 0, unknown: 0 })
  assert.deepEqual(computeTuningSummary(undefined), {
    applied: 0,
    notApplied: 0,
    unknown: 0,
  })
})

test('computeTuningSummary: unrecognised status folds into unknown', () => {
  const weird = [knob('x', 'weird' as OsTuningKnob['status'])]
  assert.deepEqual(computeTuningSummary(weird), {
    applied: 0,
    notApplied: 0,
    unknown: 1,
  })
})
