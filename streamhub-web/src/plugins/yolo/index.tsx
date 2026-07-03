/**
 * Frontend plugin: YOLO Object Detection.
 *
 * Auto-discovered (src/plugins/yolo/index.tsx default-export) — no central edit.
 * Mirrors the streamhub-core `yolo` plugin's config so the Marketplace can
 * configure the worker (model size, CUDA on/off, callback URL, confidence, FPS,
 * room and a multiselect of the 80 COCO classes) and view its logs (the generic
 * LogsDialog reads GET /plugins/yolo/logs).
 *
 * The class multiselect can't be expressed by the generic ConfigField schema, so
 * this ships a custom `ConfigComponent` (see components.tsx). It writes the same
 * flat config keys the backend validates: room, model, cuda, callbackUrl,
 * confidence, fps, classes (classes as a canonical-ordered comma string).
 */
import { definePlugin } from '@/plugins'
import { MODEL_SIZES } from './classes.ts'
import { YoloConfig, YoloOverlay } from './components.tsx'

export default definePlugin({
  id: 'yolo',
  name: 'YOLO Object Detection',
  description:
    "Detects COCO objects in the app's live stream and POSTs bounding boxes to a callback URL.",
  category: 'analytics',
  ui: 'player-overlay',
  icon: 'M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z M9 12l2 2 4-4',
  version: '1.0.0',
  configSchema: {
    fields: [
      { key: 'room', type: 'string', label: 'Room / stream', required: true },
      {
        key: 'model',
        type: 'select',
        label: 'Model size',
        default: 'nano',
        options: MODEL_SIZES.map((m) => ({ value: m, label: m })),
      },
      { key: 'cuda', type: 'boolean', label: 'Use CUDA (GPU)', default: false },
      { key: 'callbackUrl', type: 'url', label: 'Callback URL', required: true },
      {
        key: 'confidence',
        type: 'number',
        label: 'Confidence',
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.05,
      },
      { key: 'fps', type: 'number', label: 'Sample FPS', default: 2, min: 0.1, max: 30, step: 0.5 },
      { key: 'classes', type: 'string', label: 'Classes filter', default: '' },
    ],
  },
  ConfigComponent: YoloConfig,
  OverlayComponent: YoloOverlay,
})
