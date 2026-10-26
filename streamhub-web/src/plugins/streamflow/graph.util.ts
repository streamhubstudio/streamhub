/**
 * Streamflow — PURE canvas-graph model + geometry (no React/DOM).
 *
 * The visual editor keeps an in-memory `CanvasGraph` (boxes with a screen
 * `position`, edges carrying explicit `fromPort`/`toPort`). This module owns the
 * two things that must be provably correct and are therefore unit-tested under
 * node:test, independently of any DOM:
 *
 *   - (de)serialization to/from the backend `graph_json` shape
 *     (`{boxes:[{id,type,config,position?}], edges:[{from,fromPort?,to,toPort?}]}`,
 *     tolerating the `box:port` colon shorthand the runner also accepts);
 *   - connection VALIDATION (port existence, no self-loop, no edge INTO a
 *     trigger, no duplicate, and — the expensive-to-debug one — no cycle), plus
 *     the port/edge geometry the SVG cable layer draws from.
 *
 * The catalogue types mirror streamhub-core `boxes/catalogue.ts` (the palette
 * the backend serves at GET …/boxes); we redeclare them here because the web
 * app cannot import from the core package.
 */

// ---------------------------------------------------------------------------
// Catalogue (mirrors streamhub-core boxes/catalogue.ts — the GET /boxes shape)
// ---------------------------------------------------------------------------

export type BoxGroup = 'trigger' | 'action' | 'logic'

export interface BoxField {
  key: string
  type: 'string' | 'number' | 'boolean' | 'select' | 'json' | 'text'
  label: string
  help?: string
  options?: { value: string; label: string }[]
}

export interface BoxSpec {
  type: string
  group: BoxGroup
  label: string
  description: string
  inputs: string[]
  outputs: string[]
  fields: BoxField[]
  /** Flag-gated execution box (only served when streamflow.dangerousNodes is on). */
  dangerous?: boolean
}

// ---------------------------------------------------------------------------
// Canvas model
// ---------------------------------------------------------------------------

export interface Vec {
  x: number
  y: number
}

export interface CanvasBox {
  id: string
  type: string
  config: Record<string, unknown>
  position: Vec
}

export interface CanvasEdge {
  /** Client-only id (stable for React keys + click-to-delete). */
  id: string
  from: string
  fromPort: string
  to: string
  toPort: string
}

export interface CanvasGraph {
  boxes: CanvasBox[]
  edges: CanvasEdge[]
}

// The serialized (backend) shape.
export interface GraphJsonBox {
  id: string
  type: string
  config: Record<string, unknown>
  position?: Vec
}
export interface GraphJsonEdge {
  from: string
  fromPort?: string
  to: string
  toPort?: string
}
export interface GraphJson {
  boxes: GraphJsonBox[]
  edges: GraphJsonEdge[]
}

// ---------------------------------------------------------------------------
// Geometry — the ONE source of truth shared by the HTML nodes + SVG cables
// ---------------------------------------------------------------------------

/** Node width (px). */
export const BOX_W = 210
/** Header (drag handle) height (px). */
export const BOX_HEADER = 40
/** Vertical gap between successive ports (px). */
export const PORT_GAP = 24
/** Top padding from the box top to the FIRST port centre (px). */
export const PORT_PAD = 18

/** Y offset (from a box's top) of the port at `index`. */
export function portOffsetY(index: number): number {
  return BOX_HEADER + PORT_PAD + index * PORT_GAP
}

/** Total rendered height of a box with `inCount`/`outCount` ports. */
export function boxHeight(inCount: number, outCount: number): number {
  const rows = Math.max(1, inCount, outCount)
  return BOX_HEADER + PORT_PAD + (rows - 1) * PORT_GAP + PORT_PAD
}

/** Absolute canvas point of a box port (left edge for inputs, right for outputs). */
export function portPoint(box: CanvasBox, side: 'in' | 'out', index: number): Vec {
  return {
    x: box.position.x + (side === 'out' ? BOX_W : 0),
    y: box.position.y + portOffsetY(index),
  }
}

