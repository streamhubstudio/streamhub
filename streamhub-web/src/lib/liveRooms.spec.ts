/**
 * Unit specs for the Live-rooms table helpers (pure sort / status / paginate).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampPage,
  nextSort,
  pageCount,
  pageSlice,
  roomStatus,
  sortRooms,
  type LiveRoomLike,
  type RoomSort,
} from './liveRooms.ts'

const R = (
  room: string,
  publishers: number,
  viewers: number | null,
  startedAt?: string,
): LiveRoomLike => ({ room, publishers, viewers, startedAt })

test('roomStatus: live when it has a publisher, offline otherwise', () => {
  assert.equal(roomStatus(R('a', 1, 3)), 'live')
  assert.equal(roomStatus(R('a', 2, 0)), 'live')
  assert.equal(roomStatus(R('a', 0, 5)), 'offline')
})

test('sortRooms: does not mutate the input', () => {
  const rooms = [R('b', 1, 1), R('a', 1, 1)]
  const copy = [...rooms]
  sortRooms(rooms, { key: 'room', dir: 'asc' })
  assert.deepEqual(rooms, copy)
})

test('sortRooms: by name asc/desc', () => {
  const rooms = [R('charlie', 1, 1), R('alpha', 1, 1), R('bravo', 1, 1)]
  assert.deepEqual(
    sortRooms(rooms, { key: 'room', dir: 'asc' }).map((r) => r.room),
    ['alpha', 'bravo', 'charlie'],
  )
  assert.deepEqual(
    sortRooms(rooms, { key: 'room', dir: 'desc' }).map((r) => r.room),
    ['charlie', 'bravo', 'alpha'],
  )
})

test('sortRooms: viewers treats null as below any real count', () => {
  const rooms = [R('a', 1, 5), R('b', 1, null), R('c', 1, 2)]
  assert.deepEqual(
    sortRooms(rooms, { key: 'viewers', dir: 'asc' }).map((r) => r.room),
    ['b', 'c', 'a'],
  )
})

test('sortRooms: by publishers', () => {
  const rooms = [R('a', 3, 0), R('b', 1, 0), R('c', 2, 0)]
  assert.deepEqual(
    sortRooms(rooms, { key: 'publishers', dir: 'desc' }).map((r) => r.room),
    ['a', 'c', 'b'],
  )
})

test('sortRooms: by since (startedAt), missing dates sort as oldest', () => {
  const rooms = [
    R('a', 1, 0, '2026-07-09T10:00:00Z'),
    R('b', 1, 0, undefined),
    R('c', 1, 0, '2026-07-09T12:00:00Z'),
  ]
  assert.deepEqual(
    sortRooms(rooms, { key: 'since', dir: 'desc' }).map((r) => r.room),
    ['c', 'a', 'b'],
  )
})

test('sortRooms: by status (offline < live alphabetically)', () => {
  const rooms = [R('a', 1, 0), R('b', 0, 0), R('c', 2, 0)]
  // asc → offline first (localeCompare: 'live' > 'offline'? no: 'live' < 'offline')
  const asc = sortRooms(rooms, { key: 'status', dir: 'asc' }).map(roomStatus)
  assert.deepEqual(asc, ['live', 'live', 'offline'])
})

test('sortRooms: ties break on room name regardless of direction', () => {
  const rooms = [R('b', 1, 1), R('a', 1, 1), R('c', 1, 1)]
  // Equal on publishers → name asc tiebreak, both directions.
  assert.deepEqual(
    sortRooms(rooms, { key: 'publishers', dir: 'asc' }).map((r) => r.room),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(
    sortRooms(rooms, { key: 'publishers', dir: 'desc' }).map((r) => r.room),
    ['a', 'b', 'c'],
  )
})

test('pageCount: at least 1, ceils', () => {
  assert.equal(pageCount(0, 20), 1)
  assert.equal(pageCount(20, 20), 1)
  assert.equal(pageCount(21, 20), 2)
  assert.equal(pageCount(41, 20), 3)
})

test('clampPage: bounds into [1, pageCount]', () => {
  assert.equal(clampPage(0, 100, 20), 1)
  assert.equal(clampPage(-3, 100, 20), 1)
  assert.equal(clampPage(99, 100, 20), 5)
  assert.equal(clampPage(Number.NaN, 100, 20), 1)
  assert.equal(clampPage(3, 100, 20), 3)
})

test('pageSlice: returns the right 20-item window', () => {
  const items = Array.from({ length: 45 }, (_, i) => i)
  assert.deepEqual(pageSlice(items, 1, 20), items.slice(0, 20))
  assert.deepEqual(pageSlice(items, 2, 20), items.slice(20, 40))
  assert.deepEqual(pageSlice(items, 3, 20), items.slice(40, 45))
  // Out-of-range page clamps to the last page.
  assert.deepEqual(pageSlice(items, 99, 20), items.slice(40, 45))
})

test('nextSort: same key flips dir, new key starts asc', () => {
  const s: RoomSort = { key: 'room', dir: 'asc' }
  assert.deepEqual(nextSort(s, 'room'), { key: 'room', dir: 'desc' })
  assert.deepEqual(nextSort(s, 'viewers'), { key: 'viewers', dir: 'asc' })
  assert.deepEqual(nextSort({ key: 'room', dir: 'desc' }, 'room'), {
    key: 'room',
    dir: 'asc',
  })
})
