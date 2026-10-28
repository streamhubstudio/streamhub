/**
 * AppFlowDiagram — the Tablero's animated "media pipeline flow" card body.
 *
 * One inline SVG tells how THIS app is configured across THREE bands:
 *   - COMPUTE (top): Studio Apps + processor/tool chips over the core, plus a
 *     distributed edge-compute cluster (per-model chips) hanging off the HLS
 *     edge with ambient shuttles.
 *   - MEDIA (middle): the dual-lane spine — ingest → (MediaMTX router) → core →
 *     transcoding/adaptive → delivery, with a passthrough/remux lane below it
 *     that bypasses the core (-c copy). Tag chips sit under the core; the
 *     ingest/delivery column headers carry the rolling net-I/O meters.
 *   - EVENTS (bottom): the recorder taps the core towards recording → S3
 *     (bottom-left), mirrored bottom-right by the event fan-out — detections →
 *     callbacks/MQTT/log → [reserved Streamflow slot] → email/Discord/Telegram.
 *
 * Geometry + the pulse "wave" schedule are pure and deterministic
 * (src/lib/pipelineFlow.ts, unit-tested); this component only paints:
 *   - cables: a stroke-dash "flow" (CSS keyframes) — active lanes run faster
 *     and brighter than merely-configured ones; dormant lanes are static,
 *   - packets: SMIL <animateMotion> with keyPoints holds so every hop fires in
 *     causal order once per period (ingest merge → spine relay → delivery
 *     burst + storage/events taps),
 *   - nodes: arrival flashes via CSS delays derived from the same schedule.
 *
 * Coloured via the semantic `--sh-*` tokens (dark-only console palette); brand
 * cyan→blue stays constant like the rest of the chrome. Under
 * prefers-reduced-motion everything settles into a static labelled diagram
 * (CSS media query stops the dashes/flashes, the JS hook drops the SMIL
 * packets entirely).
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppPipeline } from '@/api'
import { formatBytes } from '@/lib/bytes'
import {
  buildPipelineFlow,
  smilPulseTiming,
  FLOW_X_DELIVERY,
  FLOW_X_INGEST,
  type FlowNode,
  type PipelineFlow,
} from '@/lib/pipelineFlow'

/** Live `prefers-reduced-motion: reduce` flag (same pattern as WiredCables). */
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

const CSS = `
.apf-flow {
  stroke-dasharray: 6 12;
  animation: apf-dash linear infinite;
}
@keyframes apf-dash { to { stroke-dashoffset: -36; } }
.apf-node { animation: apf-breathe 4.5s ease-in-out infinite; }
@keyframes apf-breathe {
  0%, 100% { opacity: 0.22; }
  50% { opacity: 0.55; }
}
.apf-hit {
  opacity: 0;
  animation: apf-hit var(--apf-period, 8s) linear infinite;
}
@keyframes apf-hit {
  0% { opacity: 0; }
  1.5% { opacity: 0.95; }
  9% { opacity: 0; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .apf-flow, .apf-node, .apf-hit { animation: none; }
  .apf-hit { opacity: 0; }
}
`

// --- tiny geometric icons (24×24 stroke grid, centred on the node) -----------

