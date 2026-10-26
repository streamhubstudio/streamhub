/**
 * vision — the polygon / line CANVAS overlay (drawn ON the live video).
 *
 * A `<canvas>` laid over the HLS player. Two modes, driven by `model`:
 *   - ZONE models (occupancy / crowd): draws every zone polygon; the ACTIVE
 *     zone is editable — click empty space to APPEND a vertex, grab a vertex to
 *     drag it. Each zone is translucently filled and labelled with its tag.
 *   - COUNTING: draws every line + an INSIDE-side arrow; the ACTIVE line is
 *     drawn by dragging (down = start, up = end) or by grabbing an endpoint.
 *
 * All geometry is normalized [0,1] (pure helpers in poly.util.ts, node:test
 * covered); this file only paints + plumbs pointers. The 2D context is optional
 * (jsdom returns null) so the interaction logic stays testable in vitest.
 */
import { useCallback, useEffect, useRef } from 'react'
import {
  lineEndpoints,
  lineFromEndpoints,
  nearestVertex,
  normPoint,
  snap,
  type Line,
  type Point,
  type Zone,
} from './poly.util.ts'

export interface PolygonEditorProps {
  /** Kept for callers/back-compat; the ACTIVE shape (not the model) drives the
   * edit mode now, so occupancy zones, counting lines AND POIs can co-exist. */
  model?: string
  zones: Zone[]
  lines: Line[]
  activeId: string | null
  editable: boolean
  onZonesChange: (zones: Zone[]) => void
  onLinesChange: (lines: Line[]) => void
}

type Drag =
  | { kind: 'idle' }
  | { kind: 'vertex'; index: number }
  | { kind: 'lineStart' }
  | { kind: 'lineEnd' }

const ZONE_COLORS = ['#38bdf8', '#f472b6', '#facc15', '#4ade80', '#c084fc', '#fb923c']

