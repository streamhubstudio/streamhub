/**
 * Box executors (Streamflow engine) — one small function per box type.
 *
 * Each `execute(box, ctx, deps)` reads the run bag through templates
 * (boxes/path), calls the injected capability seam (`deps`) — never a core
 * service directly — and returns `{ output, port? }`. The runner keys the output
 * into the bag under the box id and follows the edges leaving the returned port.
 * Every executor is pure of I/O beyond `deps`, so specs drive them with fakes.
 */
import { evalCondition, evalSwitch, type ConditionConfig, type SwitchConfig } from './expr';
import { getPath, resolveString, resolveValue, setPath } from './path';
import type { BoxDeps, BoxExecutor, BoxNode, BoxContext } from './context';

/** Event names an `action.emit` / lifecycle dispatch may use. */
export const STREAMFLOW_EMIT_EVENTS = [
  'streamflow.run_started',
  'streamflow.run_finished',
  'streamflow.run_failed',
  'streamflow.output',
] as const;

/** Coerce an emit event name to the declared allowlist (default output). */
export function normalizeEmitEvent(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  return (STREAMFLOW_EMIT_EVENTS as readonly string[]).includes(n)
    ? n
    : 'streamflow.output';
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ---------------------------------------------------------------------------
// Triggers — entry boxes. Their output is the trigger payload; the real
// firing/scheduling/subscription lives in StreamflowService.
// ---------------------------------------------------------------------------

const triggerExecutor: BoxExecutor = async (_box, ctx) => ({
  output: ctx.trigger.payload,
  port: 'out',
});

/**
 * Does a `trigger.event` box's config match a dispatched event? Used by the
 * service to decide whether to enqueue a run. Pure + never throws.
 */
export function matchesEventTrigger(
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>,
): boolean {
  const cfg = config ?? {};
  if (!eventNameMatches(cfg.event, event)) return false;

  const room = typeof cfg.room === 'string' ? cfg.room.trim() : '';
  if (room && String(payload?.room ?? '') !== room) return false;

  const wantTags = Array.isArray(cfg.tags)
    ? cfg.tags.map((t) => String(t)).filter(Boolean)
    : [];
  if (wantTags.length) {
    const have = extractTags(payload);
    if (!wantTags.some((t) => have.includes(t))) return false;
  }

  const predicate = cfg.predicate as ConditionConfig | undefined;
  if (predicate && Array.isArray(predicate.rules) && predicate.rules.length) {
    const bag = { event, trigger: payload ?? {} };
    if (!evalCondition(predicate, bag)) return false;
  }
  return true;
}

function eventNameMatches(pattern: unknown, event: string): boolean {
  const p = typeof pattern === 'string' ? pattern.trim() : '';
  if (!p || p === '*' || p === 'all') return true;
  if (p.endsWith('.*')) return event.startsWith(p.slice(0, -1)); // 'plate.' → plate.detected
  return event === p;
}

/**
 * Does a `trigger.mqtt` box match an `iot.data` event? The box's `topic` field
 * is an MQTT-style topic filter checked against `payload.topic` (the concrete
 * topic of the ws-ingest data frame / broker message). Empty filter = any topic.
 * Pure + never throws. This is what makes the shipped `trigger.mqtt` box fire
 * end-to-end (internal design notes section 4).
 */
export function matchesMqttTrigger(
  config: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  const filter = typeof config?.topic === 'string' ? config.topic.trim() : '';
  const topic = typeof payload?.topic === 'string' ? payload.topic : '';
  if (!filter || filter === '#' || filter === '*') return true;
  if (!topic) return false;
  return topicMatches(filter, topic);
}

/**
 * MQTT topic-filter match: `+` matches exactly one level, `#` matches the rest,
 * `*` is accepted as an alias for `#` (glob-style). Levels are `/`-separated.
 */
export function topicMatches(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    const seg = f[i];
    if (seg === '#' || seg === '*') return true; // matches the remaining levels
    if (i >= t.length) return false;
    if (seg === '+') continue; // single-level wildcard
    if (seg !== t[i]) return false;
  }
  return f.length === t.length;
}

function extractTags(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(payload?.tags)) out.push(...payload.tags.map((t) => String(t)));
  if (typeof payload?.tag === 'string') out.push(payload.tag);
  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const snapshotExecutor: BoxExecutor = async (box, ctx, deps) => {
  const room =
    resolveString(box.config.room, ctx.bag) ||
    String(ctx.trigger.payload?.room ?? '');
  if (!room) throw new Error('action.snapshot: no room (config.room / trigger.room)');
  const participant = resolveString(box.config.participantIdentity, ctx.bag) || undefined;
  const res = await deps.snapshot({ app: ctx.app, room, participantIdentity: participant });
  return { output: res, port: 'out' };
};

