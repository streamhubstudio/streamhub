/**
 * streamflow graph.util — pure model + geometry + validation under node:test.
 *
 * Locks the contract shared with the backend runner: the graph_json
 * (de)serialization round-trip (positions + ports survive; colon shorthand and
 * missing positions are tolerated; dangling edges/boxes are dropped), the
 * connection rules (self / into-trigger / bad-port / duplicate / cycle), and the
 * starter-template graph builder.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeEdgeIds,
  addBox,
  boxHeight,
  buildIntrusionTemplate,
  canConnect,
  connect,
  deserializeGraph,
  edgePath,
  flattenEventNames,
  parsePortable,
  portOffsetY,
  portPoint,
  portableFilename,
  removeBox,
  serializeGraph,
  toPortable,
  wouldCreateCycle,
  type BoxSpec,
  type CanvasGraph,
} from './graph.util.ts'

// A minimal catalogue fixture covering the types the tests touch.
const CATALOGUE: BoxSpec[] = [
  { type: 'trigger.event', group: 'trigger', label: 'On event', description: '', inputs: [], outputs: ['out'], fields: [] },
  { type: 'trigger.manual', group: 'trigger', label: 'Manual', description: '', inputs: [], outputs: ['out'], fields: [] },
  { type: 'action.snapshot', group: 'action', label: 'Snapshot', description: '', inputs: ['in'], outputs: ['out'], fields: [] },
  { type: 'action.ai', group: 'action', label: 'AI', description: '', inputs: ['in'], outputs: ['out'], fields: [] },
  { type: 'action.notify', group: 'action', label: 'Notify', description: '', inputs: ['in'], outputs: ['out'], fields: [] },
  { type: 'action.http', group: 'action', label: 'HTTP', description: '', inputs: ['in'], outputs: ['out', 'error'], fields: [] },
  { type: 'logic.condition', group: 'logic', label: 'Condition', description: '', inputs: ['in'], outputs: ['true', 'false'], fields: [] },
]

const spec = (type: string) => CATALOGUE.find((s) => s.type === type)!

function seed(): CanvasGraph {
  return {
    boxes: [
      { id: 'a', type: 'trigger.manual', config: {}, position: { x: 0, y: 0 } },
      { id: 'b', type: 'action.snapshot', config: {}, position: { x: 300, y: 0 } },
      { id: 'c', type: 'action.notify', config: {}, position: { x: 600, y: 0 } },
    ],
    edges: [],
  }
}

describe('geometry', () => {
  it('portOffsetY grows by the port gap', () => {
    assert.equal(portOffsetY(1) - portOffsetY(0), 24)
  })

  it('boxHeight scales with the tallest port column', () => {
    assert.ok(boxHeight(2, 1) > boxHeight(1, 1))
    assert.equal(boxHeight(0, 0), boxHeight(1, 1)) // both clamp to one row
  })

  it('portPoint puts inputs on the left edge and outputs on the right', () => {
    const box = { id: 'x', type: 'action.http', config: {}, position: { x: 100, y: 50 } }
    assert.equal(portPoint(box, 'in', 0).x, 100)
    assert.equal(portPoint(box, 'out', 0).x, 100 + 210)
    assert.equal(portPoint(box, 'out', 1).y, portPoint(box, 'out', 0).y + 24)
  })

  it('edgePath is a cubic bezier between the two points', () => {
    const d = edgePath({ x: 0, y: 0 }, { x: 100, y: 40 })
    assert.match(d, /^M 0 0 C /)
    assert.match(d, /100 40$/)
  })
})

describe('serialize / deserialize round-trip', () => {
  it('preserves boxes, positions, config and ported edges', () => {
    let g = seed()
    g = connect(g, CATALOGUE, { box: 'a', port: 'out' }, { box: 'b', port: 'in' })!
    const json = serializeGraph(g)
    assert.equal(json.boxes.length, 3)
    assert.deepEqual(json.boxes[0].position, { x: 0, y: 0 })
    assert.deepEqual(json.edges[0], { from: 'a', fromPort: 'out', to: 'b', toPort: 'in' })

    const back = deserializeGraph(json, CATALOGUE)
    assert.equal(back.boxes.length, 3)
    assert.equal(back.edges.length, 1)
    assert.equal(back.edges[0].from, 'a')
    assert.equal(back.edges[0].fromPort, 'out')
    assert.equal(back.edges[0].toPort, 'in')
  })

  it('accepts the `box:port` colon shorthand on edges', () => {
    const g = deserializeGraph(
      {
        boxes: [
          { id: 'k', type: 'logic.condition', position: { x: 1, y: 2 } },
          { id: 'n', type: 'action.notify', position: { x: 3, y: 4 } },
        ],
        edges: [{ from: 'k:true', to: 'n' }],
      },
      CATALOGUE,
    )
    assert.equal(g.edges.length, 1)
    assert.equal(g.edges[0].fromPort, 'true') // from the shorthand
    assert.equal(g.edges[0].toPort, 'in') // resolved to the box's first input
  })

  it('auto-lays-out boxes missing a position and drops junk', () => {
    const g = deserializeGraph(
      {
        boxes: [
          { id: 'p', type: 'trigger.manual' }, // no position
          { type: 'action.ai' }, // no id → dropped
          { id: 'q' }, // no type → dropped
        ],
        edges: [{ from: 'p', to: 'ghost' }], // unknown target → dropped
      },
      CATALOGUE,
    )
    assert.equal(g.boxes.length, 1)
    assert.equal(g.boxes[0].id, 'p')
    assert.ok(Number.isFinite(g.boxes[0].position.x))
    assert.equal(g.edges.length, 0)
  })

  it('never throws on garbage input', () => {
    assert.doesNotThrow(() => deserializeGraph(null, CATALOGUE))
    assert.doesNotThrow(() => deserializeGraph({ boxes: 'nope', edges: 7 }, CATALOGUE))
    const empty = deserializeGraph(undefined, CATALOGUE)
    assert.deepEqual(empty, { boxes: [], edges: [] })
  })
})

describe('connection validation', () => {
  it('accepts a valid output→input connection', () => {
    assert.equal(canConnect(seed(), CATALOGUE, { box: 'a', port: 'out' }, { box: 'b', port: 'in' }).ok, true)
  })

  it('rejects self-loops', () => {
    assert.equal(
      canConnect(seed(), CATALOGUE, { box: 'b', port: 'out' }, { box: 'b', port: 'in' }).reason,
      'self',
    )
  })

  it('rejects an edge INTO a trigger box', () => {
    assert.equal(
      canConnect(seed(), CATALOGUE, { box: 'b', port: 'out' }, { box: 'a', port: 'in' }).reason,
      'intoTrigger',
    )
  })

  it('rejects unknown ports', () => {
    assert.equal(
      canConnect(seed(), CATALOGUE, { box: 'a', port: 'nope' }, { box: 'b', port: 'in' }).reason,
      'badFromPort',
    )
    assert.equal(
      canConnect(seed(), CATALOGUE, { box: 'a', port: 'out' }, { box: 'b', port: 'nope' }).reason,
      'badToPort',
    )
  })

  it('rejects a duplicate edge', () => {
    const g = connect(seed(), CATALOGUE, { box: 'a', port: 'out' }, { box: 'b', port: 'in' })!
    assert.equal(
      canConnect(g, CATALOGUE, { box: 'a', port: 'out' }, { box: 'b', port: 'in' }).reason,
      'duplicate',
    )
  })

  it('rejects a connection that would create a cycle', () => {
    let g = seed()
    g = connect(g, CATALOGUE, { box: 'b', port: 'out' }, { box: 'c', port: 'in' })!
    // c → b would close the b → c cycle.
    assert.equal(
      canConnect(g, CATALOGUE, { box: 'c', port: 'out' }, { box: 'b', port: 'in' }).reason,
      'cycle',
    )
    assert.equal(g.edges.length, 1)
  })

  it('connect() returns null on an invalid attempt', () => {
    assert.equal(connect(seed(), CATALOGUE, { box: 'b', port: 'out' }, { box: 'b', port: 'in' }), null)
  })

  it('wouldCreateCycle detects an existing back-path', () => {
    const edges = [
      { id: 'e1', from: 'a', fromPort: 'out', to: 'b', toPort: 'in' },
      { id: 'e2', from: 'b', fromPort: 'out', to: 'c', toPort: 'in' },
    ]
    assert.equal(wouldCreateCycle(edges, 'c', 'a'), true)
    assert.equal(wouldCreateCycle(edges, 'a', 'c'), false)
  })
})

describe('mutations', () => {
  it('addBox appends a box with a fresh id + given position', () => {
    const g = addBox(seed(), spec('action.ai'), { x: 12, y: 34 })
    assert.equal(g.boxes.length, 4)
    const added = g.boxes[3]
    assert.equal(added.type, 'action.ai')
    assert.deepEqual(added.position, { x: 12, y: 34 })
  })

  it('removeBox drops the box and its incident edges', () => {
    let g = seed()
    g = connect(g, CATALOGUE, { box: 'a', port: 'out' }, { box: 'b', port: 'in' })!
    g = connect(g, CATALOGUE, { box: 'b', port: 'out' }, { box: 'c', port: 'in' })!
    g = removeBox(g, 'b')
    assert.equal(g.boxes.length, 2)
    assert.equal(g.edges.length, 0)
  })
})

describe('starter template', () => {
  it('builds the intrusion → snapshot → ai → validate → notify flow', () => {
    const g = buildIntrusionTemplate()
    assert.deepEqual(
      g.boxes.map((b) => b.id),
      ['trigger', 'snapshot', 'ai', 'validate', 'notify'],
    )
    assert.equal(g.edges.length, 4)
    // The validated branch leaves the condition's `true` port.
    const branch = g.edges.find((e) => e.from === 'validate')!
    assert.equal(branch.fromPort, 'true')
    assert.equal(branch.to, 'notify')
    // Trigger fires on the perimeter intrusion event.
    assert.equal(g.boxes[0].config.event, 'perimeter.intrusion')
  })

  it('condition reads the AI reply at ai.json.confidence (not ai.confidence)', () => {
    // action.ai outputs {text, usageTokens, json}; in JSON mode the parsed reply
    // lands under `json`, so the branch must read ai.json.confidence — the old
    // ai.confidence path never resolves and the true branch could never fire.
    const g = buildIntrusionTemplate()
    const validate = g.boxes.find((b) => b.id === 'validate')!
    const rules = (validate.config as { rules: { field: string }[] }).rules
    assert.equal(rules[0].field, 'ai.json.confidence')
  })

  it('notify ships a non-empty channel so a fired alarm actually delivers', () => {
    // The notifier treats an empty `channels` array as "no channels" (delivers
    // nothing); ['callback'] is the always-available, self-gating channel.
    const g = buildIntrusionTemplate()
    const notify = g.boxes.find((b) => b.id === 'notify')!
    const channels = (notify.config as { channels: unknown }).channels
    assert.ok(Array.isArray(channels) && channels.length > 0, 'channels must be non-empty')
    assert.deepEqual(channels, ['callback'])
  })

  it('every template edge is individually valid against a fresh graph', () => {
    const tmpl = buildIntrusionTemplate()
    // Rebuild edge-by-edge to prove none is a self-loop / into-trigger / cycle.
    let g: CanvasGraph = { boxes: tmpl.boxes, edges: [] }
    for (const e of tmpl.edges) {
      const check = canConnect(g, CATALOGUE, { box: e.from, port: e.fromPort }, { box: e.to, port: e.toPort })
      assert.equal(check.ok, true, `edge ${e.from}:${e.fromPort} → ${e.to}:${e.toPort} invalid: ${check.reason}`)
      g = connect(g, CATALOGUE, { box: e.from, port: e.fromPort }, { box: e.to, port: e.toPort })!
    }
    assert.equal(g.edges.length, 4)
  })
})

describe('portable (export/import client helpers)', () => {
  it('toPortable serializes a canvas graph into versioned portable JSON', () => {
    const g = buildIntrusionTemplate()
    const p = toPortable('My flow', g)
    assert.equal(p.streamflow, 1)
    assert.equal(p.name, 'My flow')
    assert.equal(p.graph!.boxes.length, g.boxes.length)
    assert.equal(p.graph!.edges.length, g.edges.length)
  })

  it('parsePortable accepts a well-shaped file and round-trips toPortable', () => {
    const p = toPortable('Flow', buildIntrusionTemplate())
    const res = parsePortable(JSON.stringify(p))
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.workflow.name, 'Flow')
  })

  it('parsePortable rejects non-JSON and wrong-shape input', () => {
    assert.deepEqual(parsePortable('{not json'), { ok: false, error: 'json' })
    assert.deepEqual(parsePortable('{"name":"x"}'), { ok: false, error: 'shape' })
    assert.deepEqual(parsePortable('123'), { ok: false, error: 'shape' })
  })

  it('portableFilename slugifies to a .streamflow.json name', () => {
    assert.equal(portableFilename('My Cool Flow!'), 'my-cool-flow.streamflow.json')
    assert.equal(portableFilename(''), 'workflow.streamflow.json')
  })
})

describe('event catalogue helpers', () => {
  it('flattenEventNames dedupes across families preserving order', () => {
    const fams = [
      { family: 'a', scope: 'app' as const, events: [{ event: 'x', description: '' }, { event: 'y', description: '' }] },
      { family: 'b', scope: 'cluster' as const, events: [{ event: 'y', description: '' }, { event: 'z', description: '' }] },
    ]
    assert.deepEqual(flattenEventNames(fams), ['x', 'y', 'z'])
    assert.deepEqual(flattenEventNames(undefined), [])
  })
})

describe('activeEdgeIds (run flow animation)', () => {
  const graph: CanvasGraph = {
    boxes: [
      { id: 't', type: 'trigger.event', config: {}, position: { x: 0, y: 0 } },
      { id: 'k', type: 'logic.condition', config: {}, position: { x: 200, y: 0 } },
      { id: 'y', type: 'action.notify', config: {}, position: { x: 400, y: 0 } },
      { id: 'n', type: 'action.notify', config: {}, position: { x: 400, y: 200 } },
    ],
    edges: [
      { id: 'e1', from: 't', fromPort: 'out', to: 'k', toPort: 'in' },
      { id: 'e2', from: 'k', fromPort: 'true', to: 'y', toPort: 'in' },
      { id: 'e3', from: 'k', fromPort: 'false', to: 'n', toPort: 'in' },
    ],
  }

  it('lights only the edges a linear/branch run traversed', () => {
    // Run took the TRUE branch: visited t, k, y — e1 + e2 light, e3 does not.
    const active = activeEdgeIds(graph, ['t', 'k', 'y'])
    assert.deepEqual([...active].sort(), ['e1', 'e2'])
  })

  it('returns empty for no steps', () => {
    assert.equal(activeEdgeIds(graph, []).size, 0)
  })

  it('never lights an edge whose from came after its to', () => {
    // Out-of-order visited ids must not light a forward edge.
    assert.equal(activeEdgeIds(graph, ['y', 'k']).size, 0)
  })
})
