/**
 * node:test — withHlsToken (G2, signed HLS of private apps).
 *
 * Locks down: the `?st=` token is appended to the playlist URL only (the core
 * rewrites the playlist so every segment carries it), with `&` when the URL
 * already has a query, before any `#fragment`, URL-escaped; an empty/absent
 * token (public app) leaves the URL byte-for-byte untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hlsPlaylistPath, withHlsToken } from './share.ts'

test('withHlsToken appends st to the playlist URL', () => {
  const path = hlsPlaylistPath('live', 'ch1')
  assert.equal(withHlsToken(path, '1800000000.abc_-'), '/hls/live/ch1/index.m3u8?st=1800000000.abc_-')
  assert.equal(
    withHlsToken('https://x.example/hls/a/b/live.m3u8?v=2', 'T'),
    'https://x.example/hls/a/b/live.m3u8?v=2&st=T',
  )
  assert.equal(withHlsToken('/hls/a/b/index.m3u8#t=10', 'T'), '/hls/a/b/index.m3u8?st=T#t=10')
  assert.equal(withHlsToken('/hls/a/b/index.m3u8', 'a b&c'), '/hls/a/b/index.m3u8?st=a%20b%26c')
})

test('withHlsToken is a no-op for public apps', () => {
  for (const st of ['', undefined, null]) {
    assert.equal(withHlsToken('/hls/live/ch1/index.m3u8', st), '/hls/live/ch1/index.m3u8')
  }
})
