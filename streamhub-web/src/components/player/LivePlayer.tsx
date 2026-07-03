/**
 * <LivePlayer> — reusable, embeddable low-latency WebRTC viewer for a single
 * room. Self-contained: mints a SUBSCRIBE-only token and opens the LiveKit
 * connection itself, so it can be dropped inline in a tab or inside a modal.
 *
 * Flow:
 *   1. Mint a subscribe token: POST /apps/:app/tokens { room, canSubscribe:true,
 *      canPublish:false } (via the existing `api.tokens` client).
 *   2. Connect to LiveKit with the returned { token, wsUrl }, publishing nothing.
 *   3. Render the video grid + <RoomAudioRenderer>, the mute/fullscreen controls
 *      and connection state, plus the optional chat/reactions/viewers addons.
 *
 * States: conectando / EN VIVO / sala vacía / error (with retry).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
} from '@livekit/components-react'
import { api, ApiRequestError } from '@/api'
import { Button, Spinner } from '@/ui'
import { PluginSlot } from '@/plugins'
import { VideoStage } from './VideoStage'
import { AudioStage } from './AudioStage'
import { PlayerControls } from './PlayerControls'
import { PlayerAddons, type PlayerAddonFeatures } from './PlayerAddons'

export interface LivePlayerProps {
  /** App (tenant) name. */
  app: string
  /** Room name to subscribe to. */
  room: string
  /**
   * Token source:
   *  - 'auth'   (default) mint a subscribe token via POST /apps/:app/tokens
   *             (requires a logged-in bearer). Used by the management surfaces.
   *  - 'public' fetch the PUBLIC play-token GET /apps/:app/play-token/:room
   *             (no auth). Used by the public /play and /embed player pages.
   */
  access?: 'auth' | 'public'
  /** Which addons to overlay. Omit to show a bare player. */
  addons?: PlayerAddonFeatures
  /** Display name used by the chat/reactions addons. */
  identity?: string
  /** Show the built-in mute/fullscreen/connection controls. Default true. */
  controls?: boolean
  /**
   * Audio-only mode: renders a compact audio bar (no video grid / fullscreen)
   * for voice channels & radio listeners. Still subscribes to the room audio.
   */
  audioOnly?: boolean
  /** Label shown on the audio bar in audioOnly mode. */
  audioLabel?: string
  /** Extra classes for the outer player frame. */
  className?: string
  /** Fired when the LiveKit connection is established. */
  onConnected?: () => void
  /** Fired on connection / data-channel errors. */
  onError?: (err: Error) => void
}

function Frame({
  className = '',
  audioOnly = false,
  children,
}: {
  className?: string
  audioOnly?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={`relative w-full overflow-hidden rounded-xl bg-black/40 ring-1 ring-white/10 ${
        audioOnly ? 'min-h-[88px]' : 'aspect-video'
      } ${className}`}
    >
      {children}
    </div>
  )
}

export function LivePlayer({
  app,
  room,
  access = 'auth',
  addons,
  identity,
  controls = true,
  audioOnly = false,
  audioLabel,
  className = '',
  onConnected,
  onError,
}: LivePlayerProps) {
  const { t } = useTranslation(['playerComponents', 'common'])
  const [connError, setConnError] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)

  const {
    data: minted,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['live-player-token', access, app, room],
    enabled: Boolean(app && room),
    staleTime: 5 * 60_000,
    retry: (count, err) =>
      !(err instanceof ApiRequestError && err.status === 401) && count < 2,
    queryFn: () =>
      access === 'public'
        ? api.playToken(app, room)
        : api.tokens.mint(app, { room, canSubscribe: true, canPublish: false }),
  })

  // --- fullscreen -----------------------------------------------------------
  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement === frameRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = frameRef.current
    if (!el) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void el.requestFullscreen().catch(() => {})
    }
  }, [])

  const handleError = useCallback(
    (e: Error) => {
      setConnError(e.message)
      onError?.(e)
    },
    [onError],
  )

  // --- loading / error (pre-connection) -------------------------------------
  if (isLoading) {
    return (
      <Frame className={className} audioOnly={audioOnly}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-300">
          <Spinner size={32} />
          <span className="text-sm">{t('playerComponents:live.generatingAccess')}</span>
        </div>
      </Frame>
    )
  }

  if (isError || !minted?.token || !minted?.wsUrl) {
    const message =
      error instanceof ApiRequestError
        ? error.message
        : !minted?.token || !minted?.wsUrl
          ? t('playerComponents:live.invalidToken')
          : t('playerComponents:live.accessError')
    return (
      <Frame className={className} audioOnly={audioOnly}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm font-medium text-white">{t('playerComponents:live.openError')}</p>
          <p className="text-xs text-amber-300">{message}</p>
          <Button variant="solid" size="sm" onClick={() => refetch()}>
            {isFetching ? t('playerComponents:live.retrying') : t('common:actions.retry')}
          </Button>
        </div>
      </Frame>
    )
  }

  // --- connected ------------------------------------------------------------
  return (
    <LiveKitRoom
      serverUrl={minted.wsUrl}
      token={minted.token}
      connect
      audio={false}
      video={false}
      onError={handleError}
      onConnected={() => {
        setConnError(null)
        onConnected?.()
      }}
    >
      <div ref={frameRef}>
        <Frame className={className} audioOnly={audioOnly}>
          {audioOnly ? <AudioStage label={audioLabel} /> : <VideoStage />}

          {/* Player-overlay plugins (e.g. Timestamp CCTV) — auto-mounted for any
              installed + active overlay plugin. No-op when none match. Skipped in
              audio-only mode (nothing to overlay). In a public context
              (access="public", the /play + /embed pages) the slot reads the
              no-auth overlay endpoint so overlays render for anonymous viewers. */}
          {!audioOnly && (
            <PluginSlot
              placement="player-overlay"
              ctx={{ app, room }}
              public={access === 'public'}
            />
          )}

          {/* Subscribed audio playback (invisible) + autoplay unlock. */}
          <RoomAudioRenderer muted={muted} />

          {addons && (
            <PlayerAddons
              features={audioOnly ? { ...addons, chat: false } : addons}
              identity={identity}
              onError={onError}
              viewersAnchor="top-left"
            />
          )}

          {controls && !audioOnly && (
            <PlayerControls
              muted={muted}
              onToggleMute={() => setMuted((m) => !m)}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
              className="absolute right-3 top-3 z-30"
            />
          )}
          {controls && audioOnly && (
            <button
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? t('playerComponents:controls.unmute') : t('playerComponents:controls.mute')}
              className="absolute right-3 top-3 z-30 flex h-10 w-10 items-center justify-center rounded-lg bg-black/60 text-white/90 ring-1 ring-white/15 backdrop-blur transition hover:bg-black/70 hover:text-white hover:ring-primary-400/50"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d={
                    muted
                      ? 'M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6'
                      : 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13'
                  }
                />
              </svg>
            </button>
          )}

          <div
            className={`absolute z-30 ${audioOnly ? 'bottom-3 right-3' : 'bottom-3 left-3'}`}
          >
            <StartAudio
              label={t('playerComponents:controls.unmute')}
              className="rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg transition hover:bg-primary-600"
            />
          </div>

          {connError && (
            <div className="absolute inset-x-0 top-0 z-40 bg-amber-500/20 px-3 py-1.5 text-center text-xs text-amber-200">
              {t('playerComponents:live.connectionProblem', { error: connError })}
            </div>
          )}
        </Frame>
      </div>
    </LiveKitRoom>
  )
}
