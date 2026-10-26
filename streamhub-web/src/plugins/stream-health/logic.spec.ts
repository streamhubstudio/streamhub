/**
 * node:test — pure logic of the stream-health monitor tab. Locks the live
 * overview normalization (staleness forces 'stale' chips), the worst-first
 * sort, the formatting helpers and the per-room threshold form round-trip
 * (bounds mirror the core contract).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildOverride,
  FEED_STALE_MS,
  formFromOverride,
  formatAgo,
  formatKbps,
  formatResolution,
  parseOverviewLive,
  sortSnapshots,
  statusTone,
  THRESHOLD_BOUNDS,
  THRESHOLD_KEYS,
  type StreamSnapshot,
} from './logic.ts'

const liveView = (streams: unknown[], ageMs = 1000) => ({
  ts: Date.now(),
  ageMs,
  payload: { ts: Date.now(), streams },
})

const snap = (room: string, status = 'healthy', extra: Record<string, unknown> = {}) => ({
  room,
  status,
  reasons: [],
  facts: {
    videoCodec: 'h264',
    width: 1280,
    height: 720,
    fps: 30,
    audioCodec: 'aac',
    sampleRate: 48000,
    channels: 2,
    bitrateKbps: 2296,
  },
  metrics: { measuredKbps: 2100, secondsSinceAdvance: 4 },
  ...extra,
})

test('parseOverviewLive: fresh feed keeps worker statuses and shapes facts/metrics', () => {
  const { streams, stale } = parseOverviewLive(
    liveView([snap('cam-1'), snap('cam-2', 'critical', { reasons: ['stalled'] })]),
  )
  assert.equal(stale, false)
  assert.equal(streams.length, 2)
  // worst-first sort
  assert.equal(streams[0].room, 'cam-2')
  assert.equal(streams[0].status, 'critical')
  assert.deepEqual(streams[0].reasons, ['stalled'])
  assert.equal(streams[1].facts?.videoCodec, 'h264')
  assert.equal(streams[1].metrics.measuredKbps, 2100)
  assert.equal(streams[1].metrics.meanDb, null)
})

test('parseOverviewLive: an old or absent feed forces every chip to stale', () => {
  const old = parseOverviewLive(liveView([snap('cam-1')], FEED_STALE_MS + 1))
  assert.equal(old.stale, true)
  assert.equal(old.streams[0].status, 'stale')

  const never = parseOverviewLive({ ts: null, ageMs: null, payload: null })
  assert.equal(never.stale, true)
  assert.deepEqual(never.streams, [])

  assert.equal(parseOverviewLive(undefined).stale, true)
})

test('parseOverviewLive: garbage entries are skipped, unknown status maps to healthy', () => {
  const { streams } = parseOverviewLive(
    liveView([null, 42, { status: 'critical' }, snap('ok', 'weird')]),
  )
  assert.equal(streams.length, 1)
  assert.equal(streams[0].room, 'ok')
  assert.equal(streams[0].status, 'healthy')
})

test('sortSnapshots: critical < degraded < stale < healthy, then alphabetical', () => {
  const mk = (room: string, status: StreamSnapshot['status']): StreamSnapshot => ({
    room,
    status,
    reasons: [],
    facts: null,
    metrics: {
      measuredKbps: null,
      secondsSinceAdvance: null,
      meanDb: null,
      desyncMs: null,
      ccErrors: null,
      droppedSegments: null,
      discontinuityTags: null,
      baselineKbps: null,
    },
  })
  const sorted = sortSnapshots([
    mk('b', 'healthy'),
    mk('a', 'healthy'),
    mk('z', 'critical'),
    mk('m', 'stale'),
    mk('d', 'degraded'),
  ])
  assert.deepEqual(
    sorted.map((s) => s.room),
    ['z', 'd', 'm', 'a', 'b'],
  )
})

test('statusTone: one class bundle per status', () => {
  assert.ok(statusTone('healthy').includes('emerald'))
  assert.ok(statusTone('degraded').includes('amber'))
  assert.ok(statusTone('critical').includes('red'))
  assert.ok(statusTone('stale').includes('zinc'))
})

test('formatting helpers', () => {
  assert.equal(formatKbps(null), '—')
  assert.equal(formatKbps(850), '850 kbps')
  assert.equal(formatKbps(2296), '2.3 Mbps')
  assert.equal(
    formatResolution({
      videoCodec: 'h264',
      width: 1920,
      height: 1080,
      fps: 25,
      audioCodec: null,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
    }),
    '1920×1080@25',
  )
  assert.equal(formatResolution(null), '—')
  assert.equal(formatAgo(5), '5s')
  assert.equal(formatAgo(125), '2m 5s')
  assert.equal(formatAgo(7500), '2h 5m')
  assert.equal(formatAgo(null), '—')
})

test('threshold bounds mirror the core contract', () => {
  assert.deepEqual(THRESHOLD_BOUNDS, {
    sample_interval_sec: [2, 300],
    silence_db: [-120, 0],
    silence_duration_sec: [1, 600],
    desync_ms: [10, 10000],
    stall_sec: [2, 600],
    bitrate_drop_pct: [0, 95],
    recover_samples: [1, 10],
  })
  assert.equal(THRESHOLD_KEYS.length, 7)
})

test('buildOverride: blank inherits, numbers pass, out-of-range/garbage → null', () => {
  assert.deepEqual(buildOverride({ silence_db: '-40', stall_sec: '' }), {
    silence_db: -40,
  })
  assert.deepEqual(buildOverride({}), {})
  assert.equal(buildOverride({ silence_db: 'quiet' }), null)
  assert.equal(buildOverride({ silence_db: '40' }), null)
  assert.equal(buildOverride({ recover_samples: '0' }), null)
})

test('formFromOverride: seeds only stored keys, round-trips with buildOverride', () => {
  const form = formFromOverride({ silence_db: -35, stall_sec: 30 })
  assert.deepEqual(form, { silence_db: '-35', stall_sec: '30' })
  assert.deepEqual(buildOverride(form), { silence_db: -35, stall_sec: 30 })
  assert.deepEqual(formFromOverride(null), {})
})
