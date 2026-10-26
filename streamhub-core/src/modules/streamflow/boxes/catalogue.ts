/**
 * Box catalogue (Streamflow) — the SERIALIZABLE palette the UI renders. One
 * entry per box type: its group, label, help, declared config fields and the
 * input/output ports (so the canvas knows where edges attach). This is metadata
 * only; execution lives in boxes/executors.ts.
 */
export type BoxGroup = 'trigger' | 'action' | 'logic';

export interface BoxField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'json' | 'text';
  label: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface BoxSpec {
  type: string;
  group: BoxGroup;
  label: string;
  description: string;
  /** Input ports (entry boxes have none). */
  inputs: string[];
  /** Output ports edges can leave from. */
  outputs: string[];
  fields: BoxField[];
  /** Flag-gated execution box (streamflow.dangerousNodes) — hidden when off. */
  dangerous?: boolean;
}

export const BOX_CATALOGUE: BoxSpec[] = [
  // --- Triggers ---------------------------------------------------------------
  {
    type: 'trigger.event',
    group: 'trigger',
    label: 'On event',
    description:
      'Fires when a StreamHub domain event is dispatched (plate.*, occupancy.*, ' +
      'perimeter intrusion, stream.*, node.*, …), optionally filtered by room, ' +
      'tags or a predicate.',
    inputs: [],
    outputs: ['out'],
    fields: [
      { key: 'event', type: 'string', label: 'Event', help: 'Exact name or prefix wildcard (e.g. plate.*). Empty = any.' },
      { key: 'room', type: 'string', label: 'Room', help: 'Only fire for this room.' },
      { key: 'tags', type: 'json', label: 'Tags', help: 'Array; fire when any matches the payload tags.' },
      { key: 'predicate', type: 'json', label: 'Predicate', help: 'Condition config: {match, rules:[{field,op,value}]}.' },
    ],
  },
  {
    type: 'trigger.schedule',
    group: 'trigger',
    label: 'On schedule',
    description: 'Fires on an interval / cron (BullMQ repeatable).',
    inputs: [],
    outputs: ['out'],
    fields: [
      { key: 'cron', type: 'string', label: 'Cron', help: 'Cron expression, e.g. 0 * * * *.' },
      { key: 'everySeconds', type: 'number', label: 'Every (seconds)', help: 'Simple interval; used when no cron.' },
    ],
  },
  {
    type: 'trigger.mqtt',
    group: 'trigger',
    label: 'On MQTT message',
    description: "Fires on an inbound MQTT topic on the app's broker.",
    inputs: [],
    outputs: ['out'],
    fields: [{ key: 'topic', type: 'string', label: 'Topic', help: 'Topic filter (wildcards allowed).' }],
  },
  {
    type: 'trigger.manual',
    group: 'trigger',
    label: 'Manual / API',
    description: 'Fires from the Run button or POST …/run.',
    inputs: [],
    outputs: ['out'],
    fields: [],
  },
  // --- Actions ----------------------------------------------------------------
  {
    type: 'action.snapshot',
    group: 'action',
    label: 'Snapshot',
    description: 'Capture a JPEG frame from a room (uploaded to the app S3).',
    inputs: ['in'],
    outputs: ['out'],
    fields: [{ key: 'room', type: 'string', label: 'Room', help: 'Defaults to the trigger room.' }],
  },
  {
    type: 'action.s3',
    group: 'action',
    label: 'Store to S3',
    description: 'Upload an in-memory blob (text/JSON/base64) to the app bucket.',
    inputs: ['in'],
    outputs: ['out'],
    fields: [
      { key: 'key', type: 'string', label: 'Key', help: 'Object key; templated.' },
      { key: 'content', type: 'text', label: 'Content', help: 'String/JSON/template. Objects are JSON-encoded.' },
      { key: 'base64', type: 'boolean', label: 'Base64', help: 'Decode content from base64 before upload.' },
      { key: 'contentType', type: 'string', label: 'Content-Type' },
    ],
  },
  {
    type: 'action.http',
    group: 'action',
    label: 'HTTP POST',
    description: 'POST a mapped JSON body to any URL (SSRF-guarded).',
    inputs: ['in'],
    outputs: ['out', 'error'],
    fields: [
      { key: 'url', type: 'string', label: 'URL' },
      { key: 'body', type: 'json', label: 'Body', help: 'Templated; defaults to the trigger payload.' },
      { key: 'headers', type: 'json', label: 'Headers' },
    ],
  },
  {
    type: 'action.ai',
    group: 'action',
    label: 'Analyze with AI',
    description:
      'Send a prompt (optionally with an image) to OpenAI/DeepSeek and capture ' +
      'the reply — budget-guarded.',
    inputs: ['in'],
    outputs: ['out'],
    fields: [
      { key: 'prompt', type: 'text', label: 'Prompt' },
      { key: 'system', type: 'text', label: 'System prompt' },
      { key: 'imageUrl', type: 'string', label: 'Image URL', help: 'Templated, e.g. {{snap.url}}.' },
      { key: 'jsonMode', type: 'boolean', label: 'JSON mode' },
      { key: 'maxTokens', type: 'number', label: 'Max tokens' },
    ],
  },
  {
    type: 'action.emit',
    group: 'action',
    label: 'Emit event',
    description: "Dispatch a streamflow.* event through the app's signed callbacks + MQTT.",
    inputs: ['in'],
    outputs: ['out'],
    fields: [
      {
        key: 'event',
        type: 'select',
        label: 'Event',
        options: [
          { value: 'streamflow.output', label: 'streamflow.output' },
          { value: 'streamflow.run_finished', label: 'streamflow.run_finished' },
          { value: 'streamflow.run_failed', label: 'streamflow.run_failed' },
        ],
      },
      { key: 'payload', type: 'json', label: 'Payload' },
    ],
  },
  {
    type: 'action.mqtt',
    group: 'action',
    label: 'Publish MQTT',
    description:
      "Publish a payload to an arbitrary topic on the app's MQTT broker " +
      '(no-op when MQTT is disabled for the app).',
    inputs: ['in'],
    outputs: ['out'],
    fields: [
      { key: 'topic', type: 'string', label: 'Topic', help: 'Templated; namespaced under the app topic prefix.' },
      { key: 'payload', type: 'json', label: 'Payload', help: 'Templated; defaults to the trigger payload. Objects are JSON-encoded.' },
      { key: 'qos', type: 'number', label: 'QoS', help: '0 (default) | 1 | 2.' },
      { key: 'retain', type: 'boolean', label: 'Retain' },
    ],
  },
  {
    type: 'action.notify',
    group: 'action',
    label: 'Notify',
    description: 'Fan out via the notifier (callback/MQTT/email/Discord/Telegram).',
    inputs: ['in'],
    outputs: ['out'],
    fields: [
      { key: 'title', type: 'string', label: 'Title' },
      { key: 'payload', type: 'json', label: 'Payload' },
      { key: 'channels', type: 'json', label: 'Channels', help: 'Array subset, e.g. ["discord"].' },
    ],
  },
  {
    type: 'action.plugin',
    group: 'action',
    label: 'Call plugin',
    description: "POST an event to another installed plugin's /events channel.",
    inputs: ['in'],
    outputs: ['out', 'error'],
    fields: [
      { key: 'plugin', type: 'string', label: 'Plugin id' },
      { key: 'event', type: 'string', label: 'Event name' },
      { key: 'data', type: 'json', label: 'Data' },
      { key: 'token', type: 'string', label: 'Ingest token', help: "The target worker's ingest token." },
    ],
  },
  // --- Logic ------------------------------------------------------------------
  {
    type: 'logic.condition',
    group: 'logic',
    label: 'Condition',
    description: 'Branch true/false on a safe typed comparison over the bag.',
    inputs: ['in'],
    outputs: ['true', 'false'],
    fields: [
      { key: 'match', type: 'select', label: 'Match', options: [
        { value: 'all', label: 'All (AND)' },
        { value: 'any', label: 'Any (OR)' },
      ] },
      { key: 'rules', type: 'json', label: 'Rules', help: '[{field, op, value}] — op: eq/ne/gt/gte/lt/lte/contains/matches/exists/…' },
    ],
  },
  {
    type: 'logic.delay',
    group: 'logic',
    label: 'Delay',
    description: 'Wait before continuing (bounded to 60s).',
    inputs: ['in'],
    outputs: ['out'],
    fields: [{ key: 'seconds', type: 'number', label: 'Seconds' }],
  },
  {
    type: 'logic.setvar',
    group: 'logic',
    label: 'Set variable',
    description: 'Map/transform bag fields into vars for downstream boxes.',
    inputs: ['in'],
    outputs: ['out'],
    fields: [{ key: 'set', type: 'json', label: 'Set', help: '{ "vars.x": "{{trigger.plate}}" }' }],
  },
  {
    type: 'logic.switch',
    group: 'logic',
    label: 'Switch',
    description: 'Route to a port by matching a field against cases.',
    inputs: ['in'],
    outputs: ['default'],
    fields: [
      { key: 'field', type: 'string', label: 'Field' },
      { key: 'cases', type: 'json', label: 'Cases', help: '[{value, port}]' },
      { key: 'default', type: 'string', label: 'Default port' },
    ],
  },
];