/** Cubic-bezier path between two points with horizontal control handles. */
export function edgePath(a: Vec, b: Vec): string {
  const dx = Math.max(30, Math.min(140, Math.abs(b.x - a.x) / 2))
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}

// ---------------------------------------------------------------------------
// ids + small lookups
// ---------------------------------------------------------------------------

let idSeq = 0
/** Collision-resistant client id. Not asserted on in tests. */
export function makeId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}`
}

export function boxById(boxes: CanvasBox[], id: string): CanvasBox | undefined {
  return boxes.find((b) => b.id === id)
}

export function isTriggerType(type: string): boolean {
  return type.startsWith('trigger.')
}

/** Box id referenced by an endpoint string (`a` or `a:port`). */
export function endpointBox(ep: string): string {
  const s = String(ep ?? '')
  const i = s.indexOf(':')
  return i >= 0 ? s.slice(0, i) : s
}

function endpointPortRaw(ep: string): string | undefined {
  const s = String(ep ?? '')
  const i = s.indexOf(':')
  return i >= 0 ? s.slice(i + 1) : undefined
}

/** Resolve a port: explicit field wins, then `:port` shorthand, then first declared, then fallback. */
function resolvePort(
  ep: string,
  explicit: string | undefined,
  declared: string[] | undefined,
  fallback: string,
): string {
  if (explicit) return explicit
  const shorthand = endpointPortRaw(ep)
  if (shorthand) return shorthand
  return declared && declared.length ? declared[0] : fallback
}

// ---------------------------------------------------------------------------
// Run flow animation — which edges a run traversed (for the canvas animation)
// ---------------------------------------------------------------------------

/**
 * Given a run's ordered visited box ids (run steps in execution order), return
 * the set of EDGE ids the run flowed through: an edge is "active" when both its
 * endpoints were visited and `from` was visited before `to`. Deterministic +
 * DOM-free → node:test-able. On a branch (e.g. condition→true), only the taken
 * edge lights up because the other branch's target was never visited.
 */
export function activeEdgeIds(graph: CanvasGraph, visitedBoxIds: string[]): Set<string> {
  const pos = new Map<string, number>()
  visitedBoxIds.forEach((id, i) => {
    if (!pos.has(id)) pos.set(id, i)
  })
  const active = new Set<string>()
  for (const e of graph.edges) {
    const from = pos.get(e.from)
    const to = pos.get(e.to)
    if (from !== undefined && to !== undefined && from < to) active.add(e.id)
  }
  return active
}

// ---------------------------------------------------------------------------
// Auto-layout (for boxes hydrated without a stored position)
// ---------------------------------------------------------------------------

const LAYOUT_COLS = 4
const LAYOUT_DX = 250
const LAYOUT_DY = 200
const LAYOUT_X0 = 60
const LAYOUT_Y0 = 60

export function autoPosition(index: number): Vec {
  return {
    x: LAYOUT_X0 + (index % LAYOUT_COLS) * LAYOUT_DX,
    y: LAYOUT_Y0 + Math.floor(index / LAYOUT_COLS) * LAYOUT_DY,
  }
}

function isVec(v: unknown): v is Vec {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Vec).x === 'number' &&
    typeof (v as Vec).y === 'number' &&
    Number.isFinite((v as Vec).x) &&
    Number.isFinite((v as Vec).y)
  )
}

// ---------------------------------------------------------------------------
// (de)serialization
// ---------------------------------------------------------------------------

/** Canvas graph → backend `graph_json`. Positions are rounded to whole px. */
export function serializeGraph(g: CanvasGraph): GraphJson {
  return {
    boxes: g.boxes.map((b) => ({
      id: b.id,
      type: b.type,
      config: b.config ?? {},
      position: { x: Math.round(b.position.x), y: Math.round(b.position.y) },
    })),
    edges: g.edges.map((e) => ({
      from: e.from,
      fromPort: e.fromPort,
      to: e.to,
      toPort: e.toPort,
    })),
  }
}

/**
 * Backend `graph_json` (or anything garbage-shaped) → a clean CanvasGraph.
 * Drops boxes without a string id/type; assigns an auto-layout position when
 * none is stored; drops edges referencing an unknown box; resolves ports
 * (explicit field, then `box:port` shorthand, then the box's first declared
 * port). Never throws.
 */
export function deserializeGraph(raw: unknown, catalogue: BoxSpec[]): CanvasGraph {
  const specByType = new Map(catalogue.map((s) => [s.type, s]))
  const g = (raw ?? {}) as { boxes?: unknown; edges?: unknown }
  const rawBoxes = Array.isArray(g.boxes) ? g.boxes : []

  const boxes: CanvasBox[] = []
  rawBoxes.forEach((rb, i) => {
    const b = rb as Partial<GraphJsonBox>
    if (!b || typeof b.id !== 'string' || !b.id) return
    if (typeof b.type !== 'string' || !b.type) return
    boxes.push({
      id: b.id,
      type: b.type,
      config:
        b.config && typeof b.config === 'object'
          ? { ...(b.config as Record<string, unknown>) }
          : {},
      position: isVec(b.position) ? { x: b.position.x, y: b.position.y } : autoPosition(i),
    })
  })

  const ids = new Set(boxes.map((b) => b.id))
  const rawEdges = Array.isArray(g.edges) ? g.edges : []
  const edges: CanvasEdge[] = []
  for (const re of rawEdges) {
    const e = (re ?? {}) as Partial<GraphJsonEdge>
    const fromEp = String(e.from ?? '')
    const toEp = String(e.to ?? '')
    const fromBoxId = endpointBox(fromEp)
    const toBoxId = endpointBox(toEp)
    if (!ids.has(fromBoxId) || !ids.has(toBoxId)) continue
    const fromSpec = specByType.get(boxById(boxes, fromBoxId)!.type)
    const toSpec = specByType.get(boxById(boxes, toBoxId)!.type)
    edges.push({
      id: makeId('edge'),
      from: fromBoxId,
      fromPort: resolvePort(fromEp, e.fromPort, fromSpec?.outputs, 'out'),
      to: toBoxId,
      toPort: resolvePort(toEp, e.toPort, toSpec?.inputs, 'in'),
    })
  }

  return { boxes, edges }
}

// ---------------------------------------------------------------------------
// mutations (all pure — return a new graph)
// ---------------------------------------------------------------------------

/** Config seeded from the spec: only `select`/`boolean` get a concrete default. */
export function defaultConfig(spec: BoxSpec): Record<string, unknown> {
  const cfg: Record<string, unknown> = {}
  for (const f of spec.fields) {
    if (f.type === 'boolean') cfg[f.key] = false
    else if (f.type === 'select' && f.options?.length) cfg[f.key] = f.options[0].value
  }
  return cfg
}

export function addBox(graph: CanvasGraph, spec: BoxSpec, position: Vec): CanvasGraph {
  const box: CanvasBox = {
    id: makeId('box'),
    type: spec.type,
    config: defaultConfig(spec),
    position,
  }
  return { boxes: [...graph.boxes, box], edges: graph.edges }
}

export function removeBox(graph: CanvasGraph, boxId: string): CanvasGraph {
  return {
    boxes: graph.boxes.filter((b) => b.id !== boxId),
    edges: graph.edges.filter((e) => e.from !== boxId && e.to !== boxId),
  }
}

export function removeEdge(graph: CanvasGraph, edgeId: string): CanvasGraph {
  return { boxes: graph.boxes, edges: graph.edges.filter((e) => e.id !== edgeId) }
}

export function moveBox(graph: CanvasGraph, boxId: string, position: Vec): CanvasGraph {
  return {
    boxes: graph.boxes.map((b) => (b.id === boxId ? { ...b, position } : b)),
    edges: graph.edges,
  }
}

export function setBoxConfig(
  graph: CanvasGraph,
  boxId: string,
  config: Record<string, unknown>,
): CanvasGraph {
  return {
    boxes: graph.boxes.map((b) => (b.id === boxId ? { ...b, config } : b)),
    edges: graph.edges,
  }
}

// ---------------------------------------------------------------------------
// connection validation
// ---------------------------------------------------------------------------

export type ConnectError =
  | 'self'
  | 'unknownBox'
  | 'badFromPort'
  | 'badToPort'
  | 'intoTrigger'
  | 'duplicate'
  | 'cycle'

export interface ConnectCheck {
  ok: boolean
  reason?: ConnectError
}

export interface Endpoint {
  box: string
  port: string
}

/**
 * Would adding an edge `from → to` (box ids) close a cycle? True iff a path
 * already runs from `to` back to `from` (or they're the same box).
 */
export function wouldCreateCycle(edges: CanvasEdge[], from: string, to: string): boolean {
  if (from === to) return true
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    const list = adj.get(e.from)
    if (list) list.push(e.to)
    else adj.set(e.from, [e.to])
  }
  const seen = new Set<string>()
  const stack = [to]
  while (stack.length) {
    const n = stack.pop() as string
    if (n === from) return true
    if (seen.has(n)) continue
    seen.add(n)
    for (const nx of adj.get(n) ?? []) stack.push(nx)
  }
  return false
}

/** Validate a proposed connection against the current graph + catalogue. */
export function canConnect(
  graph: CanvasGraph,
  catalogue: BoxSpec[],
  from: Endpoint,
  to: Endpoint,
): ConnectCheck {
  if (from.box === to.box) return { ok: false, reason: 'self' }
  const specByType = new Map(catalogue.map((s) => [s.type, s]))
  const fromBox = boxById(graph.boxes, from.box)
  const toBox = boxById(graph.boxes, to.box)
  if (!fromBox || !toBox) return { ok: false, reason: 'unknownBox' }
  if (isTriggerType(toBox.type)) return { ok: false, reason: 'intoTrigger' }
  const fromSpec = specByType.get(fromBox.type)
  const toSpec = specByType.get(toBox.type)
  if (!fromSpec || !fromSpec.outputs.includes(from.port)) return { ok: false, reason: 'badFromPort' }
  if (!toSpec || !toSpec.inputs.includes(to.port)) return { ok: false, reason: 'badToPort' }
  const dup = graph.edges.some(
    (e) =>
      e.from === from.box &&
      e.fromPort === from.port &&
      e.to === to.box &&
      e.toPort === to.port,
  )
  if (dup) return { ok: false, reason: 'duplicate' }
  if (wouldCreateCycle(graph.edges, from.box, to.box)) return { ok: false, reason: 'cycle' }
  return { ok: true }
}

/** Connect two ports, returning the new graph — or `null` when invalid. */
export function connect(
  graph: CanvasGraph,
  catalogue: BoxSpec[],
  from: Endpoint,
  to: Endpoint,
): CanvasGraph | null {
  if (!canConnect(graph, catalogue, from, to).ok) return null
  const edge: CanvasEdge = {
    id: makeId('edge'),
    from: from.box,
    fromPort: from.port,
    to: to.box,
    toPort: to.port,
  }
  return { boxes: graph.boxes, edges: [...graph.edges, edge] }
}

// ---------------------------------------------------------------------------
// Event catalogue (mirrors streamhub-core boxes/event-catalogue.ts — GET /events)
// ---------------------------------------------------------------------------

export interface CatalogueEvent {
  event: string
  description: string
  wildcard?: boolean
  viaWorkerCallback?: boolean
}
export interface EventFamily {
  family: string
  scope: 'app' | 'cluster'
  events: CatalogueEvent[]
}

/** Flatten families into a deduped, order-preserving list of event names. */
export function flattenEventNames(families: EventFamily[] | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const fam of families ?? []) {
    for (const e of fam.events ?? []) {
      if (e?.event && !seen.has(e.event)) {
        seen.add(e.event)
        out.push(e.event)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Portable workflow (export/import) — mirrors streamhub-core boxes/portable.ts
// ---------------------------------------------------------------------------

export interface PortableWorkflow {
  streamflow?: number
  name?: string
  graph?: GraphJson
  redactions?: string[]
}

export type ParsePortableResult =
  | { ok: true; workflow: PortableWorkflow }
  | { ok: false; error: 'json' | 'shape' }

/**
 * Parse + shape-check an imported `.streamflow.json` file client-side so we can
 * show a friendly error before POSTing to the server (which re-validates against
 * the catalogue). Pure → node:test-able.
 */
export function parsePortable(text: string): ParsePortableResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'json' }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'shape' }
  const wf = raw as PortableWorkflow
  const g = wf.graph as { boxes?: unknown } | undefined
  if (!g || typeof g !== 'object' || !Array.isArray(g.boxes)) {
    return { ok: false, error: 'shape' }
  }
  return { ok: true, workflow: wf }
}

/** A canvas graph → portable JSON (client-side blob, positions kept). */
export function toPortable(name: string, graph: CanvasGraph): PortableWorkflow {
  return { streamflow: 1, name, graph: serializeGraph(graph) }
}

/** Filesystem-safe filename for an exported workflow. */
export function portableFilename(name: string): string {
  const slug = (name || 'workflow').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug || 'workflow'}.streamflow.json`
}

