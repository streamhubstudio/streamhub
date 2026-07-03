/**
 * Cockpit plugin — CCTV surveillance board (frontend surface).
 *
 * Auto-discovered by the registry glob (`src/plugins/*​/index.{ts,tsx}`); drops
 * in with ZERO central edits. Declares `ui: 'panel'` so the plugin-host mounts
 * <CockpitPanel> wherever a `<PluginSlot placement="panel">` lives (the
 * Marketplace's "Active panels" area today). The config schema mirrors the core
 * plugin.meta.ts so the generic Marketplace config form seeds sensible defaults.
 */
import { definePlugin } from '@/plugins'
import { CockpitPanel } from './CockpitPanel.tsx'

export default definePlugin({
  id: 'cockpit',
  name: 'Cockpit',
  description:
    'CCTV-style surveillance board: a paginated, drag-and-drop grid of every live stream in the app.',
  category: 'panel',
  ui: 'panel',
  version: '1.0.0',
  // Grid glyph (drawn with stroke=currentColor by the marketplace icon).
  icon: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z',
  configSchema: {
    fields: [
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
      { key: 'autoPlay', type: 'boolean', label: 'Auto-play cameras', default: true },
      { key: 'showLabels', type: 'boolean', label: 'Show stream labels', default: true },
      {
        key: 'refreshSeconds',
        type: 'number',
        label: 'Auto-refresh (seconds)',
        default: 10,
        min: 3,
        max: 300,
      },
    ],
  },
  PanelComponent: CockpitPanel,
})
