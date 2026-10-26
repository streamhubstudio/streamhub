/**
 * Built-in plugin: Vidstack player provider.
 *
 * THE reference example for a `player`-slot plugin — a plugin that PROVIDES the
 * media player. It is a pure `tool` (no worker): the core only stores the typed
 * config; the frontend plugin (streamhub-web/src/plugins/vidstack) reads that
 * config and renders a Vidstack <MediaPlayer> for HLS live + VOD/MP4 in place of
 * the built-in video.js player.
 *
 * When this plugin is installed + ENABLED for an app, the app's HLS and VOD
 * players resolve it (via the plugin catalog — authenticated list or the public
 * no-auth endpoint for anonymous /play + /embed) and render Vidstack instead of
 * video.js. When it is absent or disabled the players fall back to video.js.
 * Sub-second WebRTC live keeps using LiveKit — this only swaps the HLS + VOD
 * player. See https://streamhub.studio/docs/features/players.
 *
 * Auto-discovered — the mere existence of this file under src/plugins/<id>/
 * registers the plugin in the marketplace catalog (see PluginRegistryService).
 * No central registry file is edited.
 *
 * The `configSchema` here is the SERVER-SIDE source of truth for the settings
 * the tenant persists per app; the web plugin mirrors the same keys/defaults so
 * the player renders with the chosen theme even before the backend responds.
 * Both fields are render-safe (no secrets), so they survive the public config
 * sanitizer and reach anonymous viewers.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'vidstack',
  name: 'Vidstack Player',
  description:
    'Swap the built-in video.js HLS + VOD player for an advanced, skinned ' +
    'Vidstack player (hls.js). Sub-second WebRTC live is unaffected.',
  category: 'tool',
  ui: 'player',
  version: '1.0.0',
  icon: 'play',
  configSchema: [
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
      help: 'Muted autoplay to satisfy browser policies; viewers can unmute.',
    },
  ],
});
