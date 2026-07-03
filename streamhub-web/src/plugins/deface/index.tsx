/**
 * Frontend plugin: deface — face obfuscation (player overlay).
 *
 * Auto-discovered (src/plugins/deface/index.tsx default-export) — no central
 * edit. Mirrors the streamhub-core `deface` plugin's config so the Marketplace
 * renders the generic settings form, and ships the OverlayComponent that does
 * the actual client-side obfuscation:
 *
 *   worker (CenterFace) ─POST→ core live-data channel ─GET :id/live← this
 *   overlay polls at ~the worker FPS, keeps smoothed face TRACKS (no flicker
 *   at low detector FPS) and masks each region with blur (CSS backdrop-filter),
 *   mosaic (canvas pixelation of the actual video pixels), or a solid fill —
 *   ellipses by default, rectangles when `boxes` is on; optional score labels.
 *
 * All pure logic (parsing, expansion, tracking, smoothing, letterbox geometry)
 * lives in overlay.util.ts (node:test-covered); this file is the thin React
 * shell: polling, requestAnimationFrame, DOM measurement and painting.
 *
 * PRIVACY: this obfuscates the PLAYER only — the underlying stream/recordings
 * still contain faces (see the backend plugin README).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '@/api/http'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps } from '../types.ts'
import {
  debounceEmpty,
  effectiveFaces,
  faceToPixels,
  blurRadius,
  maskBorderRadius,
  mosaicGrid,
  parseLivePayload,
  pollIntervalMs,
  resolveObjectFit,
  resolveSettings,
  scoreLabel,
  staleAfterMs,
  stepTracks,
  updateTracks,
  videoContentRect,
  INITIAL_EMPTY_STREAK,
  type DefaceSettings,
  type EmptyStreakState,
  type Face,
  type Rect,
  type Track,
} from './overlay.util.ts'

/** Time constant of the exponential easing towards fresh detector boxes. */
const SMOOTH_TAU_MS = 140
/** Cap the mosaic repaint rate — pixelation doesn't need 60 fps. */
const MOSAIC_REDRAW_MS = 100

interface LiveResponse {
  ts: number | null
  ageMs: number | null
  payload: unknown
}

// ---------------------------------------------------------------------------
// Live faces: poll + tracks + rAF smoothing
// ---------------------------------------------------------------------------

