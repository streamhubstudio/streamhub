/**
 * Built-in plugin: fleet — IoT/agent fleet management over MQTT (nodos.dev-style).
 *
 * A `panel`/tool plugin with NO worker: instead of spawning a process, it is
 * backed by the in-core `modules/fleet` FleetService, which subscribes to the
 * app's StreamHub Agents over the SAME per-app MQTT broker the app already uses
 * (config.yaml `mqtt:` block — NO second broker) and maintains a per-app
 * `fleet.db`. The service only activates for apps where this plugin is installed
 * + enabled AND `mqtt.enabled` is on.
 *
 * Topic layout (rooted at the app's mqtt.topicPrefix, default `streamhub/<app>`):
 *   <prefix>/agents/<agentId>/telemetry   agent → broker (retained)
 *   <prefix>/agents/<agentId>/status      agent → broker (retained, LWT)
 *   <prefix>/agents/<agentId>/cmd          broker → agent
 *   <prefix>/agents/<agentId>/cmd/result  agent → broker
 *
 * API: GET /apps/:app/plugins/fleet/agents (data), GET .../agents/:agentId
 * (detail + history), POST .../plugins/fleet/command (restart|ota|config|ping).
 * See https://streamhub.studio/docs/features/fleet for the full protocol + OTA/security model.
 *
 * Auto-discovered: this file's mere existence under src/plugins/fleet/ registers
 * the plugin. Every config field has a default, so a fresh install is valid.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'fleet',
  name: 'Fleet — Agent Management',
  description:
    'Connect to the StreamHub Agents in this app over MQTT: live health ' +
    '(CPU/RAM/temp/uptime/cameras/disk), online/offline status and remote ' +
    'control — restart, OTA update, config push and ping.',
  category: 'tool',
  ui: 'app-tab',
  version: '0.1.0',
  // Studio App: in-core MQTT fleet service + per-app fleet.db + full-page UI.
  // No worker to bundle → not exportable v1.
  kind: 'app',
  storage: { db: 'fleet.db' },
  icon: 'server',
  configSchema: [
    {
      key: 'offlineAfterSec',
      type: 'number',
      label: 'Offline after (seconds)',
      default: 90,
      min: 10,
      max: 3600,
      help:
        'Mark an agent offline when no telemetry arrives within this window ' +
        '(a backstop beyond the MQTT LWT). Should be a few telemetry intervals.',
    },
    {
      key: 'historyPoints',
      type: 'number',
      label: 'History points per agent',
      default: 120,
      min: 10,
      max: 1000,
      help: 'How many recent telemetry samples to keep per agent for the charts.',
    },
    {
      key: 'commandTimeoutSec',
      type: 'number',
      label: 'Command timeout (seconds)',
      default: 30,
      min: 5,
      max: 600,
      help:
        'How long a command stays "pending" before the UI treats it as timed ' +
        'out (the agent still reports late results if it recovers).',
    },
  ],
});
