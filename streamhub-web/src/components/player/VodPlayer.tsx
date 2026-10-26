/**
 * <VodPlayer> — VOD playback for a presigned MP4 (S3) using video.js.
 *
 * Used by the Grabaciones / VODs tab. video.js is initialised once against a
 * mounted <video> element and disposed on unmount; when `src` changes the
 * existing player is re-pointed instead of being recreated.
 *
 * NOTE: video.js LIVE/WebRTC is intentionally NOT used here — live playback is
 * WebRTC via <LivePlayer>. This component is for recorded MP4 files only.
 */
import { useEffect, useRef } from 'react'
import videojs from 'video.js'
import type Player from 'video.js/dist/types/player'
import 'video.js/dist/video-js.css'
import { applyInlinePlayback } from '@/lib/browserCompat'
import { usePlayerProvider } from '@/plugins'
import { ProviderPlayer } from './ProviderPlayer'

export interface VodPlayerProps {
  /** Presigned MP4 URL. */
  src: string
  /** Optional poster image URL. */
  poster?: string
  /** MIME type of the source. Default 'video/mp4'. */
  type?: string
  /** Autoplay on mount. Default true. */
  autoplay?: boolean
  /** Extra classes on the wrapper. */
  className?: string
  /**
   * App slug — OPTIONAL, additive. When set, an active `player`-slot plugin
   * (Vidstack, …) provides the player and this app's `player-overlay` plugins
   * mount on top. Omit (older call sites) → always the built-in video.js player.
   */
  app?: string
  /** Room name for overlay context (optional; paired with `app`). */
  room?: string
  /** 'public' resolves the provider via the no-auth endpoint (anonymous VOD). */
  access?: 'auth' | 'public'
}

/**
 * VOD player — resolves the app's active player PROVIDER first (when an `app` is
 * given). A `player`-slot plugin renders this MP4; otherwise it falls back to
 * the built-in video.js player below. Props are a superset of the old ones, so
 * existing call sites (which pass no `app`) keep the video.js player unchanged.
 */
export function VodPlayer(props: VodPlayerProps) {
  const provider = usePlayerProvider(props.app ?? '', {
    public: props.access === 'public',
  })
  if (provider) {
    return (
      <ProviderPlayer
        provider={provider}
        src={props.src}
        type="mp4"
        live={false}
        autoplay={props.autoplay ?? true}
        poster={props.poster}
        app={props.app}
        room={props.room}
        access={props.access}
        className={props.className}
      />
    )
  }
  return <VideoJsVodPlayer {...props} />
}

/** The built-in video.js MP4 player (the fallback when no provider). */
function VideoJsVodPlayer({
  src,
  poster,
  type = 'video/mp4',
  autoplay = true,
  className = '',
}: VodPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<Player | null>(null)

  // Initialise the player once.
  useEffect(() => {
    if (playerRef.current || !containerRef.current) return

    // video.js requires the <video> element to be in the DOM at init time.
    const videoEl = document.createElement('video-js')
    videoEl.classList.add('vjs-big-play-centered', 'vjs-theme-streamhub')
    containerRef.current.appendChild(videoEl)

    playerRef.current = videojs(videoEl, {
      controls: true,
      autoplay,
      preload: 'auto',
      fluid: true,
      playsinline: true, // iOS: play inline instead of forcing native fullscreen
      playbackRates: [0.5, 1, 1.5, 2],
      poster,
      sources: [{ src, type }],
    })
    // Legacy WebViews: also set the old webkit-playsinline attribute.
    // Safari blocks unmuted autoplay — video.js then just shows the big play
    // button (the built-in tap-to-play), so no extra fallback is needed here.
    applyInlinePlayback(videoEl)

    return () => {
      const player = playerRef.current
      if (player && !player.isDisposed()) {
        player.dispose()
      }
      playerRef.current = null
    }
    // Init-only: src/poster changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-point the existing player when the source or poster changes.
  useEffect(() => {
    const player = playerRef.current
    if (!player || player.isDisposed()) return
    player.src({ src, type })
    player.poster(poster ?? '')
  }, [src, poster, type])

  return (
    <div className={`overflow-hidden rounded-xl bg-black ring-1 ring-white/10 ${className}`}>
      <div data-vjs-player>
        <div ref={containerRef} />
      </div>
    </div>
  )
}
