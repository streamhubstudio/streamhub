/**
 * Unit specs for the wired-network geometry (pure) behind the auth cover's
 * animated cables backdrop.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWiredNetwork,
  cablePath,
  mulberry32,
  type WiredNetworkOptions,
} from './wiredNetwork.ts'

test('mulberry32: deterministic, in [0,1)', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  const c = mulberry32(43)
  const seqA = [a(), a(), a(), a()]
  const seqB = [b(), b(), b(), b()]
  assert.deepEqual(seqA, seqB) // same seed → same stream
  assert.notDeepEqual(seqA, [c(), c(), c(), c()]) // different seed → diverges
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1, `expected [0,1), got ${v}`)
  }
})

test('cablePath: well-formed cubic bézier, straight when curvature=0', () => {
  const straight = cablePath({ x: 0, y: 0, r: 1 }, { x: 100, y: 0, r: 1 }, 0)
  assert.match(straight, /^M0,0 C/) // starts at the first node
  assert.ok(straight.includes('C'), 'is a cubic curve')
  assert.ok(straight.endsWith('100,0'), 'ends at the second node')
  // Zero curvature keeps control points on the (flat) baseline.
  assert.equal(straight, 'M0,0 C25,0 75,0 100,0')

  // Non-zero curvature bows the controls off the baseline.
  const bowed = cablePath({ x: 0, y: 0, r: 1 }, { x: 100, y: 0, r: 1 }, 0.2)
  assert.notEqual(bowed, straight)
})

const OPTS: WiredNetworkOptions = {
  width: 1200,
  height: 900,
  nodeCount: 16,
  linksPerNode: 2,
  seed: 20240701,
}

test('buildWiredNetwork: deterministic for the same options', () => {
  assert.deepEqual(buildWiredNetwork(OPTS), buildWiredNetwork(OPTS))
})

test('buildWiredNetwork: a different seed changes the layout', () => {
  assert.notDeepEqual(
    buildWiredNetwork(OPTS),
    buildWiredNetwork({ ...OPTS, seed: OPTS.seed! + 1 }),
  )
})

test('buildWiredNetwork: emits the requested node count, in bounds', () => {
  const { nodes } = buildWiredNetwork(OPTS)
  assert.equal(nodes.length, OPTS.nodeCount)
  for (const n of nodes) {
    assert.ok(n.x >= 0 && n.x <= OPTS.width, `x in [0,w]: ${n.x}`)
    assert.ok(n.y >= 0 && n.y <= OPTS.height, `y in [0,h]: ${n.y}`)
    assert.ok(n.r > 0, 'node has a positive radius')
  }
})

test('buildWiredNetwork: cables are unique, undirected, valid endpoints', () => {
  const { nodes, cables } = buildWiredNetwork(OPTS)
  assert.ok(cables.length > 0, 'produces cables')

  const ids = new Set<string>()
  const pairs = new Set<string>()
  for (const c of cables) {
    // No self-links; canonical ordering from < to.
    assert.notEqual(c.from, c.to)
    assert.ok(c.from < c.to, 'endpoints canonicalised (from < to)')
    // Endpoints reference real nodes.
    assert.ok(c.from >= 0 && c.from < nodes.length)
    assert.ok(c.to >= 0 && c.to < nodes.length)
    // Ids and undirected pairs are unique.
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`)
    ids.add(c.id)
    const pair = `${c.from}-${c.to}`
    assert.ok(!pairs.has(pair), `duplicate pair ${pair}`)
    pairs.add(pair)
    // Path is a drawable cubic bézier with a sane length.
    assert.match(c.d, /^M[-\d.]+,[-\d.]+ C/)
    assert.ok(c.length > 0)
  }
})
