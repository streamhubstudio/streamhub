/**
 * node:test — restream form helpers (platform presets + URL building).
 *
 * Locks the AddTarget form logic: destination URL preview per platform
 * (preset base + key, custom URL passthrough) and pre-submit validation.
 * Mirrors streamhub-core/src/modules/restream/restream.presets.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRestreamPreview,
  isRtmpUrl,
  RESTREAM_PRESETS,
  validateRestreamInput,
} from './restream.ts'

test('buildRestreamPreview: preset platforms append the key to their base', () => {
  assert.equal(
    buildRestreamPreview('youtube', 'abcd-efgh-ijkl', ''),
    'rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl',
  )
  assert.equal(
    buildRestreamPreview('twitch', 'live_123', ''),
    'rtmp://live.twitch.tv/app/live_123',
  )
  assert.equal(
    buildRestreamPreview('facebook', 'FB-1-XYZ', ''),
    'rtmps://live-api-s.facebook.com:443/rtmp/FB-1-XYZ',
  )
})

test('buildRestreamPreview: custom uses the pasted URL (key optional)', () => {
  assert.equal(
    buildRestreamPreview('custom', '', 'rtmp://ingest.example.com/live/k1'),
    'rtmp://ingest.example.com/live/k1',
  )
  // Key appended as last segment; trailing slashes never double up.
  assert.equal(
    buildRestreamPreview('custom', 'k9', 'rtmp://ingest.example.com/live//'),
    'rtmp://ingest.example.com/live/k9',
  )
})

test('buildRestreamPreview: null while the input is invalid', () => {
  assert.equal(buildRestreamPreview('youtube', '', ''), null)
  assert.equal(buildRestreamPreview('custom', '', 'https://nope'), null)
})

test('validateRestreamInput: presets need a clean key', () => {
  assert.equal(validateRestreamInput('youtube', '', ''), 'keyRequired')
  assert.equal(validateRestreamInput('youtube', 'a/b', ''), 'keyInvalid')
  assert.equal(validateRestreamInput('youtube', 'a b', ''), 'keyInvalid')
  assert.equal(validateRestreamInput('youtube', 'abcd-1234', ''), null)
})

test('validateRestreamInput: custom needs an rtmp(s):// URL', () => {
  assert.equal(validateRestreamInput('custom', '', ''), 'urlRequired')
  assert.equal(
    validateRestreamInput('custom', '', 'https://example.com/live'),
    'urlInvalid',
  )
  assert.equal(
    validateRestreamInput('custom', '', 'rtmps://example.com/live/k'),
    null,
  )
})

test('every preset base is a valid rtmp(s) URL', () => {
  for (const { base } of Object.values(RESTREAM_PRESETS)) {
    assert.equal(isRtmpUrl(base), true, base)
  }
})
