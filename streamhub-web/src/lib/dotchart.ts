/**
 * Hand-rolled dot-chart (scatter + connecting line) math — pure, no SVG, no
 * React, no deps.
 *
 * Projects a time series of `{ ts, value }` samples onto an SVG pixel box: x is
 * linear over a time domain (defaults to the data's [minTs, maxTs]), y is linear
 * over [yMin, yMax] (yMax fixed — e.g. 100 for a %, or derived + rounded to a
 * "nice" ceiling for open-ended series like bytes). Null/non-finite values are
 * dropped so the chart shows a gap instead of a fake zero — but a *real* gap
 * must also break the connecting line rather than bridge it with a fake
 * straight segment. So alongside the flat `dots` list this also returns
 * `segments`: contiguous runs, in the ORIGINAL (pre-filter) point order, split
 * wherever a null/non-finite sample sits between two real ones.
 *
 * The <DotChart> component (src/components/DotChart.tsx) feeds this the samples
 * + box, draws one <path> per segment (the connecting line) and drops the flat
 * `dots` list straight into <circle> marks on top. Keeping the arithmetic here
 * makes it unit-testable under node:test.
 */

export interface DotPoint {
  ts: number
  value: number | null
}

export interface DotChartPadding {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

export interface DotChartOptions {
  width: number
  height: number
  padding?: DotChartPadding
  /** Time domain [start, end] in ms. Defaults to [min ts, max ts] of the data. */
  domain?: { start: number; end: number }
  /** Fixed y-axis maximum (e.g. 100 for a percentage). Omit → derived. */
  yMax?: number
  /** y-axis minimum (default 0). */
  yMin?: number
  /** How many horizontal grid/tick lines to compute (default 4). */
  yTickCount?: number
}

export interface DotCoord {
  x: number
  y: number
  ts: number
  value: number
}

export interface DotChartGeometry {
  dots: DotCoord[]
  /**
   * Coordinates grouped into contiguous runs (no real gap inside a run) —
   * one <path> per segment renders the connecting line without bridging a
   * missing-data gap.
   */
  segments: DotCoord[][]
  yMin: number
  yMax: number
  domain: { start: number; end: number }
  /** Evenly spaced y values (data units) for gridlines/labels, ascending. */
  yTicks: number[]
  /** Inner plot rectangle in pixels. */
  plot: { x: number; y: number; width: number; height: number }
}

const DEFAULT_PADDING = { top: 8, right: 8, bottom: 8, left: 8 }

/** Round a positive number UP to the nearest 1/2/5 × 10ⁿ ("nice" ceiling). */
export function niceCeil(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1
  const exp = Math.floor(Math.log10(n))
  const base = Math.pow(10, exp)
  const frac = n / base
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10
  return niceFrac * base
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

export function dotChartGeometry(
  points: readonly DotPoint[],
  opts: DotChartOptions,
): DotChartGeometry {
  const pad = { ...DEFAULT_PADDING, ...(opts.padding ?? {}) }
  const plotX = pad.left
  const plotY = pad.top
  const plotW = Math.max(0, opts.width - pad.left - pad.right)
  const plotH = Math.max(0, opts.height - pad.top - pad.bottom)

  const clean = points.filter(
    (p): p is { ts: number; value: number } =>
      Number.isFinite(p.ts) && p.value != null && Number.isFinite(p.value),
  )

  // Time domain: explicit, else span of the (clean) data.
  const tsList = clean.map((p) => p.ts)
  const start = opts.domain?.start ?? (tsList.length ? Math.min(...tsList) : 0)
  const end = opts.domain?.end ?? (tsList.length ? Math.max(...tsList) : 0)
  const tSpan = end - start

  // Value domain: yMin (default 0) → yMax (explicit, else nice ceiling of data).
  const yMin = opts.yMin ?? 0
  const dataMax = clean.reduce((m, p) => Math.max(m, p.value), yMin)
  const yMax =
    opts.yMax != null && opts.yMax > yMin ? opts.yMax : Math.max(niceCeil(dataMax), yMin + 1)
  const ySpan = yMax - yMin

  const project = (p: { ts: number; value: number }): DotCoord => {
    const tx = tSpan === 0 ? 0.5 : (p.ts - start) / tSpan
    const ny = ySpan === 0 ? 0 : (p.value - yMin) / ySpan
    return {
      x: round(plotX + tx * plotW),
      y: round(plotY + (1 - ny) * plotH), // SVG y grows downward
      ts: p.ts,
      value: p.value,
    }
  }

  const dots: DotCoord[] = clean.map(project)

  // Group into contiguous runs from the ORIGINAL point order (not `clean`) so
  // a real gap — a null/non-finite sample between two real ones — starts a
  // new segment instead of silently bridging the gap with a straight line.
  const segments: DotCoord[][] = []
  let run: DotCoord[] = []
  for (const p of points) {
    const isClean = Number.isFinite(p.ts) && p.value != null && Number.isFinite(p.value)
    if (!isClean) {
      if (run.length > 0) segments.push(run)
      run = []
      continue
    }
    run.push(project(p as { ts: number; value: number }))
  }
  if (run.length > 0) segments.push(run)

  const tickCount = Math.max(1, opts.yTickCount ?? 4)
  const yTicks: number[] = []
  for (let i = 0; i <= tickCount; i++) {
    yTicks.push(round(yMin + (ySpan * i) / tickCount))
  }

  return {
    dots,
    segments,
    yMin,
    yMax,
    domain: { start, end },
    yTicks,
    plot: { x: plotX, y: plotY, width: plotW, height: plotH },
  }
}
