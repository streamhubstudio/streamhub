/**
 * Built-in plugin: Cockpit (CCTV surveillance board).
 *
 * A no-worker PANEL. The whole feature is client-side: the frontend fetches the
 * app's active streams and renders their public embed players in a paginated,
 * drag-reorderable grid (see streamhub-web/src/plugins/cockpit). This meta only
 * declares the plugin + its default config so the marketplace can list, install
 * and configure it. Auto-discovered — no central registry edit.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'cockpit',
  name: 'Cockpit',
  description:
    'CCTV-style surveillance board: a paginated, drag-and-drop grid of every live stream in the app.',
  category: 'panel',
  ui: 'panel',
  version: '1.0.0',
  icon: 'grid',
  configSchema: [
    {
      key: 'gridSize',
      type: 'select',
      label: 'Grid size',
      default: '4x3',
      options: [
        { value: '1x1', label: '1 × 1' },
        { value: '2x2', label: '2 × 2 (4)' },
        { value: '3x3', label: '3 × 3 (9)' },
        { value: '4x3', label: '4 × 3 (12)' },
      ],
    },
    {
      key: 'autoPlay',
      type: 'boolean',
      label: 'Auto-play cameras',
      default: true,
    },
    {
      key: 'showLabels',
      type: 'boolean',
      label: 'Show stream labels',
      default: true,
    },
    {
      key: 'refreshSeconds',
      type: 'number',
      label: 'Auto-refresh (seconds)',
      default: 10,
      min: 3,
      max: 300,
    },
  ],
});
