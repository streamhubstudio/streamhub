import { test } from 'node:test'
import assert from 'node:assert/strict'
import { samplePreviewSandbox, sampleUrl, samplesIsolated, samplesOrigin } from './samplesOrigin.ts'

const page = 'https://app.example.com'

test('samplesOrigin falls back to the page origin', () => {
  assert.equal(samplesOrigin(undefined, page), page)
  assert.equal(samplesOrigin('', page + '/'), page)
  assert.equal(samplesOrigin('https://samples.example.com/', page), 'https://samples.example.com')
})

test('samplesIsolated only for a different origin', () => {
  assert.equal(samplesIsolated(undefined, page), false)
  assert.equal(samplesIsolated('', page), false)
  assert.equal(samplesIsolated('https://APP.example.com/', page), false)
  assert.equal(samplesIsolated('https://samples.example.com', page), true)
})

test('sampleUrl encodes app and file', () => {
  assert.equal(
    sampleUrl('https://samples.example.com', 'my app', 'conference.html'),
    'https://samples.example.com/samples/my%20app/conference.html',
  )
})

test('preview sandbox grants same-origin only on an isolated samples origin', () => {
  assert.ok(!samplePreviewSandbox(false).includes('allow-same-origin'))
  assert.ok(samplePreviewSandbox(true).includes('allow-same-origin'))
  assert.ok(samplePreviewSandbox(false).includes('allow-scripts'))
})
