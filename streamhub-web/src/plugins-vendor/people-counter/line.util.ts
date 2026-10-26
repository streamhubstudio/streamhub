/**
 * people-counter — PURE line-editor + counters logic (no React/DOM), so it is
 * unit-testable under node:test. The React shells (index.tsx / LineEditor.tsx)
 * only do painting, pointer plumbing and polling.
 *
 * Coordinate convention — shared with the worker (people-counter-worker/
 * people_counter_worker/geometry.py, ported from Vision One): normalized
 * [0,1] over the video frame, screen coords (y DOWN); the line is DIRECTED
 * p1→p2; `inDirection: 'right' | 'left'` says which side of p1→p2 is INSIDE
 * (crossing onto it = IN). The arrow the editor draws is the unit
 * perpendicular pointing at that side — flipping the arrow just swaps
 * `inDirection`, rotating it means dragging the endpoints.
 */
import type { ConfigValues } from '../../plugins/types.ts'

export interface LineValue {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type InDirection = 'right' | 'left'

export const DEFAULT_LINE: LineValue = { x1: 0.2, y1: 0.5, x2: 0.8, y2: 0.5 }

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Round to 4 decimals — plenty for sub-pixel precision at any resolution. */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

/** The persisted line from a config bag — clamped, garbage-safe. */
export function resolveLine(config: ConfigValues | undefined): LineValue {
  const c = config ?? {}
  return {
    x1: clamp01(num(c.lineX1, DEFAULT_LINE.x1)),
    y1: clamp01(num(c.lineY1, DEFAULT_LINE.y1)),
    x2: clamp01(num(c.lineX2, DEFAULT_LINE.x2)),
    y2: clamp01(num(c.lineY2, DEFAULT_LINE.y2)),
  }
}

export function resolveInDirection(config: ConfigValues | undefined): InDirection {
  const v = config?.inDirection
  return v === 'left' ? 'left' : 'right'
}

export function flipDirection(d: InDirection): InDirection {
  return d === 'right' ? 'left' : 'right'
}

/** Two lines equal (used for the dirty check before enabling Save). */
export function sameLine(a: LineValue, b: LineValue): boolean {
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2
}

/**
 * The config PATCH payload for a drawn line + arrow — exactly the four
 * normalized coordinate fields plus the side, rounded so the stored config
 * stays readable. This is what the Save button sends.
 */
export function lineToPatch(
  line: LineValue,
  inDirection: InDirection,
): ConfigValues {
  return {
    lineX1: round4(clamp01(line.x1)),
    lineY1: round4(clamp01(line.y1)),
    lineX2: round4(clamp01(line.x2)),
    lineY2: round4(clamp01(line.y2)),
    inDirection,
  }
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** Pointer event position → normalized [0,1] coords within `rect`. */
export function normPoint(
  rect: Rect,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  }
}

/**
 * Which endpoint (1 | 2) is within `tol` (normalized) of p, or null. Lets the
 * editor grab-and-drag an existing endpoint instead of redrawing.
 */
export function nearestEndpoint(
  line: LineValue,
  p: { x: number; y: number },
  tol = 0.04,
): 1 | 2 | null {
  const d1 = Math.hypot(p.x - line.x1, p.y - line.y1)
  const d2 = Math.hypot(p.x - line.x2, p.y - line.y2)
  if (d1 <= tol && d1 <= d2) return 1
  if (d2 <= tol) return 2
  return null
}

export function withEndpoint(
  line: LineValue,
  which: 1 | 2,
  p: { x: number; y: number },
): LineValue {
  return which === 1
    ? { ...line, x1: p.x, y1: p.y }
    : { ...line, x2: p.x, y2: p.y }
}

/**
 * The IN arrow: midpoint of the line + the unit perpendicular pointing at the
 * `inDirection` side of p1→p2 (screen coords, y down — matches the worker's
 * cross-product sign: for v = p2−p1 the RIGHT side is (−vy, vx)).
 * Returns null for a degenerate (zero-length) line.
 */
export function arrowFor(
  line: LineValue,
  inDirection: InDirection,
): { mid: { x: number; y: number }; dir: { x: number; y: number } } | null {
  const vx = line.x2 - line.x1
  const vy = line.y2 - line.y1
  const len = Math.hypot(vx, vy)
  if (len === 0) return null
  const ux = vx / len
  const uy = vy / len
  const dir =
    inDirection === 'right' ? { x: -uy, y: ux } : { x: uy, y: -ux }
  return {
    mid: { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 },
    dir,
  }
}

/** Line orientation in degrees (0 = →, 90 = ↓ in screen coords), for display. */
export function angleDeg(line: LineValue): number {
  const deg = (Math.atan2(line.y2 - line.y1, line.x2 - line.x1) * 180) / Math.PI
  return Math.round(((deg % 360) + 360) % 360)
}

// ---------------------------------------------------------------------------
// Live counters — parsed from the worker's structured log lines
// ---------------------------------------------------------------------------

export interface Counters {
  in: number
  out: number
  occupancy: number
  capacity: number
  tracking: number
  ts: number | null
}

interface WorkerLogLine {
  ts?: string
  stream?: string
  line?: string
}

/**
 * Latest counters from the plugin worker logs (GET :id/logs → workerLogs,
 * newest LAST). The worker emits `counters` / `crossing` JSON lines carrying
 * in/out/occupancy; scan backwards for the freshest one. Malformed lines are
 * skipped — worker stdout can interleave non-JSON output.
 */
export function parseCounters(
  workerLogs: WorkerLogLine[] | undefined | null,
): Counters | null {
  if (!Array.isArray(workerLogs)) return null
  for (let i = workerLogs.length - 1; i >= 0; i--) {
    const raw = workerLogs[i]?.line
    if (typeof raw !== 'string' || raw.indexOf('{') !== 0) continue
    let rec: unknown
    try {
      rec = JSON.parse(raw)
    } catch {
      continue
    }
    if (!rec || typeof rec !== 'object') continue
    const r = rec as Record<string, unknown>
    if (r.event !== 'counters' && r.event !== 'crossing') continue
    return {
      in: num(r.in, 0),
      out: num(r.out, 0),
      occupancy: num(r.occupancy, 0),
      capacity: num(r.capacity, 0),
      tracking: num(r.tracking, 0),
      ts: typeof r.ts === 'number' ? r.ts : null,
    }
  }
  return null
}
