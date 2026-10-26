/**
 * Pure helpers for the Perimeter plugin — no React/DOM (unit-tested via
 * logic.spec.ts under node:test). The React surface (index.tsx) imports these
 * so zone parsing/serialization and live-payload validation stay identical to
 * what's tested — and identical in SEMANTICS to the Python worker's
 * perimeter_worker/geometry.parse_zones (rect shorthand + polygons, clamped
 * normalized coords, garbage dropped instead of thrown).
 */
import type { ConfigValues } from '../../plugins/types.ts'

export type ArmMode = 'schedule' | 'armed' | 'disarmed'

export interface Zone {
  id: string
  /** Normalized 0-1 polygon vertices (>= 3). */
  points: [number, number][]
}

export interface PersonBox {
  /** Normalized [x, y, w, h]. */
  bbox: [number, number, number, number]
  conf: number
}

export interface PerimeterAlert {
  id: number
  ts: number
  zone: string
  confidence: number
  acked: boolean
  snapshot?: string
  clip?: string
  /** Base64 JPEG preview (only the newest few carry one). */
  thumb?: string
}

/** The worker's live status payload (see perimeter-worker/README.md). */
export interface PerimeterStatus {
  room: string
  ts: number
  armed: boolean
  mode: ArmMode
  zones: number
  persons: PersonBox[]
  alerts: PerimeterAlert[]
  unacked: number
  /** Base64 JPEG frame preview for the zone editor (may be empty). */
  frame: string
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

const ARM_MODES: ArmMode[] = ['schedule', 'armed', 'disarmed']

/** Effective room from plugin config ('' when unset — the tab asks for it). */
export function resolveRoom(config: ConfigValues | undefined): string {
  const raw = config?.room
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Effective arm mode from plugin config (defaults to schedule). */
export function resolveArmMode(config: ConfigValues | undefined): ArmMode {
  const raw = config?.armMode
  return typeof raw === 'string' && ARM_MODES.includes(raw as ArmMode)
    ? (raw as ArmMode)
    : 'schedule'
}

// ---------------------------------------------------------------------------
// Zones: config JSON ⇄ editor model (mirrors the worker's parse_zones)
// ---------------------------------------------------------------------------

function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}

function rectToPoints(rect: unknown): [number, number][] | null {
  if (!Array.isArray(rect) || rect.length !== 4) return null
  const [x, y, w, h] = rect.map(Number)
  if ([x, y, w, h].some((v) => !Number.isFinite(v)) || w <= 0 || h <= 0) {
    return null
  }
  const x1 = round4(clamp01(x))
  const y1 = round4(clamp01(y))
  const x2 = round4(clamp01(x + w))
  const y2 = round4(clamp01(y + h))
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null
  return [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ]
}

/** Parse the `zones` config value (JSON string) into the editor model.
 * Unusable entries are dropped, never thrown — a config typo must not crash
 * the tab (same rule as the worker).
 */
export function parseZonesConfig(raw: unknown): Zone[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []

  const zones: Zone[] = []
  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as Record<string, unknown> | null
    if (!entry || typeof entry !== 'object') continue
    let points: [number, number][] | null = null
    if (Array.isArray(entry.rect)) {
      points = rectToPoints(entry.rect)
    } else if (Array.isArray(entry.points)) {
      const pts: [number, number][] = []
      for (const p of entry.points) {
        if (!Array.isArray(p) || p.length < 2) {
          points = null
          pts.length = 0
          break
        }
        const px = Number(p[0])
        const py = Number(p[1])
        if (!Number.isFinite(px) || !Number.isFinite(py)) {
          pts.length = 0
          break
        }
        pts.push([round4(clamp01(px)), round4(clamp01(py))])
      }
      if (pts.length >= 3) points = pts
    }
    if (!points) continue
    const id =
      typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim()
        : `zone-${i + 1}`
    zones.push({ id, points })
  }
  return zones
}

