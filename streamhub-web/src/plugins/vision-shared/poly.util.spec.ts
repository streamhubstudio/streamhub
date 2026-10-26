/**
 * vision poly.util — pure geometry under node:test (no DOM).
 *
 * Locks the coordinate contract shared with the backend `config_json`:
 * normalized 0–1 (y down), polygon ray-cast hit-testing, vertex grab tolerance,
 * counting-line ↔ endpoints round-trip, and (de)serialization garbage-safety.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  centroid,
  clamp01,
  defaultLine,
  demographyToConfig,
  editorMode,
  isZoneModel,
  lineEndpoints,
  lineFromEndpoints,
  linesToConfig,
  nearestVertex,
  normPoint,
  parseDemography,
  parseLines,
  parsePois,
  parseZones,
  pointInPolygon,
  poisToConfig,
  round4,
  snap,
  zonesToConfig,
  type Zone,
} from './poly.util.ts'

describe('clamp / round / normPoint', () => {
  it('clamps to [0,1] and rounds to 4 decimals', () => {
    assert.equal(clamp01(1.4), 1)
    assert.equal(clamp01(-0.3), 0)
    assert.equal(round4(0.123456), 0.1235)
  })

  it('normPoint maps client coords into the rect, clamped', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 }
    assert.deepEqual(normPoint(rect, 200, 100), [0.5, 0.5])
    assert.deepEqual(normPoint(rect, 500, 500), [1, 1]) // clamped
    assert.deepEqual(normPoint({ left: 0, top: 0, width: 0, height: 0 }, 5, 5), [0, 0])
  })
})

describe('polygon geometry', () => {
  const square: [number, number][] = [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
  ]

  it('pointInPolygon: inside vs outside', () => {
    assert.equal(pointInPolygon(square, [0.5, 0.5]), true)
    assert.equal(pointInPolygon(square, [0.05, 0.05]), false)
    assert.equal(pointInPolygon(square, [0.9, 0.5]), false)
    // Degenerate polygons are never "inside".
    assert.equal(pointInPolygon([[0, 0], [1, 1]], [0.5, 0.5]), false)
  })

  it('centroid is the mean of the vertices', () => {
    assert.deepEqual(centroid(square), [0.5, 0.5])
    assert.deepEqual(centroid([]), [0, 0])
  })

  it('nearestVertex grabs within tolerance, -1 otherwise', () => {
    assert.equal(nearestVertex(square, [0.21, 0.21], 0.03), 0)
    assert.equal(nearestVertex(square, [0.79, 0.79], 0.03), 2)
    assert.equal(nearestVertex(square, [0.5, 0.5], 0.03), -1)
  })

  it('snap clamps + rounds a point', () => {
    assert.deepEqual(snap([1.2, -0.1]), [1, 0])
    assert.deepEqual(snap([0.123456, 0.98765]), [0.1235, 0.9877])
  })
})

describe('counting lines', () => {
  it('endpoints ↔ {x,y,length,angle} round-trip', () => {
    const line = { x: 0.2, y: 0.5, length: 0.6, angle: 0 }
    const { p1, p2 } = lineEndpoints(line)
    assert.deepEqual(p1, [0.2, 0.5])
    assert.equal(round4(p2[0]), 0.8)
    assert.equal(round4(p2[1]), 0.5)
    const rebuilt = lineFromEndpoints(p1, p2)
    assert.equal(rebuilt.x, 0.2)
    assert.equal(round4(rebuilt.length), 0.6)
    assert.equal(rebuilt.angle, 0)
  })

  it('a vertical drag yields a 90° line', () => {
    const l = lineFromEndpoints([0.5, 0.2], [0.5, 0.8])
    assert.equal(l.angle, 90)
    assert.equal(round4(l.length), 0.6)
  })

  it('defaultLine is a centered horizontal segment', () => {
    assert.deepEqual(defaultLine(), { x: 0.2, y: 0.5, length: 0.6, angle: 0 })
  })
})

describe('config (de)serialization', () => {
  it('parseZones tolerates garbage and clamps points', () => {
    assert.deepEqual(parseZones(undefined), [])
    assert.deepEqual(parseZones({ zones: 'nope' }), [])
    const zones = parseZones({
      zones: [{ points: [[1.5, -0.2], [0.5, 0.5], [0.1, 0.9]], detect: 'vehiculos' }],
    })
    assert.equal(zones.length, 1)
    assert.equal(zones[0].detect, 'vehiculos')
    assert.equal(zones[0].id, 'zone-1')
    assert.deepEqual(zones[0].points[0], [1, 0])
  })

  it('zonesToConfig snaps points on the way out', () => {
    const cfg = zonesToConfig([
      { id: 'z', tag: 't', detect: 'personas', points: [[0.123456, 0.5], [1.2, 0], [0.3, 0.9]] },
    ])
    assert.deepEqual(cfg.zones[0].points[0], [0.1235, 0.5])
    assert.deepEqual(cfg.zones[0].points[1], [1, 0])
  })

  it('parseLines defaults fps to 3.5 and reads inside', () => {
    const out = parseLines({ lines: [{ x: 0.2, y: 0.5, length: 0.5, inside: 'left' }] })
    assert.equal(out.fps, 3.5)
    assert.equal(out.lines[0].inside, 'left')
    assert.deepEqual(out.pois, []) // no pois → empty (whole frame)
    // Unknown inside falls back to 'top'.
    assert.equal(parseLines({ lines: [{ inside: 'zzz' }] }).lines[0].inside, 'top')
  })

  it('isZoneModel splits the two families', () => {
    assert.equal(isZoneModel('occupancy'), true)
    assert.equal(isZoneModel('crowd'), true)
    assert.equal(isZoneModel('counting'), false)
    assert.equal(isZoneModel('demography'), false)
  })
})

describe('POIs (item 34)', () => {
  const quad: [number, number][] = [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.7, 0.7],
    [0.3, 0.7],
  ]

  it('parsePois tolerates garbage, auto-ids, and clamps', () => {
    assert.deepEqual(parsePois(undefined), [])
    assert.deepEqual(parsePois({ pois: 'nope' }), [])
    const pois = parsePois({ pois: [{ tag: 'aisle', points: [[1.4, -0.2], ...quad.slice(1)] }] })
    assert.equal(pois.length, 1)
    assert.equal(pois[0].id, 'poi-1') // auto-id
    assert.equal(pois[0].tag, 'aisle')
    assert.deepEqual(pois[0].points[0], [1, 0]) // clamped
  })

  it('poisToConfig snaps + drops partial polygons (< 3 points)', () => {
    const full: Zone[] = [
      { id: 'p1', tag: 't', detect: 'personas', points: [[0.123456, 0.5], [1.2, 0], [0.3, 0.9]] },
      { id: 'p2', tag: '', detect: 'personas', points: [[0.1, 0.1], [0.2, 0.2]] }, // 2 pts → dropped
    ]
    const out = poisToConfig(full)
    assert.equal(out.pois.length, 1)
    assert.equal(out.pois[0].id, 'p1')
    assert.deepEqual(out.pois[0].points[0], [0.1235, 0.5])
    // POI config carries no `detect` field (POIs are class-agnostic regions).
    assert.equal((out.pois[0] as Record<string, unknown>).detect, undefined)
  })

  it('linesToConfig threads POIs through', () => {
    const cfg = linesToConfig([], 3.5, undefined, [
      { id: 'aisle', tag: 'a3', detect: 'personas', points: quad },
    ])
    assert.equal(cfg.pois?.length, 1)
    assert.equal(cfg.pois?.[0].tag, 'a3')
    // No pois → the key is omitted (backward compatible).
    assert.equal(linesToConfig([], 3.5).pois, undefined)
  })

  it('parseLines reads POIs from config', () => {
    const out = parseLines({ lines: [], pois: [{ id: 'z', tag: 'till', points: quad }] })
    assert.equal(out.pois.length, 1)
    assert.equal(out.pois[0].tag, 'till')
  })

  it('demography carries POIs alongside a legacy roi', () => {
    const parsed = parseDemography({
      engine: 'local',
      intervalSec: 120,
      roi: { points: quad },
      pois: [{ id: 'till', tag: 'checkout', points: quad }],
    })
    assert.equal(parsed.pois.length, 1)
    assert.equal(parsed.pois[0].tag, 'checkout')
    assert.ok(parsed.roi) // legacy roi still parsed

    const cfg = demographyToConfig({
      roi: null,
      intervalSec: 120,
      engine: 'local',
      pois: [{ id: 'till', tag: 'checkout', detect: 'personas', points: quad }],
    })
    assert.equal(cfg.pois?.length, 1)
    assert.equal(cfg.roi, undefined) // roi:null → omitted
    // No pois → omitted.
    assert.equal(demographyToConfig({ roi: null, intervalSec: 120, engine: 'local', pois: [] }).pois, undefined)
  })
})

describe('editorMode', () => {
  it('maps each model to its editor', () => {
    assert.equal(editorMode('occupancy'), 'zones')
    assert.equal(editorMode('crowd'), 'zones')
    assert.equal(editorMode('counting'), 'lines')
    assert.equal(editorMode('demography'), 'roi')
    // Unknown → the safe zones default.
    assert.equal(editorMode('whatever'), 'zones')
  })
})

describe('demography config', () => {
  it('parseDemography reads engine/interval and an ROI polygon (garbage-safe)', () => {
    const empty = parseDemography(undefined)
    assert.equal(empty.roi, null)
    assert.equal(empty.engine, 'local')
    assert.equal(empty.intervalSec, 120)

    const d = parseDemography({
      engine: 'openai',
      intervalSec: 60,
      roi: { points: [[1.4, -0.2], [0.5, 0.5], [0.2, 0.9]] },
    })
    assert.equal(d.engine, 'openai')
    assert.equal(d.intervalSec, 60)
    assert.ok(d.roi)
    assert.equal(d.roi?.points.length, 3)
    assert.deepEqual(d.roi?.points[0], [1, 0]) // clamped

    // Unknown engine falls back to local.
    assert.equal(parseDemography({ engine: 'zzz' }).engine, 'local')
  })

  it('demographyToConfig snaps + drops an incomplete ROI (< 3 points)', () => {
    const full = demographyToConfig({
      engine: 'deepseek',
      intervalSec: 90,
      roi: { id: 'roi', tag: '', detect: 'personas', points: [[0.123456, 0.5], [1.2, 0], [0.3, 0.9]] },
    })
    assert.equal(full.engine, 'deepseek')
    assert.equal(full.intervalSec, 90)
    assert.deepEqual(full.roi?.points[0], [0.1235, 0.5])
    assert.deepEqual(full.roi?.points[1], [1, 0])

    // A partial ROI (2 points) is omitted so the backend validator never 400s.
    const partial = demographyToConfig({
      engine: 'local',
      intervalSec: 120,
      roi: { id: 'roi', tag: '', detect: 'personas', points: [[0.1, 0.1], [0.2, 0.2]] },
    })
    assert.equal(partial.roi, undefined)

    const none = demographyToConfig({ engine: 'local', intervalSec: 120, roi: null })
    assert.equal(none.roi, undefined)
  })
})
