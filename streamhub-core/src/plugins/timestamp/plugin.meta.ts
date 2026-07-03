/**
 * Built-in plugin: Timestamp CCTV overlay.
 *
 * THE reference example for a PLAYER-OVERLAY plugin. It is a pure `tool`
 * (no worker): the core only stores the typed config; the frontend overlay
 * (streamhub-web/src/plugins/timestamp) reads that config and draws a live
 * CCTV-style date/time stamp on top of the player, client-side.
 *
 * Auto-discovered — the mere existence of this file under src/plugins/<id>/
 * registers the plugin in the marketplace catalog (see PluginRegistryService).
 * No central registry file is edited, so plugin authors never collide.
 *
 * The `configSchema` here is the SERVER-SIDE source of truth for the settings
 * the tenant persists per app; the web plugin mirrors the same keys/defaults so
 * the overlay renders even before the backend responds.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'timestamp',
  name: 'Timestamp CCTV',
  description:
    'Overlay a live CCTV-style date/time stamp (with the camera name) on the ' +
    'player. Configure format, corner, colour and whether to show the name.',
  category: 'tool',
  ui: 'player-overlay',
  version: '1.0.0',
  icon: 'clock',
  configSchema: [
    {
      key: 'format',
      type: 'select',
      label: 'Time format',
      default: 'datetime-24h',
      options: [
        { value: 'datetime-24h', label: 'YYYY-MM-DD HH:mm:ss' },
        { value: 'datetime-12h', label: 'YYYY-MM-DD hh:mm:ss AM/PM' },
        { value: 'time-24h', label: 'HH:mm:ss' },
        { value: 'time-12h', label: 'hh:mm:ss AM/PM' },
        { value: 'date-us', label: 'MM/DD/YYYY HH:mm:ss' },
      ],
    },
    {
      key: 'position',
      type: 'select',
      label: 'Position',
      default: 'bottom-right',
      options: [
        { value: 'top-left', label: 'Top left' },
        { value: 'top-right', label: 'Top right' },
        { value: 'bottom-left', label: 'Bottom left' },
        { value: 'bottom-right', label: 'Bottom right' },
      ],
    },
    {
      key: 'color',
      type: 'string',
      label: 'Text colour',
      default: '#00e5ff',
      placeholder: '#RRGGBB',
      help: 'Hex colour for the overlay text (e.g. #ffffff, #00e5ff).',
    },
    {
      key: 'showName',
      type: 'boolean',
      label: 'Show camera / stream name',
      default: true,
    },
  ],
});
