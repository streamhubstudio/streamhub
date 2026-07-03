/**
 * Pure helpers for the Quality / Stream Health panel.
 *
 * Framework-agnostic (no React, no DOM, no `fetch`) so every branch is unit
 * tested with Node's built-in runner (see health.logic.spec.ts). The panel
 * (QualityPanel.tsx) and the network runner (bandwidth.ts) are thin shells that
 * feed raw measurements into these classifiers — ALL the threshold logic that
 * decides green/amber/red lives here, where it is deterministic and testable.
 */
import type { ConfigValues } from '../types.ts'

/** A traffic-light verdict. `unknown` = the metric wasn't measured. */
export type TrafficLight = 'green' | 'yellow' | 'red'
export type LightOrUnknown = TrafficLight | 'unknown'

// ---------------------------------------------------------------------------
// Thresholds (mirror the core plugin.meta configSchema keys + defaults)
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  greenMinMbps: 5,
  yellowMinMbps: 1,
  targetBitrateKbps: 2500,
  maxGreenRttMs: 120,
  downloadUrl: '/apple-touch-icon.png',
  downloadTargetMb: 6,
  uploadUrl: '',
} as const

/**
 * Packet-loss grading is a fixed ladder (not exposed as a config field to keep
 * the form lean). Loss is only ever populated by a future getStats() feed; an
 * HTTP-only test leaves it undefined.
 */
export const MAX_GREEN_LOSS_PCT = 2
export const MAX_YELLOW_LOSS_PCT = 5

export interface QualityThresholds {
  greenMinMbps: number
  yellowMinMbps: number
  targetBitrateKbps: number
  maxGreenRttMs: number
  downloadUrl: string
  downloadTargetBytes: number
  uploadUrl: string
}

const BYTES_PER_MB = 1024 * 1024

