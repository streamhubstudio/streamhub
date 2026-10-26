/**
 * vision — PURE polygon/line editor geometry (no React/DOM), unit-testable
 * under node:test. The React shells (index.tsx / PolygonEditor.tsx) only paint
 * and plumb pointers.
 *
 * Coordinate convention — shared with the backend `config_json` (Wave-2
 * CONTRACT): normalized [0,1] over the video frame, screen coords (y DOWN).
 *   - occupancy / crowd zones: `points: [[x,y]…]` polygons (≥3 vertices);
 *   - counting lines: `{ x, y, length, angle, inside }` — an anchor point, a
 *     length + angle (degrees) and which side (top/bottom/left/right) is INSIDE.
 */

export type Point = [number, number]

export type ZoneDetect = 'personas' | 'vehiculos'
export type Inside = 'top' | 'bottom' | 'left' | 'right'

export interface Zone {
  id: string
  tag: string
  detect: ZoneDetect
  points: Point[]
  confidence?: number
  alertLimit?: number
  alertAfterSec?: number
}

export interface Line {
  id: string
  tag: string
  x: number
  y: number
  length: number
  angle: number
  inside: Inside
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Round to 4 decimals — sub-pixel at any resolution. */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

/** Pointer event position → normalized [0,1] coords within `rect`. */
export function normPoint(rect: Rect, clientX: number, clientY: number): Point {
  if (rect.width <= 0 || rect.height <= 0) return [0, 0]
  return [
    clamp01((clientX - rect.left) / rect.width),
    clamp01((clientY - rect.top) / rect.height),
  ]
}

/** Snap a normalized point to 4 decimals. */
export function snap(p: Point): Point {
  return [round4(clamp01(p[0])), round4(clamp01(p[1]))]
}

// ---------------------------------------------------------------------------
// polygons (occupancy / crowd)
// ---------------------------------------------------------------------------

/** Centroid of a polygon (mean of vertices); [0,0] when empty. */
export function centroid(points: Point[]): Point {
  if (points.length === 0) return [0, 0]
  let sx = 0
  let sy = 0
  for (const [x, y] of points) {
    sx += x
    sy += y
  }
  return [sx / points.length, sy / points.length]
}

/**
 * Ray-casting point-in-polygon test (even-odd rule). A point exactly on an
 * edge is treated deterministically but not specially — fine for hit-testing a
 * click inside a zone.
 */
export function pointInPolygon(points: Point[], p: Point): boolean {
  if (points.length < 3) return false
  const [px, py] = p
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    const intersect =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Index of the vertex within `tol` (normalized) of `p`, nearest first, or -1.
 * Lets the editor grab-and-drag a single vertex.
 */
export function nearestVertex(points: Point[], p: Point, tol = 0.03): number {
  let best = -1
  let bestD = tol
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - p[0], points[i][1] - p[1])
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** A regular starter polygon (small centered quad) for a new zone. */
export function defaultZonePoints(): Point[] {
  return [
    [0.35, 0.35],
    [0.65, 0.35],
    [0.65, 0.65],
    [0.35, 0.65],
  ]
}

// ---------------------------------------------------------------------------
// POIs (owner item 34) — generic tagged polygon regions for counting +
// demography. Reuse the Zone shape in the editor (detect is unused for a POI);
// they (de)serialize as `{ pois: [{ id, tag, points }] }` in the config_json.
// ---------------------------------------------------------------------------

/** Parse a model's `config_json.pois` into editor polygons (garbage-safe). */
export function parsePois(config: unknown): Zone[] {
  const pois = (config as { pois?: unknown })?.pois
  if (!Array.isArray(pois)) return []
  return pois.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>
    const pts = Array.isArray(o.points)
      ? (o.points as unknown[]).map((p) => {
          const a = Array.isArray(p) ? p : [0, 0]
          return [clamp01(num(a[0], 0)), clamp01(num(a[1], 0))] as Point
        })
      : []
    return {
      id: typeof o.id === 'string' && o.id.trim() ? o.id : `poi-${i + 1}`,
      tag: typeof o.tag === 'string' ? o.tag : '',
      detect: 'personas' as ZoneDetect, // unused for a POI; kept so it reuses the Zone editor
      points: pts,
    }
  })
}

/** Serialize editor POIs (snapped) — only real polygons (>= 3 vertices) survive. */
export function poisToConfig(pois: Zone[]): { pois: { id: string; tag: string; points: Point[] }[] } {
  return {
    pois: pois
      .filter((p) => p.points.length >= 3)
      .map((p) => ({ id: p.id, tag: p.tag, points: p.points.map((pt) => snap(pt)) })),
  }
}

