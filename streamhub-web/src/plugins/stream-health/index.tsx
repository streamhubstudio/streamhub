/**
 * Frontend Studio App: stream-health — ORIGIN stream quality monitor.
 *
 * Auto-discovered (src/plugins/stream-health/index.tsx default export).
 * Mirrors the streamhub-core `stream-health` manifest (id, kind, thresholds
 * config with the SAME keys/defaults) so the Marketplace renders the generic
 * settings form; the tab itself (HealthTab) is the all-streams monitor with
 * per-stream drill-down + per-room threshold overrides. Pure data shaping
 * lives in logic.ts (node:test).
 */
import { definePlugin } from '../types.ts'
import { HealthTab } from './HealthTab.tsx'

export default definePlugin({
  id: 'stream-health',
  name: 'Stream Health Monitor',
  description:
    'Validates ORIGIN stream quality per room: packet loss/discontinuities, ' +
    'audio silence, A/V desync, stalls and bitrate drops — with health.* ' +
    'alerts through webhooks, MQTT and Streamflow.',
  category: 'processor',
  ui: 'app-tab',
  kind: 'app',
  version: '0.1.0',
  // Heartbeat/pulse glyph (stroke=currentColor).
  icon: 'M3 12h4l2-7 4 14 2-7h6',
  sections: [
    { id: 'monitor', labelKey: 'streamHealth:section.monitor' },
    { id: 'events', labelKey: 'streamHealth:section.events' },
  ],
  configSchema: {
    fields: [
      {
        key: 'sample_interval_sec',
        type: 'number',
        label: 'Sample interval (s)',
        default: 10,
        min: 2,
        max: 300,
        step: 1,
        description: 'How often each stream is probed (one ffprobe + one audio-only decode per sample).',
      },
      {
        key: 'silence_db',
        type: 'number',
        label: 'Silence threshold (dBFS)',
        default: -50,
        min: -120,
        max: 0,
        step: 1,
        description: 'Mean segment volume at or below this counts as silent.',
      },
      {
        key: 'silence_duration_sec',
        type: 'number',
        label: 'Silence duration (s)',
        default: 15,
        min: 1,
        max: 600,
        step: 1,
        description: 'Continuous silence longer than this fires health.audio_lost.',
      },
      {
        key: 'desync_ms',
        type: 'number',
        label: 'A/V desync threshold (ms)',
        default: 200,
        min: 10,
        max: 10000,
        step: 10,
        description: 'Audio-vs-video timestamp drift beyond this fires health.av_desync.',
      },
      {
        key: 'stall_sec',
        type: 'number',
        label: 'Stall threshold (s)',
        default: 20,
        min: 2,
        max: 600,
        step: 1,
        description: 'No new HLS segment for this long fires health.stalled (critical).',
      },
      {
        key: 'bitrate_drop_pct',
        type: 'number',
        label: 'Bitrate drop (%)',
        default: 50,
        min: 0,
        max: 95,
        step: 5,
        description: 'Measured bitrate under this % of the rolling baseline = degraded. 0 disables.',
      },
      {
        key: 'recover_samples',
        type: 'number',
        label: 'Recovery samples',
        default: 2,
        min: 1,
        max: 10,
        step: 1,
        description: 'Consecutive clean samples before health.recovered (anti-flapping).',
      },
    ],
  },
  TabComponent: HealthTab,
})
