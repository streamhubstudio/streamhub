/**
 * CAPABILITY MANIFEST TEMPLATE — StreamHub Grid (bring-your-own-GPU console).
 * Design: https://streamhub.studio/docs/features/NEXTGEN-ADDONS §Grid.
 *
 * NOT DISCOVERED: folders under src/plugins/_templates/ are skipped by the
 * registry (underscore rule). Move this folder up one level to activate.
 *
 * Grid itself is INFRASTRUCTURE, not a processor: the placement contract
 * lives in plugin.contract.ts (`worker.placement: 'grid'` + requirements) and
 * the node registry/selection seam in modules/plugins/plugin-grid.service.ts.
 * THIS plugin is the operator-facing console for it — a per-app panel that
 * shows which registry nodes advertise grid capabilities (heartbeat stats
 * `grid` block), what each `grid`-placed plugin requested, where its worker
 * actually ran (fall-back vs remote), and — once TODO GRID-1/GRID-2 ship —
 * live leases with remote start/stop/logs.
 *
 * To build: dashboard side streamhub-web/src/plugins/grid/ reading
 * GET /api/v1/nodes (+ the future /api/v1/grid/* routes, TODO GRID-4).
 * No worker: the console only reads state the framework already owns.
 */
import { definePlugin } from '../../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'grid',
  name: 'StreamHub Grid',
  description:
    'BYO-GPU edge compute console: see grid-capable cluster nodes, their ' +
    'advertised GPU/capabilities, and where each grid-placed plugin worker ' +
    'runs.',
  category: 'panel',
  ui: 'app-tab',
  version: '0.1.0',
  icon: 'grid',
  configSchema: [
    {
      key: 'showStaleNodes',
      type: 'boolean',
      label: 'Show stale nodes',
      default: false,
      help:
        'Also list registry nodes whose heartbeat lapsed (never eligible for ' +
        'placement; useful to debug an edge box that stopped reporting).',
    },
    {
      key: 'schedulerPolicy',
      type: 'select',
      label: 'Scheduler policy',
      default: 'first-match',
      options: [
        { value: 'first-match', label: 'First match (deterministic)' },
        { value: 'least-loaded', label: 'Least loaded (TODO GRID-1)' },
        { value: 'region-affinity', label: 'Region affinity (TODO GRID-1)' },
      ],
      help:
        "Node selection strategy for this app's grid workers. Only " +
        "'first-match' (matchGridNode) exists today; the others are seams " +
        'for the remote scheduler.',
    },
    {
      key: 'refreshSec',
      type: 'number',
      label: 'Refresh interval (s)',
      default: 15,
      min: 5,
      max: 300,
      help: 'How often the console re-polls the nodes registry.',
    },
  ],
});
