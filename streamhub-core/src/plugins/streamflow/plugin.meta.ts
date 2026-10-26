/**
 * Built-in plugin: streamflow — an n8n-style visual event-workflow engine.
 *
 * A worker-less Studio App (same shape as `fleet`): instead of spawning a
 * process it is backed by the in-core `modules/streamflow` engine, which taps
 * `CallbacksService.dispatch` (the single event funnel) for triggers, walks a
 * DAG of "boxes" (triggers → actions → logic) per run, and persists runs/steps
 * to a per-app `streamflow.db`. It only reacts for apps where this plugin is
 * installed + enabled.
 *
 * A workflow chains boxes with typed ports, e.g. the canonical flow:
 *   trigger.event(perimeter intrusion) → action.snapshot → action.ai("is this a
 *   real intrusion?") → logic.condition(confidence > 0.7) → action.notify.
 *
 * API: /apps/:app/plugins/streamflow/{workflows,runs,boxes} (see
 * StreamflowController). AI calls (action.ai) go to an OpenAI-compatible
 * /v1/chat/completions endpoint (OpenAI, or DeepSeek by base-URL swap), gated by
 * a per-app monthly budget; the key lives in this plugin's `ai_api_key` secret
 * (or the SecretsStore), NEVER in clear config.
 *
 * Auto-discovered: this file's mere existence under src/plugins/streamflow/
 * registers the plugin. Every config field has a default, so a fresh install is
 * valid.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'streamflow',
  name: 'Streamflow — Workflow Engine',
  description:
    'Chain boxes to turn any StreamHub event into an automation: trigger on a ' +
    'domain event, snapshot the room, analyze it with ChatGPT/DeepSeek, branch ' +
    'on the result, then notify / emit / store — a visual n8n-style builder.',
  category: 'tool',
  ui: 'app-tab',
  version: '0.1.0',
  // Studio App: in-core engine + per-app streamflow.db + full-page canvas UI.
  // No worker to bundle → not exportable v1.
  kind: 'app',
  needsWorker: false,
  storage: { db: 'streamflow.db' },
  icon: 'workflow',
  // Names an `action.emit` box (or the runner's own lifecycle) may dispatch
  // through the app's signed callbacks funnel + MQTT tap.
  events: [
    'streamflow.run_started',
    'streamflow.run_finished',
    'streamflow.run_failed',
    'streamflow.output',
  ],
  configSchema: [
    {
      key: 'ai_provider',
      type: 'select',
      label: 'AI provider',
      default: 'openai',
      options: [
        { value: 'openai', label: 'OpenAI' },
        { value: 'deepseek', label: 'DeepSeek' },
      ],
      help: 'OpenAI-compatible /v1/chat/completions provider used by action.ai boxes.',
    },
    {
      key: 'ai_api_key',
      type: 'secret',
      label: 'AI API key',
      default: '',
      help:
        'API key for the selected provider. Stored as a secret, never returned ' +
        'in clear. Falls back to the SecretsStore ref of the same name.',
    },
    {
      key: 'ai_model',
      type: 'string',
      label: 'AI model',
      default: 'gpt-4o-mini',
      help: 'Model id, e.g. gpt-4o-mini (OpenAI) or deepseek-chat (DeepSeek).',
    },
    {
      key: 'ai_budget_monthly_usd',
      type: 'number',
      label: 'Monthly AI budget (USD)',
      default: 20,
      min: 0,
      max: 100000,
      help:
        'Hard cap on estimated AI spend per calendar month for this app. When ' +
        'reached, action.ai boxes fail closed until the next month.',
    },
    {
      key: 'max_runs_per_min',
      type: 'number',
      label: 'Max runs / minute',
      default: 60,
      min: 1,
      max: 100000,
      help:
        'Per-app rate limit so a hot event cannot flood the engine. Extra ' +
        'triggers within the window are dropped (logged).',
    },
    {
      key: 'dangerousNodes',
      type: 'boolean',
      label: 'Enable execution nodes (code / ssh / shell / db)',
      default: false,
      help:
        'DANGER: allows workflows to run a Node.js snippet (node:vm sandbox), a ' +
        'shell command, an SSH command, or a SQL query ON THE SERVER. OFF by ' +
        'default; when off these boxes are hidden from the palette and refused at ' +
        'run time. node:vm is a guardrail, NOT a hard security boundary — only ' +
        'enable for trusted operators.',
    },
  ],
});
