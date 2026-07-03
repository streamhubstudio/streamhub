/**
 * StreamHub player components (Wave 3).
 *
 * Public surface consumed by pages/tabs:
 *   - <LivePlayer>    low-latency WebRTC viewer (subscribe-only), embeddable.
 *   - <VodPlayer>     video.js MP4 playback for recordings.
 *   - <PlayerAddons>  chat / reactions / viewers overlay (inside a LiveKitRoom).
 *
 * Lower-level pieces are exported too so hosts can compose custom layouts.
 */
export { LivePlayer } from './LivePlayer'
export type { LivePlayerProps } from './LivePlayer'

export { VodPlayer } from './VodPlayer'
export type { VodPlayerProps } from './VodPlayer'

export { HlsPlayer } from './HlsPlayer'
export type { HlsPlayerProps } from './HlsPlayer'

export { MjpegPlayer } from './MjpegPlayer'
export type { MjpegPlayerProps } from './MjpegPlayer'

export { PlayerAddons } from './PlayerAddons'
export type { PlayerAddonsProps, PlayerAddonFeatures } from './PlayerAddons'

export { PlayerControls } from './PlayerControls'
export { VideoStage } from './VideoStage'
export { AudioStage } from './AudioStage'
export { ConnectionPill } from './ConnectionPill'
export { ViewerBadge } from './ViewerBadge'
export { ChatPanel } from './ChatPanel'
export { ReactionsOverlay } from './ReactionsOverlay'

export { useAddonChannels } from './useAddonChannels'
export type {
  AddonChannels,
  FloatingReaction,
  UseAddonChannelsOptions,
} from './useAddonChannels'

export {
  CHAT_TOPIC,
  REACTION_TOPIC,
  EMOJIS,
  encode,
  decode,
  randomId,
} from './dataChannel'
export type { ChatMessage, ReactionMessage } from './dataChannel'