const s3Executor: BoxExecutor = async (box, ctx, deps) => {
  const content = resolveValue(box.config.content, ctx.bag);
  const base64 = box.config.base64 === true;
  let body: Buffer;
  if (base64 && typeof content === 'string') {
    body = Buffer.from(content, 'base64');
  } else if (typeof content === 'string') {
    body = Buffer.from(content, 'utf8');
  } else {
    body = Buffer.from(JSON.stringify(content ?? {}), 'utf8');
  }
  const key =
    resolveString(box.config.key, ctx.bag) ||
    `streamflow/${box.id}-${deps.now()}`;
  const contentType = resolveString(box.config.contentType, ctx.bag) || undefined;
  const res = await deps.s3Upload({ app: ctx.app, key, body, contentType });
  return { output: res, port: 'out' };
};

const httpExecutor: BoxExecutor = async (box, ctx, deps) => {
  const url = resolveString(box.config.url, ctx.bag);
  if (!url) throw new Error('action.http: config.url is required');
  const body =
    box.config.body === undefined
      ? ctx.bag.trigger
      : resolveValue(box.config.body, ctx.bag);
  const headers = asObject(resolveValue(box.config.headers, ctx.bag)) as Record<
    string,
    string
  >;
  const res = await deps.httpPost({ url, body, headers });
  return { output: res, port: res.ok ? 'out' : 'error' };
};

const aiExecutor: BoxExecutor = async (box, ctx, deps) => {
  const prompt = resolveString(box.config.prompt, ctx.bag);
  if (!prompt) throw new Error('action.ai: config.prompt is required');
  const res = await deps.ai({
    app: ctx.app,
    appDir: ctx.appDir,
    prompt,
    system: resolveString(box.config.system, ctx.bag) || undefined,
    imageUrl: resolveString(box.config.imageUrl, ctx.bag) || undefined,
    imageBase64: resolveString(box.config.imageBase64, ctx.bag) || undefined,
    jsonMode: box.config.jsonMode === true,
    maxTokens:
      typeof box.config.maxTokens === 'number' ? box.config.maxTokens : undefined,
  });
  return { output: res, port: 'out' };
};

const emitExecutor: BoxExecutor = async (box, ctx, deps) => {
  const event = normalizeEmitEvent(box.config.event);
  const payload = asObject(
    box.config.payload === undefined
      ? ctx.bag.trigger
      : resolveValue(box.config.payload, ctx.bag),
  );
  await deps.emit({ app: ctx.app, event, payload });
  return { output: { event }, port: 'out' };
};

const mqttExecutor: BoxExecutor = async (box, ctx, deps) => {
  const topic = resolveString(box.config.topic, ctx.bag);
  if (!topic) throw new Error('action.mqtt: config.topic is required');
  const payload =
    box.config.payload === undefined
      ? ctx.bag.trigger
      : resolveValue(box.config.payload, ctx.bag);
  const qos =
    box.config.qos === 1 || box.config.qos === 2
      ? (box.config.qos as 1 | 2)
      : 0;
  const retain = box.config.retain === true;
  await deps.mqttPublish({ app: ctx.app, topic, payload, qos, retain });
  return { output: { topic }, port: 'out' };
};

const notifyExecutor: BoxExecutor = async (box, ctx, deps) => {
  const event = resolveString(box.config.event, ctx.bag) || 'streamflow.output';
  const payload = asObject(
    box.config.payload === undefined
      ? ctx.bag.trigger
      : resolveValue(box.config.payload, ctx.bag),
  );
  const title = resolveString(box.config.title, ctx.bag) || undefined;
  const channels = Array.isArray(box.config.channels)
    ? box.config.channels.map((c) => String(c))
    : undefined;
  await deps.notify({ app: ctx.app, event, payload, title, channels });
  return { output: { event }, port: 'out' };
};

const pluginExecutor: BoxExecutor = async (box, ctx, deps) => {
  const pluginId = resolveString(box.config.plugin, ctx.bag);
  const event = resolveString(box.config.event, ctx.bag);
  if (!pluginId || !event) {
    throw new Error('action.plugin: config.plugin and config.event are required');
  }
  const data = asObject(resolveValue(box.config.data, ctx.bag));
  const room =
    resolveString(box.config.room, ctx.bag) ||
    String(ctx.trigger.payload?.room ?? '') ||
    undefined;
  const token = resolveString(box.config.token, ctx.bag) || undefined;
  const url = resolveString(box.config.url, ctx.bag) || undefined;
  const res = await deps.pluginEvent({ app: ctx.app, pluginId, event, data, room, token, url });
  return { output: res, port: res.ok ? 'out' : 'error' };
};

