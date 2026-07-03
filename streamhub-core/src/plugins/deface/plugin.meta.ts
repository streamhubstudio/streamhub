/**
 * Built-in plugin: deface — face obfuscation (privacy).
 *
 * A `needsWorker` PROCESSOR modelled on https://github.com/ORB-HD/deface: the
 * core spawns a Python worker (repo-root `deface-worker/`) that pulls the app's
 * live stream over HLS, runs CENTERFACE face detection (the ONNX model deface
 * uses) and pushes normalized face boxes into the framework live-data channel
 * (POST /apps/:app/plugins/deface/live with the injected STREAMHUB_INGEST_*
 * env). The PLAYER overlay (streamhub-web/src/plugins/deface) polls
 * GET :id/live and obfuscates the detected regions CLIENT-SIDE
 * (blur / mosaic / solid, ellipse or box).
 *
 * PRIVACY CAVEAT: this anonymizes the PLAYER, not the stream — the raw
 * WebRTC/HLS media and recordings still contain the faces (see README.md).
 *
 * Auto-discovered: this file's mere existence under src/plugins/deface/
 * registers the plugin. Config mirrors deface's real CLI options; every field
 * has a default so a fresh install is immediately valid.
 */
import * as path from 'path';
import { definePlugin } from '../../modules/plugins/plugin.contract';

/**
 * Locate the repo-root `deface-worker/` python package. At runtime this file is
 * dist/plugins/deface/plugin.meta.js and under ts-jest it is src/plugins/...;
 * either way `../../../..` climbs streamhub-core → repo root. Overridable via
 * DEFACE_WORKER_DIR so an operator can point at a checkout / installed copy.
 */
function workerDir(): string {
  return (
    process.env.DEFACE_WORKER_DIR ??
    path.resolve(__dirname, '..', '..', '..', '..', 'deface-worker')
  );
}

export default definePlugin({
  id: 'deface',
  name: 'Deface — Face Obfuscation',
  description:
    "Detects faces in the app's live stream (CenterFace) and obfuscates them " +
    'on the player: blur, mosaic or solid mask over each face.',
  category: 'processor',
  ui: 'player-overlay',
  needsWorker: true,
  version: '1.0.0',
  icon: 'shield',
  configSchema: [
    {
      key: 'room',
      type: 'string',
      label: 'Room / stream',
      default: '',
      required: true,
      placeholder: 'live',
      help: 'HLS room name to process — /hls/<app>/<room>/index.m3u8.',
    },
    {
      key: 'thresh',
      type: 'number',
      label: 'Detection threshold',
      default: 0.2,
      min: 0,
      max: 1,
      help:
        'Face detection sensitivity (0–1). Lower catches more faces but adds ' +
        'false positives; raise it if too much is masked.',
    },
    {
      key: 'replacewith',
      type: 'select',
      label: 'Anonymization method',
      default: 'blur',
      options: [
        { value: 'blur', label: 'Blur (gaussian)' },
        { value: 'mosaic', label: 'Mosaic (pixelate)' },
        { value: 'solid', label: 'Solid (black fill)' },
        { value: 'none', label: 'None (detect only)' },
      ],
      help: 'How the player masks each detected face region.',
    },
    {
      key: 'maskScale',
      type: 'number',
      label: 'Mask scale',
      default: 1.3,
      min: 1,
      max: 3,
      help:
        'Enlarge detected boxes by this factor to cover hair/chin ' +
        '(deface --mask-scale).',
    },
    {
      key: 'boxes',
      type: 'boolean',
      label: 'Rectangular masks',
      default: false,
      help: 'On masks with rectangles; off uses ellipses (deface default).',
    },
    {
      key: 'mosaicSize',
      type: 'number',
      label: 'Mosaic block size',
      default: 20,
      min: 2,
      max: 200,
      help: "Pixel size of mosaic blocks — only used when method is 'mosaic'.",
    },
    {
      key: 'scale',
      type: 'string',
      label: 'Detection downscale',
      default: '',
      placeholder: '640x360',
      help:
        'WxH to downscale frames for detection (empty = native). Smaller is ' +
        'much faster on CPU at a small accuracy cost (deface --scale).',
    },
    {
      key: 'backend',
      type: 'select',
      label: 'Inference backend',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Auto (onnxrt if available, else opencv)' },
        { value: 'onnxrt', label: 'ONNX Runtime' },
        { value: 'opencv', label: 'OpenCV DNN' },
      ],
    },
    {
      key: 'cuda',
      type: 'boolean',
      label: 'Use CUDA (GPU)',
      default: false,
      help:
        'On uses the CUDA execution provider (needs onnxruntime-gpu); off runs ' +
        'on CPU. Falls back to CPU automatically when CUDA is unavailable.',
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
      key: 'drawScores',
      type: 'boolean',
      label: 'Draw detection scores',
      default: false,
      help: 'Show the confidence score next to each mask (debugging).',
    },
  ],
  worker: {
    spawn(ctx) {
      const dir = workerDir();
      const cuda = ctx.config.cuda === true || ctx.config.cuda === 'true';
      return {
        command: process.env.PLUGIN_PYTHON ?? 'python3',
        args: ['-m', 'deface_worker', '--app', ctx.app],
        cwd: dir,
        env: {
          PYTHONPATH: dir,
          PYTHONUNBUFFERED: '1',
          DEFACE_APP: ctx.app,
          DEFACE_ROOM: String(ctx.config.room ?? ''),
          DEFACE_THRESH: String(ctx.config.thresh ?? 0.2),
          DEFACE_MASK_SCALE: String(ctx.config.maskScale ?? 1.3),
          DEFACE_SCALE: String(ctx.config.scale ?? ''),
          DEFACE_BACKEND: String(ctx.config.backend ?? 'auto'),
          DEFACE_EXECUTION_PROVIDER: cuda ? 'cuda' : 'cpu',
          DEFACE_FPS: String(ctx.config.fps ?? 2),
          // Shared model cache: <DATA_DIR>/models/deface/centerface.onnx is
          // downloaded on first run (like yolo auto-downloads its weights).
          DEFACE_MODEL_DIR: path.join(ctx.dataDir, 'models', 'deface'),
          // Stream sources: prefer the on-disk HLS dir, fall back to the public
          // URL. The worker picks whichever resolves first.
          DEFACE_HLS_DIR: path.join(ctx.appDir, 'hls'),
          DEFACE_PUBLIC_BASE: process.env.PUBLIC_BASE_URL ?? '',
          DEFACE_LIVEKIT_URL: ctx.livekitUrl,
          // Callback target: defaults to the framework live-data channel — the
          // worker-hook injects STREAMHUB_INGEST_URL/_TOKEN; an operator may
          // override DEFACE_CALLBACK_URL in the core env to divert the feed.
        },
      };
    },
  },
});
