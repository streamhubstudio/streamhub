/**
 * <MjpegPlayer> — playback of a direct WS-ingest camera (ESP32-CAM, type
 * 'ws-mjpeg') WITHOUT transcoding: a plain <img> over the multipart MJPEG
 * endpoint `/live/<app>/<room>/mjpeg` (ESP32-WS-INGEST.md §4a). Sub-second
 * latency, zero JS decoding, works everywhere an <img> works.
 *
 * Resilience: cameras are flaky by nature — on <img> error the player shows a
 * "camera offline" state and auto-retries with a fresh cache-busted URL every
 * few seconds (plus a manual retry button). Same frame/fullscreen chrome
 * conventions as <LivePlayer>.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui'
import { mjpegUrl, withCacheBuster } from '@/lib/mjpeg'
import { PluginSlot } from '@/plugins'

export interface MjpegPlayerProps {
  /** App (tenant) name. */
  app: string
  /** Room of the camera (short or namespaced — the endpoint namespaces). */
  room: string
  /** Play token for apps with publicPlayback off (rides as ?token=). */
  token?: string | null
  /** Show the fullscreen control. Default true. */
  controls?: boolean
  /** Extra classes for the outer player frame. */
  className?: string
  /** Overlay data source: 'auth' (default) or 'public' (anonymous /play + /embed). */
  access?: 'auth' | 'public'
}

const AUTO_RETRY_MS = 8000

export function MjpegPlayer({
  app,
  room,
  token,
  controls = true,
  className = '',
  access = 'auth',
}: MjpegPlayerProps) {
  const { t } = useTranslation(['playerComponents', 'common'])
  const [epoch, setEpoch] = useState(() => Date.now())
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)

  const src = withCacheBuster(mjpegUrl(app, room, token), epoch)

  const retry = useCallback(() => {
    setFailed(false)
    setLoaded(false)
    setEpoch(Date.now())
  }, [])

  // Flaky-camera auto-reconnect: retry with a fresh stream while failed.
  useEffect(() => {
    if (!failed) return
    const id = setTimeout(retry, AUTO_RETRY_MS)
    return () => clearTimeout(id)
  }, [failed, retry])

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

  return (
    <div ref={frameRef}>
      <div
        className={`relative aspect-video w-full overflow-hidden rounded-xl bg-black/60 ring-1 ring-white/10 ${className}`}
      >
        {!failed && (
          <img
            key={epoch}
            src={src}
            alt={room}
            className="h-full w-full object-contain"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}

        {/* Connecting state until the first frame paints. */}
        {!failed && !loaded && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-300">
            {t('playerComponents:mjpeg.connecting')}
          </div>
        )}

        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm font-medium text-white">
              {t('playerComponents:mjpeg.offline')}
            </p>
            <p className="text-xs text-slate-400">
              {t('playerComponents:mjpeg.offlineHint')}
            </p>
            <Button variant="solid" size="sm" onClick={retry}>
              {t('common:actions.retry')}
            </Button>
          </div>
        )}

        {/* Player-overlay plugins (e.g. Timestamp CCTV) — same host LivePlayer/
            HlsPlayer mount. Overlay children are absolute (z-20), under the
            z-30 LIVE badge/fullscreen chrome. */}
        {app && loaded && !failed && (
          <PluginSlot
            placement="player-overlay"
            ctx={{ app, room }}
            public={access === 'public'}
          />
        )}

        {/* LIVE badge + mode tag (MJPEG has no audio — no mute control). */}
        {loaded && !failed && (
          <div className="absolute left-3 top-3 z-30 flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-[11px] font-semibold text-white ring-1 ring-white/15 backdrop-blur">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
              {t('playerComponents:mjpeg.live')}
            </span>
            <span className="rounded-md bg-black/60 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-slate-300 ring-1 ring-white/15 backdrop-blur">
              mjpeg
            </span>
          </div>
        )}

        {controls && (
          <button
            onClick={toggleFullscreen}
            aria-label={
              isFullscreen
                ? t('playerComponents:controls.exitFullscreen')
                : t('playerComponents:controls.enterFullscreen')
            }
            className="absolute right-3 top-3 z-30 flex h-10 w-10 items-center justify-center rounded-lg bg-black/60 text-white/90 ring-1 ring-white/15 backdrop-blur transition hover:bg-black/70 hover:text-white hover:ring-primary-400/50"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d={
                  isFullscreen
                    ? 'M9 9H4m5 0V4m6 5h5m-5 0V4M9 15H4m5 0v5m6-5h5m-5 0v5'
                    : 'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5'
                }
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
