/**
 * Built-in plugin: YOLO object detection.
 *
 * A `needsWorker` PROCESSOR: the core spawns a Python worker (see the repo-root
 * `yolo-worker/` package) that pulls the app's live stream over HLS, runs
 * ultralytics YOLO inference and POSTs detections to a callback URL. The plugin
 * itself stays fully decoupled from the core — it is only this manifest plus a
 * pure `worker.spawn(ctx)` that returns { command, args, env }. The framework
 * owns the whole worker lifecycle (start/stop/status/logs) via the worker-hook.
 *
 * Auto-discovered: this file's mere existence under src/plugins/yolo/ registers
 * the plugin. No central registry edit — no collisions between plugin authors.
 *
 * Config (validated by the framework against this schema):
 *   - model:       nano | small | medium | large | xlarge  → yolov8{n,s,m,l,x}
 *   - cuda:        run inference on GPU (CUDA) or CPU
 *   - callbackUrl: where the worker POSTs each frame's detections
 *   - confidence:  minimum detection confidence (0–1)
 *   - fps:         frames per second to sample from the stream
 *   - classes:     comma-separated COCO class names to keep (empty = all 80)
 *   - room:        which room/stream of the app to analyze (HLS room name)
 */
import * as path from 'path';
import { definePlugin } from '../../modules/plugins/plugin.contract';

/**
 * Locate the repo-root `yolo-worker/` python package. At runtime this file is
 * dist/plugins/yolo/plugin.meta.js and under ts-jest it is src/plugins/yolo/...;
 * either way `../../../..` climbs streamhub-core → repo root. Overridable via
 * YOLO_WORKER_DIR so an operator can point at a checkout / installed copy.
 */
function workerDir(): string {
  return (
    process.env.YOLO_WORKER_DIR ??
    path.resolve(__dirname, '..', '..', '..', '..', 'yolo-worker')
  );
}

/** Map the friendly size choice to the ultralytics model weight name. */
const MODEL_BY_SIZE: Record<string, string> = {
  nano: 'yolov8n',
  small: 'yolov8s',
  medium: 'yolov8m',
  large: 'yolov8l',
  xlarge: 'yolov8x',
};

export default definePlugin({
  id: 'yolo',
  name: 'YOLO Object Detection',
  description:
    "Runs a YOLO worker over the app's live stream, detecting COCO objects " +
    'and POSTing bounding boxes to a callback URL.',
  category: 'processor',
  ui: 'player-overlay',
  needsWorker: true,
  version: '1.0.0',
  icon: 'target',
  configSchema: [
    {
      key: 'room',
      type: 'string',
      label: 'Room / stream',
      default: '',
      required: true,
      placeholder: 'live',
      help: "HLS room name to analyze — /hls/<app>/<room>/index.m3u8.",
    },
    {
      key: 'model',
      type: 'select',
      label: 'Model size',
      default: 'nano',
      options: [
        { value: 'nano', label: 'Nano (fastest, CPU-friendly)' },
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large', label: 'Large' },
        { value: 'xlarge', label: 'XLarge (most accurate, GPU)' },
      ],
    },
    {
      key: 'cuda',
      type: 'boolean',
      label: 'Use CUDA (GPU)',
      default: false,
      help: 'On uses the GPU; off runs on CPU. Leave it off on CPU-only hosts.',
    },
    {
      key: 'callbackUrl',
      type: 'string',
      label: 'Callback URL',
      default: '',
      required: true,
      placeholder: 'https://example.com/hooks/yolo',
      help: 'POST {app, room, ts, detections:[{class,conf,bbox}]} per frame.',
    },
    {
      key: 'confidence',
      type: 'number',
      label: 'Confidence threshold',
      default: 0.35,
      min: 0,
      max: 1,
      help: 'Minimum detection confidence (0–1).',
    },
    {
      key: 'fps',
      type: 'number',
      label: 'Sample FPS',
      default: 2,
      min: 0.1,
      max: 30,
      help: 'Frames per second to sample from the stream (lower = less CPU).',
    },
    {
      key: 'classes',
      type: 'string',
      label: 'Classes filter',
      default: '',
      placeholder: 'person,car,dog (empty = all 80 COCO classes)',
      help: 'Comma-separated COCO class names to keep; empty detects all.',
    },
  ],
  worker: {
    spawn(ctx) {
      const size = String(ctx.config.model ?? 'nano');
      const model = MODEL_BY_SIZE[size] ?? 'yolov8n';
      const cuda = ctx.config.cuda === true || ctx.config.cuda === 'true';
      const dir = workerDir();
      return {
        command: process.env.PLUGIN_PYTHON ?? 'python3',
        args: ['-m', 'yolo_worker', '--app', ctx.app],
        cwd: dir,
        env: {
          PYTHONPATH: dir,
          PYTHONUNBUFFERED: '1',
          YOLO_APP: ctx.app,
          YOLO_ROOM: String(ctx.config.room ?? ''),
          YOLO_MODEL: model,
          YOLO_DEVICE: cuda ? 'cuda' : 'cpu',
          YOLO_CONFIDENCE: String(ctx.config.confidence ?? 0.35),
          YOLO_FPS: String(ctx.config.fps ?? 2),
          YOLO_CLASSES: String(ctx.config.classes ?? ''),
          YOLO_CALLBACK_URL: String(ctx.config.callbackUrl ?? ''),
          // Stream sources: prefer the on-disk HLS dir, fall back to the public
          // URL. The worker picks whichever resolves first.
          YOLO_HLS_DIR: path.join(ctx.appDir, 'hls'),
          YOLO_PUBLIC_BASE: process.env.PUBLIC_BASE_URL ?? '',
          YOLO_LIVEKIT_URL: ctx.livekitUrl,
        },
      };
    },
  },
});
