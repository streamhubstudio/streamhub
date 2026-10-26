/**
 * Presence plugin — PURE logic (no React/DOM) so it runs under node:test.
 *
 * Everything the presence tab needs to compute: zone JSON (de)serialization
 * shared with the backend config field, rect math for the canvas zone editor,
 * live-payload parsing (GET /apps/:app/plugins/presence/data) and the
 * carry-forward step-function segments for the per-zone occupancy timeline.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A zone rect in NORMALIZED (0-1) frame coordinates — the config shape. */
export interface ZoneRect {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
}

/** Per-zone live status as pushed by the worker (monitor snapshot). */
export interface ZoneStatus {
  id: string
  name: string
  persons: number
  absent: boolean
  emptyForSec: number
  lastPresentTs: number | null
}

export interface PresenceEvent {
  event: string
  zone: string
  zoneName?: string
  ts: number
  persons?: number
  absentForSec?: number
  emptyForSec?: number
}

export interface TimelinePoint {
  ts: number
  zone: string
  persons: number
}

/** The live-data payload the worker pushes (see presence-worker/README.md). */
export interface PresenceState {
  room: string
  ts: number
  thresholdMin: number
  schedule: { window: string; days: string; tz: string; inSchedule: boolean }
  zones: ZoneStatus[]
  events: PresenceEvent[]
  timeline: TimelinePoint[]
}

// ---------------------------------------------------------------------------
// Zone config (de)serialization — mirror of the worker's tolerant parser
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** Parse the `zones` config JSON string (or array), skipping invalid entries. */
export function parseZones(raw: unknown): ZoneRect[] {
  let data: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return []
    try {
      data = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(data)) return []
  const out: ZoneRect[] = []
  const seen = new Set<string>()
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id.trim() : ''
    if (!id || seen.has(id)) continue
    const x = num(rec.x)
    const y = num(rec.y)
    const w = num(rec.w)
    const h = num(rec.h)
    if (x === null || y === null || w === null || h === null) continue
    const cx = clamp(x, 0, 1)
    const cy = clamp(y, 0, 1)
    const cw = clamp(w, 0, 1 - cx)
    const ch = clamp(h, 0, 1 - cy)
    if (cw <= 0 || ch <= 0) continue
    const name =
      typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : id
    seen.add(id)
    out.push({ id, name, x: cx, y: cy, w: cw, h: ch })
  }
  return out
}

/** Serialize zones for the plugin config PATCH (rounded, stable key order). */
export function serializeZones(zones: ZoneRect[]): string {
  const r = (v: number) => Math.round(v * 10000) / 10000
  return JSON.stringify(
    zones.map((z) => ({
      id: z.id,
      name: z.name,
      x: r(z.x),
      y: r(z.y),
      w: r(z.w),
      h: r(z.h),
    })),
  )
}

// ---------------------------------------------------------------------------
// Zone editor rect math
// ---------------------------------------------------------------------------

/** Minimum area (fraction of the frame) for a drag to count as a zone. */
export const MIN_ZONE_AREA = 0.001

/** Two drag points (normalized) → a clamped rect, or null if degenerate. */
export function rectFromDrag(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number; w: number; h: number } | null {
  const x1 = clamp(Math.min(a.x, b.x), 0, 1)
  const y1 = clamp(Math.min(a.y, b.y), 0, 1)
  const x2 = clamp(Math.max(a.x, b.x), 0, 1)
  const y2 = clamp(Math.max(a.y, b.y), 0, 1)
  const w = x2 - x1
  const h = y2 - y1
  if (w * h < MIN_ZONE_AREA) return null
  return { x: x1, y: y1, w, h }
}

/** A fresh unique id: zone-1, zone-2, … (never colliding with existing). */
export function nextZoneId(zones: ZoneRect[]): string {
  const taken = new Set(zones.map((z) => z.id))
  for (let i = zones.length + 1; ; i++) {
    const id = `zone-${i}`
    if (!taken.has(id)) return id
  }
}

/** Topmost (last-drawn) zone containing a normalized point, or null. */
export function hitZone(zones: ZoneRect[], px: number, py: number): string | null {
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i]
    if (px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h) return z.id
  }
  return null
}

// ---------------------------------------------------------------------------
// Live payload parsing
// ---------------------------------------------------------------------------

