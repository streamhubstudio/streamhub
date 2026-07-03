/**
 * WiredCables — the auth cover's animated "streaming signal" backdrop.
 *
 * A network of glowing nodes wired together by curved cables (à la a circuit /
 * StreamCloud mark) with pulses of light travelling along them. Geometry comes
 * from the pure, deterministic `buildWiredNetwork` (src/lib/wiredNetwork.ts);
 * this component only paints it and animates it:
 *   - cables: a subtle stroke-dash "flow" (CSS keyframes),
 *   - pulses: a bright dot riding each cable via SMIL <animateMotion>/<mpath>,
 *   - nodes: a gently breathing halo (CSS opacity).
 *
 * Brand colours only (cyan #22b6f0 → blue #2f7bff). It's purely decorative:
 * pointer-events-none + aria-hidden. Honours prefers-reduced-motion two ways —
 * the media query stops the CSS animations, and the JS hook also drops the SMIL
 * pulses entirely — so with reduced motion it renders a static wired diagram.
 */
import { useEffect, useMemo, useState } from 'react'
import { buildWiredNetwork } from '@/lib/wiredNetwork'

// Wide viewBox roughly matching the brand panel; the SVG slice-fills it.
const VB_W = 1200
const VB_H = 900

/** Live `prefers-reduced-motion: reduce` flag. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return reduced
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n
}

const CSS = `
.shc-flow {
  stroke-dasharray: 5 11;
  animation: shc-dash 2.6s linear infinite;
}
@keyframes shc-dash { to { stroke-dashoffset: -32; } }
.shc-node {
  animation: shc-breathe 4.5s ease-in-out infinite;
}
@keyframes shc-breathe {
  0%, 100% { opacity: 0.22; }
  50% { opacity: 0.6; }
}
@media (prefers-reduced-motion: reduce) {
  .shc-flow, .shc-node { animation: none; }
}
`

export function WiredCables({ className = '' }: { className?: string }) {
  const reduced = usePrefersReducedMotion()
  const { nodes, cables } = useMemo(
    () =>
      buildWiredNetwork({
        width: VB_W,
        height: VB_H,
        nodeCount: 16,
        linksPerNode: 2,
        seed: 20240701,
      }),
    [],
  )

  return (
    <svg
      className={className}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="shc-cable" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22b6f0" />
          <stop offset="100%" stopColor="#2f7bff" />
        </linearGradient>
        <radialGradient id="shc-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#eafaff" stopOpacity="0.95" />
          <stop offset="45%" stopColor="#5cc8f5" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#22b6f0" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Cables (faint gradient strokes with a slow dash "flow"). */}
      <g stroke="url(#shc-cable)" strokeLinecap="round">
        {cables.map((c, i) => (
          <path
            key={c.id}
            id={c.id}
            d={c.d}
            strokeWidth={1.3}
            strokeOpacity={0.34}
            className={reduced ? undefined : 'shc-flow'}
            style={{ animationDelay: `${(-i * 0.6).toFixed(2)}s` }}
          />
        ))}
      </g>

      {/* Signal pulses riding each cable (SMIL). Dropped under reduced motion. */}
      {!reduced &&
        cables.map((c, i) => {
          const dur = clamp(c.length / 70, 4, 9)
          const begin = -((i * 1.37) % dur)
          return (
            <g key={`pulse-${c.id}`}>
              <circle r={8} fill="url(#shc-glow)" />
              <circle r={2.1} fill="#eafcff" />
              <animateMotion
                dur={`${dur.toFixed(2)}s`}
                begin={`${begin.toFixed(2)}s`}
                repeatCount="indefinite"
                calcMode="linear"
              >
                <mpath href={`#${c.id}`} xlinkHref={`#${c.id}`} />
              </animateMotion>
            </g>
          )
        })}

      {/* Nodes: breathing halo + solid core. */}
      <g>
        {nodes.map((n, i) => (
          <g key={`node-${i}`}>
            <circle
              cx={n.x}
              cy={n.y}
              r={n.r * 3.4}
              fill="url(#shc-glow)"
              className={reduced ? undefined : 'shc-node'}
              style={{ animationDelay: `${(-i * 0.45).toFixed(2)}s`, opacity: reduced ? 0.4 : undefined }}
            />
            <circle cx={n.x} cy={n.y} r={n.r} fill="#cfeeff" opacity={0.9} />
          </g>
        ))}
      </g>

      <style>{CSS}</style>
    </svg>
  )
}