// ---------------------------------------------------------------------------
// DANGEROUS execution boxes (flag-gated: streamflow.dangerousNodes).
//
// Every one refuses unless ctx.dangerousEnabled is true (belt with the catalogue
// hiding them from the palette + the config default of OFF). They never build a
// shell string / interpolate SQL — the runner adapts node:vm / execFile / ssh2 /
// pg|mysql2 into the deps seam; secret refs ({{secret.NAME}} → key/dsn) are
// resolved by the runner BEFORE the executor runs, never inline in the graph.
// ---------------------------------------------------------------------------

export const DANGEROUS_TYPES = new Set([
  'action.code',
  'action.shell',
  'action.ssh',
  'action.db',
]);

export function isDangerousType(type: string): boolean {
  return DANGEROUS_TYPES.has(type);
}

/** Throw a uniform refusal when execution nodes are disabled for the app. */
function assertDangerousEnabled(ctx: BoxContext, type: string): void {
  if (!ctx.dangerousEnabled) {
    throw new Error(
      `${type}: execution nodes are disabled (enable streamflow.dangerousNodes)`,
    );
  }
}

const CODE_TIMEOUT_DEFAULT = 5_000;
const CODE_TIMEOUT_MAX = 5_000;
const SHELL_TIMEOUT_DEFAULT = 10_000;
const SSH_TIMEOUT_DEFAULT = 15_000;
const DB_TIMEOUT_DEFAULT = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DB_ROW_LIMIT_DEFAULT = 100;
const DB_ROW_LIMIT_MAX = 10_000;

