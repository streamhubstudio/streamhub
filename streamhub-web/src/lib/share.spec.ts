/**
 * node:test — pure logic of the public share / HLS-fallback helpers.
 *
 * Locks down:
 *  - URL builders: /play page, /embed page, /hls playlist — exact shapes with
 *    URL-escaping, and the iframe + video.js embed snippets the share menu
 *    copies verbatim.
 *  - isPassthroughStream: only the synthetic passthrough row (participant
 *    'passthrough' / streamId `<room>/passthrough`) matches — a regular RTMP
 *    stream must never be routed away from LiveKit egress.
 *  - playlistIsFresh / defaultPlayback: HLS is DEFAULT only when the playlist
 *    exists AND is fresh-ish; stale/missing/error → WebRTC (the fallback can
 *    never break existing playback). Freshness prefers the server's own Date
 *    header (clock-skew safe) and treats missing headers as fresh.
 *  - probeHls: HEAD-first with GET fallback on method rejection; 404 and
 *    thrown/timeout fetches resolve {available:false} without throwing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HLS_FRESH_WINDOW_MS,
  defaultPlayback,
  embedIframeSnippet,
  hlsEmbedSnippet,
  hlsPlaylistPath,
  hlsPlaylistUrl,
  isPassthroughStream,
  playlistIsFresh,
  probeHls,
  publicEmbedUrl,
  publicPlayerUrl,
  signedEmbedIframe,
  signedEmbedUrl,
} from './share.ts'

const ORIGIN = 'https://stream.example.com'

test('URL builders: exact public surfaces with escaping', () => {
  assert.equal(hlsPlaylistPath('live', 'ch1'), '/hls/live/ch1/index.m3u8')
  assert.equal(hlsPlaylistUrl(ORIGIN, 'live', 'ch1'), `${ORIGIN}/hls/live/ch1/index.m3u8`)
  assert.equal(publicPlayerUrl(ORIGIN, 'live', 'ch1'), `${ORIGIN}/play/live/ch1`)
  assert.equal(publicEmbedUrl(ORIGIN, 'live', 'ch1'), `${ORIGIN}/embed/live/ch1`)

  // Escaping + trailing-slash origin tolerance.
  assert.equal(
    publicPlayerUrl(`${ORIGIN}/`, 'my app', 'sala/1'),
    `${ORIGIN}/play/my%20app/sala%2F1`,
  )
  assert.equal(hlsPlaylistPath('a b', 'c#d'), '/hls/a%20b/c%23d/index.m3u8')
})

test('embedIframeSnippet: the exact copyable <iframe>', () => {
  assert.equal(
    embedIframeSnippet(`${ORIGIN}/embed/live/ch1`),
    `<iframe src="${ORIGIN}/embed/live/ch1" width="640" height="360" ` +
      `frameborder="0" allow="autoplay; fullscreen" allowfullscreen></iframe>`,
  )
})

test('hlsEmbedSnippet: self-contained video.js embed over the playlist', () => {
  const snippet = hlsEmbedSnippet(`${ORIGIN}/hls/live/ch1/index.m3u8`)
  assert.ok(
    snippet.includes(
      `<source src="${ORIGIN}/hls/live/ch1/index.m3u8" type="application/x-mpegURL" />`,
    ),
  )
  assert.ok(snippet.includes('video.min.js'))
  assert.ok(snippet.includes("videojs('streamhub-hls')"))
})

test('signedEmbedUrl/Iframe: tokenized embed carries exp+sig, no bearer secret', () => {
  const url = signedEmbedUrl(ORIGIN, 'live', 'ch1', 1712345678, 'a'.repeat(64))
  assert.equal(
    url,
    `${ORIGIN}/embed/live/ch1?exp=1712345678&sig=${'a'.repeat(64)}`,
  )
  // Escapes app/room too (shares publicEmbedUrl's slug builder).
  assert.equal(
    signedEmbedUrl(ORIGIN, 'my app', 'sala/1', 9, 'deadbeef'),
    `${ORIGIN}/embed/my%20app/sala%2F1?exp=9&sig=deadbeef`,
  )

  const iframe = signedEmbedIframe(ORIGIN, 'live', 'ch1', 42, 'f'.repeat(64))
  assert.ok(iframe.startsWith('<iframe'))
  assert.ok(iframe.includes(`src="${ORIGIN}/embed/live/ch1?exp=42&sig=${'f'.repeat(64)}"`))
  // The only credential in the snippet is the HMAC signature — never an sk_/JWT.
  assert.doesNotMatch(iframe, /sk_/)
  assert.doesNotMatch(iframe, /Bearer/i)
  assert.doesNotMatch(iframe, /eyJ/)
})

test('isPassthroughStream: only the synthetic passthrough row matches', () => {
  assert.equal(isPassthroughStream({ participant: 'passthrough' }), true)
  assert.equal(isPassthroughStream({ streamId: 'ch1/passthrough' }), true)
  assert.equal(
    isPassthroughStream({ participant: 'passthrough', streamId: 'ch1/passthrough' }),
    true,
  )

  // Regular streams — never rerouted away from LiveKit.
  assert.equal(isPassthroughStream({ participant: 'obs', streamId: 'room1/obs' }), false)
  assert.equal(isPassthroughStream({ participant: null, streamId: 'room1' }), false)
  assert.equal(isPassthroughStream({}), false)
  // A room literally named "passthrough" with a real publisher is NOT one.
  assert.equal(
    isPassthroughStream({ participant: 'obs', streamId: 'passthrough/obs' }),
    false,
  )
})

test('playlistIsFresh: header-driven, skew-safe, forgiving on missing data', () => {
  const now = Date.parse('2026-07-09T12:00:00Z')
  const iso = (ms: number) => new Date(ms).toUTCString()

  // Recently touched → fresh; older than the window → stale.
  assert.equal(playlistIsFresh(iso(now - 5_000), null, now), true)
  assert.equal(playlistIsFresh(iso(now - HLS_FRESH_WINDOW_MS - 1_000), null, now), false)

  // Server Date header wins over a skewed client clock (client 10min ahead).
  const skewedClient = now + 10 * 60_000
  assert.equal(playlistIsFresh(iso(now - 5_000), iso(now), skewedClient), true)

  // Missing / unparsable Last-Modified → assume fresh (proxy stripped it).
  assert.equal(playlistIsFresh(null, null, now), true)
  assert.equal(playlistIsFresh('not-a-date', null, now), true)
})

test('defaultPlayback: HLS only when available AND fresh', () => {
  assert.equal(defaultPlayback({ available: true, fresh: true }), 'hls')
  assert.equal(defaultPlayback({ available: true, fresh: false }), 'webrtc')
  assert.equal(defaultPlayback({ available: false, fresh: false }), 'webrtc')
  assert.equal(defaultPlayback(undefined), 'webrtc')
  assert.equal(defaultPlayback(null), 'webrtc')
})

function fakeResponse(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
  } as Response
}

test('probeHls: HEAD 200 with fresh headers → available + fresh', async () => {
  const calls: string[] = []
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls.push(init?.method ?? 'GET')
    return fakeResponse(200, { 'last-modified': new Date().toUTCString() })
  }) as typeof fetch

  const res = await probeHls('/hls/live/ch1/index.m3u8', fetchImpl)
  assert.deepEqual(res, { available: true, fresh: true })
  assert.deepEqual(calls, ['HEAD'])
})

test('probeHls: 404 → unavailable, no GET retry', async () => {
  const calls: string[] = []
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls.push(init?.method ?? 'GET')
    return fakeResponse(404)
  }) as typeof fetch

  const res = await probeHls('/hls/live/nope/index.m3u8', fetchImpl)
  assert.deepEqual(res, { available: false, fresh: false })
  assert.deepEqual(calls, ['HEAD'])
})

test('probeHls: HEAD rejected (405) → GET fallback wins', async () => {
  const calls: string[] = []
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push(method)
    return method === 'HEAD'
      ? fakeResponse(405)
      : fakeResponse(200, { 'last-modified': new Date().toUTCString() })
  }) as typeof fetch

  const res = await probeHls('/hls/live/ch1/index.m3u8', fetchImpl)
  assert.deepEqual(res, { available: true, fresh: true })
  assert.deepEqual(calls, ['HEAD', 'GET'])
})

test('probeHls: stale Last-Modified → available but NOT fresh', async () => {
  const fetchImpl = (async () =>
    fakeResponse(200, {
      'last-modified': new Date(Date.now() - 60 * 60_000).toUTCString(),
    })) as unknown as typeof fetch

  const res = await probeHls('/hls/live/old/index.m3u8', fetchImpl)
  assert.deepEqual(res, { available: true, fresh: false })
})

test('probeHls: network error → {available:false} without throwing', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('network down')
  }) as unknown as typeof fetch

  const res = await probeHls('/hls/live/ch1/index.m3u8', fetchImpl)
  assert.deepEqual(res, { available: false, fresh: false })
})
