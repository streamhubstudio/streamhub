/**
 * stream-health (frontend) — PURE data shaping for the monitor tab, kept out
 * of React so node:test covers it (npm test in streamhub-web).
 *
 * Sources it shapes:
 *   - the worker's live `overview` snapshot read from the framework channel
 *     GET /apps/:app/plugins/stream-health/live/state?room=overview
 *     → `{ ts, ageMs, payload: { ts, streams: [...] } }`;
 *   - the module's db-backed REST (overview / events / settings).
 */

export type HealthStatus = 'healthy' | 'degraded' | 'critical' | 'stale'

export interface StreamFacts {
  videoCodec: string | null
  width: number | null
  height: number | null
  fps: number | null
  audioCodec: string | null
  sampleRate: number | null
  channels: number | null
  bitrateKbps: number | null
}

export interface StreamMetrics {
  measuredKbps: number | null
  secondsSinceAdvance: number | null
  meanDb: number | null
  desyncMs: number | null
  ccErrors: number | null
  droppedSegments: number | null
  discontinuityTags: number | null
  baselineKbps: number | null
}

export interface StreamSnapshot {
  room: string
  status: HealthStatus
  reasons: string[]
  facts: StreamFacts | null
  metrics: StreamMetrics
}

/** Worker feed older than this is STALE — grey out, don't trust chips. */
export const FEED_STALE_MS = 45_000

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null

function parseFacts(v: unknown): StreamFacts | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  return {
    videoCodec: str(o.videoCodec),
    width: num(o.width),
    height: num(o.height),
    fps: num(o.fps),
    audioCodec: str(o.audioCodec),
    sampleRate: num(o.sampleRate),
    channels: num(o.channels),
    bitrateKbps: num(o.bitrateKbps),
  }
}

function parseMetrics(v: unknown): StreamMetrics {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  return {
    measuredKbps: num(o.measuredKbps),
    secondsSinceAdvance: num(o.secondsSinceAdvance),
    meanDb: num(o.meanDb),
    desyncMs: num(o.desyncMs),
    ccErrors: num(o.ccErrors),
    droppedSegments: num(o.droppedSegments),
    discontinuityTags: num(o.discontinuityTags),
    baselineKbps: num(o.baselineKbps),
  }
}

/**
 * Normalize the live-state read. `stale` (feed too old / never pushed) forces
 * every snapshot's status to 'stale' so the grid never shows a confident
 * green chip off a dead feed.
 */
export function parseOverviewLive(
  view: { ts: number | null; ageMs: number | null; payload: unknown } | null | undefined,
): { streams: StreamSnapshot[]; stale: boolean } {
  const ageMs = view?.ageMs ?? null
  const stale = ageMs === null || ageMs > FEED_STALE_MS
  const payload = view?.payload
  const raw =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).streams
      : null
  const streams: StreamSnapshot[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const o = item as Record<string, unknown>
      const room = str(o.room)
      if (!room) continue
      const status = str(o.status)
      streams.push({
        room,
        status: stale
          ? 'stale'
          : status === 'critical' || status === 'degraded'
            ? status
            : 'healthy',
        reasons: Array.isArray(o.reasons) ? o.reasons.map((r) => String(r)) : [],
        facts: parseFacts(o.facts),
        metrics: parseMetrics(o.metrics),
      })
    }
  }
  return { streams: sortSnapshots(streams), stale }
}

/** Worst-first, then alphabetical — the monitor grid order. */
export function sortSnapshots(list: StreamSnapshot[]): StreamSnapshot[] {
  const rank: Record<HealthStatus, number> = {
    critical: 0,
    degraded: 1,
    stale: 2,
    healthy: 3,
  }
  return [...list].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.room.localeCompare(b.room),
  )
}

/** Tailwind classes for a status chip (badge background + text, both themes). */
export function statusTone(status: HealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    case 'degraded':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
    case 'critical':
      return 'bg-red-500/15 text-red-600 dark:text-red-400'
    default:
      return 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400'
  }
}

/** Dot color for a status chip. */
export function statusDot(status: HealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'bg-emerald-500'
    case 'degraded':
      return 'bg-amber-500'
    case 'critical':
      return 'bg-red-500'
    default:
      return 'bg-zinc-400'
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatKbps(v: number | null): string {
  if (v === null) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(1)} Mbps` : `${v} kbps`
}

export function formatResolution(f: StreamFacts | null): string {
  if (!f || f.width === null || f.height === null) return '—'
  return `${f.width}×${f.height}${f.fps !== null ? `@${f.fps}` : ''}`
}

export function formatDb(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)} dB`
}

export function formatMs(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)} ms`
}

export function formatAgo(sec: number | null): string {
  if (sec === null) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

// ---------------------------------------------------------------------------
// Per-room threshold editor
// ---------------------------------------------------------------------------

/** The editable threshold keys, mirroring the core contract order. */
export const THRESHOLD_KEYS = [
  'sample_interval_sec',
  'silence_db',
  'silence_duration_sec',
  'desync_ms',
  'stall_sec',
  'bitrate_drop_pct',
  'recover_samples',
] as const

export type ThresholdKey = (typeof THRESHOLD_KEYS)[number]

export const THRESHOLD_BOUNDS: Record<ThresholdKey, [number, number]> = {
  sample_interval_sec: [2, 300],
  silence_db: [-120, 0],
  silence_duration_sec: [1, 600],
  desync_ms: [10, 10000],
  stall_sec: [2, 600],
  bitrate_drop_pct: [0, 95],
  recover_samples: [1, 10],
}

/**
 * Build the PUT body from the editor's raw string inputs: blank = inherit
 * (key omitted), anything else must parse to a finite number within bounds.
 * Returns null when any field is invalid (the form highlights it instead of
 * saving).
 */
export function buildOverride(
  form: Partial<Record<ThresholdKey, string>>,
): Partial<Record<ThresholdKey, number>> | null {
  const out: Partial<Record<ThresholdKey, number>> = {}
  for (const key of THRESHOLD_KEYS) {
    const raw = form[key]
    if (raw === undefined || raw.trim() === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n)) return null
    const [min, max] = THRESHOLD_BOUNDS[key]
    if (n < min || n > max) return null
    out[key] = n
  }
  return out
}

/** Seed the editor's string form from a stored override. */
export function formFromOverride(
  override: Partial<Record<ThresholdKey, number>> | null | undefined,
): Partial<Record<ThresholdKey, string>> {
  const out: Partial<Record<ThresholdKey, string>> = {}
  for (const key of THRESHOLD_KEYS) {
    const v = override?.[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = String(v)
  }
  return out
}
