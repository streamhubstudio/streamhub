/**
 * Hand-rolled sparkline math — pure, no SVG, no React, no dependencies.
 *
 * The <Sparkline> component (src/components/Sparkline.tsx) feeds it a series of
 * numbers plus the target pixel box and gets back polyline points it can drop
 * straight into an <svg><polyline points=…/>. Scaling maps the data's [min,max]
 * onto the box height (inverted, because SVG y grows downward), with a flat
 * series pinned to the vertical middle.
 */

export interface SparklineOptions {
  width: number
  height: number
  /** Inner padding so the stroke isn't clipped at the edges. */
  padding?: number
}

export interface SparklineGeometry {
  /** "x,y x,y …" ready for <polyline points>. */
  points: string
  /** Same coordinates as tuples (handy for markers / area fills). */
  coords: Array<[number, number]>
  min: number
  max: number
}

/** Cap a rolling buffer to its last `max` entries (returns a new array). */
export function pushCapped<T>(buffer: readonly T[], value: T, max: number): T[] {
  const next = [...buffer, value]
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * Project a numeric series onto an SVG coordinate box.
 * - 0 points → empty geometry.
 * - 1 point  → a single centred dot.
 * - flat series (min === max) → a horizontal line through the vertical middle.
 */
export function sparklineGeometry(
  values: readonly number[],
  { width, height, padding = 1 }: SparklineOptions,
): SparklineGeometry {
  const clean = values.filter((v) => Number.isFinite(v)) as number[]
  if (clean.length === 0) {
    return { points: '', coords: [], min: 0, max: 0 }
  }

  const min = Math.min(...clean)
  const max = Math.max(...clean)
  const span = max - min

  const innerW = Math.max(0, width - padding * 2)
  const innerH = Math.max(0, height - padding * 2)

  const stepX = clean.length > 1 ? innerW / (clean.length - 1) : 0

  const coords = clean.map((v, i) => {
    const x = padding + (clean.length > 1 ? i * stepX : innerW / 2)
    // Flat series → pin to the middle; else invert (SVG y grows downward).
    const norm = span === 0 ? 0.5 : (v - min) / span
    const y = padding + (1 - norm) * innerH
    return [round(x), round(y)] as [number, number]
  })

  return {
    points: coords.map(([x, y]) => `${x},${y}`).join(' '),
    coords,
    min,
    max,
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
