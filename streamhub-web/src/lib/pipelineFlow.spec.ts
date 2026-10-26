/**
 * Unit specs for the pipeline-flow geometry (pure) behind the Tablero's
 * <AppFlowDiagram>. Locks down the DYNAMIC topologies: only enabled stages
 * produce nodes/cables, the wave schedule stays causal and SMIL-safe, and the
 * degenerate shapes (0 ingest, transcoding off, no CDN, no recording, dormant
 * S3, N plugins) all yield a coherent diagram.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AppPipeline } from '../api/types.ts'
import {
  buildPipelineFlow,
  fmtKeyTime,
  smilPulseTiming,
  FLOW_WIDTH,
  FLOW_PERIOD,
  type FlowHop,
  type PipelineFlow,
} from './pipelineFlow.ts'

// --- fixtures -----------------------------------------------------------------

/** A fully-loaded pipeline: every stage on, some live. */
function full(overrides: Partial<AppPipeline> = {}): AppPipeline {
  return {
    ingest: [
      { type: 'rtmp', enabled: true, active: true, label: 'RTMP', detail: ':1935' },
      { type: 'whip', enabled: true, active: false, label: 'WHIP' },
      { type: 'webrtc', enabled: true, active: true, label: 'WebRTC' },
      { type: 'rtsp', enabled: false, active: false, label: 'RTSP' },
    ],
    processing: {
      transcoding: { enabled: true, encoder: 'gpu', hwaccel: 'auto' },
      adaptive: {
        enabled: true,
        layers: [
          { name: '720p', height: 720 },
          { name: '480p', height: 480 },
          { name: '360p', height: 360 },
        ],
      },
      passthrough: { enabled: false, transports: [] },
    },
    delivery: [
      { type: 'webrtc', enabled: true, active: true, label: 'WebRTC' },
      { type: 'hls', enabled: true, active: false, label: 'HLS' },
      { type: 'cdn', enabled: true, active: false, label: 'CDN' },
    ],
    storage: {
      recording: { enabled: true, splitMinutes: 15 },
      s3: { configured: true, bucket: 'my-app-vods' },
    },
    plugins: [
      { id: 'yolo', enabled: true, kind: 'plugin', category: 'processor' },
      { id: 'deface', enabled: true, kind: 'plugin', category: 'processor' },
      { id: 'transcription', enabled: false, kind: 'plugin', category: 'processor' },
    ],
    live: { activeStreams: 2, viewers: 14 },
    ...overrides,
  }
}

/** The bare minimum: nothing enabled anywhere. */
function minimal(): AppPipeline {
  return full({
    ingest: [],
    processing: {
      transcoding: { enabled: false, encoder: 'cpu', hwaccel: 'cpu' },
      adaptive: { enabled: false, layers: [] },
      passthrough: { enabled: false, transports: [] },
    },
    delivery: [],
    storage: { recording: { enabled: false }, s3: { configured: false } },
    plugins: [],
    live: { activeStreams: 0 },
  })
}

const ids = (flow: PipelineFlow) => flow.nodes.map((n) => n.id)
const cableById = (flow: PipelineFlow, id: string) =>
  flow.cables.find((c) => c.id === id)