/** Coerce an arbitrary config value to a finite number, else `fallback`. */
export function toNumber(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

/** Coerce to a finite number that is >= 0, else `fallback`. */
export function toNonNegative(raw: unknown, fallback: number): number {
  const n = toNumber(raw, fallback)
  return n >= 0 ? n : fallback
}

/** Coerce to a trimmed string, else `fallback`. */
function toStringOr(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback
}

/**
 * Fold a raw persisted config bag into safe, defaulted thresholds. Hostile /
 * missing values fall back to the defaults; the amber floor is clamped to never
 * exceed the green floor so the ladder stays coherent.
 */
export function resolveThresholds(config: ConfigValues | undefined): QualityThresholds {
  const c = config ?? {}
  const greenMinMbps = toNonNegative(c.green_min_mbps, DEFAULTS.greenMinMbps)
  const yellowRaw = toNonNegative(c.yellow_min_mbps, DEFAULTS.yellowMinMbps)
  // Amber floor can't sit above the green floor.
  const yellowMinMbps = Math.min(yellowRaw, greenMinMbps)
  const downloadTargetMb = toNonNegative(c.download_target_mb, DEFAULTS.downloadTargetMb)
  return {
    greenMinMbps,
    yellowMinMbps,
    targetBitrateKbps: toNonNegative(c.target_bitrate_kbps, DEFAULTS.targetBitrateKbps),
    maxGreenRttMs: toNonNegative(c.max_green_rtt_ms, DEFAULTS.maxGreenRttMs),
    downloadUrl: toStringOr(c.download_url, DEFAULTS.downloadUrl),
    downloadTargetBytes: Math.max(1, Math.round(downloadTargetMb * BYTES_PER_MB)),
    uploadUrl: toStringOr(c.upload_url, DEFAULTS.uploadUrl),
  }
}

// ---------------------------------------------------------------------------
// Throughput math
// ---------------------------------------------------------------------------

/** Megabits/second for `bytes` transferred over `ms`. 0 when ms <= 0. */
export function bytesToMbps(bytes: number, ms: number): number {
  if (ms <= 0 || bytes <= 0) return 0
  return (bytes * 8) / (ms / 1000) / 1_000_000
}

/** Kilobits/second for `bytes` over `ms`. 0 when ms <= 0. */
export function bytesToKbps(bytes: number, ms: number): number {
  if (ms <= 0 || bytes <= 0) return 0
  return (bytes * 8) / (ms / 1000) / 1000
}

export function mbpsToKbps(mbps: number): number {
  return mbps * 1000
}

/**
 * getStats()-style instantaneous bitrate (kbps) between two cumulative
 * byte/timestamp samples. This is exactly how you'd derive a WebRTC inbound
 * bitrate from two `RTCInboundRtpStreamStats.bytesReceived` readings — the
 * download runner samples the streamed body the same way to show a live
 * reception bitrate. 0 when the time delta is non-positive.
 */
export function deltaKbps(
  prevBytes: number,
  prevMs: number,
  bytes: number,
  ms: number,
): number {
  const db = bytes - prevBytes
  const dt = ms - prevMs
  if (dt <= 0 || db <= 0) return 0
  return (db * 8) / (dt / 1000) / 1000
}

// ---------------------------------------------------------------------------
// Latency statistics
// ---------------------------------------------------------------------------

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Population standard deviation. */
export function stddev(xs: number[]): number {
  if (xs.length === 0) return 0
  const m = mean(xs)
  const variance = mean(xs.map((x) => (x - m) ** 2))
  return Math.sqrt(variance)
}

/**
 * Jitter as the mean absolute difference between consecutive RTT samples
 * (RFC-3550 spirit, simplified). 0 for fewer than two samples.
 */
export function jitterFrom(rtts: number[]): number {
  if (rtts.length < 2) return 0
  let sum = 0
  for (let i = 1; i < rtts.length; i++) sum += Math.abs(rtts[i] - rtts[i - 1])
  return sum / (rtts.length - 1)
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Grade a download/upload speed (Mbps) on the configured ladder. */
export function classifyThroughput(
  mbps: number | undefined,
  t: QualityThresholds,
): LightOrUnknown {
  if (mbps === undefined || !Number.isFinite(mbps)) return 'unknown'
  if (mbps >= t.greenMinMbps) return 'green'
  if (mbps >= t.yellowMinMbps) return 'yellow'
  return 'red'
}

/**
 * Grade the received/target bitrate (kbps): green at/above target, amber down
 * to half the target, red below that.
 */
export function classifyBitrate(
  kbps: number | undefined,
  t: QualityThresholds,
): LightOrUnknown {
  if (kbps === undefined || !Number.isFinite(kbps)) return 'unknown'
  if (t.targetBitrateKbps <= 0) return 'green'
  if (kbps >= t.targetBitrateKbps) return 'green'
  if (kbps >= t.targetBitrateKbps / 2) return 'yellow'
  return 'red'
}

/**
 * Grade latency: RTT at/below the green cap AND jitter within half of it is
 * green; up to 2× the RTT cap (or jitter within the cap) is amber; worse is red.
 */
export function classifyLatency(
  rttMs: number | undefined,
  jitterMs: number | undefined,
  t: QualityThresholds,
): LightOrUnknown {
  if (rttMs === undefined || !Number.isFinite(rttMs)) return 'unknown'
  const cap = t.maxGreenRttMs
  const jitter = jitterMs !== undefined && Number.isFinite(jitterMs) ? jitterMs : 0
  if (rttMs <= cap && jitter <= cap / 2) return 'green'
  if (rttMs <= cap * 2 && jitter <= cap) return 'yellow'
  return 'red'
}

/** Grade packet loss on the fixed ladder. */
export function classifyLoss(pct: number | undefined): LightOrUnknown {
  if (pct === undefined || !Number.isFinite(pct)) return 'unknown'
  if (pct <= MAX_GREEN_LOSS_PCT) return 'green'
  if (pct <= MAX_YELLOW_LOSS_PCT) return 'yellow'
  return 'red'
}

const RANK: Record<TrafficLight, number> = { green: 0, yellow: 1, red: 2 }

/**
 * Fold several sub-lights into the overall verdict = the WORST present light
 * (red beats amber beats green). `unknown` lights are ignored; if every input
 * is unknown the result is `unknown`.
 */
export function worst(...lights: LightOrUnknown[]): LightOrUnknown {
  let acc: TrafficLight | null = null
  for (const l of lights) {
    if (l === 'unknown') continue
    if (acc === null || RANK[l] > RANK[acc]) acc = l
  }
  return acc ?? 'unknown'
}

export interface HealthMetrics {
  /** Download throughput (Mbps). */
  downMbps?: number
  /** Upload throughput (Mbps). */
  upMbps?: number
  /** Round-trip latency (ms). */
  rttMs?: number
  /** Latency jitter (ms). */
  jitterMs?: number
  /** Measured reception / target bitrate (kbps). */
  bitrateKbps?: number
  /** Packet loss (%) — only from a getStats() feed; undefined for HTTP tests. */
  packetLossPct?: number
}

export interface HealthReport {
  overall: LightOrUnknown
  download: LightOrUnknown
  upload: LightOrUnknown
  latency: LightOrUnknown
  bitrate: LightOrUnknown
  loss: LightOrUnknown
}

/**
 * The single entry point the panel calls: classify each sub-metric and fold
 * them into an overall traffic light. Deterministic + pure.
 */
export function classifyHealth(
  m: HealthMetrics,
  t: QualityThresholds,
): HealthReport {
  const download = classifyThroughput(m.downMbps, t)
  const upload = classifyThroughput(m.upMbps, t)
  const latency = classifyLatency(m.rttMs, m.jitterMs, t)
  const bitrate = classifyBitrate(m.bitrateKbps, t)
  const loss = classifyLoss(m.packetLossPct)
  return {
    overall: worst(download, upload, latency, bitrate, loss),
    download,
    upload,
    latency,
    bitrate,
    loss,
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers (formatting only — kept pure so they're covered too)
// ---------------------------------------------------------------------------

const EMPTY = '—'

/** Format a Mbps value to one decimal, or an em-dash when absent. */
export function formatMbps(mbps: number | undefined): string {
  if (mbps === undefined || !Number.isFinite(mbps)) return EMPTY
  return mbps >= 100 ? Math.round(mbps).toString() : mbps.toFixed(1)
}

/** Format a millisecond value as a rounded integer, or an em-dash. */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return EMPTY
  return Math.round(ms).toString()
}

/** Format a kbps value as a rounded integer, or an em-dash. */
export function formatKbps(kbps: number | undefined): string {
  if (kbps === undefined || !Number.isFinite(kbps)) return EMPTY
  return Math.round(kbps).toString()
}