/** Serialize the editor model back into the `zones` config JSON. */
export function zonesToConfig(zones: Zone[]): string {
  return JSON.stringify(
    zones.map((z) => ({
      id: z.id,
      points: z.points.map(([x, y]) => [round4(x), round4(y)]),
    })),
  )
}

/** First free `zone-N` id (drawing assigns it; the list can rename). */
export function nextZoneId(zones: Zone[]): string {
  const taken = new Set(zones.map((z) => z.id))
  let n = zones.length + 1
  while (taken.has(`zone-${n}`)) n++
  return `zone-${n}`
}

/**
 * Commit a mouse drag (two normalized corners, any order) into a rect zone.
 * Returns null for degenerate drags (under ~2% of the frame in either axis)
 * so a stray click never creates an invisible zone.
 */
export function rectToZone(
  a: { x: number; y: number },
  b: { x: number; y: number },
  id: string,
  minSize = 0.02,
): Zone | null {
  const x1 = clamp01(Math.min(a.x, b.x))
  const y1 = clamp01(Math.min(a.y, b.y))
  const x2 = clamp01(Math.max(a.x, b.x))
  const y2 = clamp01(Math.max(a.y, b.y))
  if (x2 - x1 < minSize || y2 - y1 < minSize) return null
  const points = rectToPoints([x1, y1, x2 - x1, y2 - y1])
  return points ? { id, points } : null
}

/** SVG polygon `points` attribute in a 0-100 viewBox. */
export function pointsToSvg(points: [number, number][]): string {
  return points.map(([x, y]) => `${round4(x * 100)},${round4(y * 100)}`).join(' ')
}

// ---------------------------------------------------------------------------
// Live status payload
// ---------------------------------------------------------------------------

function toPerson(raw: unknown): PersonBox | null {
  const p = raw as Record<string, unknown> | null
  if (!p || typeof p !== 'object' || !Array.isArray(p.bbox) || p.bbox.length !== 4) {
    return null
  }
  const bbox = p.bbox.map(Number)
  if (bbox.some((v) => !Number.isFinite(v))) return null
  return {
    bbox: bbox as [number, number, number, number],
    conf: Number(p.conf) || 0,
  }
}

function toAlert(raw: unknown): PerimeterAlert | null {
  const a = raw as Record<string, unknown> | null
  if (!a || typeof a !== 'object') return null
  const ts = Number(a.ts)
  if (!Number.isFinite(ts)) return null
  return {
    id: Number(a.id) || 0,
    ts,
    zone: typeof a.zone === 'string' ? a.zone : '?',
    confidence: Number(a.confidence) || 0,
    acked: Boolean(a.acked),
    snapshot: typeof a.snapshot === 'string' ? a.snapshot : '',
    clip: typeof a.clip === 'string' ? a.clip : '',
    thumb: typeof a.thumb === 'string' ? a.thumb : '',
  }
}

/** Validate + normalize the polled live payload; null when unusable. */
export function parseStatus(payload: unknown): PerimeterStatus | null {
  const p = payload as Record<string, unknown> | null
  if (!p || typeof p !== 'object' || typeof p.armed !== 'boolean') return null
  const mode =
    typeof p.mode === 'string' && ARM_MODES.includes(p.mode as ArmMode)
      ? (p.mode as ArmMode)
      : 'schedule'
  const persons = Array.isArray(p.persons)
    ? (p.persons.map(toPerson).filter(Boolean) as PersonBox[])
    : []
  const alerts = Array.isArray(p.alerts)
    ? (p.alerts.map(toAlert).filter(Boolean) as PerimeterAlert[])
    : []
  return {
    room: typeof p.room === 'string' ? p.room : '',
    ts: Number(p.ts) || 0,
    armed: p.armed,
    mode,
    zones: Number(p.zones) || 0,
    persons,
    alerts,
    unacked: Number(p.unacked) || 0,
    frame: typeof p.frame === 'string' ? p.frame : '',
  }
}

/** "91%" for the alert rows / person boxes. */
export function formatConfidence(conf: number): string {
  return `${Math.round(clamp01(conf) * 100)}%`
}
