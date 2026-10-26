/**
 * Unit specs for onboarding-state persistence over raw config.yaml (pure).
 * The block round-trips through js-yaml on the core side, so the reader must
 * tolerate quoting and the writer must leave the rest of the file untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readOnboarding,
  upsertOnboardingBlock,
  isOnboardingResolved,
  type OnboardingState,
} from './onboarding.ts'

const SAMPLE = `name: live
display_name: Live
room_prefix: live
recording:
  enabled: false
features:
  chat: true
`

test('readOnboarding: absent block → null', () => {
  assert.equal(readOnboarding(SAMPLE), null)
  assert.equal(readOnboarding(''), null)
})

test('readOnboarding: parses a completed block', () => {
  const yaml = `${SAMPLE}onboarding:\n  status: completed\n  purpose: surveillance\n  completed_at: "2026-07-13T00:00:00.000Z"\n`
  assert.deepEqual(readOnboarding(yaml), {
    status: 'completed',
    purpose: 'surveillance',
    completedAt: '2026-07-13T00:00:00.000Z',
  })
})

test('readOnboarding: tolerates single/double quotes and re-dumped forms', () => {
  const yaml = `onboarding:\n  status: 'dismissed'\n  purpose: "radio"\n`
  assert.deepEqual(readOnboarding(yaml), {
    status: 'dismissed',
    purpose: 'radio',
    completedAt: undefined,
  })
})

test('readOnboarding: unknown status coerces to pending; unknown purpose dropped', () => {
  const yaml = `onboarding:\n  status: wat\n  purpose: bogus\n`
  assert.deepEqual(readOnboarding(yaml), {
    status: 'pending',
    purpose: undefined,
    completedAt: undefined,
  })
})

test('readOnboarding: a block with no status → null (safe re-offer)', () => {
  assert.equal(readOnboarding('onboarding:\n  purpose: radio\n'), null)
})

test('upsertOnboardingBlock: appends when absent, preserving the file', () => {
  const state: OnboardingState = { status: 'completed', purpose: 'general' }
  const out = upsertOnboardingBlock(SAMPLE, state)
  assert.ok(out.startsWith(SAMPLE.replace(/\s*$/, '')))
  assert.match(out, /\nonboarding:\n {2}status: completed\n {2}purpose: general\n$/)
  assert.deepEqual(readOnboarding(out), {
    status: 'completed',
    purpose: 'general',
    completedAt: undefined,
  })
})

test('upsertOnboardingBlock: replaces an existing block in place', () => {
  const first = upsertOnboardingBlock(SAMPLE, { status: 'dismissed', purpose: 'radio' })
  const second = upsertOnboardingBlock(first, {
    status: 'completed',
    purpose: 'surveillance',
    completedAt: '2026-07-13T01:02:03.000Z',
  })
  // Only one onboarding block, and the other keys survived untouched.
  assert.equal(second.match(/^onboarding:/gm)?.length, 1)
  assert.match(second, /^name: live$/m)
  assert.match(second, /^features:$/m)
  assert.deepEqual(readOnboarding(second), {
    status: 'completed',
    purpose: 'surveillance',
    completedAt: '2026-07-13T01:02:03.000Z',
  })
})

test('upsertOnboardingBlock: replacing does not eat the following top-level key', () => {
  const yaml = `onboarding:\n  status: pending\ntrailing_key: kept\n`
  const out = upsertOnboardingBlock(yaml, { status: 'completed' })
  assert.match(out, /^trailing_key: kept$/m)
  assert.equal(readOnboarding(out)?.status, 'completed')
})

test('isOnboardingResolved: completed/dismissed resolved; pending/null not', () => {
  assert.equal(isOnboardingResolved({ status: 'completed' }), true)
  assert.equal(isOnboardingResolved({ status: 'dismissed' }), true)
  assert.equal(isOnboardingResolved({ status: 'pending' }), false)
  assert.equal(isOnboardingResolved(null), false)
})