function boundedTimeout(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

const codeExecutor: BoxExecutor = async (box, ctx, deps) => {
  assertDangerousEnabled(ctx, 'action.code');
  if (!deps.runCode) throw new Error('action.code: sandbox not available');
  const source = resolveString(box.config.source, ctx.bag);
  if (!source) throw new Error('action.code: config.source is required');
  const res = await deps.runCode({
    source,
    input: ctx.bag,
    timeoutMs: boundedTimeout(box.config.timeoutMs, CODE_TIMEOUT_DEFAULT, CODE_TIMEOUT_MAX),
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  return { output: res, port: res.ok ? 'out' : 'error' };
};

const shellExecutor: BoxExecutor = async (box, ctx, deps) => {
  assertDangerousEnabled(ctx, 'action.shell');
  if (!deps.runShell) throw new Error('action.shell: not available');
  const command = resolveString(box.config.command, ctx.bag);
  if (!command) throw new Error('action.shell: config.command is required');
  const rawArgs = resolveValue(box.config.args, ctx.bag);
  const args = Array.isArray(rawArgs) ? rawArgs.map((a) => String(a)) : [];
  const res = await deps.runShell({
    command,
    args,
    timeoutMs: boundedTimeout(box.config.timeoutMs, SHELL_TIMEOUT_DEFAULT, 60_000),
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  return { output: res, port: res.ok ? 'out' : 'error' };
};

const sshExecutor: BoxExecutor = async (box, ctx, deps) => {
  assertDangerousEnabled(ctx, 'action.ssh');
  if (!deps.runSsh) throw new Error('action.ssh: not available');
  const host = resolveString(box.config.host, ctx.bag);
  const user = resolveString(box.config.user, ctx.bag);
  const command = resolveString(box.config.command, ctx.bag);
  // The private key arrives already resolved from a secret ref ({{secret.NAME}}).
  const privateKey = resolveString(box.config.key, ctx.bag);
  if (!host || !user || !command) {
    throw new Error('action.ssh: config.host, config.user and config.command are required');
  }
  if (!privateKey) throw new Error('action.ssh: config.key (a {{secret.NAME}} ref) is required');
  const port = boundedTimeout(box.config.port, 22, 65535);
  const res = await deps.runSsh({
    host,
    port,
    user,
    privateKey,
    passphrase: resolveString(box.config.passphrase, ctx.bag) || undefined,
    command,
    timeoutMs: boundedTimeout(box.config.timeoutMs, SSH_TIMEOUT_DEFAULT, 120_000),
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  return { output: res, port: res.ok ? 'out' : 'error' };
};

const dbExecutor: BoxExecutor = async (box, ctx, deps) => {
  assertDangerousEnabled(ctx, 'action.db');
  if (!deps.runDb) throw new Error('action.db: not available');
  const engine = box.config.engine === 'mysql' ? 'mysql' : 'postgres';
  // The DSN arrives already resolved from a secret ref ({{secret.NAME}}).
  const dsn = resolveString(box.config.dsn, ctx.bag);
  const query = typeof box.config.query === 'string' ? box.config.query : '';
  if (!dsn) throw new Error('action.db: config.dsn (a {{secret.NAME}} ref) is required');
  if (!query.trim()) throw new Error('action.db: config.query is required');
  // PARAMETERIZED ONLY: params are resolved from the bag, never interpolated into
  // the SQL text (the query string is passed verbatim to the driver).
  const rawParams = resolveValue(box.config.params, ctx.bag);
  const params = Array.isArray(rawParams) ? rawParams : [];
  const rowLimit = boundedTimeout(box.config.rowLimit, DB_ROW_LIMIT_DEFAULT, DB_ROW_LIMIT_MAX);
  const res = await deps.runDb({
    engine,
    dsn,
    query,
    params,
    rowLimit,
    timeoutMs: boundedTimeout(box.config.timeoutMs, DB_TIMEOUT_DEFAULT, 60_000),
  });
  return { output: res, port: res.ok ? 'out' : 'error' };
};

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

const conditionExecutor: BoxExecutor = async (box, ctx) => {
  const matched = evalCondition(box.config as ConditionConfig, ctx.bag);
  return { output: { matched }, port: matched ? 'true' : 'false' };
};

const delayExecutor: BoxExecutor = async (box, ctx, deps) => {
  const seconds = Number(resolveValue(box.config.seconds, ctx.bag));
  const msCfg = Number(resolveValue(box.config.ms, ctx.bag));
  let ms = Number.isFinite(msCfg) && msCfg > 0 ? msCfg : 0;
  if (!ms && Number.isFinite(seconds) && seconds > 0) ms = seconds * 1000;
  // Bound so a single box can never wedge the worker.
  ms = Math.max(0, Math.min(ms, 60_000));
  if (ms > 0) await deps.sleep(ms);
  return { output: { delayedMs: ms }, port: 'out' };
};

const setvarExecutor: BoxExecutor = async (box, ctx) => {
  const applied: Record<string, unknown> = {};
  // Two accepted shapes: `set: { "vars.x": tmpl }` and/or
  // `assignments: [{ path, value }]`.
  const set = asObject(box.config.set);
  for (const [path, tmpl] of Object.entries(set)) {
    const v = resolveValue(tmpl, ctx.bag);
    setPath(ctx.bag, path, v);
    applied[path] = v;
  }
  const assignments = Array.isArray(box.config.assignments)
    ? box.config.assignments
    : [];
  for (const a of assignments) {
    const path = String((a as Record<string, unknown>)?.path ?? '').trim();
    if (!path) continue;
    const v = resolveValue((a as Record<string, unknown>)?.value, ctx.bag);
    setPath(ctx.bag, path, v);
    applied[path] = v;
  }
  return { output: applied, port: 'out' };
};

const switchExecutor: BoxExecutor = async (box, ctx) => {
  const cfg = box.config as unknown as SwitchConfig;
  const port = evalSwitch(cfg, ctx.bag);
  const value = getPath(ctx.bag, String(cfg.field ?? ''));
  return { output: { port, value }, port };
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const EXECUTORS: Record<string, BoxExecutor> = {
  'trigger.event': triggerExecutor,
  'trigger.schedule': triggerExecutor,
  'trigger.mqtt': triggerExecutor,
  'trigger.manual': triggerExecutor,
  'action.snapshot': snapshotExecutor,
  'action.s3': s3Executor,
  'action.http': httpExecutor,
  'action.ai': aiExecutor,
  'action.emit': emitExecutor,
  'action.mqtt': mqttExecutor,
  'action.notify': notifyExecutor,
  'action.plugin': pluginExecutor,
  'action.code': codeExecutor,
  'action.shell': shellExecutor,
  'action.ssh': sshExecutor,
  'action.db': dbExecutor,
  'logic.condition': conditionExecutor,
  'logic.delay': delayExecutor,
  'logic.setvar': setvarExecutor,
  'logic.switch': switchExecutor,
};

/** True when a box type is a trigger (an entry box with no input). */
export function isTriggerType(type: string): boolean {
  return type.startsWith('trigger.');
}

export function getExecutor(type: string): BoxExecutor | undefined {
  return EXECUTORS[type];
}

export type { BoxNode, BoxContext };