function useFaceTracks(
  app: string | undefined,
  room: string | undefined,
  settings: DefaceSettings,
): Track[] {
  const [tracks, setTracks] = useState<Track[]>([])
  const tracksRef = useRef<Track[]>([])
  // Anti-flapping gate ahead of the tracker — see debounceEmpty: a flappy
  // detector alternating N faces ↔ 0 faces between samples must not blink
  // the masks, so a single empty payload is suppressed rather than applied.
  const streakRef = useRef<EmptyStreakState>(INITIAL_EMPTY_STREAK)

  // Poll the public live endpoint at ~the worker FPS.
  useEffect(() => {
    if (!app || !room) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const interval = pollIntervalMs(settings.fps)
    const staleMs = staleAfterMs(settings.fps)
    // Hold masks across a couple of missed detections, never below the
    // staleness window (over-mask rather than flicker a face into view).
    // This is the SECOND line of defense: the empty-streak gate below stops
    // phantom empties from reaching this at all; once a streak is confirmed
    // genuine, per-track holdMs still gives each mask its own grace period.
    const holdMs = Math.max(2 * interval, staleMs)

    const apply = (faces: Face[]) => {
      const now = performance.now()
      const debounced = debounceEmpty(faces, streakRef.current, now)
      streakRef.current = debounced.state
      if (debounced.faces === null) return // unconfirmed empty streak → keep tracks as-is
      tracksRef.current = updateTracks(tracksRef.current, debounced.faces, now, {
        holdMs,
      })
    }

    const tick = async () => {
      try {
        const res = await request<LiveResponse>(
          `/apps/${encodeURIComponent(app)}/plugins/deface/live`,
          { auth: false, query: { room } },
        )
        if (!alive) return
        const fresh = typeof res?.ageMs === 'number' && res.ageMs <= staleMs
        const parsed = fresh ? parseLivePayload(res.payload) : null
        apply(parsed ? effectiveFaces(parsed, settings) : [])
      } catch {
        if (!alive) return
        apply([]) // endpoint gone/network hiccup → subject to the same hysteresis
      }
      timer = setTimeout(tick, interval)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, room, settings.fps, settings.maskScale, settings.replacewith])

  // rAF loop easing rendered boxes towards their targets.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const step = (t: number) => {
      raf = requestAnimationFrame(step)
      const dt = t - last
      last = t
      const next = stepTracks(tracksRef.current, dt, SMOOTH_TAU_MS)
      if (next !== tracksRef.current) {
        tracksRef.current = next
      }
      // Publish only when the array identity changed (stepTracks returns the
      // same instance when fully settled) or tracks were added/removed.
      setTracks((prev) => (prev === tracksRef.current ? prev : tracksRef.current))
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  return tracks
}

// ---------------------------------------------------------------------------
// Player geometry: find the <video> and its letterboxed content rect
// ---------------------------------------------------------------------------

/**
 * Measure geometry against the ACTUAL `<video>` element's own rendered box,
 * not the overlay root's. The overlay root is a sibling of the player's
 * video stage (mounted at the player-frame level), which commonly pads/
 * centers the `<video>` inside its own layout (grid, aspect-ratio tiles) —
 * so the two boxes differ. Because both are centered on the same point,
 * conflating them used to produce a bug that "matched" at the center of the
 * frame and grew wrong towards the edges (a scale error anchored at the
 * shared center) rather than a uniform offset, which made it easy to miss.
 *
 * `videoContentRect` also needs the actual CSS `object-fit` of the element
 * (`contain` vs `cover`) — StreamHub's own video tiles use `cover` for
 * camera tracks and `contain` for screen-share, and third-party embeds may
 * use either — read via `getComputedStyle` and resolved with the same
 * fallback-to-contain policy as the pure helper.
 */
function useVideoGeometry(rootRef: React.RefObject<HTMLDivElement | null>): {
  video: HTMLVideoElement | null
  content: Rect | null
} {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [content, setContent] = useState<Rect | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const findVideo = (): HTMLVideoElement | null => {
      let el: HTMLElement | null = root.parentElement
      while (el) {
        const v = el.querySelector('video')
        if (v) return v
        el = el.parentElement
      }
      return null
    }

    let current: HTMLVideoElement | null = null
    const update = () => {
      const rootBox = root.getBoundingClientRect()
      if (!current) {
        // No <video> found (yet) — fall back to filling the overlay root so
        // masks aren't stuck at a stale/empty rect while the player mounts.
        setContent(videoContentRect(rootBox.width, rootBox.height, 0, 0))
        return
      }
      const videoBox = current.getBoundingClientRect()
      const fit = resolveObjectFit(getComputedStyle(current).objectFit)
      const inner = videoContentRect(
        videoBox.width,
        videoBox.height,
        current.videoWidth,
        current.videoHeight,
        fit,
      )
      // Compose: the <video>'s own offset from the overlay root (padding,
      // grid centering, …) PLUS the letterbox/crop offset within its box.
      // Masks are positioned absolute against `root`, so everything must be
      // expressed in root's coordinate space.
      setContent({
        x: videoBox.left - rootBox.left + inner.x,
        y: videoBox.top - rootBox.top + inner.y,
        w: inner.w,
        h: inner.h,
      })
    }
    const ro = new ResizeObserver(update)
    const attach = (v: HTMLVideoElement | null) => {
      if (current === v) return
      current?.removeEventListener('loadedmetadata', update)
      current?.removeEventListener('resize', update)
      if (current) ro.unobserve(current)
      current = v
      setVideo(v)
      v?.addEventListener('loadedmetadata', update)
      v?.addEventListener('resize', update)
      if (v) ro.observe(v)
      update()
    }

    attach(findVideo())
    // The player may mount its <video> after the overlay — rescan cheaply.
    const scan = setInterval(() => {
      if (!current || !current.isConnected) attach(findVideo())
    }, 1000)
    ro.observe(root)
    update()
    return () => {
      clearInterval(scan)
      ro.disconnect()
      attach(null)
    }
  }, [rootRef])

  return { video, content }
}

// ---------------------------------------------------------------------------
// Mosaic mask: pixelate the real video region on a tiny canvas
// ---------------------------------------------------------------------------

