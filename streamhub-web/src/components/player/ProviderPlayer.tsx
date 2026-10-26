/**
 * <ProviderPlayer> — mounts a `player`-slot plugin's media player in place of
 * the built-in video.js player.
 *
 * HlsPlayer and VodPlayer resolve the app's active player provider (via
 * `usePlayerProvider`) and, when one exists, delegate to this wrapper instead of
 * their video.js path. It:
 *   1. renders the provider's `PlayerComponent` with the STABLE media contract
 *      ({ src, type, live, autoplay, poster }) + the plugin's merged config, and
 *   2. keeps parity with the video.js players by mounting the app's active
 *      `player-overlay` plugins (e.g. Timestamp CCTV) on top — the same
 *      relatively-positioned frame, so overlays position identically whichever
 *      player renders underneath.
 *
 * The provider is a swap of the HLS + VOD/MP4 player ONLY; sub-second WebRTC
 * live still uses <LivePlayer>/LiveKit.
 */
import { PluginSlot } from '@/plugins'
import type { PlayerSource, PluginView } from '@/plugins'

export interface ProviderPlayerProps extends PlayerSource {
  /** The resolved provider view (must carry `registered.PlayerComponent`). */
  provider: PluginView
  /** App slug — mounts this app's `player-overlay` plugins on top. */
  app?: string
  /** Room name for overlay context (optional; paired with `app`). */
  room?: string
  /** 'public' reads the no-auth overlay endpoint (anonymous /play + /embed). */
  access?: 'auth' | 'public'
  /** Extra classes on the wrapper. */
  className?: string
}

export function ProviderPlayer({
  provider,
  src,
  type,
  live,
  autoplay,
  poster,
  app,
  room,
  access = 'auth',
  className = '',
}: ProviderPlayerProps) {
  const Player = provider.registered?.PlayerComponent
  // Defensive: the resolver only returns providers with a PlayerComponent, but
  // never crash the surface if that invariant is ever violated.
  if (!Player) return null

  return (
    <div
      data-testid="provider-player"
      data-provider={provider.id}
      className={`relative overflow-hidden rounded-xl bg-black ring-1 ring-white/10 ${className}`}
    >
      <Player
        src={src}
        type={type}
        live={live}
        autoplay={autoplay}
        poster={poster}
        config={provider.config}
        pluginId={provider.id}
      />

      {/* Player-overlay plugins (e.g. Timestamp CCTV) — same parity as the
          video.js players. No-op when none match or no app is provided. */}
      {app && (
        <PluginSlot
          placement="player-overlay"
          ctx={{ app, room }}
          public={access === 'public'}
        />
      )}
    </div>
  )
}
