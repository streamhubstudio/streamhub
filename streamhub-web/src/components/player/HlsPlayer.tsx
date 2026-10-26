/**
 * <HlsPlayer> — live HLS playback for a `.m3u8` playlist using video.js.
 *
 * This is the SEPARATE livestreaming player (≈6-15s latency, AntMedia-style,
 * embeddable) described in https://streamhub.studio/docs/history/WAVE3 §1b. It is NOT the WebRTC <LivePlayer>
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
import { PluginSlot, usePlayerProvider } from '@/plugins'
import { applyInlinePlayback, isAutoplayBlockedError } from '@/lib/browserCompat'
import { ProviderPlayer } from './ProviderPlayer'

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
  /**
   * Which player renders when an app player PROVIDER (Vidstack) is installed:
   *  - 'auto'     (default) the provider when active, else video.js — the
   *               historical behavior every existing call site relies on;
   *  - 'provider' force the provider (still falls back to video.js when none is
   *               active, so it never blanks out);
   *  - 'builtin'  force the built-in video.js player even if a provider is active.
   * Powers the Live view's Vidstack | video.js dual-player selector.
   */
  forcePlayer?: 'auto' | 'provider' | 'builtin'
}

/**
 * `blocked` = the browser refused autoplay (Safari Low Power Mode, per-site
 * autoplay settings): the stream is fine, we just need a user gesture — show a
 * tap-to-play overlay instead of retrying or erroring.
 */
type Status = 'loading' | 'offline' | 'playing' | 'error' | 'blocked'

const HLS_TYPE = 'application/x-mpegURL'
const MAX_ATTEMPTS = 20

/**
 * Live HLS player — resolves the app's active player PROVIDER first. When a
 * `player`-slot plugin (Vidstack, …) is installed + enabled it renders that
 * provider's player for this `.m3u8`; otherwise it falls back to the built-in
 * video.js player below. The external props are unchanged, so every call site
 * (StreamsTab, embeds) keeps working whichever player renders.
 */
export function HlsPlayer(props: HlsPlayerProps) {
  const provider = usePlayerProvider(props.app ?? '', {
    public: props.access === 'public',
  })
  // 'builtin' forces video.js even when a provider is active (the selector's
  // video.js choice); 'auto'/'provider' use the provider whenever one is active.
  const forced = props.forcePlayer ?? 'auto'
  if (provider && forced !== 'builtin') {
    return (
      <ProviderPlayer
        provider={provider}
        src={props.src}
        type="hls"
        live
        autoplay={props.autoplay ?? true}
        poster={props.poster}
        app={props.app}
        room={props.room}
        access={props.access}
        className={props.className}
      />
    )
  }
  return <VideoJsHlsPlayer {...props} />
}

/** The built-in video.js live-HLS player (the fallback when no provider). */
function VideoJsHlsPlayer({
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
  const statusRef = useRef<Status>(status)

  // Always read the freshest src/status from the (stable, init-once) callbacks.
  srcRef.current = src
  statusRef.current = status

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
    if (p && typeof p.catch === 'function')
      p.catch((err: unknown) => {
        // Autoplay refused (Safari Low Power Mode / autoplay settings): the
        // stream is healthy — ask for a tap instead of spinning or erroring.
        if (isAutoplayBlockedError(err)) {
          clearRetry()
          setStatus('blocked')
        }
      })
  }, [clearRetry])

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

  // Tap-to-play: the user gesture that satisfies the autoplay policy.
  const tapToPlay = useCallback(() => {
    const player = playerRef.current
    if (!player || player.isDisposed()) return
    const p = player.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  }, [])

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
      playsinline: true, // iOS: never hijack into fullscreen (WEBRTC-BROWSER-COMPAT)
      html5: { vhs: { overrideNative: true } },
    })
    playerRef.current = player
    // Belt-and-braces for embedded WebViews: legacy webkit-playsinline too.
    applyInlinePlayback(videoEl)

    const onPlaying = () => {
      attempts.current = 0
      clearRetry()
      setStatus('playing')
    }
    // `loadeddata` fires even when autoplay was refused — it must not clear a
    // `blocked` state (the tap-to-play overlay). Real `playing` always wins.
    player.on('loadeddata', () => {
      if (statusRef.current !== 'blocked') onPlaying()
    })
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
          ) : status === 'blocked' ? (
            /* Autoplay refused — one tap satisfies the browser's gesture rule. */
            <button
              type="button"
              onClick={tapToPlay}
              className="pointer-events-auto flex flex-col items-center gap-3 text-white"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-500 shadow-lg transition hover:bg-primary-600">
                <svg className="ml-1 h-7 w-7" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.8-6.86a1.04 1.04 0 000-1.76L9.56 4.26A1.04 1.04 0 008 5.14z" />
                </svg>
              </span>
              <span className="text-sm font-medium">
                {t('playerComponents:controls.tapToPlay')}
              </span>
            </button>
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