function iconPaths(key: string): React.ReactNode {
  switch (key) {
    case 'rtmp':
    case 'rtmps': // broadcast tower
      return (
        <>
          <path d="M5 8a7 7 0 0 1 14 0" />
          <path d="M8.2 8a3.8 3.8 0 0 1 7.6 0" />
          <circle cx="12" cy="8" r="1.6" />
          <path d="M12 10v11" />
        </>
      )
    case 'whip':
    case 'webrtc': // bolt (low-latency)
      return <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    case 'rtsp':
    case 'ws-mjpeg': // camera
      return (
        <>
          <rect x="2" y="5" width="11.5" height="10" rx="1.8" />
          <path d="m13.5 8.5 4.5-2.7v8.4l-4.5-2.7" />
          <circle cx="7.5" cy="10" r="2.2" />
        </>
      )
    case 'srt': // reliable transport (double chevron burst)
      return <path d="m5 7 5 5-5 5M12 7l5 5-5 5" />
    case 'url': // link
      return (
        <>
          <path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
          <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6" />
        </>
      )
    case 'core': // layer stack (the server)
      return (
        <>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 13 9 5 9-5" />
          <path d="m3 8.5 9 5 9-5" opacity=".55" />
        </>
      )
    case 'mediamtx': // single-port router / splitter
      return (
        <>
          <circle cx="6" cy="12" r="2.4" />
          <circle cx="18" cy="6" r="2.4" />
          <circle cx="18" cy="18" r="2.4" />
          <path d="M8.2 11 16 6.8M8.2 13 16 17.2" />
        </>
      )
    case 'remux': // -c copy (duplicate)
      return (
        <>
          <rect x="4" y="4" width="12" height="12" rx="2" />
          <path d="M8 20h10a2 2 0 0 0 2-2V8" />
        </>
      )
    case 'transcoding': // cpu chip
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" />
        </>
      )
    case 'adaptive': // quality ladder
      return <path d="M4 19v-6M9 19V9M14 19v-7M19 19V5" />
    case 'hls': // playlist
      return (
        <>
          <path d="M4 6h16M4 11h16M4 16h8" />
          <path d="m15 14 5 3-5 3v-6Z" />
        </>
      )
    case 'cdn': // globe
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a13.5 13.5 0 0 1 0 18M12 3a13.5 13.5 0 0 0 0 18" />
        </>
      )
    case 'restream': // cast / broadcast-out
      return (
        <>
          <path d="M4 12a8 8 0 0 1 8 8M4 16a4 4 0 0 1 4 4" />
          <circle cx="5" cy="19" r="1.2" fill="currentColor" stroke="none" />
          <rect x="10.5" y="4" width="10" height="8.5" rx="1.6" />
        </>
      )
    case 'edge': // distributed cluster (2×2 grid)
      return (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1.4" />
          <rect x="14" y="3" width="7" height="7" rx="1.4" />
          <rect x="3" y="14" width="7" height="7" rx="1.4" />
          <rect x="14" y="14" width="7" height="7" rx="1.4" />
        </>
      )
    case 'model': // inference sensor
      return (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </>
      )
    case 'events': // activity waveform
      return <path d="M3 12h4l3 8 4-16 3 8h4" />
    case 'streamflow': // workflow nodes
      return (
        <>
          <circle cx="6" cy="6" r="2.2" />
          <circle cx="18" cy="6" r="2.2" />
          <circle cx="12" cy="18" r="2.2" />
          <path d="M8 7 10.5 16M16 7 13.5 16" />
        </>
      )
    case 'callbacks': // webhook / external POST
      return (
        <>
          <path d="M14 4h6v6" />
          <path d="M20 4 11 13" />
          <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
        </>
      )
    case 'mqtt': // pub/sub broadcast
      return (
        <>
          <circle cx="12" cy="12" r="1.8" />
          <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M6 6a9 9 0 0 0 0 12M18 6a9 9 0 0 1 0 12" />
        </>
      )
    case 'log': // document with lines
      return (
        <>
          <path d="M6 3h9l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
          <path d="M9 12h7M9 16h7M9 8h3" />
        </>
      )
    case 'email': // envelope
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </>
      )
    case 'discord': // chat bubble
      return (
        <>
          <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1Z" />
          <circle cx="9.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="14.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
        </>
      )
    case 'telegram': // paper plane
      return <path d="m21 4-9.5 9.5M21 4 14 21l-3-7-7-3 17-7Z" />
    case 'recording': // record dot
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
        </>
      )
    case 's3': // cloud upload
      return (
        <>
          <path d="M7 17a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19.4 9.5 3.8 3.8 0 0 1 18.5 17H16" />
          <path d="M12 21v-7m-3 3 3-3 3 3" />
        </>
      )
    default: // generic play (webrtc delivery)
      return <path d="M8 5.5v13l11-6.5-11-6.5Z" />
  }
}

/** Icon key for a node: ingest/delivery by type, notify/model by suffix, else id. */
function iconKey(n: FlowNode): string {
  const io = n.id.match(/^(?:in|out)-(.+)-\d+$/)
  if (io) return io[1]
  if (n.id.startsWith('notify-')) return n.id.slice('notify-'.length)
  if (n.id.startsWith('model-')) return 'model'
  return n.id
}

function NodeIcon({ node, active, size = 24 }: { node: FlowNode; active: boolean; size?: number }) {
  const off = size / 2
  const scale = size / 24
  return (
    <g
      transform={`translate(${node.x - off}, ${node.y - off}) scale(${scale})`}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      color={active ? 'var(--color-sky2)' : 'var(--sh-fg-muted)'}
    >
      {iconPaths(iconKey(node))}
    </g>
  )
}

