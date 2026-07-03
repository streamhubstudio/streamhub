/**
 * Built-in plugin: Radio.
 *
 * Turns the standalone WebRTC radio (máster + listeners + listen-token, spec §6)
 * into an INSTALLABLE app section. When installed + enabled the frontend mounts
 * the radio console as an `app-tab` INSIDE the app (see streamhub-web
 * src/plugins/radio) — no more loose header button.
 *
 * No worker: the máster publishes mic audio straight over WebRTC (LiveKit
 * fan-out) and listeners subscribe; the only server touch is minting the
 * publish / subscribe-only listen tokens, which the existing /apps/:app/tokens
 * + radio listen-token endpoints already cover. This manifest therefore only
 * declares config; all behaviour is client-side.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'radio',
  name: 'Radio',
  description:
    'Audio-only WebRTC radio inside the app: go on air from the mic, watch the ' +
    'live listener count and hand out subscribe-only listen tokens.',
  category: 'panel',
  ui: 'app-tab',
  version: '1.0.0',
  icon: 'radio',
  configSchema: [
    {
      key: 'room',
      type: 'string',
      label: 'Room name',
      default: 'radio',
      placeholder: 'radio',
      help: 'LiveKit room the máster publishes to and listeners subscribe from.',
    },
    {
      key: 'listenTokenTtlSeconds',
      type: 'number',
      label: 'Listen token TTL (seconds)',
      default: 3600,
      min: 60,
      max: 86400,
      help: 'Lifetime of generated subscribe-only listener tokens.',
    },
    {
      key: 'autoStartMonitor',
      type: 'boolean',
      label: 'Auto-start listener monitor',
      default: true,
    },
  ],
});
