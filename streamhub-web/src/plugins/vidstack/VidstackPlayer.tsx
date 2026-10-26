/**
 * <VidstackPlayer> — the media player rendered by the `vidstack` player-provider
 * plugin. This is the component the `player`-slot resolver mounts in place of the
 * built-in video.js player for HLS live + VOD/MP4 (WebRTC live is unaffected).
 *
 * It renders a Vidstack <MediaPlayer> with the default video layout (a clean,
 * accessible, keyboard-friendly skin) and:
 *   - plays HLS (`.m3u8`) via a LOCALLY bundled hls.js (no CDN fetch — wired
 *     through `onProviderChange` + `isHLSProvider`) and progressive MP4 natively;
 *   - honours `live` (live-edge stream UI) vs VOD (`on-demand`);
 *   - autoplays MUTED to satisfy browser policy, exactly like HlsPlayer; when the
 *     browser still blocks it (Safari Low Power Mode) Vidstack's own big-play
 *     button IS the tap-to-play affordance — parity without extra code;
 *   - sets `playsInline` so iOS never hijacks into native fullscreen;
 *   - themes the accent to the dashboard brand token (`--color-primary-500`) and
 *     respects `prefers-reduced-motion` (Vidstack's default styles gate their
 *     animations on it).
 *
 * The component receives the STABLE PlayerComponentProps contract
 * ({ src, type, autoplay, poster, live } + the plugin's merged `config`).
 */
import { useCallback, type CSSProperties } from 'react'
import {
  MediaPlayer,
  MediaProvider,
  Poster,
  isHLSProvider,
  type MediaProviderAdapter,
} from '@vidstack/react'
import {
  DefaultVideoLayout,
  defaultLayoutIcons,
} from '@vidstack/react/player/layouts/default'
import Hls from 'hls.js'
import '@vidstack/react/player/styles/default/theme.css'
import '@vidstack/react/player/styles/default/layouts/video.css'
import type { PlayerComponentProps } from '@/plugins'

const HLS_MIME = 'application/x-mpegurl'
const MP4_MIME = 'video/mp4'

/** Brand accent → dashboard primary token (falls back to the brand blue hex). */
const BRAND_STYLE: CSSProperties & Record<`--${string}`, string> = {
  '--media-brand': 'var(--color-primary-500, #2f7bff)',
}

export function VidstackPlayer({
  src,
  type,
  autoplay = true,
  poster,
  live = false,
  config,
  className = '',
}: PlayerComponentProps) {
  // Config can force autoplay off; otherwise follow the caller's intent.
  const shouldAutoplay = autoplay && config?.autoplay !== false
  const theme = typeof config?.theme === 'string' ? config.theme : 'auto'

  // Use the locally bundled hls.js instead of Vidstack's default CDN import, so
  // playback is self-contained (no external host) and deterministic under test.
  const onProviderChange = useCallback((provider: MediaProviderAdapter | null) => {
    if (isHLSProvider(provider)) {
      provider.library = Hls
    }
  }, [])

  return (
    <MediaPlayer
      className={`vds-streamhub aspect-video w-full overflow-hidden bg-black ${className}`}
      src={{ src, type: type === 'hls' ? HLS_MIME : MP4_MIME }}
      poster={poster}
      streamType={live ? 'live' : 'on-demand'}
      autoPlay={shouldAutoplay}
      muted={shouldAutoplay}
      playsInline
      load="eager"
      aria-label="StreamHub player"
      data-theme={theme}
      style={BRAND_STYLE}
      onProviderChange={onProviderChange}
    >
      <MediaProvider>
        {poster && <Poster className="vds-poster absolute inset-0 h-full w-full" src={poster} alt="" />}
      </MediaProvider>
      <DefaultVideoLayout icons={defaultLayoutIcons} />
    </MediaPlayer>
  )
}

export default VidstackPlayer
