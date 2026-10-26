/**
 * Unit specs for the onboarding step graph + plan builder (pure).
 * Locks the per-purpose flow and the answer → API-action mapping so the wizard
 * UI stays a dumb shell over this logic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stepsForPurpose,
  buildPlan,
  kebab,
  adaptiveForViewers,
  PURPOSE_META,
  ALL_PURPOSES,
  type PlanAction,
} from './onboardingPlan.ts'

test('stepsForPurpose: no purpose yet → only the purpose step', () => {
  assert.deepEqual(stepsForPurpose(undefined), ['purpose'])
})

test('stepsForPurpose: surveillance shows vision + tags, no extras', () => {
  assert.deepEqual(stepsForPurpose('surveillance'), [
    'purpose',
    'recording',
    'viewers',
    'vision',
    'tags',
    'summary',
  ])
})

test('stepsForPurpose: radio skips viewers/vision, has extras', () => {
  assert.deepEqual(stepsForPurpose('radio'), [
    'purpose',
    'recording',
    'extras',
    'summary',
  ])
})

test('stepsForPurpose: meetings — no viewers, no vision, extras', () => {
  assert.deepEqual(stepsForPurpose('meetings'), [
    'purpose',
    'recording',
    'extras',
    'summary',
  ])
})

test('stepsForPurpose: general — viewers only unless vision opt-in', () => {
  assert.deepEqual(stepsForPurpose('general'), [
    'purpose',
    'recording',
    'viewers',
    'summary',
  ])
  assert.deepEqual(stepsForPurpose('general', { visionOptIn: true }), [
    'purpose',
    'recording',
    'viewers',
    'vision',
    'tags',
    'summary',
  ])
})

test('every purpose has a summary as the last step and a valid recipe slug', () => {
  for (const p of ALL_PURPOSES) {
    const steps = stepsForPurpose(p, { visionOptIn: true })
    assert.equal(steps[0], 'purpose')
    assert.equal(steps.at(-1), 'summary')
    // Slug of a REAL published post, or '' = fall back to the blog index.
    assert.match(PURPOSE_META[p].recipe, /^[a-z0-9-]*$/)
  }
})

test('kebab: slugifies labels to the core tag regex', () => {
  assert.equal(kebab('Downtown Store'), 'downtown-store')
  assert.equal(kebab('  Cámara Entrada!!  '), 'camara-entrada')
  assert.equal(kebab('a__b--c'), 'a-b-c')
  assert.equal(kebab('***'), '')
})

test('adaptiveForViewers: small → off, medium/large → on', () => {
  assert.equal(adaptiveForViewers('small'), false)
  assert.equal(adaptiveForViewers('medium'), true)
  assert.equal(adaptiveForViewers('large'), true)
})

test('buildPlan: empty answers → empty plan', () => {
  assert.deepEqual(buildPlan({}), [])
})

test('buildPlan: surveillance full run maps every answer', () => {
  const plan = buildPlan({
    purpose: 'surveillance',
    recording: true,
    viewers: 'large',
    visionModels: ['occupancy', 'lpr', 'occupancy'], // dup ignored
    tags: ['Downtown Store', 'downtown store', ' '], // dup + blank ignored
  })
  assert.deepEqual(plan, [
    { type: 'config.recording', enabled: true },
    { type: 'config.adaptive', enabled: true },
    { type: 'plugin.install', id: 'occupancy' },
    { type: 'plugin.install', id: 'lpr' },
    { type: 'tag.create', slug: 'downtown-store', label: 'Downtown Store' },
  ])
})

test('buildPlan: small audience turns adaptive OFF', () => {
  const plan = buildPlan({ purpose: 'general', viewers: 'small' })
  assert.deepEqual(plan, [{ type: 'config.adaptive', enabled: false }])
})

test('buildPlan: vision models ignored when the vision step is not shown', () => {
  // general without opt-in never surfaces vision — selections cannot leak in.
  const plan = buildPlan({ purpose: 'general', visionModels: ['crowd'], tags: ['x'] })
  assert.deepEqual(plan, [])
})

test('buildPlan: general with vision opt-in installs the models', () => {
  const plan = buildPlan({
    purpose: 'general',
    visionOptIn: true,
    visionModels: ['crowd'],
  })
  assert.deepEqual(plan, [{ type: 'plugin.install', id: 'crowd' }])
})

test('buildPlan: radio → radio plugin + passthrough ingress', () => {
  const plan = buildPlan({ purpose: 'radio', recording: false })
  assert.deepEqual(plan, [
    { type: 'config.recording', enabled: false },
    { type: 'plugin.install', id: 'radio' },
    { type: 'ingress.passthrough' },
  ])
})

test('buildPlan: events → chat/reactions/viewer-counter features + quality plugin', () => {
  const plan = buildPlan({ purpose: 'events', viewers: 'medium' })
  const features = plan.find((a): a is Extract<PlanAction, { type: 'features' }> =>
    a.type === 'features',
  )
  assert.deepEqual(features?.features, {
    chat: true,
    reactions: true,
    viewerCounter: true,
  })
  assert.ok(plan.some((a) => a.type === 'plugin.install' && a.id === 'quality'))
})

test('buildPlan: live-shopping → reactions + viewer-counter features', () => {
  const plan = buildPlan({ purpose: 'live-shopping', viewers: 'large' })
  const features = plan.find((a): a is Extract<PlanAction, { type: 'features' }> =>
    a.type === 'features',
  )
  assert.deepEqual(features?.features, { reactions: true, viewerCounter: true })
})
