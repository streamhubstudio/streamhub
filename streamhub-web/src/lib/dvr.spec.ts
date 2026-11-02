/**
 * Unit specs for the DVR/timeshift helpers (pure, G5).
 * Run with Node's built-in runner: `npm run test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dvrPlaylistPath,
  formatBehindLive,
  formatDvrStartAt,
  formatWallClock,
  isAtLiveEdge,
  mediaTimeToEpoch,
  parseDvrStartAt,
  pdtEpochAtZero,
  resolveSeekTarget,
  withStartAt,
} from './dvr.ts'

const T = Date.parse('2026-10-29T14:00:00Z')

test('parseDvrStartAt: absolute instants (epoch s / ms / ISO)', () => {
  assert.deepEqual(parseDvrStartAt('1793282400'), { kind: 'epoch', epochMs: 1793282400000 })
  assert.deepEqual(parseDvrStartAt('1793282400123'), { kind: 'epoch', epochMs: 1793282400123 })
  assert.deepEqual(parseDvrStartAt(' 1793282400.5 '), { kind: 'epoch', epochMs: 1793282400500 })
  assert.deepEqual(parseDvrStartAt('2026-10-29T14:00:00Z'), { kind: 'epoch', epochMs: T })
  assert.deepEqual(parseDvrStartAt('2026-10-29T11:00:00-03:00'), { kind: 'epoch', epochMs: T })
})

test('parseDvrStartAt: relative to the live edge', () => {
  assert.deepEqual(parseDvrStartAt('-90'), { kind: 'offset', seconds: 90 })
  assert.deepEqual(parseDvrStartAt('-2.5'), { kind: 'offset', seconds: 2.5 })
  assert.deepEqual(parseDvrStartAt('-45s'), { kind: 'offset', seconds: 45 })
  assert.deepEqual(parseDvrStartAt('-5m'), { kind: 'offset', seconds: 300 })
  assert.deepEqual(parseDvrStartAt('-1h30m'), { kind: 'offset', seconds: 5400 })
  assert.deepEqual(parseDvrStartAt('-1h2m3s'), { kind: 'offset', seconds: 3723 })
})

test('parseDvrStartAt: garbage is ignored (start live)', () => {
  for (const raw of [null, undefined, '', '  ', '-', '-0', '-m', '90', '12345', 'abc', 'March 7', '-5x', '1e12', '--5', '2026-10-29']) {
    assert.equal(parseDvrStartAt(raw), null, String(raw))
  }
})

test('formatDvrStartAt round-trips through parse (epoch seconds)', () => {
  const s = formatDvrStartAt(T + 999)
  assert.equal(s, String(T / 1000))
  assert.deepEqual(parseDvrStartAt(s), { kind: 'epoch', epochMs: T })
})

test('pdtEpochAtZero: first timed segment with a PDT anchors the timeline', () => {
  assert.equal(pdtEpochAtZero(null), null)
  assert.equal(pdtEpochAtZero([{ dateTimeObject: new Date(T) }]), null, 'untimed segment')
  assert.equal(pdtEpochAtZero([{ start: 10 }, { start: 14, dateTimeObject: new Date(T) }]), T - 14_000)
  assert.equal(pdtEpochAtZero([{ start: 2, programDateTime: T }]), T - 2000)
})

test('resolveSeekTarget: offsets, epochs through the PDT anchor, clamping', () => {
  const win = { start: 100, end: 3700 }
  const zero = T - 100_000 // media 100 s == T
  assert.deepEqual(resolveSeekTarget({ kind: 'offset', seconds: 600 }, win, zero, T), { time: 3100, clamped: false })
  assert.deepEqual(resolveSeekTarget({ kind: 'offset', seconds: 7200 }, win, zero, T), { time: 100, clamped: true })
  assert.deepEqual(resolveSeekTarget({ kind: 'epoch', epochMs: T + 60_000 }, win, zero, T), { time: 160, clamped: false })
  assert.deepEqual(resolveSeekTarget({ kind: 'epoch', epochMs: T - 60_000 }, win, zero, T), { time: 100, clamped: true })
  assert.deepEqual(resolveSeekTarget({ kind: 'epoch', epochMs: T + 9e9 }, win, zero, T), { time: 3700, clamped: true })
  // No PDT anchor: "now - instant" behind the live edge.
  assert.deepEqual(resolveSeekTarget({ kind: 'epoch', epochMs: T - 300_000 }, win, null, T), { time: 3400, clamped: false })
  // A window not known yet → no target.
  assert.equal(resolveSeekTarget({ kind: 'offset', seconds: 1 }, { start: NaN, end: 1 }, null, T), null)
  assert.equal(resolveSeekTarget({ kind: 'offset', seconds: 1 }, { start: 5, end: 1 }, null, T), null)
})

test('mediaTimeToEpoch / isAtLiveEdge', () => {
  assert.equal(mediaTimeToEpoch(12, T), T + 12_000)
  assert.equal(mediaTimeToEpoch(12, null), null)
  assert.equal(isAtLiveEdge(95, { start: 0, end: 100 }), true)
  assert.equal(isAtLiveEdge(80, { start: 0, end: 100 }), false)
  assert.equal(isAtLiveEdge(80, { start: 0, end: 100 }, 30), true)
})

test('formatBehindLive / formatWallClock', () => {
  assert.equal(formatBehindLive(0.4), '')
  assert.equal(formatBehindLive(NaN), '')
  assert.equal(formatBehindLive(65), '-01:05')
  assert.equal(formatBehindLive(3723.9), '-1:02:03')
  assert.equal(formatWallClock(T, 'UTC'), '14:00:00')
  assert.equal(formatWallClock(T, 'America/Argentina/Buenos_Aires'), '11:00:00')
  assert.equal(formatWallClock(null), '')
})

test('dvrPlaylistPath / withStartAt', () => {
  assert.equal(dvrPlaylistPath('live', 'cam 1'), '/hls/live/cam%201/dvr.m3u8')
  assert.equal(withStartAt('https://x/embed/live/cam1', '-5m'), 'https://x/embed/live/cam1?t=-5m')
  assert.equal(
    withStartAt('https://x/embed/live/cam1?exp=1&sig=a&t=old#frag', '1793282400'),
    'https://x/embed/live/cam1?exp=1&sig=a&t=1793282400#frag',
  )
})
