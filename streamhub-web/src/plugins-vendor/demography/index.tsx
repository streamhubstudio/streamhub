/**
 * Frontend Studio App: demography — age / gender / emotion.
 *
 * One of the four vision model-apps (Edge-as-capability). A thin wrapper over the
 * shared VisionAppTab; the id 'demography' drives the per-app API + the ROI
 * editor (a single region-of-interest polygon + interval/engine). Mirrors the
 * streamhub-core `demography` manifest, incl. the opt-in vision-API key.
 * Auto-discovered via src/plugins/demography/index.tsx.
 */
import { makeVisionApp } from '../../plugins/vision-shared/VisionAppTab.tsx'

export default makeVisionApp({
  id: 'demography',
  name: 'Demography — Age / Gender / Emotion',
  description:
    'Per-face age / gender / emotion reads (InsightFace, or an opt-in vision-API ' +
    'engine) — co-located or distributed per-stream on edge nodes.',
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
      {
        key: 'engine',
        type: 'select',
        label: 'Demography engine',
        default: 'local',
        description: 'Local by default. An API engine sends periodic snapshots to that provider.',
        options: [
          { value: 'local', label: 'Local InsightFace (open-source, default)' },
          { value: 'openai', label: 'OpenAI vision API (opt-in, per-snapshot)' },
          { value: 'deepseek', label: 'DeepSeek vision API (opt-in, per-snapshot)' },
        ],
      },
      {
        key: 'ai_api_key',
        type: 'secret',
        label: 'Vision-API key (openai / deepseek engines)',
        default: '',
        description: 'Only used when the engine is an external API. Never sent to edge nodes.',
      },
      { key: 'fps', type: 'number', label: 'Sample FPS', default: 3.5, min: 0.5, max: 30, step: 0.5 },
      { key: 'confidence', type: 'number', label: 'Detection confidence', default: 0.35, min: 0, max: 1, step: 0.05 },
    ],
  },
})
