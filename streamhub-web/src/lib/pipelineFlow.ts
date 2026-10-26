/**
 * Pipeline-flow geometry — pure, deterministic, no SVG / React / dependencies.
 *
 * Maps an app's ACTUAL configured media pipeline (GET /apps/:app/pipeline) onto
 * a THREE-BAND flow diagram:
 *
 *   ┌ COMPUTE band (top) ─ Studio Apps + processor/tool chips over the core,
 *   │                      and a distributed EDGE COMPUTE cluster (per-model
 *   │                      chips) branching off the HLS delivery edge.
 *   ├ MEDIA band (middle) ─ the media spine, now DUAL-LANE: ingest → (MediaMTX
 *   │                      router) → StreamHub core → transcoding/adaptive →
 *   │                      delivery, plus a passthrough/remux lane below it that
 *   │                      bypasses the core (-c copy). Tag chips sit under the
 *   │                      core; the recorder taps the core towards storage.
 *   └ EVENTS band (bottom) ─ storage tap bottom-left (recording → S3), mirrored
 *                          bottom-right by the event fan-out: detections →
 *                          callbacks/MQTT/log → [reserved Streamflow slot] →
 *                          email/Discord/Telegram notifications.
 *
 * Only ENABLED stages produce nodes/cables, so the picture always mirrors the
 * app's real configuration; a bare core (nothing configured) is a first-class
 * shape, not an error case. New sections are optional-safe on the client — an
 * older core that omits them degrades to the classic single-band diagram.
 *
 * Outputs plain data ready for <AppFlowDiagram> (src/components):
 *   - nodes: coordinates + kind + pass-through labels/details/chips,
 *   - cables: curved cubic-bézier paths (reusing wiredNetwork's cablePath)
 *     with `enabled`/`active` flags — dormant lanes render static, active
 *     lanes pulse brighter/faster,
 *   - wave: keyTimes fractions for the SMIL pulses so ONE packet story plays
 *     per PERIOD in causal order (ingest → core → processing hold → delivery
 *     fan-out + storage/events taps),
 *   - shuttles: ambient back-and-forth pulses on the plugin / edge / notify
 *     cables.
 *
 * Kept framework-free (like AgentFlow.php) so it stays unit-testable under
 * node:test without a DOM.
 */
import type { AppPipeline } from '@/api'
import { cablePath } from './wiredNetwork.ts'

// --- output types -------------------------------------------------------------

export type FlowNodeKind =
  | 'ingest'
  | 'core'
  | 'processing'
  | 'delivery'
  | 'storage'
  | 'plugin'
  | 'mediamtx'
  | 'remux'
  | 'edge'
  | 'compute'
  | 'events'
  | 'notify'

export interface FlowNode {
  /** Stable id: `core`, `transcoding`, `mediamtx`, `remux`, `edge`, `events`,
   *  `streamflow`, `recording`, `s3`, `in-<type>-<i>`, `out-<type>-<i>`,
   *  `app-<id>`, `plug-<id>`, `model-<name>`, `notify-<channel>`. */
  id: string
  kind: FlowNodeKind
  x: number
  y: number
  /** API-provided display label (ingest/delivery) or the plugin id; fixed nodes translate via `id`. */
  label?: string
  /** Language-neutral secondary line (protocol detail, layer list, bucket…). */
  detail?: string
  /** Live right now (bright treatment) vs merely configured. */
  active: boolean
  /** Plugin chips: which lane/header they belong to. */
  group?: 'app' | 'processor'
  /** Small pill labels rendered under the node (tags, models, transports, taps). */
  chips?: string[]
  /** Faint "coming soon" placeholder (the reserved Streamflow slot). */
  placeholder?: boolean
}

export interface FlowCable {
  /** Stable id — the component namespaces it per instance for `<path id>` / `<mpath href>`. */
  id: string
  /** SVG path data ("M… C…"). */
  d: string
  /** Straight-line endpoint distance — keeps pulse speed uniform. */
  length: number
  from: string
  to: string
  /** Dormant cables (e.g. S3 configured but recording off) render dashed/faint and never pulse. */
  enabled: boolean
  /** Media flowing right now → brighter/faster treatment. */
  active: boolean
}

export interface FlowHop {
  /** Cable id the pulse rides. */
  cable: string
  /** Wave window as fractions of `period` (0 < start < end < 1). */
  start: number
  end: number
  active: boolean
  /** Pulse sizing hints (halo / core radii, viewBox units). */
  r: number
  core: number
}

