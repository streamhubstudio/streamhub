/**
 * Built-in Studio App: stream-health — ORIGIN stream quality/health monitor.
 *
 * A sampling-based (never full-decode) probe of every live stream's ORIGIN HLS
 * output. The worker (repo-root `health-worker/`, plain Node + the ffmpeg/
 * ffprobe binaries the core image already ships) wakes every
 * `sample_interval_sec` and, per room with a live playlist:
 *
 *   - diffs the media playlist (media-sequence jumps → dropped segments,
 *     no-advance → stall, EXT-X-DISCONTINUITY tags, measured bitrate);
 *   - parses the newest .ts segment's MPEG-TS continuity counters (packet
 *     loss / discontinuities) — pure JS, bounded read;
 *   - ffprobe's the newest segment for stream facts (codecs / resolution /
 *     fps / bitrate) + audio-vs-video start_time drift (A/V desync);
 *   - runs an audio-only `volumedetect` over that one segment (~2-6 s of AAC)
 *     for silence detection.
 *
 * Detected transitions POST to the framework EVENT channel
 * (STREAMHUB_EVENTS_URL, ingest-token auth) → the app's SIGNED callbacks
 * funnel (webhook + MQTT `alert` topic + Streamflow triggers) under the
 * `health.*` names below; every cycle also pushes an `overview` snapshot to
 * the live-data channel for the monitor tab. History + per-room threshold
 * overrides live in the per-app `stream-health.db`
 * (modules/stream-health). See https://streamhub.studio/docs/features/stream-health.
 *
 * Auto-discovered: this file's existence under src/plugins/stream-health/
 * registers the app. Every config field has a default so a fresh install is
 * valid; the same keys can be overridden PER ROOM via
 * PUT /apps/:app/plugins/stream-health/streams/:room/settings.
 */
import * as path from 'path';
import { definePlugin } from '../../modules/plugins/plugin.contract';

/**
 * Locate the repo-root `health-worker/` Node package. At runtime this file is
 * `dist/plugins/stream-health/plugin.meta.js` and under ts-jest it is
 * `src/plugins/stream-health/...`; either way `../../../..` climbs
 * streamhub-core → repo root. Overridable via HEALTH_WORKER_DIR (the Docker
 * image sets it to /opt/workers/health-worker).
 */
export function healthWorkerDir(): string {
  return (
    process.env.HEALTH_WORKER_DIR ??
    path.resolve(__dirname, '..', '..', '..', '..', 'health-worker')
  );
}

export default definePlugin({
  id: 'stream-health',
  name: 'Stream Health Monitor',
  description:
    'Validates ORIGIN stream quality per room: packet loss/discontinuities, ' +
    'audio silence, A/V desync, stalls and bitrate drops — sampled with ' +
    'ffprobe (no full decode), alerting through webhooks/MQTT/Streamflow.',
  category: 'processor',
  ui: 'app-tab',
  needsWorker: true,
  version: '0.1.0',
  kind: 'app',
  storage: { db: 'stream-health.db' },
  icon: 'activity',
  events: [
    'health.degraded',
    'health.recovered',
    'health.audio_lost',
    'health.audio_recovered',
    'health.av_desync',
    'health.stalled',
    'health.discontinuity',
  ],
  configSchema: [
    {
      key: 'sample_interval_sec',
      type: 'number',
      label: 'Sample interval (s)',
      default: 10,
      min: 2,
      max: 300,
      help:
        'How often each stream is probed. Cost per stream per sample is one ' +
        'ffprobe + one audio-only decode of a single segment (<1% of a core ' +
        'at the default).',
    },
    {
      key: 'silence_db',
      type: 'number',
      label: 'Silence threshold (dBFS)',
      default: -50,
      min: -120,
      max: 0,
      help: 'Mean segment volume at or below this counts as silent.',
    },
    {
      key: 'silence_duration_sec',
      type: 'number',
      label: 'Silence duration (s)',
      default: 15,
      min: 1,
      max: 600,
      help: 'Continuous silence longer than this fires health.audio_lost.',
    },
    {
      key: 'desync_ms',
      type: 'number',
      label: 'A/V desync threshold (ms)',
      default: 200,
      min: 10,
      max: 10000,
      help:
        'Audio-vs-video timestamp drift beyond this fires health.av_desync.',
    },
    {
      key: 'stall_sec',
      type: 'number',
      label: 'Stall threshold (s)',
      default: 20,
      min: 2,
      max: 600,
      help:
        'No new HLS segment for this long fires health.stalled (critical).',
    },
    {
      key: 'bitrate_drop_pct',
      type: 'number',
      label: 'Bitrate drop (%)',
      default: 50,
      min: 0,
      max: 95,
      help:
        'Measured bitrate falling below this percentage of the rolling ' +
        'baseline marks the stream degraded. 0 disables the check.',
    },
    {
      key: 'recover_samples',
      type: 'number',
      label: 'Recovery samples',
      default: 2,
      min: 1,
      max: 10,
      help:
        'Consecutive clean samples required before health.recovered fires ' +
        '(hysteresis against flapping).',
    },
  ],
  worker: {
    spawn(ctx) {
      const dir = healthWorkerDir();
      return {
        // The exact Node binary running the core (guaranteed present in the
        // image; needed for node:sqlite). PLUGIN_NODE overrides for dev setups.
        command: process.env.PLUGIN_NODE ?? process.execPath,
        args: [path.join(dir, 'src', 'main.js')],
        cwd: dir,
        env: {
          HEALTH_APP: ctx.app,
          // LOCAL placement: read the app's on-disk HLS (same host as core).
          HEALTH_HLS_DIR: path.join(ctx.appDir, 'hls'),
          // Per-app data dir: stream-health.db (history + per-room thresholds).
          HEALTH_DATA_DIR: path.join(ctx.appDir, 'stream-health'),
          // App-level threshold defaults (per-room overrides come from the db).
          HEALTH_CONFIG_JSON: JSON.stringify(ctx.config ?? {}),
        },
      };
    },
  },
});
