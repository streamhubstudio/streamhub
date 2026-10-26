/**
 * TEST-ONLY fixture plugin — a stable NON-edge-capable reference app.
 *
 * Discovered only under STREAMHUB_PLUGIN_FIXTURE_ROOT (see refapp). It is a
 * worker-backed Studio App WITHOUT `worker.edge`, so it is the stable fixture
 * for "reject a non-edge-capable plugin on the edge" specs — which previously
 * leaned on a real app (transcription) that now decouples.
 */
import * as path from 'path';
import { definePlugin } from '../../../../src/modules/plugins/plugin.contract';

export default definePlugin({
  id: 'reftool',
  name: 'Reference Tool (test fixture)',
  description: 'Test-only non-edge reference Studio App — never shipped.',
  category: 'processor',
  ui: 'app-tab',
  needsWorker: true,
  version: '1.0.0',
  kind: 'app',
  // Exportable so specs have a stable "exportable app NOT installed here"
  // fixture (the not-installed export gate rejects before touching sources).
  export: { workerDir: 'reftool-worker' },
  icon: 'settings',
  configSchema: [
    {
      key: 'source',
      type: 'string',
      label: 'Source',
      default: '',
      required: true,
    },
  ],
  worker: {
    // No `edge` — deliberately NOT edge-capable (the whole point of this fixture).
    spawn(ctx) {
      const dir = path.resolve(__dirname, '..', '..', '..', '..', 'reftool-worker');
      return {
        command: process.env.PLUGIN_PYTHON ?? 'python3',
        args: ['-m', 'reftool_worker', '--app', ctx.app],
        cwd: dir,
        env: { PYTHONPATH: dir, REFTOOL_APP: ctx.app },
      };
    },
  },
});