export interface FlowShuttle {
  cable: string
  /** Odd shuttles ride the cable backwards so the lane reads bidirectional. */
  reverse: boolean
}

export interface PipelineFlow {
  width: number
  height: number
  /** One full ingest→delivery wave, in seconds. */
  period: number
  nodes: FlowNode[]
  cables: FlowCable[]
  wave: {
    hops: FlowHop[]
    /** Node id → arrival fraction of the wave (drives the CSS "hit" flash delay). */
    hits: Record<string, number>
  }
  shuttles: FlowShuttle[]
  live: { activeStreams: number; viewers?: number }
  /** Rolling network I/O for the ingest/delivery header meters (bytes). */
  net?: { inBytes: number; outBytes: number; windowSec: number }
  /** y anchor for the media-band ingest/delivery column headers. */
  mediaHeaderY: number
}

// --- constants ------------------------------------------------------------------

export const FLOW_WIDTH = 1120
export const FLOW_PERIOD = 8.0

/** Wave propagation speed along the main cables, px/s. */
const SPEED = 230
/** The delivery fan bursts a little faster — replication, not relay. */
const FAN_SPEED = 300

/** Column anchors (exported so the component can place headers/hints even when a column is empty). */
export const FLOW_X_INGEST = 96
export const FLOW_X_CORE = 360
export const FLOW_X_DELIVERY = 904
const X_MEDIAMTX = 224
const X_REMUX = 596
/** Storage tap (bottom-left): recording → S3. */
const X_RECORDING = 296
const X_S3 = 468
/** Compute-band chip rows (Studio Apps over processors), over the processing area. */
export const FLOW_Y_APPS = 52
export const FLOW_Y_PROC = 98
/** Edge-compute cluster, top-right, hanging off the HLS delivery edge. */
const X_EDGE = 1012
const Y_EDGE = 66
/** Events band (bottom-right), mirroring the storage tap bottom-left. */
const X_EVENTS = 640
const X_STREAMFLOW = 796
const X_NOTIFY = 948

// --- build ------------------------------------------------------------------

