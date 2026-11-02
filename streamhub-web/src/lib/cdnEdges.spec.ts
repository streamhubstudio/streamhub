/**
 * Unit specs for the cdn-edge helpers of the Cluster page (pure).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cdnEdgeView, formatGbps, isCdnEdge, totalGbps } from './cdnEdges.ts'

const edge = (cdn: Record<string, unknown>) => ({ stats: { role: 'cdn-edge', cdn } })

test('isCdnEdge: the heartbeat role or a cdn block marks it', () => {
  assert.equal(isCdnEdge(edge({ txMbps: 1 })), true)
  assert.equal(isCdnEdge({ stats: { cdn: { txMbps: 1 } } }), true)
  assert.equal(isCdnEdge({ stats: { role: 'cdn-edge' } }), true)
  assert.equal(isCdnEdge({ stats: { role: 'origin', cpu: 3 } }), false)
  assert.equal(isCdnEdge({ stats: { cdn: 'x' } }), false)
  assert.equal(isCdnEdge({ stats: null }), false)
  assert.equal(isCdnEdge({}), false)
})

test('cdnEdgeView: Gbps out = txMbps / 1000, conns, cache dir', () => {
  const v = cdnEdgeView(edge({ conns: 4100, reqTotal: 9, txBytes: 1, txMbps: 16250, cacheDir: '/var/cache/nginx/hls' }))
  assert.deepEqual(v, { gbpsOut: 16.25, conns: 4100, cacheDir: '/var/cache/nginx/hls' })
  // not reported / garbage → null, never NaN
  assert.deepEqual(cdnEdgeView({ stats: { role: 'cdn-edge' } }), { gbpsOut: null, conns: null, cacheDir: null })
  assert.deepEqual(cdnEdgeView(edge({ txMbps: 'fast', conns: -1, cacheDir: '' })), { gbpsOut: null, conns: null, cacheDir: null })
})

test('formatGbps / totalGbps', () => {
  assert.equal(formatGbps(16.25), '16.25')
  assert.equal(formatGbps(0), '0.00')
  assert.equal(formatGbps(0.0125), '0.013')
  assert.equal(formatGbps(null), '—')
  assert.equal(formatGbps(Number.NaN, '-'), '-')
  assert.equal(totalGbps([edge({ txMbps: 16000 }), edge({ txMbps: 16250 }), { stats: { role: 'cdn-edge' } }]), 32.25)
})
