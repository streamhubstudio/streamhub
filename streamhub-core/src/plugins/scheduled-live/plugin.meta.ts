/**
 * Built-in plugin: Scheduled Live.
 *
 * A pure PLAYER-OVERLAY `tool` (no worker): the core only stores the typed
 * display config; the agenda itself lives in the per-app `scheduled_events`
 * table (module `scheduled-live`, CRUD API). Enabling this plugin activates the
 * countdown cover on the player and exposes the config on the public overlays
 * endpoint so anonymous /play + /embed viewers get the countdown.
 *
 * The frontend overlay (streamhub-web/src/plugins/scheduled-live) reads the
 * public agenda + this config and, client-side, shows a full-cover countdown
 * ("El vivo comienza en …") until each event's absolute start instant, then
 * animates the cover away to reveal the (already-publishing) stream.
 *
 * Auto-discovered — the mere existence of this file under src/plugins/<id>/
 * registers the plugin in the marketplace catalog. No central registry is edited.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'scheduled-live',
  name: 'Scheduled Live',
  description:
    'Schedule live premieres: viewers see a countdown until the start time, then the stream is revealed.',
  category: 'tool',
  ui: 'player-overlay',
  version: '1.0.0',
  icon: 'clock',
  configSchema: [
    {
      key: 'mode',
      type: 'select',
      label: 'Display mode',
      default: 'cover',
      options: [
        { value: 'cover', label: 'Full cover (hide stream until start)' },
        { value: 'badge', label: 'Corner badge only' },
      ],
    },
    {
      key: 'accent',
      type: 'string',
      label: 'Accent colour',
      default: '#2f7bff',
      placeholder: '#RRGGBB',
    },
    {
      key: 'headline',
      type: 'string',
      label: 'Headline',
      default: 'The live stream starts soon',
    },
    {
      key: 'revealAnimation',
      type: 'select',
      label: 'Reveal animation',
      default: 'fade',
      options: [
        { value: 'fade', label: 'Fade' },
        { value: 'zoom', label: 'Zoom' },
        { value: 'none', label: 'None' },
      ],
    },
    {
      key: 'muteUntilStart',
      type: 'boolean',
      label: 'Mute stream until start',
      default: true,
    },
    {
      key: 'showViewerLocalTime',
      type: 'boolean',
      label: "Show viewer's local start time",
      default: true,
    },
    {
      key: 'autoHideAfterStartSec',
      type: 'number',
      label: 'Keep reveal animation (seconds)',
      default: 5,
      min: 0,
      max: 60,
    },
  ],
});
