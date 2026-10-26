/**
 * Streamflow — the visual node editor (palette · canvas · config panel).
 *
 * Design mirrors n8n / nodos.dev and reuses the vision PolygonEditor's imperative
 * pointer pattern (dragRef + stateRef so the handlers read the latest graph
 * without re-subscribing):
 *   - NODES are absolutely-positioned HTML cards (Tailwind, theme-aware) laid on
 *     a scrollable surface. Ports are small circles on the left (inputs) / right
 *     (outputs) edges.
 *   - EDGES are SVG bezier cables in a layer BEHIND the cards, their endpoints
 *     computed purely from box positions + port indices (graph.util `portPoint` /
 *     `edgePath`) — so geometry needs no getBoundingClientRect and stays testable.
 *   - CONNECT: pointer-down on an output port starts a rubber-band cable; release
 *     over an input port commits it iff `canConnect` passes (ports exist, no
 *     self-loop, no edge into a trigger, no duplicate, no cycle).
 *   - Selecting a node opens the ConfigPanel (right rail).
 *
 * The parent owns the `graph` (controlled) and persists it; this component only
 * edits it via the pure `graph.util` mutators.
 */
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfigPanel } from './ConfigPanel.tsx'
import {
  BOX_W,
  BOX_HEADER,
  addBox,
  autoPosition,
  boxById,
  boxHeight,
  connect,
  edgePath,
  moveBox,
  portOffsetY,
  portPoint,
  removeBox,
  removeEdge,
  setBoxConfig,
  type BoxGroup,
  type BoxSpec,
  type CanvasBox,
  type CanvasGraph,
  type Endpoint,
  type EventFamily,
  type Vec,
} from './graph.util.ts'

export interface NodeCanvasProps {
  catalogue: BoxSpec[]
  graph: CanvasGraph
  onChange: (graph: CanvasGraph) => void
  /** Live event catalogue (GET /events) for the trigger.event picker. */
  eventCatalogue?: EventFamily[]
  /** Edge ids a recent run flowed through — animated (marching dashes). */
  activeEdges?: Set<string>
}

/**
 * Marching-dash flow animation for edges a run traversed — reuses the
 * AppFlowDiagram pattern (`stroke-dashoffset` keyframes), disabled under
 * prefers-reduced-motion.
 */
const FLOW_CSS = `
.sf-flow { stroke-dasharray: 6 10; animation: sf-dash 1.1s linear infinite; }
@keyframes sf-dash { to { stroke-dashoffset: -32; } }
@media (prefers-reduced-motion: reduce) { .sf-flow { animation: none; } }
`

type Drag =
  | { kind: 'idle' }
  | { kind: 'box'; id: string; offX: number; offY: number }
  | { kind: 'connect'; from: Endpoint }

const GROUP_ORDER: BoxGroup[] = ['trigger', 'action', 'logic']

const GROUP_HEADER: Record<BoxGroup, string> = {
  trigger: 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200',
  action: 'border-sky-400/50 bg-sky-500/15 text-sky-200',
  logic: 'border-amber-400/50 bg-amber-500/15 text-amber-200',
}
const GROUP_DOT: Record<BoxGroup, string> = {
  trigger: 'bg-emerald-400',
  action: 'bg-sky-400',
  logic: 'bg-amber-400',
}

