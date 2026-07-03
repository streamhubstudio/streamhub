/**
 * <HlsPlayer> — live HLS playback for a `.m3u8` playlist using video.js.
 *
 * This is the SEPARATE livestreaming player (≈6-15s latency, AntMedia-style,
 * embeddable) described in streamhub-docs/history/WAVE3.md §1b. It is NOT the WebRTC <LivePlayer>
 * (sub-second, used for "Ver" en vivo) nor the <VodPlayer> (recorded MP4).
 *
 * video.js v8 ships @videojs/http-streaming (VHS), so an HLS source plays with
 * no extra dependency: we just hand it `{ src, type: 'application/x-mpegURL' }`.
 *
 * Live quirk: right after the HLS egress starts the playlist 404s for a few
 * seconds until the first segments land. We treat that as a soft "offline"
 * state and auto-retry (load the source again on a timer) instead of failing.
 * After MAX_ATTEMPTS we surface a hard "error" with a manual "Reintentar".
 *
 * States: loading (initial) · offline (waiting for / lost the live signal,
 * retrying) · playing · error (gave up — manual retry available).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import videojs from 'video.js'
import type Player from 'video.js/dist/types/player'
import 'video.js/dist/video-js.css'
import { Button, Spinner } from '@/ui'
import { PluginSlot } from '@/plugins'

export interface HlsPlayerProps {
  /** Live HLS playlist URL (`.m3u8`). */
  src: string
  /** Optional poster image URL. */
  poster?: string
  /** Autoplay on mount (forces muted to satisfy browser policy). Default true. */
  autoplay?: boolean
  /** Extra classes on the wrapper. */
  className?: string
  /** Delay between auto-retries while the live playlist isn't ready. Default 4000ms. */
  retryDelayMs?: number
  /**
   * App slug — when set, installed + active `player-overlay` plugins (e.g. the
   * Timestamp CCTV overlay) mount on top of this live player. Omit for VOD/other
   * generic uses where no per-app overlay applies.
   */
  app?: string
  /** Room name for overlay context (optional; paired with `app`). */
  room?: string
  /**
   * Overlay data source for the mounted `player-overlay` plugins:
   *  - 'auth'   (default) authenticated marketplace list (management surfaces).
   *  - 'public' the no-auth overlay endpoint, for anonymous embeds (no 401).
   */
  access?: 'auth' | 'public'
}

type Status = 'loading' | 'offline' | 'playing' | 'error'

const HLS_TYPE = 'application/x-mpegURL'
const MAX_ATTEMPTS = 20

export function HlsPlayer({
  src,
  poster,
  autoplay = true,
  className = '',
  retryDelayMs = 4000,
  app,
  room,
  access = 'auth',
}: HlsPlayerProps) {
  const { t } = useTranslation(['playerComponents', 'common'])
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<Player | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const srcRef = useRef(src)
  const attempts = useRef(0)
  const [status, setStatus] = useState<Status>('loading')

  // Always read the freshest src from the (stable) load callback.
  srcRef.current = src

  const clearRetry = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
  }, [])

  // (Re)point the player at the current source and try to play.
  const loadSrc = useCallback(() => {
    const player = playerRef.current
    if (!player || player.isDisposed()) return
    player.src({ src: srcRef.current, type: HLS_TYPE })
    player.load()
    const p = player.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  }, [])

  // Schedule a soft retry (live not ready / dropped). Hard-error after the cap.
  const scheduleRetry = useCallback(() => {
    if (attempts.current >= MAX_ATTEMPTS) {
      setStatus('error')
      return
    }
    attempts.current += 1
    setStatus('offline')
    clearRetry()
    retryTimer.current = setTimeout(loadSrc, retryDelayMs)
  }, [clearRetry, loadSrc, retryDelayMs])

  // Keep a ref so the (init-once) event listeners always call the latest one.
  const scheduleRetryRef = useRef(scheduleRetry)
  scheduleRetryRef.current = scheduleRetry

  // Manual "Reintentar" — reset the attempt budget and reload immediately.
  const retryNow = useCallback(() => {
    attempts.current = 0
    clearRetry()
    setStatus('loading')
    loadSrc()
  }, [clearRetry, loadSrc])

  // Initialise the player once.
  useEffect(() => {
    if (playerRef.current || !containerRef.current) return

    const videoEl = document.createElement('video-js')
    videoEl.classList.add('vjs-big-play-centered', 'vjs-theme-streamhub')
    containerRef.current.appendChild(videoEl)

    const player = videojs(videoEl, {
      controls: true,
      autoplay,
      muted: autoplay, // muted autoplay is required by browsers to start unprompted
      preload: 'auto',
      fluid: true,
      liveui: true, // live edge / DVR UI for HLS
      html5: { vhs: { overrideNative: true } },
    })
    playerRef.current = player

    const onPlaying = () => {
      attempts.current = 0
      clearRetry()
      setStatus('playing')
    }
    player.on('loadeddata', onPlaying)
    player.on('playing', onPlaying)
    player.on('error', () => scheduleRetryRef.current())

    return () => {
      clearRetry()
      if (!player.isDisposed()) player.dispose()
      playerRef.current = null
    }
    // Init-only — src/poster handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // (Re)load whenever the source or poster changes (incl. first mount).
  useEffect(() => {
    const player = playerRef.current
    if (!player || player.isDisposed()) return
    attempts.current = 0
    clearRetry()
    setStatus('loading')
    player.poster(poster ?? '')
    loadSrc()
  }, [src, poster, loadSrc, clearRetry])

  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-black ring-1 ring-white/10 ${className}`}
    >
      <div data-vjs-player>
        <div ref={containerRef} />
      </div>

      {/* Player-overlay plugins (e.g. Timestamp CCTV) — auto-mounted for any
          installed + active overlay plugin of this app. No-op when none match
          or when no app is provided. */}
      {app && (
        <PluginSlot
          placement="player-overlay"
          ctx={{ app, room }}
          public={access === 'public'}
        />
      )}

      {status !== 'playing' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-center">
          {status === 'error' ? (
            <>
              <p className="text-sm font-medium text-red-300">
                {t('playerComponents:hls.loadError')}
              </p>
              <p className="max-w-xs text-xs text-gray-400">
                {t('playerComponents:hls.loadErrorHint')}
              </p>
              <div className="pointer-events-auto">
                <Button type="button" variant="default" size="sm" onClick={retryNow}>
                  {t('common:actions.retry')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Spinner size={28} />
              <p className="text-xs text-gray-300">
                {status === 'offline'
                  ? t('playerComponents:hls.waitingSignal')
                  : t('playerComponents:hls.loading')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
