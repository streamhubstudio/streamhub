/**
 * Quality / Stream Health plugin (frontend) — an installable diagnostic PANEL.
 *
 * Auto-discovered by src/plugins/discovery.ts (this file lives at
 * src/plugins/quality/index.tsx and default-exports a PluginModule). When
 * installed + active, the plugin-host mounts <QualityPanel> wherever a
 * `<PluginSlot placement="panel">` lives. The config schema mirrors the core
 * plugin.meta.ts so the generic Marketplace config form seeds the same
 * thresholds/defaults the traffic light grades against.
 */
import { definePlugin } from '@/plugins'
import { QualityPanel } from './QualityPanel.tsx'

export default definePlugin({
  id: 'quality',
  name: 'Quality / Stream Health',
  description:
    'Measure the client↔server connection quality (download/upload + latency/' +
    'jitter) and grade it as a green/amber/red traffic light.',
  category: 'tool',
  ui: 'panel',
  version: '1.0.0',
  // Signal-bars glyph (drawn with stroke=currentColor by the marketplace icon).
  icon: 'M3 17h2v3H3v-3zm5-4h2v7H8v-7zm5-4h2v11h-2V9zm5-4h2v15h-2V5z',
  configSchema: {
    fields: [
      {
        key: 'green_min_mbps',
        type: 'number',
        label: 'Green: min download (Mbps)',
        default: 5,
        min: 0,
        max: 10000,
        description: 'At or above this download speed the light is green (optimal).',
      },
      {
        key: 'yellow_min_mbps',
        type: 'number',
        label: 'Amber: min download (Mbps)',
        default: 1,
        min: 0,
        max: 10000,
        description: 'Between amber and green the light is amber; below it, red.',
      },
      {
        key: 'target_bitrate_kbps',
        type: 'number',
        label: 'Target stream bitrate (kbps)',
        default: 2500,
        min: 0,
        max: 100000,
        description: 'The measured reception bitrate is graded against this target.',
      },
      {
        key: 'max_green_rtt_ms',
        type: 'number',
        label: 'Green: max latency (ms)',
        default: 120,
        min: 0,
        max: 10000,
        description: 'Round-trip time (and derived jitter) at or below this stays green.',
      },
      {
        key: 'download_url',
        type: 'string',
        label: 'Download test URL',
        default: '/apple-touch-icon.png',
        placeholder: '/apple-touch-icon.png',
        description: 'Same-origin asset re-fetched (cache-busted) to measure download speed.',
      },
      {
        key: 'download_target_mb',
        type: 'number',
        label: 'Download test size (MB)',
        default: 6,
        min: 1,
        max: 200,
        description: 'Total bytes to pull before computing the download speed.',
      },
      {
        key: 'upload_url',
        type: 'url',
        label: 'Upload test URL (optional)',
        default: '',
        placeholder: 'https://…/upload',
        description: 'Optional endpoint that ACCEPTS a POST body. Blank = skip the upload leg.',
      },
    ],
  },
  PanelComponent: QualityPanel,
})