/** A starter POI polygon (offset from the zone default so a new one is visible). */
export function defaultPoiPoints(): Point[] {
  return [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.7, 0.7],
    [0.3, 0.7],
  ]
}

// ---------------------------------------------------------------------------
// lines (counting)
// ---------------------------------------------------------------------------

/** The two endpoints of a counting line, normalized (for drawing). */
export function lineEndpoints(line: Pick<Line, 'x' | 'y' | 'length' | 'angle'>): {
  p1: Point
  p2: Point
} {
  const rad = (line.angle * Math.PI) / 180
  return {
    p1: [line.x, line.y],
    p2: [line.x + line.length * Math.cos(rad), line.y + line.length * Math.sin(rad)],
  }
}

/** Build a line's `{x,y,length,angle}` from two dragged endpoints. */
export function lineFromEndpoints(p1: Point, p2: Point): Pick<Line, 'x' | 'y' | 'length' | 'angle'> {
  const dx = p2[0] - p1[0]
  const dy = p2[1] - p1[1]
  const length = round4(Math.hypot(dx, dy))
  const angle = round4((Math.atan2(dy, dx) * 180) / Math.PI)
  return { x: round4(clamp01(p1[0])), y: round4(clamp01(p1[1])), length, angle }
}

/** A default horizontal counting line across the middle. */
export function defaultLine(): Pick<Line, 'x' | 'y' | 'length' | 'angle'> {
  return { x: 0.2, y: 0.5, length: 0.6, angle: 0 }
}

// ---------------------------------------------------------------------------
// config_json (de)serialization for the settings PUT / GET
// ---------------------------------------------------------------------------

/** Parse an occupancy/crowd `config_json` into editor zones (garbage-safe). */
export function parseZones(config: unknown): Zone[] {
  const zones = (config as { zones?: unknown })?.zones
  if (!Array.isArray(zones)) return []
  return zones.map((z, i) => parseZone(z, i))
}

function parseZone(raw: unknown, i: number): Zone {
  const o = (raw ?? {}) as Record<string, unknown>
  const pts = Array.isArray(o.points)
    ? (o.points as unknown[]).map((p) => {
        const a = Array.isArray(p) ? p : [0, 0]
        return [clamp01(num(a[0], 0)), clamp01(num(a[1], 0))] as Point
      })
    : []
  const zone: Zone = {
    id: typeof o.id === 'string' && o.id.trim() ? o.id : `zone-${i + 1}`,
    tag: typeof o.tag === 'string' ? o.tag : '',
    detect: o.detect === 'vehiculos' ? 'vehiculos' : 'personas',
    points: pts,
  }
  if (o.confidence !== undefined) zone.confidence = clamp01(num(o.confidence, 0.35))
  if (o.alertLimit !== undefined) zone.alertLimit = Math.round(num(o.alertLimit, 0))
  if (o.alertAfterSec !== undefined) zone.alertAfterSec = Math.round(num(o.alertAfterSec, 0))
  return zone
}

/** Serialize editor zones back into `config_json` (rounded). */
export function zonesToConfig(zones: Zone[]): { zones: Zone[] } {
  return {
    zones: zones.map((z) => ({
      ...z,
      points: z.points.map((p) => snap(p)),
    })),
  }
}

/** Parse a counting `config_json` into editor lines (+ optional POIs). */
export function parseLines(config: unknown): {
  lines: Line[]
  fps: number
  capacity?: number
  pois: Zone[]
} {
  const c = (config ?? {}) as Record<string, unknown>
  const raw = Array.isArray(c.lines) ? c.lines : []
  const lines = raw.map((l, i) => parseLine(l, i))
  const out: { lines: Line[]; fps: number; capacity?: number; pois: Zone[] } = {
    lines,
    fps: num(c.fps, 3.5),
    pois: parsePois(config),
  }
  if (c.capacity !== undefined) out.capacity = Math.round(num(c.capacity, 0))
  return out
}

function parseLine(raw: unknown, i: number): Line {
  const o = (raw ?? {}) as Record<string, unknown>
  const inside: Inside =
    o.inside === 'top' || o.inside === 'bottom' || o.inside === 'left' || o.inside === 'right'
      ? o.inside
      : 'top'
  return {
    id: typeof o.id === 'string' && o.id.trim() ? o.id : `line-${i + 1}`,
    tag: typeof o.tag === 'string' ? o.tag : '',
    x: clamp01(num(o.x, 0.2)),
    y: clamp01(num(o.y, 0.5)),
    length: num(o.length, 0.6),
    angle: num(o.angle, 0),
    inside,
  }
}