export function buildPipelineFlow(p: AppPipeline): PipelineFlow {
  const ingest = p.ingest.filter((i) => i.enabled)
  const delivery = p.delivery.filter((d) => d.enabled)
  const enabledPlugins = p.plugins.filter((pl) => pl.enabled)
  const apps = enabledPlugins.filter((pl) => pl.kind === 'app')
  const processors = enabledPlugins.filter((pl) => pl.kind !== 'app')
  const recording = p.storage.recording.enabled
  const s3 = p.storage.s3.configured
  const streaming = (p.live?.activeStreams ?? 0) > 0
  const tags = (p.live?.tags ?? []).filter((t) => !!t).slice(0, 6)

  // Media front-door + passthrough plane (optional-safe).
  const mediamtxOn = !!p.ingestFront?.mediamtx
  const transports = p.processing.passthrough?.transports ?? []
  const remuxOn = !!p.processing.passthrough?.enabled
  const srtActive = p.ingest.some((i) => i.type === 'srt' && i.active)

  // Compute band: Studio Apps + processors chips, and the edge cluster.
  const models = (p.compute?.vision.models ?? []).filter((m) => !!m).slice(0, 5)
  const edgeTotal = p.compute?.edge.total ?? 0
  const edgeOnline = p.compute?.edge.online ?? 0
  const visionOn = !!p.compute?.vision.enabled || models.length > 0
  const edgeClusterOn = visionOn || edgeTotal > 0

  // Events band: the fan-out only appears when there is a real tap beyond the
  // always-on log (callbacks / MQTT / any notification channel).
  const ev = p.events
  const notify = p.notifications
  const notifyChannels = notify
    ? (['email', 'discord', 'telegram'] as const).filter((c) => notify[c])
    : []
  const eventsOn =
    !!(ev && (ev.callbacks.configured || ev.mqtt.enabled)) ||
    notifyChannels.length > 0

  const computeBand = apps.length > 0 || processors.length > 0 || edgeClusterOn

  // --- vertical layout: [compute band] [media band] [storage+events band] ----
  const lanes = Math.max(1, ingest.length, delivery.length)
  const bandH = Math.max(150, Math.min(64 * (lanes - 1) + 64, 400))
  const topPad = computeBand ? 156 : 64
  const yc = round(topPad + bandH / 2)
  const bandBottom = topPad + bandH
  const bottomBand = recording || s3 || eventsOn
  const yBottom = round(bandBottom + 92)
  const mediaHeaderY = round(topPad - 8)

  /** y of lane `i` of `k` stacked in the main band, centred on `yc`. */
  const laneY = (k: number, i: number): number => {
    if (k <= 1) return yc
    const h = Math.min(64 * (k - 1), bandH - 44)
    return round(yc - h / 2 + (h * i) / (k - 1))
  }

  const nodes: FlowNode[] = []
  const cables: FlowCable[] = []
  const hops: FlowHop[] = []
  const hits: Record<string, number> = {}
  const shuttles: FlowShuttle[] = []
  const at = new Map<string, { x: number; y: number }>()

  const addNode = (n: FlowNode): FlowNode => {
    nodes.push(n)
    at.set(n.id, { x: n.x, y: n.y })
    return n
  }
  const addCable = (
    from: string,
    to: string,
    curvature: number,
    opts: { enabled: boolean; active: boolean },
  ): FlowCable => {
    const a = at.get(from)!
    const b = at.get(to)!
    const c: FlowCable = {
      id: `${from}--${to}`,
      d: cablePath({ ...a, r: 0 }, { ...b, r: 0 }, curvature),
      length: round(Math.hypot(b.x - a.x, b.y - a.y)),
      from,
      to,
      ...opts,
    }
    cables.push(c)
    return c
  }
  /** Register a wave hop; returns the arrival time in seconds. */
  const addHop = (
    cable: FlowCable,
    startS: number,
    endS: number,
    active: boolean,
    rBase: number,
  ): number => {
    const start = frac(startS)
    let end = frac(endS)
    if (end <= start) end = Math.min(0.9999, start + 0.005)
    hops.push({
      cable: cable.id,
      start,
      end,
      active,
      // Active lanes carry a visibly bigger, brighter packet.
      r: active ? round(rBase * 1.4) : rBase,
      core: active ? round(rBase * 0.42) : round(rBase * 0.28),
    })
    return endS
  }

  // ===========================================================================
  // MEDIA band — core, ingest, router, spine, delivery, passthrough lane
  // ===========================================================================
  addNode({
    id: 'core',
    kind: 'core',
    x: FLOW_X_CORE,
    y: yc,
    active: streaming,
    ...(tags.length ? { chips: tags } : {}),
  })

  ingest.forEach((it, i) => {
    addNode({
      id: `in-${it.type}-${i}`,
      kind: 'ingest',
      x: FLOW_X_INGEST,
      y: laneY(ingest.length, i),
      label: it.label,
      detail: it.detail,
      active: it.active,
    })
  })

  // MediaMTX single-port router: fans the ingest in, then splits the live plane
  // (→ core) from the passthrough plane (→ remux).
  if (mediamtxOn) {
    addNode({
      id: 'mediamtx',
      kind: 'mediamtx',
      x: X_MEDIAMTX,
      y: yc,
      active: streaming,
      detail: p.ingestFront ? `:${p.ingestFront.port}` : undefined,
    })
  }
  /** Where the live plane starts its journey to the core. */
  const liveHub = mediamtxOn ? 'mediamtx' : null

  // Processing spine: core → [transcoding?] → [adaptive?]. Skipped stages
  // simply don't exist — delivery then fans straight out of the last node.
  const procIds: string[] = []
  if (p.processing.transcoding.enabled) procIds.push('transcoding')
  if (p.processing.adaptive.enabled) procIds.push('adaptive')
  const procX = procIds.length === 2 ? [520, 680] : [600]
  procIds.forEach((id, i) => {
    addNode({
      id,
      kind: 'processing',
      x: procX[i],
      y: yc,
      detail:
        id === 'adaptive'
          ? p.processing.adaptive.layers.map((l) => l.name).join(' · ') || undefined
          : undefined,
      active: streaming,
    })
  })

  delivery.forEach((d, i) => {
    addNode({
      id: `out-${d.type}-${i}`,
      kind: 'delivery',
      x: FLOW_X_DELIVERY,
      y: laneY(delivery.length, i),
      label: d.label,
      detail: d.detail,
      active: d.active,
    })
  })

  // Passthrough / remux lane: below the spine, bypassing the core (-c copy).
  const remuxY = round(yc + Math.min(bandH / 2 - 6, 110))
  if (remuxOn) {
    addNode({
      id: 'remux',
      kind: 'remux',
      x: X_REMUX,
      y: remuxY,
      active: srtActive,
      ...(transports.length ? { chips: transports } : {}),
    })
  }

  // ===========================================================================
  // COMPUTE band — Studio Apps + processor chips, edge-compute cluster
  // ===========================================================================
  const placeChips = (list: { id: string }[], y: number, prefix: 'app' | 'plug') => {
    const gap = list.length > 1 ? Math.min(150, 460 / (list.length - 1)) : 0
    list.forEach((pl, i) => {
      addNode({
        id: `${prefix}-${pl.id}`,
        kind: 'plugin',
        group: prefix === 'app' ? 'app' : 'processor',
        x: round(560 + (i - (list.length - 1) / 2) * gap),
        y,
        label: pl.id,
        active: streaming,
      })
    })
  }
  placeChips(apps, FLOW_Y_APPS, 'app')
  placeChips(processors, FLOW_Y_PROC, 'plug')

  // Edge cluster hub + per-model chips, branching off the HLS delivery edge.
  if (edgeClusterOn) {
    addNode({
      id: 'edge',
      kind: 'edge',
      x: X_EDGE,
      y: Y_EDGE,
      active: edgeOnline > 0,
      detail: edgeTotal > 0 ? `${edgeOnline}/${edgeTotal}` : undefined,
    })
    // Per-model chips stack in a single column below the hub (below its label).
    models.forEach((m, i) => {
      addNode({
        id: `model-${m}`,
        kind: 'compute',
        x: X_EDGE,
        y: round(Y_EDGE + 84 + i * 30),
        label: m,
        active: streaming && edgeOnline > 0,
      })
    })
  }

  // ===========================================================================
  // STORAGE + EVENTS band — recording→S3 (left), event fan-out (right)
  // ===========================================================================
  if (recording) {
    addNode({ id: 'recording', kind: 'storage', x: X_RECORDING, y: yBottom, active: streaming })
  }
  if (s3) {
    addNode({
      id: 's3',
      kind: 'storage',
      x: X_S3,
      y: yBottom,
      detail: p.storage.s3.bucket,
      active: streaming && recording,
    })
  }

  if (eventsOn) {
    const taps: string[] = []
    if (ev?.callbacks.configured) taps.push('callbacks')
    if (ev?.mqtt.enabled) taps.push('mqtt')
    if (ev?.log.enabled ?? true) taps.push('log')
    addNode({
      id: 'events',
      kind: 'events',
      x: X_EVENTS,
      y: yBottom,
      active: streaming,
      ...(taps.length ? { chips: taps } : {}),
    })
    // Reserved future Streamflow node — faint placeholder in the gap.
    addNode({
      id: 'streamflow',
      kind: 'events',
      x: X_STREAMFLOW,
      y: yBottom,
      active: false,
      placeholder: true,
    })
    // Notification fan-out (one node per resolved-enabled channel).
    const spread = notifyChannels.length > 1 ? Math.min(60, 120 / (notifyChannels.length - 1)) : 0
    notifyChannels.forEach((ch, i) => {
      addNode({
        id: `notify-${ch}`,
        kind: 'notify',
        x: X_NOTIFY,
        y: round(yBottom + (i - (notifyChannels.length - 1) / 2) * spread),
        active: streaming,
      })
    })
  }

  // ===========================================================================
  // Cables + wave schedule
  // ===========================================================================
  // Ingest fan-in: staggered starts so the feeds visibly merge into the hub.
  const mergeTarget = liveHub ?? 'core'
  let mergeHitS = 0.5 // even with no ingest the wave starts shortly into the cycle
  ingest.forEach((it, i) => {
    const from = `in-${it.type}-${i}`
    const raw = ingest.length > 1 ? -0.12 + 0.24 * (i / (ingest.length - 1)) : 0.05
    // A perfectly straight path has a zero-height bbox (voids gradients) — keep a hair of bow.
    const curvature = Math.abs(raw) < 0.05 ? 0.05 : raw
    const c = addCable(from, mergeTarget, curvature, { enabled: true, active: it.active })
    mergeHitS = Math.max(mergeHitS, addHop(c, 0.3 + 0.22 * i, 0.3 + 0.22 * i + c.length / SPEED, it.active, 6.5))
  })

  // MediaMTX → core (live plane relay).
  let coreHitS = mergeHitS
  if (liveHub) {
    hits.mediamtx = frac(mergeHitS)
    const c = addCable('mediamtx', 'core', -0.05, { enabled: true, active: streaming })
    coreHitS = addHop(c, mergeHitS + 0.12, mergeHitS + 0.12 + c.length / SPEED, streaming, 6.5)
  }
  hits.core = frac(coreHitS)

  // Spine: one packet relayed through each enabled processing stage, with a
  // short "processing hold" at every node.
  let cursorS = coreHitS + 0.18
  let spineEnd = 'core'
  for (const id of procIds) {
    const c = addCable(spineEnd, id, -0.06, { enabled: true, active: streaming })
    cursorS = addHop(c, cursorS, cursorS + c.length / SPEED, streaming, 7)
    hits[id] = frac(cursorS)
    cursorS += 0.24
    spineEnd = id
  }

  // Delivery fan-out: bursts from the end of the spine, slightly staggered.
  const fanStartS = cursorS + (procIds.length > 0 ? 0.15 : 0.3)
  delivery.forEach((d, i) => {
    const to = `out-${d.type}-${i}`
    const curvature = (i % 2 === 0 ? -1 : 1) * (0.05 + 0.02 * (i % 3))
    const c = addCable(spineEnd, to, curvature, { enabled: true, active: d.active })
    const start = fanStartS + 0.07 * i
    hits[to] = frac(addHop(c, start, start + c.length / FAN_SPEED, d.active, 6))
  })

  // Passthrough lane: fed from the router (or the SRT/first ingest node) and
  // remuxed straight to the HLS delivery edge — bypassing the core spine.
  if (remuxOn) {
    const srtNode = ingest.findIndex((i) => i.type === 'srt')
    const feed = liveHub ?? (srtNode >= 0 ? `in-srt-${srtNode}` : ingest.length ? `in-${ingest[0].type}-0` : 'core')
    const feedC = addCable(feed, 'remux', 0.14, { enabled: true, active: srtActive })
    const remuxEnd = addHop(feedC, mergeHitS + 0.2, mergeHitS + 0.2 + feedC.length / SPEED, srtActive, 6)
    hits.remux = frac(remuxEnd)
    const hlsIdx = delivery.findIndex((d) => d.type === 'hls')
    const outIdx = hlsIdx >= 0 ? hlsIdx : delivery.length ? 0 : -1
    if (outIdx >= 0) {
      const out = addCable('remux', `out-${delivery[outIdx].type}-${outIdx}`, -0.1, {
        enabled: true,
        active: srtActive,
      })
      addHop(out, remuxEnd + 0.12, remuxEnd + 0.12 + out.length / FAN_SPEED, srtActive, 6)
    }
  }

  // Storage lane: the recorder taps the media at the core (egress), then the
  // finished file rides on to S3. S3 configured without recording = dormant.
  if (recording) {
    const rec = addCable('core', 'recording', 0.16, { enabled: true, active: streaming })
    const recEnd = addHop(rec, coreHitS + 0.35, coreHitS + 0.35 + rec.length / SPEED, streaming, 6)
    hits.recording = frac(recEnd)
    if (s3) {
      const up = addCable('recording', 's3', -0.08, { enabled: true, active: streaming })
      hits.s3 = frac(addHop(up, recEnd + 0.22, recEnd + 0.22 + up.length / SPEED, streaming, 6))
    }
  } else if (s3) {
    addCable('core', 's3', 0.12, { enabled: false, active: false })
  }

  // Event fan-out lane: the core taps detections towards the events hub, which
  // fans out to the notification channels. The reserved Streamflow node sits in
  // the gap with faint dormant stubs (events → streamflow → notify centroid).
  if (eventsOn) {
    const tap = addCable('core', 'events', 0.2, { enabled: true, active: streaming })
    const evEnd = addHop(tap, coreHitS + 0.5, coreHitS + 0.5 + tap.length / SPEED, streaming, 5.5)
    hits.events = frac(evEnd)
    // Faint future path through the reserved Streamflow slot.
    addCable('events', 'streamflow', 0.05, { enabled: false, active: false })
    notifyChannels.forEach((ch, i) => {
      addCable('streamflow', `notify-${ch}`, (i % 2 === 0 ? -1 : 1) * 0.08, { enabled: false, active: false })
      const c = addCable('events', `notify-${ch}`, (i % 2 === 0 ? -1 : 1) * (0.06 + 0.02 * i), {
        enabled: true,
        active: streaming,
      })
      hits[`notify-${ch}`] = frac(addHop(c, evEnd + 0.18 + 0.05 * i, evEnd + 0.18 + 0.05 * i + c.length / FAN_SPEED, streaming, 5))
    })
  }

  // Plugin cables: ambient shuttles (always analysing), outside the wave.
  const chipNodes = [...apps.map((a) => `app-${a.id}`), ...processors.map((p2) => `plug-${p2.id}`)]
  chipNodes.forEach((id, i) => {
    const c = addCable('core', id, i % 2 === 0 ? -0.14 : 0.14, { enabled: true, active: streaming })
    shuttles.push({ cable: c.id, reverse: i % 2 === 1 })
  })

  // Edge cluster: HLS → edge hub (real feed) + hub → model chips (ambient).
  if (edgeClusterOn) {
    const hlsIdx = delivery.findIndex((d) => d.type === 'hls')
    const src = hlsIdx >= 0 ? `out-hls-${hlsIdx}` : delivery.length ? `out-${delivery[0].type}-0` : 'core'
    const feed = addCable(src, 'edge', -0.16, { enabled: true, active: edgeOnline > 0 })
    shuttles.push({ cable: feed.id, reverse: false })
    models.forEach((m, i) => {
      const c = addCable('edge', `model-${m}`, i % 2 === 0 ? 0.14 : -0.14, {
        enabled: true,
        active: streaming && edgeOnline > 0,
      })
      shuttles.push({ cable: c.id, reverse: i % 2 === 1 })
    })
  }

  const height = round(
    Math.max(bottomBand ? yBottom + 40 : bandBottom, ...nodes.map((n) => n.y + 44)) + 24,
  )

  return {
    width: FLOW_WIDTH,
    height,
    period: FLOW_PERIOD,
    nodes,
    cables,
    wave: { hops, hits },
    shuttles,
    live: { activeStreams: p.live?.activeStreams ?? 0, viewers: p.live?.viewers },
    ...(p.net ? { net: p.net } : {}),
    mediaHeaderY,
  }
}