// ---------------------------------------------------------------------------
// Starter template — the canonical intrusion flow (one-click seed)
// ---------------------------------------------------------------------------

/**
 * The owner's canonical example, as a ready-to-run graph:
 *   trigger.event(perimeter.intrusion) → action.snapshot → action.ai →
 *   logic.condition(ai.json.confidence ≥ 0.7) --true--> action.notify
 *
 * Box ids are stable + human-readable because the run `context` bag keys each
 * box's output by its id, so the templated refs (`{{snapshot.url}}`) resolve at
 * runtime. `action.ai` outputs `{text, usageTokens, json}` (the parsed reply
 * lands under `json` in JSON mode), so the condition reads `ai.json.confidence`
 * — NOT `ai.confidence`, which never exists. The notify box ships an explicit
 * `['callback']` channel: an empty `channels` array is treated by the notifier
 * as "no channels", so it would deliver nothing when the alarm fires.
 */
export function buildIntrusionTemplate(): CanvasGraph {
  const boxes: CanvasBox[] = [
    {
      id: 'trigger',
      type: 'trigger.event',
      config: { event: 'perimeter.intrusion' },
      position: { x: 40, y: 80 },
    },
    {
      id: 'snapshot',
      type: 'action.snapshot',
      config: {},
      position: { x: 300, y: 80 },
    },
    {
      id: 'ai',
      type: 'action.ai',
      config: {
        prompt:
          'A perimeter alarm fired. Looking at the snapshot, is this a real ' +
          'human intrusion? Reply strict JSON: ' +
          '{"intrusion": true|false, "confidence": 0..1, "reason": "..."}.',
        imageUrl: '{{snapshot.url}}',
        jsonMode: true,
      },
      position: { x: 560, y: 80 },
    },
    {
      id: 'validate',
      type: 'logic.condition',
      config: { match: 'all', rules: [{ field: 'ai.json.confidence', op: 'gte', value: 0.7 }] },
      position: { x: 820, y: 80 },
    },
    {
      id: 'notify',
      type: 'action.notify',
      config: { title: 'Confirmed intrusion', channels: ['callback'] },
      position: { x: 1080, y: 40 },
    },
  ]
  const edge = (from: string, fromPort: string, to: string, toPort: string): CanvasEdge => ({
    id: makeId('edge'),
    from,
    fromPort,
    to,
    toPort,
  })
  const edges: CanvasEdge[] = [
    edge('trigger', 'out', 'snapshot', 'in'),
    edge('snapshot', 'out', 'ai', 'in'),
    edge('ai', 'out', 'validate', 'in'),
    edge('validate', 'true', 'notify', 'in'),
  ]
  return { boxes, edges }
}
