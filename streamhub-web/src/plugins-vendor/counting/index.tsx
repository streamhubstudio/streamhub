/**
 * Frontend Studio App: counting — line-crossing people counter.
 *
 * One of the four vision model-apps (Edge-as-capability). A thin wrapper over the
 * shared VisionAppTab; the id 'counting' drives the per-app API + the crossing-
 * line editor. Mirrors the streamhub-core `counting` manifest. Auto-discovered
 * via src/plugins/counting/index.tsx.
 */
import { makeVisionApp } from '../../plugins/vision-shared/VisionAppTab.tsx'

export default makeVisionApp({
  id: 'counting',
  name: 'Counting — Line-Crossing People Counter',
  description:
    'Counts people crossing tagged lines (YOLO11 + ByteTrack): IN/OUT + live ' +
    'occupancy — co-located or distributed per-stream on edge nodes.',
  icon: 'M17 20h5v-2a4 4 0 00-3-3.87 M9 20H4v-2a4 4 0 013-3.87 M12 4a4 4 0 110 8 4 4 0 010-8z',
  configSchema: {
    fields: [
      {
        key: 'device',
        type: 'select',
        label: 'Inference device',
        default: 'cpu',
        description: 'Where the model runs. Edge nodes advertise their own GPU capacity.',
        options: [
          { value: 'cpu', label: 'CPU (portable)' },
          { value: 'cuda', label: 'CUDA GPU (recommended for multi-stream)' },
        ],
      },
      { key: 'fps', type: 'number', label: 'Sample FPS', default: 3.5, min: 0.5, max: 30, step: 0.5 },
      { key: 'confidence', type: 'number', label: 'Detection confidence', default: 0.35, min: 0, max: 1, step: 0.05 },
    ],
  },
})