// --- SMIL helpers (pure + testable; consumed by <AppFlowDiagram>) -------------

/**
 * Format a wave fraction as a SMIL keyTimes token: plain dot-decimal,
 * ≤4 decimals, no trailing zeros ("0.35", not "0.3500").
 */
export function fmtKeyTime(f: number): string {
  const s = f.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return s || '0'
}

export interface PulseTiming {
  /** `<animateMotion keyPoints>` — hold at the start, ride the hop, hold at the end. */
  keyPoints: string
  /** `<animateMotion keyTimes>` matching `keyPoints`. */
  motionKeyTimes: string
  /** `<animate attributeName="opacity" values>` — faded in/out around the hop. */
  opacityValues: string
  /** keyTimes for `opacityValues` (non-decreasing, 0…1). */
  opacityKeyTimes: string
}

/**
 * The SMIL timing attributes for one wave hop: the packet holds parked at the
 * cable start, rides during its window, and is opacity-gated so it only shows
 * while moving. Guarantees non-decreasing keyTimes even for tiny windows.
 */
export function smilPulseTiming(hop: FlowHop): PulseTiming {
  const mid = (hop.start + hop.end) / 2
  const fadeIn = Math.min(hop.start + 0.006, mid)
  const fadeOut = Math.max(hop.end - 0.006, mid)
  return {
    keyPoints: '0;0;1;1',
    motionKeyTimes: `0;${fmtKeyTime(hop.start)};${fmtKeyTime(hop.end)};1`,
    opacityValues: '0;0;1;1;0;0',
    opacityKeyTimes: `0;${fmtKeyTime(hop.start)};${fmtKeyTime(fadeIn)};${fmtKeyTime(fadeOut)};${fmtKeyTime(hop.end)};1`,
  }
}

// --- internals ----------------------------------------------------------------

/** Seconds → fraction of the wave period, rounded for stable SMIL keyTimes. */
function frac(seconds: number): number {
  return Math.min(round4(seconds / FLOW_PERIOD), 0.999)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