/** A centred row of small pills below a node (tags, transports, taps). */
function Chips({ chips, x, y }: { chips: string[]; x: number; y: number }) {
  const widths = chips.map((c) => 12 + c.length * 5.6)
  const total = widths.reduce((s, w) => s + w, 0) + 5 * (chips.length - 1)
  let cursor = x - total / 2
  return (
    <>
      {chips.map((c, i) => {
        const w = widths[i]
        const cx = cursor + w / 2
        cursor += w + 5
        return (
          <g key={c}>
            <rect
              x={cx - w / 2}
              y={y - 8}
              width={w}
              height={16}
              rx={8}
              fill="var(--sh-surface-sunken)"
              stroke="var(--sh-border)"
              strokeWidth={0.75}
            />
            <text
              x={cx}
              y={y + 3}
              textAnchor="middle"
              fontSize="8.5"
              fontFamily="ui-monospace, monospace"
              fill="var(--sh-fg-muted)"
            >
              {c}
            </text>
          </g>
        )
      })}
    </>
  )
}

// --- the diagram ---------------------------------------------------------------

export function AppFlowDiagram({
  pipeline,
  className = '',
}: {
  pipeline: AppPipeline
  className?: string
}) {
  const { t } = useTranslation('appFlow')
  const reduced = usePrefersReducedMotion()
  // Per-instance namespace for path/gradient ids (two diagrams may coexist).
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const flow: PipelineFlow = useMemo(() => buildPipelineFlow(pipeline), [pipeline])

  const dur = `${flow.period}s`
  const pathId = (cable: string) => `apf${uid}-${cable}`
  const hitDelay = (nodeId: string): string | undefined => {
    const f = flow.wave.hits[nodeId]
    return f === undefined ? undefined : `${(f * flow.period).toFixed(2)}s`
  }

  const nodeLabel = (n: FlowNode): string => n.label ?? t(`nodes.${n.id}`)
  const nodeDetail = (n: FlowNode): string | undefined => {
    if (n.id === 'transcoding') {
      return t(`detail.encoder.${pipeline.processing.transcoding.encoder}`)
    }
    if (n.id === 'recording' && pipeline.storage.recording.splitMinutes) {
      return t('detail.split', { n: pipeline.storage.recording.splitMinutes })
    }
    return n.detail
  }

  const byKind = (k: FlowNode['kind']) => flow.nodes.filter((n) => n.kind === k)
  const ingestNodes = byKind('ingest')
  const deliveryNodes = byKind('delivery')
  const appChips = flow.nodes.filter((n) => n.kind === 'plugin' && n.group === 'app')
  const procChips = flow.nodes.filter((n) => n.kind === 'plugin' && n.group !== 'app')
  const edgeNode = flow.nodes.find((n) => n.id === 'edge')
  const eventsNode = flow.nodes.find((n) => n.id === 'events')
  const storageNodes = byKind('storage')
  const core = flow.nodes.find((n) => n.id === 'core')!
  const headerY = flow.mediaHeaderY
  const deliveryHeader =
    flow.live.viewers != null
      ? `${t('groups.delivery')} · ${t('live.viewers', { n: flow.live.viewers })}`
      : t('groups.delivery')

  const centreX = (ns: FlowNode[]) => ns.reduce((s, n) => s + n.x, 0) / ns.length

  const groupHeader = (
    label: string,
    x: number,
    y: number,
    key: string,
  ): React.ReactNode => (
    <text
      key={key}
      x={x}
      y={y}
      textAnchor="middle"
      fontSize="9.5"
      letterSpacing="0.16em"
      fill="var(--sh-fg-subtle)"
    >
      {label.toUpperCase()}
    </text>
  )

  return (
    <div className={className}>
      {/* Prose topology description for screen readers. */}
      <p className="sr-only">{t('sr')}</p>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${flow.width} ${flow.height}`}
          role="img"
          aria-label={t('svg.title')}
          className="block h-auto w-full min-w-[860px]"
          style={{ '--apf-period': dur } as React.CSSProperties}
          fill="none"
        >
          <title>{t('svg.title')}</title>
          <desc>{t('svg.desc')}</desc>

          <defs>
            <linearGradient id={`apf${uid}-cable`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-sky2)" />
              <stop offset="100%" stopColor="var(--color-blue2)" />
            </linearGradient>
            <radialGradient id={`apf${uid}-glow`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#eafaff" stopOpacity="0.95" />
              <stop offset="45%" stopColor="#5cc8f5" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#22b6f0" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* ============================== Headers ============================= */}
          {groupHeader(t('groups.ingest'), FLOW_X_INGEST, headerY, 'h-ingest')}
          {groupHeader(deliveryHeader, FLOW_X_DELIVERY, headerY, 'h-delivery')}
          {/* Rolling net-I/O meters on the ingest (in) + delivery (out) columns. */}
          {flow.net && (
            <>
              <text
                x={FLOW_X_INGEST}
                y={headerY + 13}
                textAnchor="middle"
                fontSize="9"
                fontFamily="ui-monospace, monospace"
                fill="var(--sh-fg-muted)"
              >
                {`↓ ${formatBytes(flow.net.inBytes)}`}
              </text>
              <text
                x={FLOW_X_DELIVERY}
                y={headerY + 13}
                textAnchor="middle"
                fontSize="9"
                fontFamily="ui-monospace, monospace"
                fill="var(--sh-fg-muted)"
              >
                {`↑ ${formatBytes(flow.net.outBytes)}`}
              </text>
            </>
          )}
          {appChips.length > 0 &&
            groupHeader(t('groups.apps'), centreX(appChips), appChips[0].y - 20, 'h-apps')}
          {procChips.length > 0 &&
            groupHeader(t('groups.processors'), centreX(procChips), procChips[0].y - 18, 'h-proc')}
          {edgeNode && groupHeader(t('groups.edge'), edgeNode.x, edgeNode.y - 34, 'h-edge')}
          {storageNodes.length > 0 &&
            groupHeader(t('groups.storage'), centreX(storageNodes), storageNodes[0].y - 26, 'h-storage')}
          {eventsNode && groupHeader(t('groups.events'), eventsNode.x, eventsNode.y - 26, 'h-events')}

          {/* ============================== Cables ============================== */}
          <g stroke={`url(#apf${uid}-cable)`} strokeLinecap="round">
            {flow.cables.map((c) => {
              if (!c.enabled) {
                // Dormant lane (e.g. S3 without recording, reserved Streamflow):
                // static, dashed, faint.
                return (
                  <path
                    key={c.id}
                    d={c.d}
                    strokeWidth={1.2}
                    strokeOpacity={0.25}
                    strokeDasharray="3 7"
                  />
                )
              }
              return (
                <g key={c.id}>
                  <path
                    id={pathId(c.id)}
                    d={c.d}
                    strokeWidth={c.active ? 3 : 2}
                    strokeOpacity={c.active ? 0.38 : 0.28}
                  />
                  {/* Marching dashes: active lanes flow faster and brighter. */}
                  <path
                    d={c.d}
                    strokeWidth={c.active ? 2.6 : 1.8}
                    strokeOpacity={c.active ? 0.7 : 0.4}
                    className={reduced ? undefined : 'apf-flow'}
                    style={{ animationDuration: c.active ? '1.8s' : '4.6s' }}
                  />
                </g>
              )
            })}
          </g>

          {/* ========================= Signal packets ========================= */}
          {/* The wave: one packet per hop, all sharing the period so the story
              reads ingest → core → processing → delivery (+ storage/events taps). */}
          {!reduced &&
            flow.wave.hops.map((hop) => {
              const timing = smilPulseTiming(hop)
              return (
                <g key={`hop-${hop.cable}`} opacity="0">
                  <circle r={hop.r} fill={`url(#apf${uid}-glow)`} />
                  <circle r={hop.core} fill="#eafcff" />
                  <animateMotion
                    dur={dur}
                    repeatCount="indefinite"
                    calcMode="linear"
                    keyPoints={timing.keyPoints}
                    keyTimes={timing.motionKeyTimes}
                  >
                    <mpath href={`#${pathId(hop.cable)}`} />
                  </animateMotion>
                  <animate
                    attributeName="opacity"
                    dur={dur}
                    repeatCount="indefinite"
                    values={timing.opacityValues}
                    keyTimes={timing.opacityKeyTimes}
                  />
                </g>
              )
            })}

          {/* Ambient shuttles between the core and its chips / the edge cluster. */}
          {!reduced &&
            flow.shuttles.map((s, i) => (
              <g key={`shuttle-${s.cable}`}>
                <circle r={4} fill={`url(#apf${uid}-glow)`} />
                <circle r={1.4} fill="#eafcff" />
                <animateMotion
                  dur="2.8s"
                  begin={`${(-0.9 * i).toFixed(1)}s`}
                  repeatCount="indefinite"
                  calcMode="linear"
                  keyPoints={s.reverse ? '1;0' : '0;1'}
                  keyTimes="0;1"
                >
                  <mpath href={`#${pathId(s.cable)}`} />
                </animateMotion>
              </g>
            ))}

          {/* ============================== Nodes ============================== */}
          {flow.nodes.map((node) => (
            <FlowNodeShape
              key={node.id}
              node={node}
              uid={uid}
              reduced={reduced}
              delay={hitDelay(node.id)}
              label={nodeLabel(node)}
              detail={nodeDetail(node)}
              liveStreams={flow.live.activeStreams}
              soonLabel={t('nodes.soon')}
              liveText={
                node.id === 'core' && flow.live.activeStreams > 0
                  ? t('live.streams', { n: flow.live.activeStreams })
                  : undefined
              }
            />
          ))}

          {/* Empty-column hints keep the story honest when a stage is off. */}
          {ingestNodes.length === 0 && (
            <text
              x={FLOW_X_INGEST}
              y={core.y + 4}
              textAnchor="middle"
              fontSize="10.5"
              fill="var(--sh-fg-subtle)"
            >
              {t('nodes.noIngest')}
            </text>
          )}
          {deliveryNodes.length === 0 && (
            <text
              x={FLOW_X_DELIVERY}
              y={core.y + 4}
              textAnchor="middle"
              fontSize="10.5"
              fill="var(--sh-fg-subtle)"
            >
              {t('nodes.noDelivery')}
            </text>
          )}

          <style>{CSS}</style>
        </svg>
      </div>

      {/* Legend: live vs merely-configured vs dormant lanes. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-fg-subtle">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-sky2" />
          {t('legend.active')}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-sky2/35" />
          {t('legend.configured')}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-0.5 w-4 border-t border-dashed border-border-strong"
          />
          {t('legend.dormant')}
        </span>
        <span className="flex items-center gap-1.5 opacity-70">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-sm border border-dashed border-border-strong"
          />
          {t('legend.soon')}
        </span>
      </div>
    </div>
  )
}

/** One node — shape dispatched by kind, with its label/detail/chips/flash. */
function FlowNodeShape({
  node,
  uid,
  reduced,
  delay,
  label,
  detail,
  liveText,
  liveStreams,
  soonLabel,
}: {
  node: FlowNode
  uid: string
  reduced: boolean
  delay: string | undefined
  label: string
  detail?: string
  liveText?: string
  liveStreams: number
  soonLabel: string
}) {
  const glow = `url(#apf${uid}-glow)`
  const stroke = node.active ? 'var(--color-sky2)' : 'var(--sh-border-strong)'
  const strokeOpacity = node.active ? 0.55 : 1

  // --- chip nodes (Studio App / processor / model) → labelled pill ----------
  if (node.kind === 'plugin' || node.kind === 'compute') {
    const isModel = node.kind === 'compute'
    const w = 26 + label.length * 6.4
    const h = 22
    return (
      <g>
        <rect
          x={node.x - w / 2}
          y={node.y - h / 2}
          width={w}
          height={h}
          rx={11}
          strokeWidth={1}
          fill="var(--sh-surface-raised)"
          stroke={
            node.active
              ? 'var(--color-sky2)'
              : isModel
                ? 'var(--sh-border)'
                : 'var(--sh-border-strong)'
          }
          strokeOpacity={node.active ? 0.55 : 1}
          strokeDasharray={isModel ? '4 3' : undefined}
        />
        <text
          x={node.x}
          y={node.y + 3.5}
          textAnchor="middle"
          fontSize="10.5"
          fontFamily="ui-monospace, monospace"
          fill="var(--sh-fg)"
        >
          {label}
        </text>
      </g>
    )
  }

  // --- reserved Streamflow placeholder → faint dashed box + "soon" badge -----
  if (node.placeholder) {
    const w = 84
    const h = 44
    return (
      <g opacity={0.6}>
        <rect
          x={node.x - w / 2}
          y={node.y - h / 2}
          width={w}
          height={h}
          rx={12}
          strokeWidth={1.1}
          strokeDasharray="4 4"
          fill="var(--sh-surface-sunken)"
          stroke="var(--sh-border-strong)"
        />
        <NodeIcon node={node} active={false} size={20} />
        <text
          x={node.x}
          y={node.y + h / 2 + 13}
          textAnchor="middle"
          fontSize="10"
          fontWeight="600"
          fill="var(--sh-fg-subtle)"
        >
          {label}
        </text>
        <text
          x={node.x}
          y={node.y - h / 2 - 5}
          textAnchor="middle"
          fontSize="8"
          letterSpacing="0.12em"
          fill="var(--sh-fg-subtle)"
        >
          {soonLabel.toUpperCase()}
        </text>
      </g>
    )
  }

  // --- shape metrics by kind ------------------------------------------------
  const boxKinds: FlowNode['kind'][] = ['core', 'processing', 'mediamtx', 'remux', 'edge', 'events']
  const isBox = boxKinds.includes(node.kind)
  const w = node.kind === 'core' ? 128 : node.kind === 'processing' ? 112 : 96
  const h = node.kind === 'core' ? 56 : 48
  const circleR = node.kind === 'notify' ? 17 : 20
  const iconSize = node.kind === 'notify' ? 20 : 24
  const labelY = node.y + (isBox ? h / 2 : circleR) + 17

  // Chips sit under the label / detail / live lines.
  let chipsY = labelY + 14
  if (detail) chipsY += 13
  if (liveText) chipsY += 13

  return (
    <g>
      {/* Breathing halo (brand glow) on live nodes. */}
      {node.active && (
        <circle
          cx={node.x}
          cy={node.y}
          r={isBox ? 42 : 30}
          fill={glow}
          className={reduced ? undefined : 'apf-node'}
          opacity={reduced ? 0.35 : undefined}
        />
      )}

      {isBox ? (
        <rect
          x={node.x - w / 2}
          y={node.y - h / 2}
          width={w}
          height={h}
          rx={14}
          strokeWidth={1.2}
          fill="var(--sh-surface-raised)"
          stroke={stroke}
          strokeOpacity={strokeOpacity}
        />
      ) : (
        <circle
          cx={node.x}
          cy={node.y}
          r={circleR}
          strokeWidth={1.2}
          fill="var(--sh-surface-raised)"
          stroke={stroke}
          strokeOpacity={strokeOpacity}
        />
      )}

      {/* Arrival flash, delayed to the wave hit. */}
      {!reduced &&
        delay !== undefined &&
        (isBox ? (
          <rect
            x={node.x - w / 2}
            y={node.y - h / 2}
            width={w}
            height={h}
            rx={14}
            strokeWidth={1.6}
            stroke="var(--color-sky2)"
            className="apf-hit"
            style={{ animationDelay: delay }}
          />
        ) : (
          <circle
            cx={node.x}
            cy={node.y}
            r={circleR + 3}
            strokeWidth={1.6}
            stroke="var(--color-sky2)"
            className="apf-hit"
            style={{ animationDelay: delay }}
          />
        ))}

      <NodeIcon node={node} active={node.active} size={iconSize} />

      <text
        x={node.x}
        y={labelY}
        textAnchor="middle"
        fontSize="11.5"
        fontWeight="600"
        fill="var(--sh-fg)"
      >
        {label}
      </text>
      {detail && (
        <text
          x={node.x}
          y={labelY + 14}
          textAnchor="middle"
          fontSize="9.5"
          fontFamily="ui-monospace, monospace"
          fill="var(--sh-fg-subtle)"
        >
          {detail}
        </text>
      )}
      {liveText && node.id === 'core' && liveStreams > 0 && (
        <text
          x={node.x}
          y={labelY + (detail ? 28 : 14)}
          textAnchor="middle"
          fontSize="9.5"
          fontFamily="ui-monospace, monospace"
          fill="var(--color-sky2)"
        >
          {liveText}
        </text>
      )}
      {node.chips && node.chips.length > 0 && (
        <Chips chips={node.chips} x={node.x} y={chipsY} />
      )}
    </g>
  )
}
