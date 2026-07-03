/**
 * node:test — RTMP ingest credential helpers (URL join/split + masking).
 *
 * Locks the Ingress tab reveal flow: the backend's full `rtmp_url`
 * (rtmp://host:1935/live/<key>) splits into OBS "Server" + "Stream Key",
 * and keys render masked until explicitly revealed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinIngestUrl, maskSecret, splitIngestUrl } from './ingest.ts'

test('joinIngestUrl: server + key → full push URL', () => {
  assert.equal(
    joinIngestUrl('rtmp://media.example.com:1935/live', 'abc123'),
    'rtmp://media.example.com:1935/live/abc123',
  )
  // Trailing slashes on the server never double up.
  assert.equal(
    joinIngestUrl('rtmp://media.example.com:1935/live///', 'abc123'),
    'rtmp://media.example.com:1935/live/abc123',
  )
  // No key → the bare server.
  assert.equal(
    joinIngestUrl('rtmp://media.example.com:1935/live'),
    'rtmp://media.example.com:1935/live',
  )
  assert.equal(joinIngestUrl(undefined, 'abc'), undefined)
  assert.equal(joinIngestUrl('', 'abc'), undefined)
})

test('splitIngestUrl: canonical backend shape → { server, key }', () => {
  const parts = splitIngestUrl(
    'rtmp://media.example.com:1935/live/abc123',
    'abc123',
  )
  assert.deepEqual(parts, {
    server: 'rtmp://media.example.com:1935/live',
    key: 'abc123',
  })
})

test('splitIngestUrl: URL that is already the bare server', () => {
  const parts = splitIngestUrl('rtmp://media.example.com:1935/x', 'key9')
  assert.deepEqual(parts, {
    server: 'rtmp://media.example.com:1935/x',
    key: 'key9',
  })
})

test('splitIngestUrl: no key → server only; no url → undefined', () => {
  assert.deepEqual(splitIngestUrl('rtmp://h:1935/live', undefined), {
    server: 'rtmp://h:1935/live',
    key: undefined,
  })
  assert.equal(splitIngestUrl(undefined, 'k'), undefined)
  assert.equal(splitIngestUrl('', 'k'), undefined)
})

test('splitIngestUrl and joinIngestUrl round-trip', () => {
  const url = 'rtmp://media.example.com:1935/live/stream-key-77'
  const parts = splitIngestUrl(url, 'stream-key-77')
  assert.ok(parts)
  assert.equal(joinIngestUrl(parts.server, parts.key), url)
})

test('maskSecret: keeps a short prefix, hides the rest', () => {
  const masked = maskSecret('supersecretkey123', 4)
  assert.ok(masked.startsWith('supe'))
  assert.ok(!masked.includes('secret'))
  assert.ok(masked.includes('•'))
  // Bullet padding is capped so huge keys stay short.
  assert.ok(maskSecret('x'.repeat(200)).length <= 4 + 12)
  assert.equal(maskSecret(''), '')
  assert.equal(maskSecret(undefined), '')
})
