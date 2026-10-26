/**
 * Unit specs for the Live Control Overlay helpers (pure).
 * Run with Node's built-in runner (see package.json "test").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  coverVisible,
  fitClass,
  isLiveControlPush,
  parsePublicState,
  resolveSettings,
} from './overlay.util.ts'

test('resolveSettings applies defaults', () => {
  assert.deepEqual(resolveSettings(undefined), { fit: 'cover', showFinishedBadge: true })
  assert.deepEqual(resolveSettings({ fit: 'contain', showFinishedBadge: false }), {
    fit: 'contain',
    showFinishedBadge: false,
  })
})

test('coverVisible only for paused/finished', () => {
  assert.equal(coverVisible('live'), false)
  assert.equal(coverVisible('paused'), true)
  assert.equal(coverVisible('finished'), true)
  assert.equal(coverVisible(undefined), false)
})

test('fitClass maps to object-fit utilities', () => {
  assert.equal(fitClass('cover'), 'object-cover')
  assert.equal(fitClass('contain'), 'object-contain')
})

test('parsePublicState narrows a paused image cover', () => {
  const s = parsePublicState({
    streamId: 's1',
    room: 'r1',
    state: 'paused',
    since: 't',
    cover: { mode: 'image', assetId: 4, cardColor: '#000', assetUrl: 'https://x/a.png' },
  })
  assert.equal(s?.state, 'paused')
  assert.equal(s?.cover?.mode, 'image')
  assert.equal(s?.cover?.assetUrl, 'https://x/a.png')
})

test('parsePublicState drops the cover when live', () => {
  const s = parsePublicState({ streamId: 's1', state: 'live', cover: { mode: 'text' } })
  assert.equal(s?.state, 'live')
  assert.equal(s?.cover, null)
})

test('parsePublicState rejects junk', () => {
  assert.equal(parsePublicState(null), null)
  assert.equal(parsePublicState(42), null)
})

test('isLiveControlPush recognises the state push', () => {
  assert.equal(isLiveControlPush(JSON.stringify({ type: 'live-control', state: 'paused' })), true)
  assert.equal(isLiveControlPush(new TextEncoder().encode(JSON.stringify({ type: 'live-control' }))), true)
  assert.equal(isLiveControlPush(JSON.stringify({ type: 'other' })), false)
  assert.equal(isLiveControlPush('not json'), false)
})
