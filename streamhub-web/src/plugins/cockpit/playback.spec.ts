/**
 * node:test — Cockpit per-tile player resolution (the vidstack/HLS wall bug).
 *
 * Regression guard: a tile must NOT be locked to the WebRTC `<LivePlayer>`.
 *  - a ws-mjpeg camera → the MJPEG <img> player;
 *  - a room with a fresh public HLS playlist → the HLS player (which routes
 *    through the app's active provider — Vidstack — so the wall shows video and
 *    honours the installed player plugin);
 *  - anything else (no/stale playlist, probe pending) → WebRTC, unchanged, so a
 *    plain LiveKit camera with no HLS egress keeps working exactly as before.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickCellMode } from './playback.ts'

test('ws-mjpeg camera always resolves to the MJPEG player', () => {
  assert.equal(pickCellMode({ streamType: 'ws-mjpeg' }), 'mjpeg')
  // MJPEG wins even if an HLS playlist happens to exist for the room.
  assert.equal(
    pickCellMode({ streamType: 'ws-mjpeg', hls: { available: true, fresh: true } }),
    'mjpeg',
  )
})

test('a fresh public HLS playlist → the provider-aware HLS player', () => {
  assert.equal(pickCellMode({ hls: { available: true, fresh: true } }), 'hls')
  assert.equal(
    pickCellMode({ streamType: 'rtmp', hls: { available: true, fresh: true } }),
    'hls',
  )
})

test('no / stale / pending HLS → WebRTC (unchanged default)', () => {
  assert.equal(pickCellMode({ hls: { available: true, fresh: false } }), 'webrtc')
  assert.equal(pickCellMode({ hls: { available: false, fresh: false } }), 'webrtc')
  assert.equal(pickCellMode({ streamType: 'webrtc' }), 'webrtc')
  assert.equal(pickCellMode({}), 'webrtc') // probe still pending
})
