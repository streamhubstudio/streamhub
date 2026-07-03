/**
 * node:test — pure logic of the ws-mjpeg player mode (ESP32 WS ingest).
 *
 * Locks down:
 *  - pickPlayerMode: /play + /embed render MJPEG ONLY for an active ws-mjpeg
 *    camera; every other state (inactive, other type, missing/failed info)
 *    falls back to the WebRTC player — the feature can never break existing
 *    playback.
 *  - URL builders: /live endpoints (+ play-token query), cache-buster, the
 *    copyable wss:// publish URL and relative→absolute URL resolution.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  absoluteUrl,
  frameUrl,
  mjpegUrl,
  pickPlayerMode,
  withCacheBuster,
  wsPublishUrl,
} from './mjpeg.ts'

test('pickPlayerMode: only an ACTIVE ws-mjpeg camera selects mjpeg', () => {
  assert.equal(pickPlayerMode({ active: true, type: 'ws-mjpeg' }), 'mjpeg')

  // Everything else → webrtc (LivePlayer), incl. degraded/error states.
  assert.equal(pickPlayerMode({ active: false, type: null }), 'webrtc')
  assert.equal(pickPlayerMode({ active: false, type: 'ws-mjpeg' }), 'webrtc')
  assert.equal(pickPlayerMode({ active: true, type: 'rtmp' }), 'webrtc')
  assert.equal(pickPlayerMode(undefined), 'webrtc')
  assert.equal(pickPlayerMode(null), 'webrtc')
  assert.equal(pickPlayerMode({}), 'webrtc')
  // A lying payload (active as string) must not enable mjpeg.
  assert.equal(
    pickPlayerMode({ active: 'yes' as unknown as boolean, type: 'ws-mjpeg' }),
    'webrtc',
  )
})

test('mjpegUrl / frameUrl: /live endpoints with escaping + optional token', () => {
  assert.equal(mjpegUrl('live', 'live-cam1'), '/live/live/live-cam1/mjpeg')
  assert.equal(frameUrl('live', 'live-cam1'), '/live/live/live-cam1/frame.jpg')
  // The play token rides as ?token= (private apps, AUTHZ=on).
  assert.equal(
    mjpegUrl('live', 'cam1', 'tok en'),
    '/live/live/cam1/mjpeg?token=tok%20en',
  )
  // Path segments are URL-escaped.
  assert.equal(mjpegUrl('a b', 'c/d'), '/live/a%20b/c%2Fd/mjpeg')
})

test('withCacheBuster: appends with ? or & as needed', () => {
  assert.equal(withCacheBuster('/live/a/b/mjpeg', 7), '/live/a/b/mjpeg?t=7')
  assert.equal(
    withCacheBuster('/live/a/b/mjpeg?token=x', 7),
    '/live/a/b/mjpeg?token=x&t=7',
  )
})

test('wsPublishUrl: https base → wss, http → ws, fallback to page origin', () => {
  assert.equal(
    wsPublishUrl('https://streamhub.example.com', 'https://ignored', 'live', 'cam1'),
    'wss://streamhub.example.com/ingest/ws?app=live&room=cam1',
  )
  assert.equal(
    wsPublishUrl('http://10.0.0.5:3020/', 'https://ignored', 'live', 'cam1'),
    'ws://10.0.0.5:3020/ingest/ws?app=live&room=cam1',
  )
  // No configured base → derive from the dashboard origin.
  assert.equal(
    wsPublishUrl(undefined, 'https://panel.example.com', 'live', 'cam 1'),
    'wss://panel.example.com/ingest/ws?app=live&room=cam%201',
  )
  assert.equal(
    wsPublishUrl('', 'https://panel.example.com', 'live', 'cam1'),
    'wss://panel.example.com/ingest/ws?app=live&room=cam1',
  )
})

test('absoluteUrl: relative core URLs resolve against the origin', () => {
  const origin = 'https://streamhub.example.com'
  assert.equal(
    absoluteUrl('/live/live/live-cam1/mjpeg', origin),
    'https://streamhub.example.com/live/live/live-cam1/mjpeg',
  )
  // ws endpoints keep the ws(s) scheme.
  assert.equal(
    absoluteUrl('/ingest/ws?app=live&room=cam1', origin),
    'wss://streamhub.example.com/ingest/ws?app=live&room=cam1',
  )
  assert.equal(
    absoluteUrl('/live/ws?app=live&room=cam1', 'http://localhost:5173'),
    'ws://localhost:5173/live/ws?app=live&room=cam1',
  )
  // Already-absolute URLs pass through untouched.
  assert.equal(absoluteUrl('https://cdn.example.com/x', origin), 'https://cdn.example.com/x')
  assert.equal(absoluteUrl('wss://a/b', origin), 'wss://a/b')
  assert.equal(absoluteUrl(undefined, origin), '')
})
