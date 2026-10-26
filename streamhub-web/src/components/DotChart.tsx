/**
 * Hand-rolled dot chart (SVG scatter + connecting line, zero dependencies).
 *
 * Plots a host resource-usage time series as dots joined by a line over a
 * light grid. All the scaling math lives in the pure, unit-tested
 * `dotChartGeometry` helper (src/lib/dotchart.ts); this component is just the
 * SVG shell + axis labels. The line renders as one <path> per `segments` run
 * so a real data gap breaks the line instead of bridging it with a fake
 * straight segment. Colours resolve through Tailwind tokens (`currentColor`
 * for the accent, `text-fg*`/`border` for chrome) so it inherits the brand
 * accent and works in light and dark. Responsive: a fixed viewBox scaled to
 * the container width via `preserveAspectRatio` (dots stay round).
 */
import { useId } from 'react'
import { dotChartGeometry, type DotPoint } from '@/lib/dotchart'

const VIEW_W = 640
const VIEW_H = 200
const PAD = { top: 12, right: 14, bottom: 24, left: 46 }

interface DotChartProps {
  points: DotPoint[]
  /** Time domain [start, end] in ms — keeps every chart on the same x-scale. */
  domain: { start: number; end: number }
  /** Fixed y-axis max (e.g. 100 for a %). Omit → derived from the data. */
  yMax?: number
  /** Render a y value as an axis/tooltip label (e.g. `${v}%`, formatBytes). */
  formatY: (value: number) => string
  /** Render a ts (ms) as an x-axis / tooltip label. */
  formatX: (ts: number) => string
  /** Tailwind text-color class for the dots (defaults to the brand accent). */
  accentClass?: string
  /** Accessible chart title. */
  ariaLabel: string
  /** Shown centered when there are no finite points. */
  emptyLabel: string
}

export function DotChart({
  points,
  domain,
  yMax,
  formatY,
  formatX,
  accentClass = 'text-primary-500',
  ariaLabel,
  emptyLabel,
}: DotChartProps) {
  const gradientId = useId()
  const geo = dotChartGeometry(points, {
    width: VIEW_W,
    height: VIEW_H,
    padding: PAD,
    domain,
    yMax,
    yTickCount: 4,
  })
  const { plot } = geo
  const hasData = geo.dots.length > 0

  // Three x labels: start, middle, end of the domain.
  const xLabelTs = [
    domain.start,
    Math.round((domain.start + domain.end) / 2),
    domain.end,
  ]

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-auto w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <radialGradient id={gradientId}>
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.9} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0.35} />
        </radialGradient>
      </defs>

      {/* Horizontal gridlines + y labels */}
      {geo.yTicks.map((tick, i) => {
        const y =
          plot.y + plot.height - (i / (geo.yTicks.length - 1)) * plot.height
        return (
          <g key={tick}>
            <line
              x1={plot.x}
              y1={y}
              x2={plot.x + plot.width}
              y2={y}
              className="text-border"
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={1}
            />
            <text
              x={plot.x - 8}
              y={y + 3}
              textAnchor="end"
              className="fill-fg-subtle text-[10px]"
            >
              {formatY(tick)}
            </text>
          </g>
        )
      })}

      {/* X axis labels */}
      {hasData &&
        xLabelTs.map((ts, i) => {
          const x =
            plot.x +
            (domain.end === domain.start
              ? plot.width / 2
              : ((ts - domain.start) / (domain.end - domain.start)) * plot.width)
          return (
            <text
              key={ts}
              x={x}
              y={VIEW_H - 6}
              textAnchor={i === 0 ? 'start' : i === xLabelTs.length - 1 ? 'end' : 'middle'}
              className="fill-fg-subtle text-[10px]"
            >
              {formatX(ts)}
            </text>
          )
        })}

      {/* Connecting line — one <path> per contiguous segment so a real data
          gap breaks the line instead of drawing straight through it. */}
      <g className={accentClass}>
        {geo.segments.map(
          (seg, i) =>
            seg.length > 1 && (
              <path
                key={i}
                d={seg.map((d, j) => `${j === 0 ? 'M' : 'L'}${d.x},${d.y}`).join(' ')}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeOpacity={0.8}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ),
        )}
      </g>

      {/* Dots */}
      <g className={accentClass}>
        {geo.dots.map((d) => (
          <circle
            key={d.ts}
            cx={d.x}
            cy={d.y}
            r={2.6}
            fill={`url(#${gradientId})`}
          >
            <title>{`${formatX(d.ts)} · ${formatY(d.value)}`}</title>
          </circle>
        ))}
      </g>

      {!hasData && (
        <text
          x={VIEW_W / 2}
          y={VIEW_H / 2}
          textAnchor="middle"
          className="fill-fg-subtle text-[12px]"
        >
          {emptyLabel}
        </text>
      )}
    </svg>
  )
}
