/**
 * Built-in plugin: Watermark overlay.
 *
 * Reference for a no-worker TOOL rendered as a PLAYER OVERLAY. Pure config; the
 * frontend overlay module (streamhub-web/src/plugins/watermark) reads this same
 * config and draws the text watermark over the player, client-side.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'watermark',
  name: 'Watermark',
  description: 'Overlay a text watermark on the player.',
  category: 'tool',
  ui: 'player-overlay',
  version: '1.0.0',
  icon: 'stamp',
  configSchema: [
    {
      key: 'text',
      type: 'string',
      label: 'Watermark text',
      default: 'StreamHub',
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
      key: 'opacity',
      type: 'number',
      label: 'Opacity',
      default: 0.6,
      min: 0,
      max: 1,
    },
  ],
});
