/**
 * safety-ppe frontend logic — pure helpers (unit-tested under node:test).
 *
 * Zone (de)serialization mirrors the worker's zones.py semantics (tolerant
 * parse, 0–1 clamping, zero-area drop) so what the editor writes is exactly
 * what the worker reads. The violations table is built from the worker's
 * structured JSON log lines (`event: "violation"`) mirrored into the plugin
 * logs endpoint — the durable archive lives in <DATA_DIR>/safety-ppe.db.
 */

export interface ZoneDraft {
  name: string
  /** Normalized 0–1 frame-relative rect. */
  x: number
  y: number
  w: number
  h: number
}

export interface ViolationRow {
  /** Unix seconds (worker log timestamp). */
  ts: number
  zone: string
  missing: string[]
  confidence: number
  /** Absolute snapshot path on the server ('' when none was written). */
  snapshot: string
}

/** A worker log line as returned by GET /apps/:app/plugins/:id/logs. */
export interface WorkerLogLine {
  ts?: string
  stream?: string
  line?: string
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/** Parse the plugin's `zones` config JSON into editor drafts ([] on any problem). */
export function parseZones(raw: unknown): ZoneDraft[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: ZoneDraft[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const name = String((entry as Record<string, unknown>).name ?? '').trim()
    const rect = (entry as Record<string, unknown>).rect
    if (!name || seen.has(name) || !Array.isArray(rect) || rect.length !== 4) continue
    const [x, y, w, h] = rect.map((v) => clamp01(Number(v)))
    out.push({ name, x, y, w, h })
    seen.add(name)
  }
  return out
}

/**
 * Serialize editor drafts back to the config JSON string. Nameless or
 * zero-area zones are dropped; rects are clamped so x+w ≤ 1 and y+h ≤ 1.
 * No valid zones → '' (the worker then watches the whole frame as zone "all").
 */
export function serializeZones(zones: ZoneDraft[]): string {
  const clean = []
  const seen = new Set<string>()
  for (const z of zones) {
    const name = z.name.trim()
    if (!name || seen.has(name)) continue
    const x = clamp01(z.x)
    const y = clamp01(z.y)
    const w = Math.min(clamp01(z.w), 1 - x)
    const h = Math.min(clamp01(z.h), 1 - y)
    if (w <= 0 || h <= 0) continue
    clean.push({ name, rect: [x, y, w, h] })
    seen.add(name)
  }
  return clean.length ? JSON.stringify(clean) : ''
}

/** 'HH:MM-HH:MM' (or empty = always). Mirrors the worker's parse_hours. */
export function isValidHours(raw: string): boolean {
  if (!raw.trim()) return true
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(raw)
  if (!m) return false
  const [h1, m1, h2, m2] = m.slice(1).map(Number)
  return h1 <= 23 && h2 <= 23 && m1 <= 59 && m2 <= 59
}

/** Day names/ranges/ISO numbers (or empty = every day). Mirrors parse_days. */
export function isValidDays(raw: string): boolean {
  if (!raw.trim()) return true
  const token = /^(mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?|[1-7])$/i
  return raw.split(',').every((part) => {
    const p = part.trim()
    if (!p) return false
    if (p.includes('-')) {
      const [lo, hi, ...rest] = p.split('-')
      return rest.length === 0 && token.test(lo.trim()) && token.test(hi.trim())
    }
    return token.test(p)
  })
}

/**
 * Worker log lines → violation table rows, newest first.
 *
 * Each worker stdout line is a JSON record; only `event === "violation"`
 * lines become rows. Non-JSON / foreign lines are skipped silently (the ring
 * also carries start/zones/schedule lines and system messages).
 */
export function parseViolationLogs(lines: WorkerLogLine[]): ViolationRow[] {
  const rows: ViolationRow[] = []
  for (const entry of lines) {
    if (!entry?.line) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(entry.line)
    } catch {
      continue
    }
    if (!rec || rec.event !== 'violation') continue
    const missing = Array.isArray(rec.missing) ? rec.missing.map(String) : []
    rows.push({
      ts: typeof rec.ts === 'number' ? rec.ts : 0,
      zone: String(rec.zone ?? ''),
      missing,
      confidence: typeof rec.confidence === 'number' ? rec.confidence : 0,
      snapshot: String(rec.snapshot ?? ''),
    })
  }
  rows.sort((a, b) => b.ts - a.ts)
  return rows
}
