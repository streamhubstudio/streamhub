/**
 * Pure helpers for the Backups panel (Server Settings → Backups). Kept out of
 * the React component so they run under `node --test` (npm test).
 */

/** Minimal snapshot shape the helpers need (subset of api BackupSnapshot). */
export interface SnapshotLike {
  createdAt: string
  sizeBytes: number
  preRestore?: boolean
}

/** Minimal database shape (subset of api BackupDatabase). */
export interface DatabaseLike {
  db: string
  kind: 'global' | 'app'
  app?: string
  orphaned?: boolean
}

/**
 * Age of a snapshot in WHOLE days relative to `now` (0 = today). Invalid
 * timestamps return null so the UI can fall back to a dash.
 */
export function snapshotAgeDays(createdAt: string, now = Date.now()): number | null {
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return null
  const diff = now - t
  if (diff < 0) return 0
  return Math.floor(diff / 86_400_000)
}

/** Total size of a snapshot list in bytes (ignores negative/NaN entries). */
export function totalSnapshotBytes(snapshots: SnapshotLike[]): number {
  return snapshots.reduce(
    (sum, s) => sum + (Number.isFinite(s.sizeBytes) && s.sizeBytes > 0 ? s.sizeBytes : 0),
    0,
  )
}

/**
 * The destructive-action gate used by the restore dialog: the operator must
 * type the confirmation phrase (whitespace/case-insensitive) before the
 * Restore button unlocks — same contract as the DB purge modal.
 */
export function restoreConfirmed(typed: string, phrase: string): boolean {
  return typed.trim().toUpperCase() === phrase.trim().toUpperCase()
}

/**
 * Stable sort key/label for a database entry: the global registry first, then
 * apps alphabetically, orphaned dirs last.
 */
export function databaseOrder(d: DatabaseLike): string {
  if (d.orphaned) return `2:${d.db}`
  return d.kind === 'global' ? `0:${d.db}` : `1:${d.db}`
}

/** Sort databases: global registry → apps A-Z → orphaned dirs. */
export function sortDatabases<T extends DatabaseLike>(dbs: T[]): T[] {
  return [...dbs].sort((a, b) => databaseOrder(a).localeCompare(databaseOrder(b)))
}

/**
 * Number of 1-based pages needed to show `total` items `pageSize` at a time
 * (minimum 1, even for an empty list, so a page-1-of-1 UI never divides by
 * zero).
 */
export function snapshotPageCount(total: number, pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * Clamp a 1-based page number into `[1, snapshotPageCount(total, pageSize)]`
 * — used when a database's snapshot list shrinks (e.g. after a restore
 * invalidates the query) and a stale page number would otherwise render an
 * empty page.
 */
export function clampSnapshotPage(page: number, total: number, pageSize: number): number {
  const last = snapshotPageCount(total, pageSize)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(Math.floor(page), last)
}

/**
 * The slice of `items` visible on a 1-based `page` (page is clamped first) —
 * pairs with the shared `<Pagination currentPage pageSize total>` component,
 * which is also 1-based.
 */
export function snapshotsOnPage<T>(items: T[], page: number, pageSize: number): T[] {
  const p = clampSnapshotPage(page, items.length, pageSize)
  const start = (p - 1) * pageSize
  return items.slice(start, start + pageSize)
}
