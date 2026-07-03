/**
 * Unit specs for the VODs / logs query builders (pure).
 * Run with: `npm test` → node --test over src/lib/*.spec.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIngressQuery,
  buildLogsQuery,
  buildVodsQuery,
  toQueryRecord,
} from './queryParams.ts'

test('buildVodsQuery: empty input yields an empty query string', () => {
  assert.equal(buildVodsQuery().toString(), '')
  assert.equal(buildVodsQuery({}).toString(), '')
})

test('buildVodsQuery: drops empty strings but keeps 0 offset', () => {
  const sp = buildVodsQuery({ room: '', status: '', limit: 20, offset: 0 })
  assert.equal(sp.get('room'), null)
  assert.equal(sp.get('status'), null)
  assert.equal(sp.get('limit'), '20')
  assert.equal(sp.get('offset'), '0')
})

test('buildVodsQuery: trims room and serialises filters + paging', () => {
  const sp = buildVodsQuery({
    room: '  lobby  ',
    status: 'ready',
    order: 'size_bytes',
    dir: 'desc',
    limit: 20,
    offset: 40,
  })
  assert.equal(sp.get('room'), 'lobby')
  assert.equal(sp.get('status'), 'ready')
  assert.equal(sp.get('order'), 'size_bytes')
  assert.equal(sp.get('dir'), 'desc')
  assert.equal(sp.toString(), 'room=lobby&status=ready&order=size_bytes&dir=desc&limit=20&offset=40')
})

test('buildVodsQuery: `all` only appears when explicitly true', () => {
  assert.equal(buildVodsQuery({ all: false }).get('all'), null)
  assert.equal(buildVodsQuery({ all: true }).get('all'), 'true')
})

test('buildLogsQuery: serialises level/source/q and trims text', () => {
  const sp = buildLogsQuery({
    level: 'error',
    source: '  ffmpeg ',
    q: '  timeout ',
    limit: 50,
    offset: 0,
  })
  assert.equal(sp.get('level'), 'error')
  assert.equal(sp.get('source'), 'ffmpeg')
  assert.equal(sp.get('q'), 'timeout')
  assert.equal(sp.get('limit'), '50')
  assert.equal(sp.get('offset'), '0')
})

test('buildLogsQuery: empty free-text is dropped', () => {
  const sp = buildLogsQuery({ q: '   ', source: '' })
  assert.equal(sp.get('q'), null)
  assert.equal(sp.get('source'), null)
  assert.equal(sp.toString(), '')
})

test('buildIngressQuery: paging keeps 0 offset, page math serialises', () => {
  const sp = buildIngressQuery({ limit: 20, offset: 0 })
  assert.equal(sp.get('limit'), '20')
  assert.equal(sp.get('offset'), '0')
  // Page 3 with pageSize 20 → offset 40.
  const page3 = buildIngressQuery({ limit: 20, offset: (3 - 1) * 20 })
  assert.equal(page3.get('offset'), '40')
})

test('buildIngressQuery: trims filters and drops empties', () => {
  const sp = buildIngressQuery({ room: '  cam1 ', q: '' })
  assert.equal(sp.get('room'), 'cam1')
  assert.equal(sp.get('q'), null)
  assert.equal(buildIngressQuery().toString(), '')
})

test('toQueryRecord: flattens URLSearchParams into a plain record', () => {
  const rec = toQueryRecord(buildVodsQuery({ status: 'ready', limit: 20 }))
  assert.deepEqual(rec, { status: 'ready', limit: '20' })
})
