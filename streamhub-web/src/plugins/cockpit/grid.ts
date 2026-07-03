/**
 * Cockpit — PURE grid/paging/ordering/settings helpers.
 *
 * No React, no DOM, no browser APIs, so this is unit-tested with node:test
 * (see ../cockpit.spec.ts). The panel component (CockpitPanel.tsx) is a thin
 * shell over these functions: it fetches streams, calls these to compute the
 * visible page + ordering, and persists the reordering via localStorage.
 */

// ---------------------------------------------------------------------------
// Grid layouts
// ---------------------------------------------------------------------------

export interface GridLayout {
  /** Stable id, also the value stored in config/localStorage. */
  id: string
  cols: number
  rows: number
  /** cols * rows — number of cells (and page size). */
  cells: number
}

/** The selectable surveillance layouts (kept in sync with the config schema). */
export const GRID_LAYOUTS: readonly GridLayout[] = [
  { id: '1x1', cols: 1, rows: 1, cells: 1 },
  { id: '2x2', cols: 2, rows: 2, cells: 4 },
  { id: '3x3', cols: 3, rows: 3, cells: 9 },
  { id: '4x3', cols: 4, rows: 3, cells: 12 },
]

export const DEFAULT_GRID = '4x3'

/** Resolve a layout id to its geometry, falling back to the default. */
export function getLayout(id: string | undefined): GridLayout {
  return (
    GRID_LAYOUTS.find((l) => l.id === id) ??
    GRID_LAYOUTS.find((l) => l.id === DEFAULT_GRID)!
  )
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Number of pages needed to show `total` items `perPage` at a time (min 1). */
export function pageCount(total: number, perPage: number): number {
  if (perPage <= 0) return 1
  return Math.max(1, Math.ceil(Math.max(0, total) / perPage))
}

/** Clamp a 0-based page index into `[0, pageCount-1]`. */
export function clampPage(page: number, total: number, perPage: number): number {
  const last = pageCount(total, perPage) - 1
  if (!Number.isFinite(page) || page < 0) return 0
  return Math.min(Math.floor(page), last)
}

/** The slice of `items` visible on 0-based `page` (page is clamped first). */
export function pageItems<T>(items: T[], page: number, perPage: number): T[] {
  if (perPage <= 0) return []
  const p = clampPage(page, items.length, perPage)
  const start = p * perPage
  return items.slice(start, start + perPage)
}

// ---------------------------------------------------------------------------
// Ordering (drag-and-drop persistence)
// ---------------------------------------------------------------------------

/** De-dupe a list of ids, preserving first-seen order. */
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Reconcile a persisted order with the ids currently present:
 *  - keep saved ids that still exist, in their saved order,
 *  - append newly-appeared ids (not in the saved order) at the end, in their
 *    current order.
 * Dropped streams fall out; new streams land last. Deterministic + idempotent.
 */
export function reconcileOrder(saved: string[], currentIds: string[]): string[] {
  const current = new Set(currentIds)
  const kept = dedupe(saved).filter((id) => current.has(id))
  const keptSet = new Set(kept)
  const appended = currentIds.filter((id) => !keptSet.has(id))
  return [...kept, ...appended]
}

/**
 * Order `items` by the id list `order`. Items whose key isn't in `order` are
 * appended at the end preserving their original relative order (so a brand-new
 * stream is never hidden just because it isn't in the saved order yet).
 */
export function applyOrder<T>(
  items: T[],
  order: string[],
  keyOf: (item: T) => string,
): T[] {
  const rank = new Map<string, number>()
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i)
  })
  const big = order.length
  return items
    .map((item, i) => ({ item, i, r: rank.get(keyOf(item)) ?? big + i }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.item)
}

/**
 * Move `activeId` so it sits at `overId`'s position within `order`. Returns a
 * NEW array; a no-op (same id, or either id absent) returns a copy unchanged.
 */
export function moveOrder(
  order: string[],
  activeId: string,
  overId: string,
): string[] {
  if (activeId === overId) return [...order]
  const from = order.indexOf(activeId)
  const to = order.indexOf(overId)
  if (from === -1 || to === -1) return [...order]
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, activeId)
  return next
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface CockpitSettings {
  gridSize: string
  autoPlay: boolean
  showLabels: boolean
  refreshSeconds: number
}

export const REFRESH_MIN = 3
export const REFRESH_MAX = 300

export const DEFAULT_SETTINGS: CockpitSettings = {
  gridSize: DEFAULT_GRID,
  autoPlay: true,
  showLabels: true,
  refreshSeconds: 10,
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

/** Clamp helper exported for the refresh interval control. */
export function clampRefresh(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_SETTINGS.refreshSeconds
  return Math.min(REFRESH_MAX, Math.max(REFRESH_MIN, Math.round(seconds)))
}

/**
 * Coerce an arbitrary bag (plugin config and/or a localStorage blob) into a
 * fully-populated, validated CockpitSettings. `base` supplies the fallbacks
 * (e.g. the plugin's configured defaults); missing/invalid keys fall back to it.
 */
export function normalizeSettings(
  raw: Partial<Record<keyof CockpitSettings, unknown>> | undefined,
  base: CockpitSettings = DEFAULT_SETTINGS,
): CockpitSettings {
  const src = raw ?? {}
  const gridSize =
    typeof src.gridSize === 'string' && getLayout(src.gridSize).id === src.gridSize
      ? src.gridSize
      : base.gridSize
  return {
    gridSize,
    autoPlay: toBool(src.autoPlay, base.autoPlay),
    showLabels: toBool(src.showLabels, base.showLabels),
    refreshSeconds: clampRefresh(toInt(src.refreshSeconds, base.refreshSeconds)),
  }
}
