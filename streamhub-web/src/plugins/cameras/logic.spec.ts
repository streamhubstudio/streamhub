/**
 * Fast logic suite (node:test) for the cameras plugin's pure helpers: response
 * parsing, grid filters/counts, formatters, the PTZ hold controller and the
 * RTMP url/key split of the alta flow.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PtzHold,
  cameraCounts,
  filterCameras,
  formatAge,
  formatBytes,
  formatRssi,
  formatSdUsed,
  formatUptime,
  hasCap,
  isOpen,
  parseCameras,
  parseDetail,
  rssiBars,
  sitesOf,
  splitRtmpUrl,
  validDevice,
  type PtzDir,
} from './logic.ts'

const LIST = {
  active: true,
  baseTopic: 'opencam',
  generatedAt: 'x',
  cameras: [
    {
      device: 'stand-01',
      site: 'abasto',
      online: true,
      status: 'online',
      caps: ['ptz', 'sd'],
      capsKnown: true,
      summary: { rssi: -61, sdFreeKb: 50, sdTotalKb: 100, streamRunning: true },
    },
    { device: 'stand-02', site: 'unicenter', online: false, status: 'offline', summary: {} },
    { device: 'stand-03', online: false, status: 'weird' },
    { site: 'no-id' },
    'junk',
  ],
}

test('parseCameras coerces + drops junk', () => {
  const r = parseCameras(LIST)
  assert.equal(r.active, true)
  assert.equal(r.cameras.length, 3)
  assert.equal(r.cameras[0].summary.rssi, -61)
  assert.equal(r.cameras[0].summary.ptzX, null)
  assert.equal(r.cameras[2].status, 'unknown')
  assert.deepEqual(r.cameras[2].caps, [])
  assert.deepEqual(parseCameras(undefined).cameras, [])
  assert.equal(parseCameras({}).baseTopic, 'opencam')
})

test('filters, counts, sites, caps', () => {
  const { cameras } = parseCameras(LIST)
  assert.deepEqual(cameraCounts(cameras), { all: 3, online: 1, offline: 2 })
  assert.equal(filterCameras(cameras, 'online').length, 1)
  assert.equal(filterCameras(cameras, 'offline').length, 2)
  assert.equal(filterCameras(cameras, 'all', 'unicenter').length, 1)
  assert.deepEqual(sitesOf(cameras), ['abasto', 'unicenter'])
  assert.equal(hasCap(cameras[0], 'ptz'), true)
  assert.equal(hasCap(cameras[0], 'voice'), false)
  assert.equal(hasCap(cameras[1], 'voice'), true) // caps unknown → offered
})

test('parseDetail reads commands, events (array or {events}) and history', () => {
  const d = parseDetail({
    camera: LIST.cameras[0],
    history: [{ ts: 't', rssi: -60 }],
    commands: [{ id: 'c1', cmd: 'ptz/stop', status: 'done' }, { id: 'c2', status: 'bogus' }, {}],
    events: [{ id: 3, level: 'warn', src: 'stream', event: 'stopped' }, { nope: 1 }],
  })
  assert.ok(d)
  assert.equal(d.commands.length, 2)
  assert.equal(d.commands[1].status, 'pending')
  assert.equal(d.events.length, 1)
  assert.equal(d.history[0].rssi, -60)
  assert.equal(parseDetail({ camera: {} }), null)
  assert.equal(isOpen('accepted'), true)
  assert.equal(isOpen('timeout'), false)
})

test('formatters', () => {
  assert.equal(rssiBars(null), 0)
  assert.equal(rssiBars(-50), 4)
  assert.equal(rssiBars(-61), 3)
  assert.equal(rssiBars(-80), 1)
  assert.equal(rssiBars(-95), 0)
  assert.equal(formatRssi(-61.4), '-61 dBm')
  assert.equal(formatSdUsed(25, 100), '75%')
  assert.equal(formatSdUsed(null, 100), '—')
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(50 * 1024 * 1024), '50 MB')
  assert.equal(formatUptime(3 * 3600 + 12 * 60), '3h 12m')
  assert.equal(formatAge(120000), '2m')
})

function fakeTimers() {
  let next = 1
  const live = new Map<number, () => void>()
  return {
    timers: {
      setInterval: (fn: () => void) => {
        const h = next++
        live.set(h, fn)
        return h
      },
      clearInterval: (h: unknown) => {
        live.delete(h as number)
      },
    },
    tick: () => [...live.values()].forEach((fn) => fn()),
    live,
  }
}

test('PtzHold: immediate move, repeats while held, exactly one stop', () => {
  const sent: string[] = []
  const t = fakeTimers()
  const hold = new PtzHold((d: PtzDir) => sent.push(`move:${d}`), () => sent.push('stop'), t.timers)
  hold.start('left')
  assert.deepEqual(sent, ['move:left'])
  hold.start('left') // idempotent
  t.tick()
  t.tick()
  assert.deepEqual(sent, ['move:left', 'move:left', 'move:left'])
  hold.start('up') // switch direction, no stop in between, one timer
  assert.equal(t.live.size, 1)
  assert.equal(hold.active, 'up')
  hold.stop()
  hold.stop() // second release (pointerleave after pointerup) sends nothing
  assert.deepEqual(sent.slice(3), ['move:up', 'stop'])
  assert.equal(t.live.size, 0)
  t.tick()
  assert.equal(sent.length, 5)
})

test('splitRtmpUrl + validDevice', () => {
  assert.deepEqual(splitRtmpUrl('rtmp://h:1935/live/ptk_abc', 'ptk_abc'), {
    url: 'rtmp://h:1935/live',
    key: 'ptk_abc',
  })
  assert.deepEqual(splitRtmpUrl('rtmp://h/live', 'k'), { url: 'rtmp://h/live', key: 'k' })
  assert.equal(validDevice('stand-02'), true)
  assert.equal(validDevice('a/b'), false)
  assert.equal(validDevice('+'), false)
  assert.equal(validDevice(''), false)
})