export function PolygonEditor({
  zones,
  lines,
  activeId,
  editable,
  onZonesChange,
  onLinesChange,
}: PolygonEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<Drag>({ kind: 'idle' })
  // Keep latest props in refs for the imperative pointer handlers.
  const stateRef = useRef({ zones, lines, activeId })
  stateRef.current = { zones, lines, activeId }

  // --- painting -------------------------------------------------------------

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return // jsdom / lost context — logic still works

    ctx.clearRect(0, 0, w, h)
    // Paint BOTH layers: polygons (zones / POIs) and lines can co-exist on one
    // canvas (counting draws lines + POI polygons together).
    paintZones(ctx, w, h, zones, activeId)
    paintLines(ctx, w, h, lines, activeId)
  }, [zones, lines, activeId])

  useEffect(() => {
    paint()
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  // --- pointer interaction --------------------------------------------------

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>): Point =>
    normPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)

  const activeZone = () =>
    stateRef.current.zones.find((z) => z.id === stateRef.current.activeId)
  const activeLine = () =>
    stateRef.current.lines.find((l) => l.id === stateRef.current.activeId)

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = pointAt(e)

    // The ACTIVE shape decides the edit mode: a polygon (zone / POI) grabs or
    // appends a vertex; a line drags an endpoint.
    const zone = activeZone()
    if (zone) {
      const grabbed = nearestVertex(zone.points, p)
      if (grabbed >= 0) {
        dragRef.current = { kind: 'vertex', index: grabbed }
      } else {
        // Append a vertex to the active polygon.
        dragRef.current = { kind: 'vertex', index: zone.points.length }
        updateZone(zone.id, { points: [...zone.points, snap(p)] })
      }
      return
    }

    const line = activeLine()
    if (!line) return
    const { p1, p2 } = lineEndpoints(line)
    const dEnd = Math.hypot(p2[0] - p[0], p2[1] - p[1])
    const dStart = Math.hypot(p1[0] - p[0], p1[1] - p[1])
    if (dStart <= 0.04 && dStart <= dEnd) {
      dragRef.current = { kind: 'lineStart' }
    } else if (dEnd <= 0.04) {
      dragRef.current = { kind: 'lineEnd' }
    } else {
      // Start a fresh drag from this point.
      dragRef.current = { kind: 'lineEnd' }
      updateLine(line.id, { ...lineFromEndpoints(p, p) })
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable || dragRef.current.kind === 'idle') return
    const p = pointAt(e)
    if (dragRef.current.kind === 'vertex') {
      const zone = activeZone()
      if (!zone) return
      const points = zone.points.slice()
      points[dragRef.current.index] = snap(p)
      updateZone(zone.id, { points })
      return
    }
    const line = activeLine()
    if (!line) return
    const { p1, p2 } = lineEndpoints(line)
    const next =
      dragRef.current.kind === 'lineStart'
        ? lineFromEndpoints(p, p2)
        : lineFromEndpoints(p1, p)
    updateLine(line.id, next)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable) return
    onPointerMove(e)
    dragRef.current = { kind: 'idle' }
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  function updateZone(id: string, patch: Partial<Zone>) {
    onZonesChange(
      stateRef.current.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)),
    )
  }
  function updateLine(id: string, patch: Partial<Line>) {
    onLinesChange(
      stateRef.current.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    )
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="vision-editor-canvas"
      role="application"
      aria-label={lines.length ? 'counting line editor' : 'zone polygon editor'}
      className={`absolute inset-0 z-10 h-full w-full ${
        editable ? 'cursor-crosshair' : 'pointer-events-none'
      }`}
      style={{ touchAction: editable ? 'none' : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

// ---------------------------------------------------------------------------
// painting helpers (kept dumb; no state)
// ---------------------------------------------------------------------------

function paintZones(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  zones: Zone[],
  activeId: string | null,
) {
  zones.forEach((zone, i) => {
    const color = ZONE_COLORS[i % ZONE_COLORS.length]
    const active = zone.id === activeId
    if (zone.points.length >= 2) {
      ctx.beginPath()
      ctx.moveTo(zone.points[0][0] * w, zone.points[0][1] * h)
      for (const [x, y] of zone.points.slice(1)) ctx.lineTo(x * w, y * h)
      ctx.closePath()
      ctx.fillStyle = `${color}22`
      ctx.fill()
      ctx.lineWidth = active ? 3 : 1.5
      ctx.strokeStyle = color
      ctx.stroke()
    }
    // Vertex handles on the active zone.
    if (active) {
      ctx.fillStyle = color
      for (const [x, y] of zone.points) {
        ctx.beginPath()
        ctx.arc(x * w, y * h, 6, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // Tag label at the first vertex.
    if (zone.points.length && zone.tag) {
      ctx.font = 'bold 12px ui-sans-serif, system-ui'
      ctx.fillStyle = color
      ctx.fillText(zone.tag, zone.points[0][0] * w + 6, zone.points[0][1] * h - 6)
    }
  })
}

function paintLines(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  lines: Line[],
  activeId: string | null,
) {
  lines.forEach((line, i) => {
    const color = ZONE_COLORS[i % ZONE_COLORS.length]
    const active = line.id === activeId
    const { p1, p2 } = lineEndpoints(line)
    const x1 = p1[0] * w
    const y1 = p1[1] * h
    const x2 = p2[0] * w
    const y2 = p2[1] * h

    ctx.lineWidth = active ? 3.5 : 2
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()

    // Endpoints on the active line.
    if (active) {
      ctx.fillStyle = '#facc15'
      for (const [ex, ey] of [
        [x1, y1],
        [x2, y2],
      ]) {
        ctx.beginPath()
        ctx.arc(ex, ey, 6, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // Inside-side arrow at the midpoint.
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    const dir = insideVector(line.inside)
    const len = Math.max(20, Math.min(w, h) * 0.07)
    ctx.strokeStyle = '#4ade80'
    ctx.beginPath()
    ctx.moveTo(mx, my)
    ctx.lineTo(mx + dir[0] * len, my + dir[1] * len)
    ctx.stroke()

    if (line.tag) {
      ctx.font = 'bold 12px ui-sans-serif, system-ui'
      ctx.fillStyle = color
      ctx.fillText(line.tag, mx + 8, my - 8)
    }
  })
}

function insideVector(inside: Line['inside']): Point {
  switch (inside) {
    case 'top':
      return [0, -1]
    case 'bottom':
      return [0, 1]
    case 'left':
      return [-1, 0]
    case 'right':
      return [1, 0]
  }
}
