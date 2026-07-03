/**
 * Built-in plugin: Quality / Stream Health.
 *
 * A no-worker PANEL (pure `tool`). The whole feature is client-side: the
 * frontend panel (streamhub-web/src/plugins/quality) runs a bandwidth test
 * against the server (download/upload throughput + latency/jitter) and shows a
 * traffic-light verdict (green = optimal, amber = fair, red = poor). This meta
 * only declares the plugin + its typed thresholds so the marketplace can list,
 * install and configure it. Auto-discovered — no central registry edit.
 *
 * The `configSchema` is the SERVER-SIDE source of truth for the thresholds the
 * tenant persists per app; the web plugin mirrors the same keys/defaults so the
 * traffic light classifies even before the backend responds.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'quality',
  name: 'Quality / Stream Health',
  description:
    'Measure the client↔server connection quality: a download/upload bandwidth ' +
    'test plus latency/jitter, distilled into a green/amber/red traffic light ' +
    'against configurable thresholds.',
  category: 'tool',
  ui: 'panel',
  version: '1.0.0',
  icon: 'signal',
  configSchema: [
    {
      key: 'green_min_mbps',
      type: 'number',
      label: 'Green: min download (Mbps)',
      default: 5,
      min: 0,
      max: 10000,
      help: 'At or above this download speed the light is green (optimal).',
    },
    {
      key: 'yellow_min_mbps',
      type: 'number',
      label: 'Amber: min download (Mbps)',
      default: 1,
      min: 0,
      max: 10000,
      help: 'Between amber and green thresholds the light is amber; below it, red.',
    },
    {
      key: 'target_bitrate_kbps',
      type: 'number',
      label: 'Target stream bitrate (kbps)',
      default: 2500,
      min: 0,
      max: 100000,
      help: 'Expected outbound/received stream bitrate. The measured reception '
        + 'bitrate is graded against this (green ≥ target, amber ≥ half).',
    },
    {
      key: 'max_green_rtt_ms',
      type: 'number',
      label: 'Green: max latency (ms)',
      default: 120,
      min: 0,
      max: 10000,
      help: 'Round-trip time (and derived jitter) at or below this stays green.',
    },
    {
      key: 'download_url',
      type: 'string',
      label: 'Download test URL',
      default: '/apple-touch-icon.png',
      placeholder: '/apple-touch-icon.png',
      help: 'Same-origin asset re-fetched (cache-busted) to measure download '
        + 'throughput. Point at a larger static file for steadier numbers.',
    },
    {
      key: 'download_target_mb',
      type: 'number',
      label: 'Download test size (MB)',
      default: 6,
      min: 1,
      max: 200,
      help: 'Total bytes to pull before computing the download speed.',
    },
    {
      key: 'upload_url',
      type: 'string',
      label: 'Upload test URL (optional)',
      default: '',
      placeholder: 'https://…/upload',
      help: 'Optional endpoint that ACCEPTS a POST body (e.g. an S3 presigned '
        + 'URL). Leave blank to skip the upload leg — no browser-only test can '
        + 'measure upload without a server that reads the body.',
    },
  ],
});