/**
 * DANGEROUS execution boxes — only surfaced when the app enables
 * `streamflow.dangerousNodes`. Each runs code/commands/SQL on the server; secret
 * material (SSH key, DB DSN) is referenced as `{{secret.NAME}}`, never inline.
 */
export const DANGEROUS_BOXES: BoxSpec[] = [
  {
    type: 'action.code',
    group: 'action',
    label: 'Run code (sandbox)',
    description:
      'Run a Node.js snippet in a node:vm sandbox (no require/process, 5s ' +
      'timeout). Read `input` (the run bag), set `output`. NOT a hard security ' +
      'boundary — trusted operators only.',
    inputs: ['in'],
    outputs: ['out', 'error'],
    dangerous: true,
    fields: [
      { key: 'source', type: 'text', label: 'Code', help: 'JS: read `input`, set `output = …`.' },
      { key: 'timeoutMs', type: 'number', label: 'Timeout (ms)', help: 'Max 5000.' },
    ],
  },
  {
    type: 'action.shell',
    group: 'action',
    label: 'Run shell command',
    description:
      'Run a local command via execFile (argv array — NO shell string). Output ' +
      'captured + truncated. Server-side; trusted operators only.',
    inputs: ['in'],
    outputs: ['out', 'error'],
    dangerous: true,
    fields: [
      { key: 'command', type: 'string', label: 'Command', help: 'Executable (no shell).' },
      { key: 'args', type: 'json', label: 'Args', help: 'Array of string args (templated).' },
      { key: 'timeoutMs', type: 'number', label: 'Timeout (ms)' },
    ],
  },
  {
    type: 'action.ssh',
    group: 'action',
    label: 'Run SSH command',
    description:
      'Run a command over SSH. The private key is a secret ref ' +
      '({{secret.NAME}}), never inline. Output captured + truncated.',
    inputs: ['in'],
    outputs: ['out', 'error'],
    dangerous: true,
    fields: [
      { key: 'host', type: 'string', label: 'Host' },
      { key: 'port', type: 'number', label: 'Port', help: 'Default 22.' },
      { key: 'user', type: 'string', label: 'User' },
      { key: 'key', type: 'string', label: 'Private key', help: 'Use {{secret.NAME}} — never paste the key.' },
      { key: 'command', type: 'string', label: 'Command' },
      { key: 'timeoutMs', type: 'number', label: 'Timeout (ms)' },
    ],
  },
  {
    type: 'action.db',
    group: 'action',
    label: 'Query database',
    description:
      'Run a PARAMETERIZED SQL query on postgres/mysql. The DSN is a secret ref ' +
      '({{secret.NAME}}). Params are bound ($1/?), never interpolated. Row-limited.',
    inputs: ['in'],
    outputs: ['out', 'error'],
    dangerous: true,
    fields: [
      { key: 'engine', type: 'select', label: 'Engine', options: [
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'mysql', label: 'MySQL' },
      ] },
      { key: 'dsn', type: 'string', label: 'DSN', help: 'Use {{secret.NAME}} — a connection string.' },
      { key: 'query', type: 'text', label: 'Query', help: 'Use $1/? placeholders; NEVER string-build SQL.' },
      { key: 'params', type: 'json', label: 'Params', help: 'Array bound to the placeholders (templated).' },
      { key: 'rowLimit', type: 'number', label: 'Row limit', help: 'Default 100, max 10000.' },
    ],
  },
];

/**
 * The box catalogue for the UI. Dangerous execution boxes are included ONLY when
 * the app has `streamflow.dangerousNodes` enabled (so the palette hides them by
 * default). Import validation uses `{ dangerous: true }` so a portable workflow
 * that names an execution box still validates (it just won't run until enabled).
 */
export function boxCatalogue(opts: { dangerous?: boolean } = {}): BoxSpec[] {
  return opts.dangerous ? [...BOX_CATALOGUE, ...DANGEROUS_BOXES] : BOX_CATALOGUE;
}