export function parseLivePayload(payload: unknown): PresenceState | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (typeof p.ts !== 'number' || !Array.isArray(p.zones)) return null
  const schedule = (p.schedule ?? {}) as Record<string, unknown>
  const zones: ZoneStatus[] = []
  for (const z of p.zones) {
    if (typeof z !== 'object' || z === null) continue
    const r = z as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    zones.push({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : r.id,
      persons: typeof r.persons === 'number' ? r.persons : 0,
      absent: r.absent === true,
      emptyForSec: typeof r.emptyForSec === 'number' ? r.emptyForSec : 0,
      lastPresentTs:
        typeof r.lastPresentTs === 'number' ? r.lastPresentTs : null,
    })
  }
  const events: PresenceEvent[] = []
  if (Array.isArray(p.events)) {
    for (const e of p.events) {
      if (typeof e !== 'object' || e === null) continue
      const r = e as Record<string, unknown>
      if (typeof r.event !== 'string' || typeof r.zone !== 'string') continue
      if (typeof r.ts !== 'number') continue
      events.push(r as unknown as PresenceEvent)
    }
  }
  const timeline: TimelinePoint[] = []
  if (Array.isArray(p.timeline)) {
    for (const t of p.timeline) {
      if (typeof t !== 'object' || t === null) continue
      const r = t as Record<string, unknown>
      if (
        typeof r.ts !== 'number' ||
        typeof r.zone !== 'string' ||
        typeof r.persons !== 'number'
      )
        continue
      timeline.push({ ts: r.ts, zone: r.zone, persons: r.persons })
    }
  }
  return {
    room: typeof p.room === 'string' ? p.room : '',
    ts: p.ts,
    thresholdMin: typeof p.thresholdMin === 'number' ? p.thresholdMin : 5,
    schedule: {
      window: typeof schedule.window === 'string' ? schedule.window : '',
      days: typeof schedule.days === 'string' ? schedule.days : '',
      tz: typeof schedule.tz === 'string' ? schedule.tz : '',
      inSchedule: schedule.inSchedule !== false,
    },
    zones,
    events,
    timeline,
  }
}

// ---------------------------------------------------------------------------
// Timeline segments (carry-forward step function)
// ---------------------------------------------------------------------------

/** One horizontal timeline slice: [start, end] as 0-1 fractions of the window. */
export interface TimelineSegment {
  start: number
  end: number
  persons: number
}

/**
 * Build render segments for one zone over the window [now - windowS, now].
 * The occupancy table is a step function (points only on change/heartbeat), so
 * each point's value carries FORWARD until the next point. A point older than
 * the window seeds the carry-in value; time before the first known value gets
 * no segment (unknown ≠ empty).
 */
export function zoneSegments(
  timeline: TimelinePoint[],
  zoneId: string,
  windowS: number,
  now: number,
): TimelineSegment[] {
  const start = now - windowS
  const pts = timeline
    .filter((t) => t.zone === zoneId)
    .sort((a, b) => a.ts - b.ts)
  if (pts.length === 0 || windowS <= 0) return []

  const frac = (ts: number) => clamp((ts - start) / windowS, 0, 1)
  const segments: TimelineSegment[] = []
  let curVal: number | null = null
  let curFrom = start

  for (const p of pts) {
    if (p.ts <= start) {
      curVal = p.persons // carry-in: latest value before the window
      continue
    }
    if (p.ts > now) break
    if (curVal !== null && p.ts > curFrom) {
      segments.push({ start: frac(curFrom), end: frac(p.ts), persons: curVal })
    }
    curVal = p.persons
    curFrom = Math.max(p.ts, start)
  }
  if (curVal !== null && now > curFrom) {
    segments.push({ start: frac(curFrom), end: 1, persons: curVal })
  }
  // Merge adjacent equal-value segments (cosmetic + fewer DOM nodes).
  const merged: TimelineSegment[] = []
  for (const s of segments) {
    const last = merged[merged.length - 1]
    if (last && last.persons === s.persons && Math.abs(last.end - s.start) < 1e-9) {
      last.end = s.end
    } else {
      merged.push({ ...s })
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Stable per-zone accent colors (index-based, cycles). */
const ZONE_COLORS = [
  '#34d399', // emerald
  '#60a5fa', // blue
  '#fbbf24', // amber
  '#f472b6', // pink
  '#a78bfa', // violet
  '#2dd4bf', // teal
]

export function zoneColor(index: number): string {
  return ZONE_COLORS[((index % ZONE_COLORS.length) + ZONE_COLORS.length) % ZONE_COLORS.length]
}

export const EVENT_LABELS: Record<string, { label: string; tone: 'bad' | 'ok' | 'warn' }> = {
  'presence.absent': { label: 'Absent', tone: 'bad' },
  'presence.returned': { label: 'Returned', tone: 'ok' },
  'presence.after_hours': { label: 'After hours', tone: 'warn' },
}

/** '5 s' / '3 min' / '2 h 05 min' — compact absence durations. */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} h ${String(rm).padStart(2, '0')} min` : `${h} h`
}

/** HH:MM:SS local wall clock for an event timestamp (unix seconds). */
export function formatClock(tsSec: number): string {
  const d = new Date(tsSec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
