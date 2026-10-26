/**
 * people-counter — the counting-line CANVAS overlay (owner requirement: the
 * line is drawn ON the live video).
 *
 * A `<canvas>` laid over the HLS player. In edit mode the operator:
 *   - drags anywhere to DRAW the line (pointer down = start, up = end);
 *   - grabs an existing endpoint to move just that end (rotate/resize);
 *   - the green IN arrow at the midpoint always shows the current
 *     orientation; flipping it is a button in the tab (swaps `inDirection`).
 *
 * All geometry is normalized [0,1] (pure helpers in line.util.ts — tested
 * under node:test); this file only does painting + pointer plumbing, and the
 * canvas 2D context is optional (jsdom returns null) so the interaction logic
 * stays testable in the vitest component suite.
 */
import { useCallback, useEffect, useRef } from 'react'
import {
  arrowFor,
  nearestEndpoint,
  normPoint,
  withEndpoint,
  type InDirection,
  type LineValue,
} from './line.util.ts'

export interface LineEditorProps {
  line: LineValue
  inDirection: InDirection
  /** Off = display-only overlay (no pointer capture, player stays clickable). */
  editable: boolean
  onChange: (line: LineValue) => void
  /** Labels for the arrow ends (localized by the tab). */
  labels?: { in: string; out: string }
}

type DragState =
  | { kind: 'idle' }
  | { kind: 'draw' }
  | { kind: 'endpoint'; which: 1 | 2 }

export function LineEditor({
  line,
  inDirection,
  editable,
  onChange,
  labels,
}: LineEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<DragState>({ kind: 'idle' })
  const lineRef = useRef(line)
  lineRef.current = line

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
    if (!ctx) return // jsdom / lost context — logic still works, no paint

    ctx.clearRect(0, 0, w, h)
    const l = lineRef.current
    const x1 = l.x1 * w
    const y1 = l.y1 * h
    const x2 = l.x2 * w
    const y2 = l.y2 * h

    // The counting line.
    ctx.lineWidth = 3
    ctx.strokeStyle = '#ef4444'
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()

    // Endpoints (draggable in edit mode).
    ctx.fillStyle = '#facc15'
    for (const [ex, ey] of [
      [x1, y1],
      [x2, y2],
    ]) {
      ctx.beginPath()
      ctx.arc(ex, ey, editable ? 7 : 5, 0, Math.PI * 2)
      ctx.fill()
    }

    // The IN arrow — orientation + side, rotates with the line.
    const arrow = arrowFor(l, inDirection)
    if (arrow) {
      const mx = arrow.mid.x * w
      const my = arrow.mid.y * h
      const len = Math.max(28, Math.min(w, h) * 0.09)
      const ax = mx + arrow.dir.x * len
      const ay = my + arrow.dir.y * len
      ctx.lineWidth = 2.5
      ctx.strokeStyle = '#4ade80'
      ctx.fillStyle = '#4ade80'
      ctx.beginPath()
      ctx.moveTo(mx, my)
      ctx.lineTo(ax, ay)
      ctx.stroke()
      // Arrow head.
      const hx = arrow.dir.x
      const hy = arrow.dir.y
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(ax - hx * 10 - hy * 6, ay - hy * 10 + hx * 6)
      ctx.lineTo(ax - hx * 10 + hy * 6, ay - hy * 10 - hx * 6)
      ctx.closePath()
      ctx.fill()
      // IN / OUT labels on either side of the line.
      ctx.font = 'bold 12px ui-sans-serif, system-ui'
      ctx.textAlign = 'center'
      ctx.fillStyle = '#4ade80'
      ctx.fillText(labels?.in ?? 'IN', ax + hx * 14, ay + hy * 14 + 4)
      ctx.fillStyle = '#f87171'
      ctx.fillText(
        labels?.out ?? 'OUT',
        mx - hx * (len + 14),
        my - hy * (len + 14) + 4,
      )
    }
  }, [editable, inDirection, labels])

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

  // --- pointer interaction ----------------------------------------------------

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>) =>
    normPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable) return
    e.preventDefault()
    // jsdom has no pointer capture — guard for the component tests.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = pointAt(e)
    const grabbed = nearestEndpoint(lineRef.current, p)
    if (grabbed) {
      dragRef.current = { kind: 'endpoint', which: grabbed }
      onChange(withEndpoint(lineRef.current, grabbed, p))
    } else {
      dragRef.current = { kind: 'draw' }
      onChange({ x1: p.x, y1: p.y, x2: p.x, y2: p.y })
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable || dragRef.current.kind === 'idle') return
    const p = pointAt(e)
    if (dragRef.current.kind === 'draw') {
      onChange({ ...lineRef.current, x2: p.x, y2: p.y })
    } else {
      onChange(withEndpoint(lineRef.current, dragRef.current.which, p))
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable) return
    onPointerMove(e)
    dragRef.current = { kind: 'idle' }
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="people-counter-line-canvas"
      role="application"
      aria-label="counting line editor"
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