/** Structural invariants every topology must satisfy. */
function assertCoherent(flow: PipelineFlow) {
  const nodeIds = new Set(ids(flow))
  assert.equal(nodeIds.size, flow.nodes.length, 'node ids are unique')
  const cableIds = new Set(flow.cables.map((c) => c.id))
  assert.equal(cableIds.size, flow.cables.length, 'cable ids are unique')

  for (const n of flow.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id}: finite coords`)
    assert.ok(n.x >= 0 && n.x <= flow.width, `${n.id}: x in viewBox`)
    assert.ok(n.y >= 0 && n.y <= flow.height, `${n.id}: y in viewBox`)
  }
  for (const c of flow.cables) {
    assert.ok(nodeIds.has(c.from), `${c.id}: from exists`)
    assert.ok(nodeIds.has(c.to), `${c.id}: to exists`)
    assert.match(c.d, /^M-?[\d.]+,-?[\d.]+ C/, `${c.id}: cubic bézier path`)
    assert.ok(c.length > 0, `${c.id}: positive length`)
  }
  for (const h of flow.wave.hops) {
    assert.ok(cableIds.has(h.cable), `hop ${h.cable}: cable exists`)
    assert.ok(h.start > 0 && h.start < h.end && h.end < 1, `hop ${h.cable}: 0<start<end<1`)
    const c = cableById(flow, h.cable)!
    assert.ok(c.enabled, `hop ${h.cable}: rides an enabled cable only`)
  }
  for (const s of flow.shuttles) {
    assert.ok(cableIds.has(s.cable), `shuttle ${s.cable}: cable exists`)
  }
  for (const [node, f] of Object.entries(flow.wave.hits)) {
    assert.ok(nodeIds.has(node), `hit ${node}: node exists`)
    assert.ok(f > 0 && f < 1, `hit ${node}: fraction in (0,1)`)
  }
}

// --- full topology --------------------------------------------------------------

test('full pipeline: every enabled stage becomes a node, disabled ones do not', () => {
  const flow = buildPipelineFlow(full())
  assertCoherent(flow)
  const nodeIds = ids(flow)

  assert.ok(nodeIds.includes('core'))
  assert.ok(nodeIds.includes('transcoding'))
  assert.ok(nodeIds.includes('adaptive'))
  assert.ok(nodeIds.includes('recording'))
  assert.ok(nodeIds.includes('s3'))
  assert.ok(nodeIds.includes('in-rtmp-0'))
  assert.ok(nodeIds.includes('in-whip-1'))
  assert.ok(nodeIds.includes('in-webrtc-2'))
  assert.ok(!nodeIds.some((id) => id.includes('rtsp')), 'disabled ingest filtered')
  assert.ok(nodeIds.includes('out-webrtc-0'))
  assert.ok(nodeIds.includes('out-hls-1'))
  assert.ok(nodeIds.includes('out-cdn-2'))
  assert.ok(nodeIds.includes('plug-yolo'))
  assert.ok(nodeIds.includes('plug-deface'))
  assert.ok(!nodeIds.includes('plug-transcription'), 'disabled plugin filtered')

  assert.equal(flow.width, FLOW_WIDTH)
  assert.equal(flow.period, FLOW_PERIOD)
  assert.deepEqual(flow.live, { activeStreams: 2, viewers: 14 })
})

test('full pipeline: deterministic (same input → same output)', () => {
  assert.deepEqual(buildPipelineFlow(full()), buildPipelineFlow(full()))
})

test('full pipeline: the spine chains core → transcoding → adaptive → delivery', () => {
  const flow = buildPipelineFlow(full())
  assert.ok(cableById(flow, 'core--transcoding'))
  assert.ok(cableById(flow, 'transcoding--adaptive'))
  // Delivery fans out of the END of the spine (adaptive), not the core.
  for (const type of ['webrtc', 'hls', 'cdn']) {
    const c = flow.cables.find((c) => c.to.startsWith(`out-${type}`))
    assert.ok(c, `delivery cable to ${type}`)
    assert.equal(c.from, 'adaptive')
  }
})

test('full pipeline: the wave plays in causal order', () => {
  const flow = buildPipelineFlow(full())
  const { hits, hops } = flow.wave
  const hopFor = (cable: string): FlowHop => {
    const h = hops.find((h) => h.cable === cable)
    assert.ok(h, `hop on ${cable}`)
    return h
  }

  // Every ingest packet lands before (or exactly when) the core hit fires.
  for (const h of hops.filter((h) => h.cable.startsWith('in-'))) {
    assert.ok(h.end <= hits.core, 'ingest arrives before the core hit')
  }
  // Spine relays after the core hit, in order.
  assert.ok(hopFor('core--transcoding').start > hits.core)
  assert.ok(hopFor('transcoding--adaptive').start >= hits.transcoding)
  // Delivery fan bursts only after the spine finishes.
  for (const h of hops.filter((h) => h.cable.includes('--out-'))) {
    assert.ok(h.start >= hits.adaptive, 'fan waits for processing')
  }
  // Storage: tap after the core hit, then recording → S3 strictly after.
  assert.ok(hopFor('core--recording').start > hits.core)
  assert.ok(hopFor('recording--s3').start >= hits.recording)
})

test('active vs configured: hop flags + pulse sizing follow the live state', () => {
  const flow = buildPipelineFlow(full())
  const rtmp = flow.wave.hops.find((h) => h.cable === 'in-rtmp-0--core')!
  const whip = flow.wave.hops.find((h) => h.cable === 'in-whip-1--core')!
  assert.equal(rtmp.active, true)
  assert.equal(whip.active, false)
  assert.ok(rtmp.r > whip.r, 'active pulses ride bigger')
  assert.ok(rtmp.core > whip.core)

  // With zero live streams the whole spine goes quiet (configured-only pulses).
  const idle = buildPipelineFlow(full({ live: { activeStreams: 0 } }))
  for (const h of idle.wave.hops.filter((h) => !h.cable.startsWith('in-'))) {
    if (h.cable.includes('--out-')) continue // delivery keeps its own flag
    assert.equal(h.active, false, `${h.cable} idle`)
  }
  assert.equal(idle.nodes.find((n) => n.id === 'core')!.active, false)
})

// --- dynamic cases ---------------------------------------------------------------

test('transcoding off: no processing nodes, delivery fans straight from the core', () => {
  const flow = buildPipelineFlow(
    full({
      processing: {
        transcoding: { enabled: false, encoder: 'cpu', hwaccel: 'cpu' },
        adaptive: { enabled: false, layers: [] },
      },
    }),
  )
  assertCoherent(flow)
  assert.ok(!ids(flow).includes('transcoding'))
  assert.ok(!ids(flow).includes('adaptive'))
  for (const c of flow.cables.filter((c) => c.to.startsWith('out-'))) {
    assert.equal(c.from, 'core')
  }
})

test('adaptive without transcoding: single processing node, centred slot', () => {
  const flow = buildPipelineFlow(
    full({
      processing: {
        transcoding: { enabled: false, encoder: 'cpu', hwaccel: 'cpu' },
        adaptive: { enabled: true, layers: [{ name: '540p', height: 540 }] },
      },
    }),
  )
  assertCoherent(flow)
  assert.ok(!ids(flow).includes('transcoding'))
  const adaptive = flow.nodes.find((n) => n.id === 'adaptive')!
  assert.equal(adaptive.detail, '540p')
  assert.ok(cableById(flow, 'core--adaptive'))
  for (const c of flow.cables.filter((c) => c.to.startsWith('out-'))) {
    assert.equal(c.from, 'adaptive')
  }
})

test('0 ingest: no ingest nodes/hops, the wave still fires downstream', () => {
  const flow = buildPipelineFlow(full({ ingest: [] }))
  assertCoherent(flow)
  assert.ok(!flow.nodes.some((n) => n.kind === 'ingest'))
  assert.ok(!flow.wave.hops.some((h) => h.cable.startsWith('in-')))
  assert.ok(flow.wave.hits.core > 0, 'core hit still scheduled')
  assert.ok(flow.wave.hops.some((h) => h.cable.includes('--out-')), 'delivery still pulses')
})

test('no CDN: only enabled delivery endpoints render', () => {
  const flow = buildPipelineFlow(
    full({
      delivery: [
        { type: 'webrtc', enabled: true, active: false, label: 'WebRTC' },
        { type: 'hls', enabled: true, active: false, label: 'HLS' },
        { type: 'cdn', enabled: false, active: false, label: 'CDN' },
      ],
    }),
  )
  assertCoherent(flow)
  assert.ok(!ids(flow).some((id) => id.startsWith('out-cdn')))
  assert.equal(flow.nodes.filter((n) => n.kind === 'delivery').length, 2)
})

test('no recording + no S3: the storage lane disappears and the box shrinks', () => {
  const withStorage = buildPipelineFlow(full())
  const flow = buildPipelineFlow(
    full({ storage: { recording: { enabled: false }, s3: { configured: false } } }),
  )
  assertCoherent(flow)
  assert.ok(!ids(flow).includes('recording'))
  assert.ok(!ids(flow).includes('s3'))
  assert.ok(flow.height < withStorage.height, 'no storage row reserved')
})

test('S3 configured but recording off: dormant lane — dashed cable, no pulse', () => {
  const flow = buildPipelineFlow(
    full({
      storage: {
        recording: { enabled: false },
        s3: { configured: true, bucket: 'cold-bucket' },
      },
    }),
  )
  assertCoherent(flow)
  assert.ok(!ids(flow).includes('recording'))
  const s3 = flow.nodes.find((n) => n.id === 's3')!
  assert.equal(s3.detail, 'cold-bucket')
  assert.equal(s3.active, false)
  const lane = cableById(flow, 'core--s3')!
  assert.equal(lane.enabled, false, 'dormant cable')
  assert.ok(!flow.wave.hops.some((h) => h.cable === 'core--s3'), 'never pulses')
})

test('recording without S3: local-only recording still renders and pulses', () => {
  const flow = buildPipelineFlow(
    full({ storage: { recording: { enabled: true }, s3: { configured: false } } }),
  )
  assertCoherent(flow)
  assert.ok(ids(flow).includes('recording'))
  assert.ok(!ids(flow).includes('s3'))
  assert.ok(flow.wave.hops.some((h) => h.cable === 'core--recording'))
})

test('N plugins: one chip + one ambient shuttle each, none rides the wave', () => {
  const plugins = ['yolo', 'deface', 'transcription', 'watermark', 'timestamp'].map(
    (id) => ({ id, enabled: true, kind: 'plugin' as const, category: 'processor' as const }),
  )
  const flow = buildPipelineFlow(full({ plugins }))
  assertCoherent(flow)
  const chips = flow.nodes.filter((n) => n.kind === 'plugin')
  assert.equal(chips.length, 5)
  assert.equal(flow.shuttles.length, 5)
  // Chips share the top row and never collide horizontally.
  const xs = chips.map((c) => c.x).sort((a, b) => a - b)
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] - xs[i - 1] >= 60, 'chips spaced apart')
  }
  assert.ok(!flow.wave.hops.some((h) => h.cable.includes('plug-')), 'plugins are ambient only')

  const none = buildPipelineFlow(full({ plugins: [] }))
  assert.equal(none.shuttles.length, 0)
  assert.ok(none.height < flow.height, 'plugin row only reserved when needed')
})

test('minimal pipeline: the core alone is still a valid diagram', () => {
  const flow = buildPipelineFlow(minimal())
  assertCoherent(flow)
  assert.deepEqual(ids(flow), ['core'])
  assert.equal(flow.cables.length, 0)
  assert.equal(flow.wave.hops.length, 0)
  assert.ok(flow.height > 0 && flow.height < 400)
})

test('lane count drives the height: more ingests → taller band', () => {
  const two = buildPipelineFlow(full())
  const seven = buildPipelineFlow(
    full({
      ingest: (['rtmp', 'rtmps', 'whip', 'webrtc', 'rtsp', 'url', 'ws-mjpeg'] as const).map(
        (type) => ({ type, enabled: true, active: false, label: type.toUpperCase() }),
      ),
    }),
  )
  assertCoherent(seven)
  assert.equal(seven.nodes.filter((n) => n.kind === 'ingest').length, 7)
  assert.ok(seven.height > two.height)
  // Even with 7 staggered feeds the whole wave fits inside one period.
  for (const h of seven.wave.hops) assert.ok(h.end < 1)
})

// --- 3-band extensions (compute / passthrough / events) -------------------------

/** A fully-loaded pipeline with EVERY new band populated. */
function loaded(overrides: Partial<AppPipeline> = {}): AppPipeline {
  return full({
    ingest: [
      { type: 'rtmp', enabled: true, active: true, label: 'RTMP' },
      { type: 'srt', enabled: true, active: true, label: 'SRT' },
    ],
    ingestFront: { mediamtx: true, port: 1935 },
    processing: {
      transcoding: { enabled: true, encoder: 'gpu', hwaccel: 'auto' },
      adaptive: { enabled: true, layers: [{ name: '720p', height: 720 }] },
      passthrough: { enabled: true, transports: ['rtmp', 'srt'] },
    },
    compute: {
      edge: { total: 3, online: 2 },
      vision: {
        enabled: true,
        models: ['object', 'face'],
        assignments: { running: 4, pending: 1 },
      },
    },
    delivery: [
      { type: 'webrtc', enabled: true, active: true, label: 'WebRTC' },
      { type: 'hls', enabled: true, active: true, label: 'HLS' },
      { type: 'restream', enabled: true, active: true, label: 'Restream', detail: '2 targets' },
    ],
    plugins: [
      { id: 'cockpit', enabled: true, kind: 'app', category: 'panel' },
      { id: 'yolo', enabled: true, kind: 'plugin', category: 'processor' },
      { id: 'deface', enabled: true, kind: 'plugin', category: 'processor' },
    ],
    live: { activeStreams: 2, viewers: 9, tags: ['store-01', 'lobby'] },
    events: {
      callbacks: { configured: true },
      mqtt: { enabled: true },
      log: { enabled: true },
    },
    notifications: { email: true, discord: true, telegram: false },
    net: { inBytes: 1_500_000, outBytes: 9_000_000, windowSec: 3600 },
    ...overrides,
  })
}

test('MediaMTX front: a router node splits ingest between core and remux', () => {
  const flow = buildPipelineFlow(loaded())
  assertCoherent(flow)
  const router = flow.nodes.find((n) => n.id === 'mediamtx')!
  assert.equal(router.kind, 'mediamtx')
  // Ingest merges into the router, which relays to the core.
  for (const c of flow.cables.filter((c) => c.from.startsWith('in-') && !c.to.startsWith('remux'))) {
    assert.equal(c.to, 'mediamtx')
  }
  assert.ok(cableById(flow, 'mediamtx--core'))
  assert.ok(flow.wave.hits.mediamtx > 0 && flow.wave.hits.mediamtx <= flow.wave.hits.core)
})

test('passthrough plane: a remux lane bypasses the core straight to HLS', () => {
  const flow = buildPipelineFlow(loaded())
  assertCoherent(flow)
  const remux = flow.nodes.find((n) => n.id === 'remux')!
  assert.equal(remux.kind, 'remux')
  assert.deepEqual(remux.chips, ['rtmp', 'srt'])
  // Fed from the router (not the core) and out to the HLS delivery edge.
  assert.ok(cableById(flow, 'mediamtx--remux'), 'remux fed off the router, not the core')
  assert.ok(!cableById(flow, 'core--remux'), 'remux never rides through the core')
  assert.ok(flow.cables.some((c) => c.from === 'remux' && c.to.startsWith('out-hls')))
})

test('compute band: apps vs processors split into their own chip rows', () => {
  const flow = buildPipelineFlow(loaded())
  assertCoherent(flow)
  const appChip = flow.nodes.find((n) => n.id === 'app-cockpit')!
  const procChip = flow.nodes.find((n) => n.id === 'plug-yolo')!
  assert.equal(appChip.kind, 'plugin')
  assert.equal(appChip.group, 'app')
  assert.equal(procChip.group, 'processor')
  // The apps row sits strictly above the processors row.
  assert.ok(appChip.y < procChip.y, 'apps row above processors row')
  // Each chip still gets an ambient shuttle off the core.
  assert.ok(flow.shuttles.some((s) => s.cable === 'core--app-cockpit'))
  assert.ok(flow.shuttles.some((s) => s.cable === 'core--plug-yolo'))
})

test('edge cluster: hub + per-model chips branch off the HLS edge with shuttles', () => {
  const flow = buildPipelineFlow(loaded())
  assertCoherent(flow)
  const edge = flow.nodes.find((n) => n.id === 'edge')!
  assert.equal(edge.kind, 'edge')
  assert.equal(edge.detail, '2/3') // online/total
  const modelIds = flow.nodes.filter((n) => n.kind === 'compute').map((n) => n.id)
  assert.deepEqual(modelIds.sort(), ['model-face', 'model-object'])
  // The hub hangs off the HLS delivery edge (branch), model chips are ambient.
  assert.ok(flow.cables.some((c) => c.from.startsWith('out-hls') && c.to === 'edge'))
  assert.ok(flow.shuttles.some((s) => s.cable === 'edge--model-object'))
  // No model chip rides the causal wave.
  assert.ok(!flow.wave.hops.some((h) => h.cable.includes('model-')))
})

test('events band: detections → events hub → notify fan-out + reserved Streamflow', () => {
  const flow = buildPipelineFlow(loaded())
  assertCoherent(flow)
  const hub = flow.nodes.find((n) => n.id === 'events')!
  assert.equal(hub.kind, 'events')
  assert.deepEqual(hub.chips, ['callbacks', 'mqtt', 'log'])
  // The reserved Streamflow slot is a faint placeholder with dormant cables.
  const sf = flow.nodes.find((n) => n.id === 'streamflow')!
  assert.equal(sf.placeholder, true)
  assert.equal(cableById(flow, 'events--streamflow')!.enabled, false)
  // Only the two enabled channels fan out; telegram is off.
  const notifyIds = flow.nodes.filter((n) => n.kind === 'notify').map((n) => n.id).sort()
  assert.deepEqual(notifyIds, ['notify-discord', 'notify-email'])
  assert.ok(cableById(flow, 'core--events'))
  assert.ok(cableById(flow, 'events--notify-email')!.enabled)
})

test('tags: distinct live tag slugs ride under the core as chips', () => {
  const flow = buildPipelineFlow(loaded())
  const core = flow.nodes.find((n) => n.id === 'core')!
  assert.deepEqual(core.chips, ['store-01', 'lobby'])
  // Net summary is surfaced for the header meters.
  assert.deepEqual(flow.net, { inBytes: 1_500_000, outBytes: 9_000_000, windowSec: 3600 })
})

test('events band absent when there is no real fan-out (log-only)', () => {
  const flow = buildPipelineFlow(
    loaded({
      events: { callbacks: { configured: false }, mqtt: { enabled: false }, log: { enabled: true } },
      notifications: { email: false, discord: false, telegram: false },
    }),
  )
  assertCoherent(flow)
  assert.ok(!flow.nodes.some((n) => n.kind === 'events'))
  assert.ok(!flow.nodes.some((n) => n.kind === 'notify'))
})

test('optional-safe: an older-core pipeline (no new sections) still renders', () => {
  // full() carries none of ingestFront/compute/events/notifications/net.
  const flow = buildPipelineFlow(full())
  assertCoherent(flow)
  assert.ok(!flow.nodes.some((n) => ['mediamtx', 'remux', 'edge', 'compute', 'events', 'notify'].includes(n.kind)))
  assert.equal(flow.net, undefined)
})

// --- SMIL helpers ----------------------------------------------------------------

test('fmtKeyTime: dot-decimal, trailing zeros trimmed', () => {
  assert.equal(fmtKeyTime(0), '0')
  assert.equal(fmtKeyTime(0.35), '0.35')
  assert.equal(fmtKeyTime(0.35), fmtKeyTime(0.35))
  assert.equal(fmtKeyTime(0.5), '0.5')
  assert.equal(fmtKeyTime(0.1234), '0.1234')
  assert.equal(fmtKeyTime(1), '1')
})

test('smilPulseTiming: non-decreasing keyTimes bracketed by 0 and 1', () => {
  const flow = buildPipelineFlow(full())
  for (const hop of flow.wave.hops) {
    const t = smilPulseTiming(hop)
    for (const list of [t.motionKeyTimes, t.opacityKeyTimes]) {
      const parts = list.split(';').map(Number)
      assert.equal(parts[0], 0)
      assert.equal(parts[parts.length - 1], 1)
      for (let i = 1; i < parts.length; i++) {
        assert.ok(Number.isFinite(parts[i]), `${list}: numeric`)
        assert.ok(parts[i] >= parts[i - 1], `${list}: non-decreasing`)
      }
    }
    assert.equal(t.keyPoints.split(';').length, t.motionKeyTimes.split(';').length)
    assert.equal(t.opacityValues.split(';').length, t.opacityKeyTimes.split(';').length)
  }
})

test('smilPulseTiming: survives a degenerate zero-width hop', () => {
  const t = smilPulseTiming({ cable: 'x', start: 0.5, end: 0.5005, active: true, r: 6, core: 2 })
  const parts = t.opacityKeyTimes.split(';').map(Number)
  for (let i = 1; i < parts.length; i++) {
    assert.ok(parts[i] >= parts[i - 1], 'still non-decreasing')
  }
})
