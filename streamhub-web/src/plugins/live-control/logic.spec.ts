/**
 * Unit specs for the Live Control console helpers (pure).
 * Run with Node's built-in runner (see package.json "test").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CoverAsset, LiveControlSettings, StreamListItem } from './api.ts'
import {
  assetsForMode,
  coverSummary,
  editorToOverride,
  formatBytes,
  initialEditor,
  stateTone,
} from './logic.ts'

const SETTINGS: LiveControlSettings = {
  defaultMode: 'image',
  defaultCardTitle: 'Hold on',
  defaultCardText: 'Paused',
  defaultCardColor: '#111111',
  muteAudioServerSide: true,
  pollSeconds: 5,
  defaultPauseAssetId: 3,
  defaultFinishAssetId: 7,
}

const IMG: CoverAsset = {
  id: 3,
  kind: 'image',
  s3Key: 'k',
  filename: 'a.png',
  contentType: 'image/png',
  sizeBytes: 2048,
  label: 'Intro',
  createdAt: '',
  url: 'u',
}
const VID: CoverAsset = { ...IMG, id: 4, kind: 'video', filename: 'b.mp4', contentType: 'video/mp4', label: null }

test('stateTone maps to the shared Badge tones', () => {
  assert.equal(stateTone('live'), 'green')
  assert.equal(stateTone('paused'), 'amber')
  assert.equal(stateTone('finished'), 'slate')
})

test('formatBytes is human readable', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(1024 * 1024 * 3), '3 MB')
})

test('assetsForMode filters by kind; text has none', () => {
  const all = [IMG, VID]
  assert.deepEqual(assetsForMode(all, 'image'), [IMG])
  assert.deepEqual(assetsForMode(all, 'video'), [VID])
  assert.deepEqual(assetsForMode(all, 'text'), [])
})

test('initialEditor seeds from the app defaults per phase', () => {
  const pause = initialEditor('pause', SETTINGS)
  assert.equal(pause.mode, 'image')
  assert.equal(pause.assetId, 3)
  const finish = initialEditor('finish', SETTINGS)
  assert.equal(finish.assetId, 7)
  // No settings → safe text fallback.
  const none = initialEditor('pause', null)
  assert.equal(none.mode, 'text')
  assert.equal(none.assetId, null)
})

test('editorToOverride drops irrelevant fields per mode', () => {
  const text = editorToOverride({ mode: 'text', assetId: 9, cardTitle: 'Hi', cardText: '', cardColor: '#000' })
  assert.deepEqual(text, { mode: 'text', cardTitle: 'Hi', cardText: undefined, cardColor: '#000' })

  const image = editorToOverride({ mode: 'image', assetId: 5, cardTitle: 'x', cardText: 'y', cardColor: '#fff' })
  assert.deepEqual(image, { mode: 'image', assetId: 5 })

  const imageNoAsset = editorToOverride({ mode: 'image', assetId: null, cardTitle: '', cardText: '', cardColor: '' })
  assert.deepEqual(imageNoAsset, { mode: 'image', assetId: undefined })
})

test('coverSummary describes the active cover', () => {
  const paused: StreamListItem = {
    streamId: 's1',
    type: 'rtmp',
    room: 'r',
    status: 'live',
    startedAt: '',
    participant: null,
    control: {
      streamId: 's1',
      room: 'r',
      state: 'paused',
      since: null,
      cover: { mode: 'image', assetId: 3, cardTitle: null, cardText: null, cardColor: '#000', assetUrl: 'u' },
    },
  }
  assert.equal(coverSummary(paused), 'image #3')

  const live: StreamListItem = { ...paused, control: { ...paused.control, state: 'live', cover: null } }
  assert.equal(coverSummary(live), '')
})
