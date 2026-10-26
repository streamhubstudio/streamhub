/**
 * Frontend Studio App: crowd — density snapshot threshold.
 *
 * One of the four vision model-apps (Edge-as-capability). A thin wrapper over the
 * shared VisionAppTab; the id 'crowd' drives the per-app API + the polygon zone
 * editor. Mirrors the streamhub-core `crowd` manifest. Auto-discovered via
 * src/plugins/crowd/index.tsx.
 */
import { makeVisionApp } from '../../plugins/vision-shared/VisionAppTab.tsx'

export default makeVisionApp({
  id: 'crowd',
  name: 'Crowd — Density Threshold',
  description:
    'Periodic head-count per polygon zone with a multi-cycle threshold alert — ' +
    'co-located or distributed per-stream on edge nodes.',
  icon: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 15a3 3 0 100-6 3 3 0 000 6z',
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
