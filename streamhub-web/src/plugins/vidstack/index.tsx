/**
 * Vidstack — the reference PLAYER-PROVIDER plugin (`ui: 'player'`).
 *
 * PATTERN (how a player-provider plugin is written):
 *   1. `definePlugin({ ui: 'player', configSchema, PlayerComponent })` as the
 *      default export → auto-discovered by the glob in discovery.ts. No central
 *      file is edited.
 *   2. Ship a `PlayerComponent` that takes the STABLE media contract
 *      ({ src, type: 'hls' | 'mp4', autoplay?, poster?, live? }) — that is the
 *      whole interface the HLS/VOD resolver relies on, so providers are a swap.
 *   3. Keep the config keys/defaults in lock-step with the backend meta
 *      (streamhub-core/src/plugins/vidstack/plugin.meta.ts).
 *
 * When this plugin is installed + ENABLED for an app, `usePlayerProvider` picks
 * it up and HlsPlayer/VodPlayer render <VidstackPlayer> instead of video.js
 * (anonymous /play + /embed resolve it via the public endpoint). Otherwise the
 * players fall back to video.js. Sub-second WebRTC live keeps using LiveKit.
 */
import { definePlugin } from '../types.ts'
import { VidstackPlayer } from './VidstackPlayer.tsx'

export default definePlugin({
  id: 'vidstack',
  name: 'Vidstack Player',
  description:
    'Swap the built-in video.js HLS + VOD player for an advanced, skinned ' +
    'Vidstack player (hls.js). Sub-second WebRTC live is unaffected.',
  category: 'tool',
  ui: 'player',
  version: '1.0.0',
  icon: 'M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.8-6.86a1.04 1.04 0 000-1.76L9.56 4.26A1.04 1.04 0 008 5.14z',
  configSchema: {
    fields: [
      {
        key: 'theme',
        type: 'select',
        label: 'Player theme',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Match dashboard (auto)' },
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ],
      },
      {
        key: 'autoplay',
        type: 'boolean',
        label: 'Autoplay on load',
        default: true,
      },
    ],
  },
  PlayerComponent: VidstackPlayer,
})
