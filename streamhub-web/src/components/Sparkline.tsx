/**
 * Hand-rolled sparkline (SVG, zero dependencies).
 *
 * Renders a series of numbers as a tiny trend line with a soft area fill and a
 * dot on the latest sample. All the scaling math lives in the pure, unit-tested
 * `sparklineGeometry` helper (src/lib/sparkline.ts); this component is just the
 * SVG shell. Colours resolve through Tailwind classes so it inherits the
 * StreamHub brand accent and works in light/dark.
 */
import { useId } from 'react'
import { sparklineGeometry } from '@/lib/sparkline'

interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  /** Stroke/fill colour class (uses currentColor). Defaults to the brand accent. */
  className?: string
  /** Accessible label; falls back to a generic description. */
  ariaLabel?: string
}

export function Sparkline({
  values,
  width = 120,
  height = 32,
  className = 'text-primary-500',
  ariaLabel,
}: SparklineProps) {
  const gradientId = useId()
  const padding = 2
  const { points, coords } = sparklineGeometry(values, { width, height, padding })

  if (coords.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={className}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeDasharray="3 3"
        />
      </svg>
    )
  }

  const last = coords[coords.length - 1]
  // Close the polyline down to the baseline for a soft area fill.
  const areaPath = `M ${coords[0][0]},${height - padding} L ${points.replace(/ /g, ' L ')} L ${last[0]},${height - padding} Z`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.25} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r={1.8} fill="currentColor" />
    </svg>
  )
}
