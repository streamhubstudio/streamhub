/**
 * node:test — pure logic of the stream-health monitor tab. Locks the live
 * overview normalization (staleness forces 'stale' chips), the worst-first
 * sort, the formatting helpers and the per-room threshold form round-trip
 * (bounds mirror the core contract), plus (3.4) the remote edge probes'
 * grouping and the "source has no audio" fact.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildOverride,
  FEED_STALE_MS,
  formFromOverride,
  groupSnapshots,
  formatAgo,
  formatCodecs,
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
    origin: null,
    via: null,
    url: null,
    error: null,
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
      audioSource: null,
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

test('parseOverviewLive: remote probe fields, absent on origin snapshots', () => {
  const { streams } = parseOverviewLive(
    liveView([
      snap('cam-1'),
      snap('cam-1@edge1', 'critical', {
        origin: 'cam-1',
        via: 'edge1',
        url: 'https://cdn1/hls/live/cam-1/index.m3u8',
        error: 'HTTP 502',
      }),
    ]),
  )
  const [remote, origin] = streams
  assert.equal(remote.room, 'cam-1@edge1')
  assert.equal(remote.origin, 'cam-1')
  assert.equal(remote.via, 'edge1')
  assert.equal(remote.error, 'HTTP 502')
  assert.equal(origin.origin, null)
  assert.equal(origin.via, null)
})

test('groupSnapshots: edges fold under their room; a bad edge surfaces the room', () => {
  const { streams } = parseOverviewLive(
    liveView([
      snap('a-cam'),
      snap('b-cam'),
      snap('b-cam@z-edge', 'healthy', { origin: 'b-cam', via: 'z-edge' }),
      snap('b-cam@edge1', 'critical', { origin: 'b-cam', via: 'edge1' }),
      snap('c-cam@edge1', 'degraded', { origin: 'c-cam', via: 'edge1' }), // origin not in the feed yet
    ]),
  )
  const groups = groupSnapshots(streams)
  assert.deepEqual(
    groups.map((g) => [g.room, g.status, g.origin?.room ?? null, g.edges.map((e) => e.via)]),
    [
      ['b-cam', 'critical', 'b-cam', ['edge1', 'z-edge']],
      ['c-cam', 'degraded', null, ['edge1']],
      ['a-cam', 'healthy', 'a-cam', []],
    ],
  )
  const stale = groupSnapshots(parseOverviewLive(liveView([snap('a')], FEED_STALE_MS + 1)).streams)
  assert.equal(stale[0].status, 'stale')
})

test('formatCodecs: a source with no audio says so instead of the filler codec', () => {
  const facts = parseOverviewLive(
    liveView([snap('x', 'healthy', { facts: { videoCodec: 'h264', audioCodec: 'aac', audioSource: 'none' } })]),
  ).streams[0].facts
  assert.equal(facts?.audioSource, 'none')
  assert.equal(formatCodecs(facts, 'none', 'no audio source'), 'h264/no audio source')
  assert.equal(formatCodecs({ ...facts!, audioSource: 'track' }, 'none', 'nas'), 'h264/aac')
  assert.equal(formatCodecs({ ...facts!, audioSource: null, audioCodec: null }, 'none', 'nas'), 'h264/none')
  assert.equal(formatCodecs(null, 'none', 'nas'), '—')
})
