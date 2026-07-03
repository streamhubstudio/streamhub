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
}

export function VodPlayer({
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
      playbackRates: [0.5, 1, 1.5, 2],
      poster,
      sources: [{ src, type }],
    })

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