export function NodeCanvas({ catalogue, graph, onChange, eventCatalogue, activeEdges }: NodeCanvasProps) {
  const { t } = useTranslation('streamflow')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<{ from: Vec } | null>(null)
  const [pointer, setPointer] = useState<Vec | null>(null)

  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<Drag>({ kind: 'idle' })
  const stateRef = useRef({ graph, catalogue })
  stateRef.current = { graph, catalogue }

  const specByType = useMemo(
    () => new Map(catalogue.map((s) => [s.type, s])),
    [catalogue],
  )
  const grouped = useMemo(() => {
    const g: Record<BoxGroup, BoxSpec[]> = { trigger: [], action: [], logic: [] }
    for (const s of catalogue) g[s.group]?.push(s)
    return g
  }, [catalogue])

  const selected = selectedId ? boxById(graph.boxes, selectedId) : undefined

  // Surface extent (fits all nodes with breathing room).
  const extent = useMemo(() => {
    let w = 1400
    let h = 800
    for (const b of graph.boxes) {
      const spec = specByType.get(b.type)
      const bh = boxHeight(spec?.inputs.length ?? 1, spec?.outputs.length ?? 1)
      w = Math.max(w, b.position.x + BOX_W + 260)
      h = Math.max(h, b.position.y + bh + 160)
    }
    return { w, h }
  }, [graph.boxes, specByType])

  // --- coordinate helper ----------------------------------------------------

  const surfacePoint = (e: { clientX: number; clientY: number }): Vec => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }

  // --- palette --------------------------------------------------------------

  const addFromPalette = (spec: BoxSpec) => {
    const pos = autoPosition(graph.boxes.length)
    const next = addBox(graph, spec, pos)
    onChange(next)
    setSelectedId(next.boxes[next.boxes.length - 1].id)
  }

  // --- node drag ------------------------------------------------------------

  const onHeaderDown = (e: React.PointerEvent, box: CanvasBox) => {
    e.preventDefault()
    const p = surfacePoint(e)
    dragRef.current = { kind: 'box', id: box.id, offX: p.x - box.position.x, offY: p.y - box.position.y }
    setSelectedId(box.id)
  }

  // --- connection gesture ---------------------------------------------------

  const startConnect = (e: React.PointerEvent, box: CanvasBox, port: string, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { kind: 'connect', from: { box: box.id, port } }
    const from = portPoint(box, 'out', index)
    setConnecting({ from })
    setPointer(from)
    setSelectedId(box.id)
  }

  const completeConnect = (e: React.PointerEvent, box: CanvasBox, port: string) => {
    const d = dragRef.current
    if (d.kind !== 'connect') return
    e.stopPropagation()
    const next = connect(stateRef.current.graph, stateRef.current.catalogue, d.from, {
      box: box.id,
      port,
    })
    endGesture()
    if (next) onChange(next)
  }

  const endGesture = () => {
    dragRef.current = { kind: 'idle' }
    setConnecting(null)
    setPointer(null)
  }

  const onSurfaceMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (d.kind === 'idle') return
    const p = surfacePoint(e)
    if (d.kind === 'box') {
      onChange(moveBox(stateRef.current.graph, d.id, { x: Math.max(0, p.x - d.offX), y: Math.max(0, p.y - d.offY) }))
    } else if (d.kind === 'connect') {
      setPointer(p)
    }
  }

  const onSurfaceUp = () => {
    // A drop that didn't land on an input port just cancels.
    endGesture()
  }

  // --- render ---------------------------------------------------------------

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      {/* Palette */}
      <div className="w-full shrink-0 space-y-3 lg:w-52">
        <h4 className="text-xs font-semibold uppercase tracking-wide opacity-70">
          {t('palette.title')}
        </h4>
        {GROUP_ORDER.map((group) => (
          <div key={group} className="space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-60">
              <span className={`h-2 w-2 rounded-full ${GROUP_DOT[group]}`} />
              {t(`group.${group}`)}
            </div>
            {grouped[group].map((spec) => (
              <button
                key={spec.type}
                type="button"
                title={spec.description}
                data-testid={`sf-palette-${spec.type}`}
                onClick={() => addFromPalette(spec)}
                className={`flex w-full items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-white/10 ${
                  spec.dangerous
                    ? 'border-red-400/40 hover:border-red-400/70'
                    : 'border-white/10 hover:border-white/25'
                } bg-white/5`}
              >
                {spec.dangerous && (
                  <span title={t('palette.dangerous')} className="text-red-400">
                    ⚠
                  </span>
                )}
                {spec.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Canvas surface */}
      <div className="min-w-0 flex-1">
      <p className="mb-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 lg:hidden dark:text-amber-300">
        {t('canvas.smallScreenHint')}
      </p>
      <div
        className="relative min-h-[420px] w-full overflow-auto rounded-lg border border-white/10 bg-navy-800/40"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      >
        <div
          ref={surfaceRef}
          data-testid="sf-canvas"
          className="relative"
          style={{ width: extent.w, height: extent.h, touchAction: 'none' }}
          onPointerMove={onSurfaceMove}
          onPointerUp={onSurfaceUp}
          onPointerDown={(e) => {
            // Click empty surface = deselect.
            if (e.target === surfaceRef.current) setSelectedId(null)
          }}
        >
          {/* Edge layer (behind nodes). */}
          <svg
            className="absolute inset-0"
            width={extent.w}
            height={extent.h}
            style={{ pointerEvents: 'none' }}
          >
            <style>{FLOW_CSS}</style>
            {graph.edges.map((edge) => {
              const fromBox = boxById(graph.boxes, edge.from)
              const toBox = boxById(graph.boxes, edge.to)
              if (!fromBox || !toBox) return null
              const fromSpec = specByType.get(fromBox.type)
              const toSpec = specByType.get(toBox.type)
              const oi = Math.max(0, fromSpec?.outputs.indexOf(edge.fromPort) ?? 0)
              const ii = Math.max(0, toSpec?.inputs.indexOf(edge.toPort) ?? 0)
              const d = edgePath(portPoint(fromBox, 'out', oi), portPoint(toBox, 'in', ii))
              const isActive = activeEdges?.has(edge.id) ?? false
              return (
                <g key={edge.id}>
                  <path
                    d={d}
                    fill="none"
                    stroke="#7dd3fc"
                    strokeWidth={isActive ? 3 : 2}
                    strokeOpacity={isActive ? 0.9 : 0.8}
                  />
                  {isActive && (
                    <path
                      d={d}
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth={2.4}
                      strokeLinecap="round"
                      className="sf-flow"
                      data-testid="sf-edge-active"
                    />
                  )}
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    data-testid="sf-edge"
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onClick={() => onChange(removeEdge(graph, edge.id))}
                  >
                    <title>{t('canvas.deleteEdge')}</title>
                  </path>
                </g>
              )
            })}
            {connecting && pointer && (
              <path
                d={edgePath(connecting.from, pointer)}
                fill="none"
                stroke="#7dd3fc"
                strokeWidth={2}
                strokeDasharray="5 4"
                strokeOpacity={0.7}
              />
            )}
          </svg>

          {/* Nodes. */}
          {graph.boxes.map((box) => {
            const spec = specByType.get(box.type)
            const inputs = spec?.inputs ?? []
            const outputs = spec?.outputs ?? ['out']
            const group = spec?.group ?? 'action'
            const h = boxHeight(inputs.length, outputs.length)
            const isSel = box.id === selectedId
            return (
              <div
                key={box.id}
                data-testid={`sf-node-${box.id}`}
                data-node-type={box.type}
                className={`absolute select-none rounded-lg border bg-navy-900/90 shadow-lg backdrop-blur ${
                  isSel ? 'border-sky-400/80 ring-1 ring-sky-400/40' : 'border-white/15'
                }`}
                style={{ left: box.position.x, top: box.position.y, width: BOX_W, height: h }}
                onClick={() => setSelectedId(box.id)}
              >
                {/* header / drag handle */}
                <div
                  className={`flex cursor-grab items-center gap-1.5 rounded-t-lg border-b px-2.5 text-xs font-semibold active:cursor-grabbing ${GROUP_HEADER[group]}`}
                  style={{ height: BOX_HEADER }}
                  onPointerDown={(e) => onHeaderDown(e, box)}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${GROUP_DOT[group]}`} />
                  <span className="truncate">{spec?.label ?? box.type}</span>
                </div>

                {/* input ports */}
                {inputs.map((port, i) => (
                  <PortDot
                    key={`in-${port}`}
                    side="in"
                    port={port}
                    y={portOffsetY(i)}
                    boxId={box.id}
                    onPointerUp={(e) => completeConnect(e, box, port)}
                    onPointerDown={(e) => completeConnect(e, box, port)}
                  />
                ))}
                {/* output ports */}
                {outputs.map((port, i) => (
                  <PortDot
                    key={`out-${port}`}
                    side="out"
                    port={port}
                    y={portOffsetY(i)}
                    boxId={box.id}
                    onPointerDown={(e) => startConnect(e, box, port, i)}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
      </div>

      {/* Config panel */}
      {selected && (
        <ConfigPanel
          box={selected}
          spec={specByType.get(selected.type)}
          eventCatalogue={eventCatalogue}
          onChange={(config) => onChange(setBoxConfig(graph, selected.id, config))}
          onDelete={() => {
            onChange(removeBox(graph, selected.id))
            setSelectedId(null)
          }}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// A single port dot (+ its label), positioned on the node edge.
// ---------------------------------------------------------------------------

function PortDot({
  side,
  port,
  y,
  boxId,
  onPointerDown,
  onPointerUp,
}: {
  side: 'in' | 'out'
  port: string
  y: number
  boxId: string
  onPointerDown?: (e: React.PointerEvent) => void
  onPointerUp?: (e: React.PointerEvent) => void
}) {
  const edge = side === 'in' ? { left: -7 } : { right: -7 }
  return (
    <div
      className="absolute flex items-center gap-1"
      style={{
        top: y - 7,
        ...edge,
        flexDirection: side === 'in' ? 'row' : 'row-reverse',
      }}
    >
      <button
        type="button"
        data-port-side={side}
        data-testid={`sf-port-${boxId}-${side}-${port}`}
        aria-label={`${side} port ${port}`}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        className={`h-3.5 w-3.5 rounded-full border-2 ${
          side === 'out'
            ? 'border-sky-300 bg-sky-500 hover:bg-sky-400'
            : 'border-white/50 bg-navy-900 hover:border-sky-300'
        }`}
      />
      <span className="pointer-events-none text-[9px] uppercase tracking-wide opacity-60">
        {port}
      </span>
    </div>
  )
}
