/**
 * Built-in plugin: Live Control Overlay (viewer cover).
 *
 * The VIEWER side of live-control (owner item 31): a `player-overlay` that, on
 * the /play + /embed players (incl. anonymous), polls the app's PUBLIC
 * live-control state for the current stream and, while it is paused/finished,
 * draws the configured cover (image / looping video / text card) over the video
 * and mutes it client-side. It renders nothing while the stream is live.
 *
 * It carries NO state of its own — everything comes from the `live-control`
 * console's in-core service via GET /apps/:app/plugins/live-control/public. Ship
 * BOTH plugins for the full experience (see internal design notes).
 *
 * Auto-discovered: the file's mere existence registers the plugin. Its config
 * only tweaks how the cover renders; the state comes from the backend.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'live-control-overlay',
  name: 'Live Control Overlay',
  description:
    'Shows the Live Control cover (image, looping video or text card) to viewers ' +
    'while a stream is paused or finished. Pairs with the Live Control console.',
  category: 'tool',
  ui: 'player-overlay',
  version: '1.0.0',
  icon: 'pause',
  configSchema: [
    {
      key: 'fit',
      type: 'select',
      label: 'Image/video fit',
      default: 'cover',
      options: [
        { value: 'cover', label: 'Cover (fill, may crop)' },
        { value: 'contain', label: 'Contain (letterbox)' },
      ],
    },
    {
      key: 'showFinishedBadge',
      type: 'boolean',
      label: 'Show a "finished" badge on the final card',
      default: true,
    },
  ],
});
