/**
 * TEST-ONLY fixture — stand-in for the DECOUPLED `occupancy` vision app.
 * The 2.16 vision-split boot migration (modules/vision-apps) resolves each
 * model app via registry.getMeta('occupancy') to normalize carried config; the
 * real app is vendored now, so hermetic core tests discover this stand-in
 * (STREAMHUB_PLUGIN_FIXTURE_ROOT). Schema mirrors the migration-carried keys.
 */
import { definePlugin } from '../../../../src/modules/plugins/plugin.contract';

export default definePlugin({
  id: 'occupancy',
  name: 'Occupancy (test fixture)',
  description: 'Stand-in for the decoupled occupancy vision app.',
  category: 'processor',
  ui: 'app-tab',
  needsWorker: true,
  version: '0.1.0',
  kind: 'app',
  storage: { db: 'occupancy.db' },
  configSchema: [
    {
      key: 'device',
      type: 'select',
      label: 'Device',
      default: 'cpu',
      options: [
        { value: 'cpu', label: 'CPU' },
        { value: 'cuda', label: 'CUDA' },
      ],
    },
    { key: 'fps', type: 'number', label: 'FPS', default: 3.5, min: 0.1, max: 30 },
    { key: 'confidence', type: 'number', label: 'Confidence', default: 0.35, min: 0, max: 1 },
  ],
  worker: {
    edge: true,
    spawn(ctx) {
      return {
        command: process.env.PLUGIN_PYTHON ?? 'python3',
        args: ['-m', 'vision_edge', '--model', 'occupancy'],
        env: { VISION_APP: ctx.app, VISION_MODEL: 'occupancy' },
      };
    },
  },
});
