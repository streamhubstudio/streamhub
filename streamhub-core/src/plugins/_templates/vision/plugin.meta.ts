/**
 * CAPABILITY MANIFEST TEMPLATE — StreamHub Vision (retail & CCTV intelligence).
 * Design: https://streamhub.studio/docs/features/NEXTGEN-ADDONS §Vision.
 *
 * NOT DISCOVERED: folders under src/plugins/_templates/ are skipped by the
 * registry (underscore rule). To start building Vision, move this folder up
 * one level (src/plugins/vision/) — the manifest already validates against the
 * live registry rules (locked by plugin-placement.spec.ts) — then:
 *   1. create the repo-root `vision-worker/` Python package (clone the
 *      yolo-worker layout: HLS in → inference → POST results out);
 *   2. add the dashboard side: streamhub-web/src/plugins/vision/ (app-tab
 *      analytics panel; zone editor draws on a player snapshot);
 *   3. results feed back via the live-data channel (occupancy "now") and
 *      LiveKit data messages on topic `plugin:vision` (events: line-cross,
 *      zone-enter/exit) — see NEXTGEN-ADDONS.md §Feed-back.
 *
 * What is REAL here: the id/category/ui, the typed config schema (every field
 * defaulted), the GRID placement request and the worker spawn contract.
 * What is TODO: the vision_worker package itself (the AI is NOT implemented).
 */
import * as path from 'path';
import { definePlugin } from '../../../modules/plugins/plugin.contract';

/** Repo-root `vision-worker/` package (same convention as yolo/deface). */
function workerDir(): string {
  return (
    process.env.VISION_WORKER_DIR ??
    path.resolve(__dirname, '..', '..', '..', '..', 'vision-worker')
  );
}

export default definePlugin({
  id: 'vision',
  name: 'StreamHub Vision',
  description:
    'Retail & CCTV intelligence over live streams: people counting, zone ' +
    'occupancy, dwell time and heatmaps — YOLO/OpenCV on a GRID GPU node or ' +
    'a managed vision API.',
  category: 'processor',
  ui: 'app-tab',
  needsWorker: true,
  version: '0.1.0',
  icon: 'eye',
  configSchema: [
    {
      key: 'room',
      type: 'string',
      label: 'Room / stream',
      default: '',
      required: true,
      placeholder: 'cam-entrance',
      help: 'HLS room to analyze — /hls/<app>/<room>/index.m3u8.',
    },
    {
      key: 'mode',
      type: 'select',
      label: 'Analytics mode',
      default: 'people-count',
      options: [
        { value: 'people-count', label: 'People counting (in/out lines)' },
        { value: 'zone-occupancy', label: 'Zone occupancy' },
        { value: 'dwell-time', label: 'Dwell time per zone' },
        { value: 'heatmap', label: 'Traffic heatmap' },
      ],
    },
    {
      key: 'provider',
      type: 'select',
      label: 'Inference provider',
      default: 'yolo-local',
      options: [
        { value: 'yolo-local', label: 'YOLO / OpenCV (open-source, local/GRID)' },
        { value: 'aws-rekognition', label: 'AWS Rekognition (paid API)' },
        { value: 'azure-vision', label: 'Azure AI Vision (paid API)' },
        { value: 'gcp-video-ai', label: 'Google Video Intelligence (paid API)' },
      ],
      help: 'Open-source runs on the worker; paid APIs relay sampled frames.',
    },
    {
      key: 'apiKey',
      type: 'secret',
      label: 'Provider API key',
      default: '',
      help: 'Only for paid-API providers; ignored by yolo-local.',
    },
    {
      key: 'zones',
      type: 'string',
      label: 'Zones / lines (JSON)',
      default: '[]',
      placeholder: '[{"id":"door","kind":"line","points":[[0.1,0.5],[0.9,0.5]]}]',
      help:
        'Normalized 0–1 polygons/lines the dashboard zone editor writes; the ' +
        'worker evaluates crossings/occupancy against them.',
    },
    {
      key: 'confidence',
      type: 'number',
      label: 'Confidence threshold',
      default: 0.35,
      min: 0,
      max: 1,
    },
    {
      key: 'fps',
      type: 'number',
      label: 'Sample FPS',
      default: 4,
      min: 0.1,
      max: 30,
      help: 'Frames per second to sample (counting needs more than heatmaps).',
    },
  ],
  worker: {
    // GRID: person detection at useful FPS wants a GPU; falls back to local
    // CPU (like yolo nano) until the remote scheduler ships.
    placement: 'grid',
    grid: { gpu: true, capabilities: ['cuda', 'yolo'] },
    spawn(ctx) {
      const dir = workerDir();
      return {
        // TODO(vision-worker): package does not exist yet — clone the
        // repo-root yolo-worker layout (module `vision_worker`).
        command: process.env.PLUGIN_PYTHON ?? 'python3',
        args: ['-m', 'vision_worker', '--app', ctx.app],
        cwd: dir,
        env: {
          PYTHONPATH: dir,
          PYTHONUNBUFFERED: '1',
          VISION_APP: ctx.app,
          VISION_ROOM: String(ctx.config.room ?? ''),
          VISION_MODE: String(ctx.config.mode ?? 'people-count'),
          VISION_PROVIDER: String(ctx.config.provider ?? 'yolo-local'),
          VISION_API_KEY: String(ctx.config.apiKey ?? ''),
          VISION_ZONES: String(ctx.config.zones ?? '[]'),
          VISION_CONFIDENCE: String(ctx.config.confidence ?? 0.35),
          VISION_FPS: String(ctx.config.fps ?? 4),
          VISION_HLS_DIR: path.join(ctx.appDir, 'hls'),
          VISION_LIVEKIT_URL: ctx.livekitUrl,
          // Results out: live-data channel via the injected STREAMHUB_INGEST_*
          // env; events additionally as data messages on topic `plugin:vision`.
        },
      };
    },
  },
});
