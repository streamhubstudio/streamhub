/**
 * Unit specs for the Quality / Stream Health PURE classifiers (health.logic.ts).
 *
 * Lives under src/plugins/quality/ so the `src/plugins/*​/*.spec.ts` runner picks
 * it up (see package.json "test"). Only imports the pure module — no React/DOM,
 * no fetch. Every threshold branch (optimal / fair / poor) is exercised here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS,
  MAX_GREEN_LOSS_PCT,
  MAX_YELLOW_LOSS_PCT,
  bytesToKbps,
  bytesToMbps,
  classifyBitrate,
  classifyHealth,
  classifyLatency,
  classifyLoss,
  classifyThroughput,
  deltaKbps,
  formatKbps,
  formatMbps,
  formatMs,
  jitterFrom,
  mbpsToKbps,
  mean,
  resolveThresholds,
  stddev,
  toNonNegative,
  toNumber,
  worst,
} from './health.logic.ts'

const T = resolveThresholds({}) // defaults: green>=5, yellow>=1, target 2500kbps, rtt 120ms

// --- config coercion -------------------------------------------------------

test('toNumber / toNonNegative: coerce strings, reject junk & negatives', () => {
  assert.equal(toNumber('12.5', 0), 12.5)
  assert.equal(toNumber(7, 0), 7)
  assert.equal(toNumber('nope', 3), 3)
  assert.equal(toNumber(undefined, 3), 3)
  assert.equal(toNumber(Number.NaN, 3), 3)
  assert.equal(toNonNegative('-4', 9), 9)
  assert.equal(toNonNegative('0', 9), 0)
})

test('resolveThresholds: defaults when empty', () => {
  assert.equal(T.greenMinMbps, DEFAULTS.greenMinMbps)
  assert.equal(T.yellowMinMbps, DEFAULTS.yellowMinMbps)
  assert.equal(T.targetBitrateKbps, DEFAULTS.targetBitrateKbps)
  assert.equal(T.maxGreenRttMs, DEFAULTS.maxGreenRttMs)
  assert.equal(T.downloadUrl, DEFAULTS.downloadUrl)
  assert.equal(T.uploadUrl, '')
  assert.equal(T.downloadTargetBytes, DEFAULTS.downloadTargetMb * 1024 * 1024)
})

test('resolveThresholds: reads + sanitizes overrides', () => {
  const r = resolveThresholds({
    green_min_mbps: '25',
    yellow_min_mbps: 3,
    target_bitrate_kbps: '4000',
    max_green_rtt_ms: 80,
    download_url: '  /big.bin  ',
    download_target_mb: 10,
    upload_url: 'https://up.example/put',
  })
  assert.equal(r.greenMinMbps, 25)
  assert.equal(r.yellowMinMbps, 3)
  assert.equal(r.targetBitrateKbps, 4000)
  assert.equal(r.maxGreenRttMs, 80)
  assert.equal(r.downloadUrl, '/big.bin')
  assert.equal(r.downloadTargetBytes, 10 * 1024 * 1024)
  assert.equal(r.uploadUrl, 'https://up.example/put')
})

test('resolveThresholds: amber floor clamped to never exceed green floor', () => {
  const r = resolveThresholds({ green_min_mbps: 4, yellow_min_mbps: 9 })
  assert.equal(r.greenMinMbps, 4)
  assert.equal(r.yellowMinMbps, 4) // clamped down from 9
})

// --- throughput math -------------------------------------------------------

test('bytesToMbps / bytesToKbps: bits-over-seconds, guarded', () => {
  // 1_000_000 bytes in 1000ms = 8 Mbps = 8000 kbps
  assert.equal(bytesToMbps(1_000_000, 1000), 8)
  assert.equal(bytesToKbps(1_000_000, 1000), 8000)
  // 2_500_000 bytes in 2000ms = 10 Mbps
  assert.equal(bytesToMbps(2_500_000, 2000), 10)
  assert.equal(bytesToMbps(1000, 0), 0)
  assert.equal(bytesToMbps(0, 1000), 0)
  assert.equal(bytesToMbps(1000, -5), 0)
})

test('mbpsToKbps', () => {
  assert.equal(mbpsToKbps(2.5), 2500)
})

test('deltaKbps: getStats-style instantaneous bitrate between two samples', () => {
  // +125_000 bytes over 1000ms = 1_000_000 bits/s = 1000 kbps
  assert.equal(deltaKbps(0, 0, 125_000, 1000), 1000)
  assert.equal(deltaKbps(125_000, 1000, 375_000, 2000), 2000)
  // non-positive time or byte deltas are guarded to 0
  assert.equal(deltaKbps(0, 1000, 125_000, 1000), 0)
  assert.equal(deltaKbps(500, 0, 100, 1000), 0)
})

// --- latency statistics ----------------------------------------------------

test('mean / stddev: population stats, empty-safe', () => {
  assert.equal(mean([]), 0)
  assert.equal(mean([10, 20, 30]), 20)
  assert.equal(stddev([]), 0)
  assert.equal(stddev([5, 5, 5]), 0)
  assert.equal(stddev([2, 4, 6]), Math.sqrt(8 / 3))
})

test('jitterFrom: mean absolute consecutive difference', () => {
  assert.equal(jitterFrom([]), 0)
  assert.equal(jitterFrom([50]), 0)
  // diffs: |60-50|, |55-60| = 10, 5 -> mean 7.5
  assert.equal(jitterFrom([50, 60, 55]), 7.5)
})

// --- classification: throughput -------------------------------------------

test('classifyThroughput: green/amber/red ladder + unknown', () => {
  assert.equal(classifyThroughput(9, T), 'green') // >= 5
  assert.equal(classifyThroughput(5, T), 'green') // boundary inclusive
  assert.equal(classifyThroughput(3, T), 'yellow') // 1..5
  assert.equal(classifyThroughput(1, T), 'yellow') // boundary inclusive
  assert.equal(classifyThroughput(0.4, T), 'red') // < 1
  assert.equal(classifyThroughput(undefined, T), 'unknown')
  assert.equal(classifyThroughput(Number.NaN, T), 'unknown')
})

// --- classification: bitrate ----------------------------------------------

test('classifyBitrate: vs target (green>=target, amber>=half)', () => {
  assert.equal(classifyBitrate(3000, T), 'green') // >= 2500
  assert.equal(classifyBitrate(2500, T), 'green')
  assert.equal(classifyBitrate(1300, T), 'yellow') // >= 1250
  assert.equal(classifyBitrate(1250, T), 'yellow')
  assert.equal(classifyBitrate(800, T), 'red')
  assert.equal(classifyBitrate(undefined, T), 'unknown')
  // target 0 disables the check → always green
  assert.equal(classifyBitrate(1, resolveThresholds({ target_bitrate_kbps: 0 })), 'green')
})

// --- classification: latency ----------------------------------------------

test('classifyLatency: RTT + jitter bands', () => {
  // cap 120ms; green needs rtt<=120 AND jitter<=60
  assert.equal(classifyLatency(40, 10, T), 'green')
  assert.equal(classifyLatency(120, 60, T), 'green') // boundaries inclusive
  // low rtt but jittery -> amber
  assert.equal(classifyLatency(40, 90, T), 'yellow')
  // rtt in 120..240 with jitter<=120 -> amber
  assert.equal(classifyLatency(200, 30, T), 'yellow')
  // too high rtt -> red
  assert.equal(classifyLatency(500, 10, T), 'red')
  // huge jitter -> red
  assert.equal(classifyLatency(40, 300, T), 'red')
  // jitter omitted defaults to 0
  assert.equal(classifyLatency(100, undefined, T), 'green')
  assert.equal(classifyLatency(undefined, undefined, T), 'unknown')
})

// --- classification: loss --------------------------------------------------

test('classifyLoss: fixed ladder', () => {
  assert.equal(classifyLoss(0), 'green')
  assert.equal(classifyLoss(MAX_GREEN_LOSS_PCT), 'green')
  assert.equal(classifyLoss(MAX_GREEN_LOSS_PCT + 0.5), 'yellow')
  assert.equal(classifyLoss(MAX_YELLOW_LOSS_PCT), 'yellow')
  assert.equal(classifyLoss(MAX_YELLOW_LOSS_PCT + 1), 'red')
  assert.equal(classifyLoss(undefined), 'unknown')
})

// --- worst folding ---------------------------------------------------------

test('worst: red beats amber beats green; unknown ignored', () => {
  assert.equal(worst('green', 'green'), 'green')
  assert.equal(worst('green', 'yellow'), 'yellow')
  assert.equal(worst('green', 'red', 'yellow'), 'red')
  assert.equal(worst('green', 'unknown'), 'green')
  assert.equal(worst('unknown', 'unknown'), 'unknown')
  assert.equal(worst(), 'unknown')
})

// --- classifyHealth (end-to-end fold) --------------------------------------

test('classifyHealth: all-green optimal path', () => {
  const r = classifyHealth(
    { downMbps: 50, upMbps: 20, rttMs: 30, jitterMs: 5, bitrateKbps: 4000 },
    T,
  )
  assert.deepEqual(r, {
    overall: 'green',
    download: 'green',
    upload: 'green',
    latency: 'green',
    bitrate: 'green',
    loss: 'unknown',
  })
})

test('classifyHealth: one poor metric drags the overall to red', () => {
  const r = classifyHealth(
    { downMbps: 0.5, upMbps: 20, rttMs: 30, jitterMs: 5, bitrateKbps: 4000 },
    T,
  )
  assert.equal(r.download, 'red')
  assert.equal(r.overall, 'red')
})

test('classifyHealth: fair download → amber overall (nothing worse)', () => {
  const r = classifyHealth({ downMbps: 3, rttMs: 30 }, T)
  assert.equal(r.download, 'yellow')
  assert.equal(r.upload, 'unknown')
  assert.equal(r.overall, 'yellow')
})

test('classifyHealth: measured-only-download still yields a verdict', () => {
  const r = classifyHealth({ downMbps: 8 }, T)
  assert.equal(r.overall, 'green')
})

test('classifyHealth: no metrics at all → unknown overall', () => {
  assert.equal(classifyHealth({}, T).overall, 'unknown')
})

test('classifyHealth: high packet loss forces red even with fast link', () => {
  const r = classifyHealth(
    { downMbps: 100, upMbps: 50, rttMs: 20, jitterMs: 2, packetLossPct: 12 },
    T,
  )
  assert.equal(r.loss, 'red')
  assert.equal(r.overall, 'red')
})

// --- formatting ------------------------------------------------------------

test('formatMbps / formatMs / formatKbps: rounding + em-dash fallback', () => {
  assert.equal(formatMbps(12.34), '12.3')
  assert.equal(formatMbps(150.6), '151')
  assert.equal(formatMbps(undefined), '—')
  assert.equal(formatMs(42.7), '43')
  assert.equal(formatMs(undefined), '—')
  assert.equal(formatKbps(2499.6), '2500')
  assert.equal(formatKbps(undefined), '—')
})
