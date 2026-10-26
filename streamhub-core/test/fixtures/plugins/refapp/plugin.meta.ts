/**
 * TEST-ONLY fixture plugin — the stable "reference app".
 *
 * This is NOT a shipped plugin: it lives under test/ and is discovered ONLY
 * when STREAMHUB_PLUGIN_FIXTURE_ROOT points at test/fixtures/plugins (the test
 * suite sets it; production never does). It exists so specs that just need
 * "some exportable, edge-capable, worker-backed app with a secret config field"
 * can exercise a behaviour WITHOUT depending on a real shipping app — real apps
 * decouple to their own repos over time, and a fixture must not decouple.
 *
 * Covers: exportable + storage (appstore/plugins-export fixtures), edge-capable
 * (edge assignment fixtures), a `callbackUrl` secret (public-config stripping),
 * and a pure worker.spawn (spawn-template fidelity). Kept at a stable 1.0.0.
 */
import * as path from 'path';
import { definePlugin } from '../../../../src/modules/plugins/plugin.contract';

function workerDir(): string {
  return (
    process.env.REFAPP_WORKER_DIR ??
    path.resolve(__dirname, '..', '..', '..', '..', 'refapp-worker')
  );
}

export default definePlugin({
  id: 'refapp',
  name: 'Reference App (test fixture)',
  description: 'Test-only reference Studio App — never shipped.',
  category: 'processor',
  ui: 'app-tab',
  needsWorker: true,
  version: '1.0.0',
  kind: 'app',
  storage: { db: 'refapp.db' },
  export: { workerDir: 'refapp-worker' },
  icon: 'settings',
  events: ['refapp.detected'],
  configSchema: [
    {
      key: 'room',
      type: 'string',
      label: 'Room / stream',
      default: '',
      required: true,
      placeholder: 'cam1',
      help: 'HLS room name to analyze.',
    },
    {
      key: 'callbackUrl',
      type: 'string',
      label: 'Callback URL',
      default: '',
      placeholder: 'https://example.com/hooks/refapp',
      help: 'A secret POST target — stripped from the public config.',
    },
    {
      key: 'confidence',
      type: 'number',
      label: 'Confidence',
      default: 0.5,
      min: 0,
      max: 1,
    },
    {
      key: 'cuda',
      type: 'boolean',
      label: 'Use CUDA',
      default: false,
    },
  ],
  worker: {
    placement: 'grid',
    grid: { gpu: true, capabilities: ['cuda', 'refapp'] },
    edge: true,
    spawn(ctx) {
      const cuda = ctx.config.cuda === true || ctx.config.cuda === 'true';
      const dir = workerDir();
      return {
        command: process.env.PLUGIN_PYTHON ?? 'python3',
        args: ['-m', 'refapp_worker', '--app', ctx.app],
        cwd: dir,
        env: {
          PYTHONPATH: dir,
          PYTHONUNBUFFERED: '1',
          REFAPP_APP: ctx.app,
          REFAPP_ROOM: String(ctx.config.room ?? ''),
          REFAPP_DEVICE: cuda ? 'cuda' : 'cpu',
          REFAPP_CONFIDENCE: String(ctx.config.confidence ?? 0.5),
          REFAPP_CALLBACK_URL: String(ctx.config.callbackUrl ?? ''),
          REFAPP_HLS_DIR: path.join(ctx.appDir, 'hls'),
          REFAPP_LIVEKIT_URL: ctx.livekitUrl,
        },
      };
    },
  },
});
