/**
 * Live Control Overlay — the VIEWER cover (player-overlay).
 *
 * On the /play + /embed players (incl. anonymous), it polls the app's PUBLIC
 * live-control state for the current room's stream and, while it is
 * paused/finished, draws the resolved cover (image / looping video / text card)
 * over the video and mutes it client-side. Renders nothing while live.
 *
 * REAL-TIME PUSH: when mounted inside a LiveKit room context it also subscribes
 * to the `live-control` data topic — the core pushes on every transition and the
 * overlay refetches instantly. The poll stays as the fallback transport (and the
 * only one on HLS/MJPEG players, which have no LiveKit connection).
 *
 * IMPORTANT (documented in the feature page): this is a client-side overlay over
 * OUR players. A consumer hitting the raw HLS URL bypasses it in v1.
 *
 * Pure logic lives in overlay.util.ts (node:test); this is the thin React shell.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataChannel, useMaybeRoomContext } from '@livekit/components-react'
import { request } from '@/api/http'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps } from '../types.ts'
import {
  LIVE_CONTROL_TOPIC,
  coverVisible,
  fitClass,
  isLiveControlPush,
  parsePublicState,
  resolveSettings,
  type PublicState,
} from './overlay.util.ts'

const PAUSE_ICON = 'M10 9v6m4-6v6M4 5h16v14H4z'
const POLL_MS = 5000

// ---------------------------------------------------------------------------
// Public-state poll
// ---------------------------------------------------------------------------

async function fetchPublicState(app: string, room: string): Promise<PublicState | null> {
  const raw = await request(`/apps/${encodeURIComponent(app)}/plugins/live-control/public`, {
    auth: false,
    query: { room },
  })
  return parsePublicState(raw)
}

function usePublicState(
  app: string | undefined,
  room: string | undefined,
): { state: PublicState | null; refresh: () => void } {
  const [state, setState] = useState<PublicState | null>(null)
  const [key, setKey] = useState(0)
  useEffect(() => {
    if (!app || !room) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const s = await fetchPublicState(app, room)
        if (alive) setState(s)
      } catch {
        /* network hiccup — keep last */
      }
      timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, room, key])
  return { state, refresh: () => setKey((k) => k + 1) }
}

/** Bridge: refetch immediately on a live-control data-channel push. */
function PushBridge({ onPush }: { onPush: () => void }) {
  useDataChannel(LIVE_CONTROL_TOPIC, (msg) => {
    if (isLiveControlPush(msg.payload)) onPush()
  })
  return null
}

// ---------------------------------------------------------------------------
// Client-side mute while covering (copied convention from scheduled-live)
// ---------------------------------------------------------------------------

function findMedia(root: HTMLElement | null): HTMLMediaElement[] {
  if (!root) return []
  const frame = (root.offsetParent as HTMLElement | null) ?? root.parentElement ?? root
  return Array.from(frame.querySelectorAll('video, audio')) as HTMLMediaElement[]
}

function useMuteWhileCovering(rootRef: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  const mutedRef = useRef<{ el: HTMLMediaElement; prev: boolean }[]>([])
  useEffect(() => {
    if (!active) return
    const saved = findMedia(rootRef.current).map((el) => ({ el, prev: el.muted }))
    for (const { el } of saved) el.muted = true
    mutedRef.current = saved
    return () => {
      for (const { el, prev } of mutedRef.current) {
        try {
          el.muted = prev
        } catch {
          /* element gone */
        }
      }
      mutedRef.current = []
    }
  }, [active, rootRef])
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

function LiveControlOverlay({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('liveControlOverlayPlugin')
  const rootRef = useRef<HTMLDivElement>(null)
  const settings = resolveSettings(ctx.config as Record<string, unknown> | undefined)
  const { state, refresh } = usePublicState(ctx.app, ctx.room)

  const lkRoom = useMaybeRoomContext()
  const bridge = lkRoom ? <PushBridge onPush={refresh} /> : null

  const visible = coverVisible(state?.state) && !!state?.cover
  useMuteWhileCovering(rootRef, visible)

  if (!visible || !state?.cover) return bridge
  const cover = state.cover
  const finished = state.state === 'finished'
  const fit = fitClass(settings.fit)

  return (
    <>
      {bridge}
      <div
        ref={rootRef}
        className="pointer-events-auto absolute inset-0 z-30 flex flex-col items-center justify-center overflow-hidden bg-black text-center text-white"
        style={cover.mode === 'text' ? { backgroundColor: cover.cardColor } : undefined}
        aria-label={t(finished ? 'aria.finished' : 'aria.paused')}
        data-testid="live-control-cover"
      >
        {cover.mode === 'image' && cover.assetUrl && (
          <img src={cover.assetUrl} alt="" className={`absolute inset-0 h-full w-full ${fit}`} />
        )}
        {cover.mode === 'video' && cover.assetUrl && (
          <video
            src={cover.assetUrl}
            className={`absolute inset-0 h-full w-full ${fit}`}
            autoPlay
            loop
            muted
            playsInline
          />
        )}

        {cover.mode === 'text' && (
          <div className="max-w-2xl px-6">
            {cover.cardTitle && <h2 className="text-2xl font-bold sm:text-4xl">{cover.cardTitle}</h2>}
            {cover.cardText && <p className="mt-3 text-sm opacity-80 sm:text-base">{cover.cardText}</p>}
          </div>
        )}

        {finished && settings.showFinishedBadge && (
          <span className="absolute left-3 top-3 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide backdrop-blur-sm">
            {t('badge.finished')}
          </span>
        )}
      </div>
    </>
  )
}

export default definePlugin({
  id: 'live-control-overlay',
  name: 'Live Control Overlay',
  description:
    'Shows the Live Control cover (image, looping video or text card) to viewers ' +
    'while a stream is paused or finished. Pairs with the Live Control console.',
  category: 'tool',
  icon: PAUSE_ICON,
  version: '1.0.0',
  ui: 'player-overlay',
  configSchema: {
    fields: [
      {
        key: 'fit',
        type: 'select',
        label: 'Image/video fit',
        default: 'cover',
        options: [
          { value: 'cover', label: 'Cover (fill, may crop)' },
          { value: 'contain', label: 'Contain (letterbox)' },
        ],
      },
      {
        key: 'showFinishedBadge',
        type: 'boolean',
        label: 'Show a "finished" badge on the final card',
        default: true,
      },
    ],
  },
  OverlayComponent: LiveControlOverlay,
})