function MosaicPatch({
  video,
  face,
  cols,
  rows,
  radius,
  onFallback,
}: {
  video: HTMLVideoElement
  face: Face
  cols: number
  rows: number
  radius: string
  onFallback: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const faceRef = useRef(face)
  faceRef.current = face

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) {
      onFallback()
      return
    }
    let raf = 0
    let last = 0
    let stopped = false
    const draw = (t: number) => {
      if (stopped) return
      raf = requestAnimationFrame(draw)
      if (t - last < MOSAIC_REDRAW_MS) return
      last = t
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return
      const f = faceRef.current
      try {
        ctx2d.imageSmoothingEnabled = false
        ctx2d.drawImage(
          video,
          f.x * vw,
          f.y * vh,
          f.w * vw,
          f.h * vh,
          0,
          0,
          canvas.width,
          canvas.height,
        )
      } catch {
        // Tainted canvas (cross-origin media) — mosaic impossible; blur instead.
        stopped = true
        cancelAnimationFrame(raf)
        onFallback()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }, [video, onFallback])

  return (
    <canvas
      ref={canvasRef}
      width={cols}
      height={rows}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        imageRendering: 'pixelated',
        borderRadius: radius,
        backgroundColor: '#000',
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// The overlay surface
// ---------------------------------------------------------------------------

function DefaceOverlay({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('deface')
  const settings = useMemo(() => resolveSettings(ctx.config), [ctx.config])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { video, content } = useVideoGeometry(rootRef)
  const tracks = useFaceTracks(ctx.app, ctx.room, settings)
  // Mosaic needs readable video pixels; when that fails we degrade to blur.
  const [mosaicBroken, setMosaicBroken] = useState(false)
  const breakMosaic = useCallback(() => setMosaicBroken(true), [])

  const radius = maskBorderRadius(settings.boxes)
  const method =
    settings.replacewith === 'mosaic' && (mosaicBroken || !video)
      ? 'blur'
      : settings.replacewith

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      aria-label={t('overlay.ariaLabel', { count: tracks.length })}
    >
      {content &&
        tracks.map((track) => {
          const px = faceToPixels(track.cur, content)
          if (px.w <= 0 || px.h <= 0) return null
          const grid = mosaicGrid(px.w, px.h, settings.mosaicSize)
          return (
            <div
              key={track.id}
              style={{
                position: 'absolute',
                left: px.x,
                top: px.y,
                width: px.w,
                height: px.h,
              }}
            >
              {method === 'blur' && (
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: radius,
                    backdropFilter: `blur(${blurRadius(px.w)}px)`,
                    WebkitBackdropFilter: `blur(${blurRadius(px.w)}px)`,
                    backgroundColor: 'rgba(0,0,0,0.15)',
                  }}
                />
              )}
              {method === 'mosaic' && video && (
                <MosaicPatch
                  video={video}
                  face={track.cur}
                  cols={grid.cols}
                  rows={grid.rows}
                  radius={radius}
                  onFallback={breakMosaic}
                />
              )}
              {method === 'solid' && (
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: radius,
                    backgroundColor: '#000',
                  }}
                />
              )}
              {method === 'none' && settings.drawScores && (
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: radius,
                    border: '1px solid rgba(74, 222, 128, 0.9)',
                  }}
                />
              )}
              {settings.drawScores && (
                <span
                  className="absolute -top-5 left-0 rounded bg-black/70 px-1 font-mono text-[10px] leading-4 text-emerald-300"
                  title={t('overlay.scoreTitle')}
                >
                  {scoreLabel(track.cur.score)}
                </span>
              )}
            </div>
          )
        })}
    </div>
  )
}

export default definePlugin({
  id: 'deface',
  name: 'Deface — Face Obfuscation',
  description:
    'Detects faces in the live stream (CenterFace worker) and obfuscates them on the player: blur, mosaic or solid mask.',
  category: 'privacy',
  ui: 'player-overlay',
  icon: 'M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z M9.2 11h.01M14.8 11h.01M9.5 14.5a3.2 3.2 0 005 0',
  version: '1.0.0',
  configSchema: {
    fields: [
      { key: 'room', type: 'string', label: 'Room / stream', required: true },
      {
        key: 'thresh',
        type: 'number',
        label: 'Detection threshold',
        default: 0.2,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'replacewith',
        type: 'select',
        label: 'Anonymization method',
        default: 'blur',
        options: [
          { value: 'blur', label: 'Blur (gaussian)' },
          { value: 'mosaic', label: 'Mosaic (pixelate)' },
          { value: 'solid', label: 'Solid (black fill)' },
          { value: 'none', label: 'None (detect only)' },
        ],
      },
      {
        key: 'maskScale',
        type: 'number',
        label: 'Mask scale',
        default: 1.3,
        min: 1,
        max: 3,
        step: 0.1,
      },
      { key: 'boxes', type: 'boolean', label: 'Rectangular masks', default: false },
      {
        key: 'mosaicSize',
        type: 'number',
        label: 'Mosaic block size',
        default: 20,
        min: 2,
        max: 200,
        step: 1,
      },
      {
        key: 'scale',
        type: 'string',
        label: 'Detection downscale',
        default: '',
        placeholder: '640x360',
      },
      {
        key: 'backend',
        type: 'select',
        label: 'Inference backend',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'onnxrt', label: 'ONNX Runtime' },
          { value: 'opencv', label: 'OpenCV DNN' },
        ],
      },
      { key: 'cuda', type: 'boolean', label: 'Use CUDA (GPU)', default: false },
      {
        key: 'fps',
        type: 'number',
        label: 'Sample FPS',
        default: 2,
        min: 0.1,
        max: 30,
        step: 0.5,
      },
      {
        key: 'drawScores',
        type: 'boolean',
        label: 'Draw detection scores',
        default: false,
      },
    ],
  },
  OverlayComponent: DefaceOverlay,
})
