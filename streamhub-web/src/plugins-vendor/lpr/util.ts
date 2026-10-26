/**
 * LPR frontend — PURE logic (node:test'able, no React/DOM).
 *
 * Mirrors the worker's plate normalization/list parsing (lpr-worker
 * plates.py) so what the operator types in the whitelist editor matches what
 * the worker will match, and defensively parses the live-data payload the
 * worker pushes ({ room, ts, last, recent }) into typed reads for the table.
 */

export interface LprRead {
  plate: string
  confidence: number
  /** Unix seconds (float). */
  ts: number
  listMatch: 'whitelist' | 'blacklist' | null
  snapshot: string | null
  /** Base64 JPEG — only ever present on the `last` read. */
  thumb?: string
}

export interface LprLiveView {
  last: LprRead | null
  recent: LprRead[]
}

/** Canonical plate form: uppercase A–Z0–9 only (mirrors the worker). */
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, '')
}

/** Parse a comma/semicolon/newline-separated list → normalized, de-duped. */
export function parsePlateList(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const chunk of raw.split(/[,;\n\r]+/)) {
    const plate = normalizePlate(chunk)
    if (plate && !seen.has(plate)) {
      seen.add(plate)
      out.push(plate)
    }
  }
  return out
}

/** Editor round-trip: canonical textarea form (one plate per line). */
export function formatPlateList(plates: string[]): string {
  return plates.join('\n')
}

/** Normalize a whole textarea value to the canonical stored config string. */
export function canonicalListConfig(raw: string): string {
  return formatPlateList(parsePlateList(raw))
}

function toRead(value: unknown): LprRead | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.plate !== 'string' || !v.plate) return null
  const listMatch =
    v.listMatch === 'whitelist' || v.listMatch === 'blacklist'
      ? v.listMatch
      : null
  return {
    plate: v.plate,
    confidence: typeof v.confidence === 'number' ? v.confidence : 0,
    ts: typeof v.ts === 'number' ? v.ts : 0,
    listMatch,
    snapshot: typeof v.snapshot === 'string' && v.snapshot ? v.snapshot : null,
    thumb: typeof v.thumb === 'string' && v.thumb ? v.thumb : undefined,
  }
}

/**
 * Defensive parse of the worker's live payload. Anything malformed collapses
 * to an empty view rather than throwing mid-render.
 */
export function parseLivePayload(payload: unknown): LprLiveView {
  if (!payload || typeof payload !== 'object') return { last: null, recent: [] }
  const p = payload as Record<string, unknown>
  const recent = Array.isArray(p.recent)
    ? (p.recent.map(toRead).filter(Boolean) as LprRead[])
    : []
  return { last: toRead(p.last), recent }
}

/** Base name of a snapshot path (the table shows the file, not the abs path). */
export function snapshotName(path: string | null): string {
  if (!path) return ''
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}