/** Serialize editor lines (+ optional POIs) back into `config_json`. */
export function linesToConfig(
  lines: Line[],
  fps: number,
  capacity?: number,
  pois?: Zone[],
): { lines: Line[]; fps: number; capacity?: number; pois?: { id: string; tag: string; points: Point[] }[] } {
  const out: {
    lines: Line[]
    fps: number
    capacity?: number
    pois?: { id: string; tag: string; points: Point[] }[]
  } = {
    lines: lines.map((l) => ({
      ...l,
      x: round4(l.x),
      y: round4(l.y),
      length: round4(l.length),
      angle: round4(l.angle),
    })),
    fps: round4(fps),
  }
  if (capacity !== undefined && capacity > 0) out.capacity = Math.round(capacity)
  if (pois && pois.length) {
    const p = poisToConfig(pois).pois
    if (p.length) out.pois = p
  }
  return out
}

/** Whether a model draws polygons (zones) or lines. */
export function isZoneModel(model: string): boolean {
  return model === 'occupancy' || model === 'crowd'
}

/**
 * Which editor a model's per-room settings use:
 *   - 'zones' — occupancy / crowd: N tagged polygons (config `{ zones }`);
 *   - 'lines' — counting: N tagged crossing lines (config `{ lines, fps }`);
 *   - 'roi'   — demography: ONE optional region-of-interest polygon plus an
 *     inference interval + engine (config `{ roi?, intervalSec, engine }`).
 */
export type EditorMode = 'zones' | 'lines' | 'roi'

export function editorMode(model: string): EditorMode {
  if (model === 'counting') return 'lines'
  if (model === 'demography') return 'roi'
  return 'zones' // occupancy / crowd (and any unknown → safest default)
}

// ---------------------------------------------------------------------------
// demography ROI (a single optional polygon + interval + engine)
// ---------------------------------------------------------------------------

export type DemographyEngine = 'local' | 'openai' | 'deepseek'

export interface Demography {
  /** The ROI polygon as a single editor zone, or null when unset (whole frame). */
  roi: Zone | null
  intervalSec: number
  engine: DemographyEngine
  /** Tagged POIs (owner item 34) — a face is gated + named by the POI it's in. */
  pois: Zone[]
}

const ENGINES: DemographyEngine[] = ['local', 'openai', 'deepseek']

/** Parse a demography `config_json` into the editor shape (garbage-safe). */
export function parseDemography(config: unknown): Demography {
  const c = (config ?? {}) as Record<string, unknown>
  const roiRaw = (c.roi as { points?: unknown })?.points
  let roi: Zone | null = null
  if (Array.isArray(roiRaw) && roiRaw.length > 0) {
    roi = {
      id: 'roi',
      tag: '',
      detect: 'personas',
      points: (roiRaw as unknown[]).map((p) => {
        const a = Array.isArray(p) ? p : [0, 0]
        return [clamp01(num(a[0], 0)), clamp01(num(a[1], 0))] as Point
      }),
    }
  }
  const engine = ENGINES.includes(c.engine as DemographyEngine)
    ? (c.engine as DemographyEngine)
    : 'local'
  return { roi, intervalSec: Math.round(num(c.intervalSec, 120)), engine, pois: parsePois(config) }
}

/** Serialize the demography editor shape back into `config_json`. */
export function demographyToConfig(d: Demography): {
  roi?: { points: Point[] }
  pois?: { id: string; tag: string; points: Point[] }[]
  intervalSec: number
  engine: DemographyEngine
} {
  const out: {
    roi?: { points: Point[] }
    pois?: { id: string; tag: string; points: Point[] }[]
    intervalSec: number
    engine: DemographyEngine
  } = {
    intervalSec: Math.round(d.intervalSec),
    engine: d.engine,
  }
  // Only emit an ROI once it is a real polygon (>= 3 vertices) — a partial draw
  // would be rejected by the backend validator.
  if (d.roi && d.roi.points.length >= 3) {
    out.roi = { points: d.roi.points.map((p) => snap(p)) }
  }
  if (d.pois && d.pois.length) {
    const p = poisToConfig(d.pois).pois
    if (p.length) out.pois = p
  }
  return out
}
