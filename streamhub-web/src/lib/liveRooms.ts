/**
 * Pure helpers for the Tablero "Live rooms" table (GET /apps/:app/stats →
 * live.rooms). Kept free of React / api types so the sort / status / paginate
 * logic is unit-testable in isolation. Tolerates partial / missing fields (the
 * stats endpoint may omit `viewers` when the viewerCounter feature is off, and
 * `startedAt` is optional).
 */

/** Minimal shape of a live room used by the sort/status logic. */
export interface LiveRoomLike {
  room: string
  viewers: number | null
  publishers: number
  startedAt?: string
}

/** The columns the operator can sort by. */
export type RoomSortKey = 'room' | 'viewers' | 'publishers' | 'since' | 'status'
export type SortDir = 'asc' | 'desc'
export interface RoomSort {
  key: RoomSortKey
  dir: SortDir
}

/** Live/Offline status of a room — derived, since all rows are "live" rooms. */
export type RoomStatus = 'live' | 'offline'

/**
 * A room is "live" while it has at least one active publisher; a room that is
 * still present but has no publisher right now (a publisher that just dropped,
 * viewers still connected) reads as "offline".
 */
export function roomStatus(r: LiveRoomLike): RoomStatus {
  return r.publishers > 0 ? 'live' : 'offline'
}

function ts(iso?: string): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/** Sort key extractor → primitive comparable value. */
function compare(a: LiveRoomLike, b: LiveRoomLike, key: RoomSortKey): number {
  switch (key) {
    case 'room':
      return a.room.localeCompare(b.room)
    case 'viewers':
      // Unknown (null) viewers sort below any real count.
      return (a.viewers ?? -1) - (b.viewers ?? -1)
    case 'publishers':
      return a.publishers - b.publishers
    case 'since':
      return ts(a.startedAt) - ts(b.startedAt)
    case 'status':
      return roomStatus(a).localeCompare(roomStatus(b))
    default:
      return 0
  }
}

/**
 * Stable-sorted copy of `rooms` by the given key/direction. Ties break on the
 * room name (ascending) so the order never jitters between equal rows across
 * poll refreshes. Never mutates the input.
 */
export function sortRooms(rooms: LiveRoomLike[], sort: RoomSort): LiveRoomLike[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...rooms].sort((a, b) => {
    const primary = compare(a, b, sort.key)
    if (primary !== 0) return primary * dir
    // Deterministic tiebreak, independent of direction.
    return a.room.localeCompare(b.room)
  })
}

/** Total pages for `count` items at `pageSize` (always ≥ 1). */
export function pageCount(count: number, pageSize: number): number {
  if (pageSize <= 0) return 1
  return Math.max(1, Math.ceil(count / pageSize))
}

/** Clamp a 1-based page into `[1, pageCount]` (tolerates NaN / out-of-range). */
export function clampPage(page: number, count: number, pageSize: number): number {
  const max = pageCount(count, pageSize)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(Math.floor(page), max)
}

/** The 1-based `page` slice of `items` at `pageSize` (clamps the page first). */
export function pageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  if (pageSize <= 0) return items
  const p = clampPage(page, items.length, pageSize)
  const start = (p - 1) * pageSize
  return items.slice(start, start + pageSize)
}

/** Toggle sort: same key flips direction, a new key starts ascending. */
export function nextSort(prev: RoomSort, key: RoomSortKey): RoomSort {
  if (prev.key === key) {
    return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
  }
  return { key, dir: 'asc' }
}
