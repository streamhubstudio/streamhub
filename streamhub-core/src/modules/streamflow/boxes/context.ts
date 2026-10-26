/**
 * Shared box-executor contracts (Streamflow engine).
 *
 * A box executor is a small, PURE-ISH async function of (box, ctx, deps): it
 * reads the mutable run `bag` through templates, calls injected capability
 * functions (`deps`) — never a core service directly — and returns an output +
 * an optional branch port. This keeps every executor unit-testable with a fake
 * `deps` and no NestJS/DI.
 */

/** A resolved graph box (from workflow graph_json). */
export interface BoxNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

/** Snapshot capture result (subset of StreamsService.snapshot). */
export interface SnapshotResult {
  key: string;
  url: string;
}

/** Input to the AI box (superset of the raw prompt/vision options). */
export interface AiBoxInput {
  app: string;
  appDir: string;
  prompt: string;
  system?: string;
  imageUrl?: string;
  imageBase64?: string;
  jsonMode?: boolean;
  maxTokens?: number;
}

export interface AiBoxResult {
  text: string;
  usageTokens: number;
  /** Parsed JSON when the model returned valid JSON, else undefined. */
  json?: unknown;
}

export interface HttpPostResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Result of a dangerous execution box (code/shell/ssh/db). */
export interface ExecResult {
  ok: boolean;
  /** Sandbox `output` / db rows / command result payload. */
  output?: unknown;
  /** Process/db exit or row count where meaningful. */
  code?: number | null;
  stdout?: string;
  stderr?: string;
  rowCount?: number;
  error?: string;
}

/**
 * Capability seam handed to executors. The runner adapts the real core services
 * (StreamsService / S3Service / AiClient / NotifierService / CallbacksService /
 * SSRF-guarded fetch) into these narrow functions; specs pass fakes.
 */
export interface BoxDeps {
  snapshot(input: {
    app: string;
    room: string;
    participantIdentity?: string;
  }): Promise<SnapshotResult>;
  s3Upload(input: {
    app: string;
    key: string;
    body: Buffer;
    contentType?: string;
  }): Promise<{ key: string; url: string }>;
  ai(input: AiBoxInput): Promise<AiBoxResult>;
  httpPost(input: {
    url: string;
    body: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<HttpPostResult>;
  emit(input: {
    app: string;
    event: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  /** Publish a raw payload to an arbitrary MQTT topic on the app's broker. */
  mqttPublish(input: {
    app: string;
    topic: string;
    payload: unknown;
    qos?: 0 | 1 | 2;
    retain?: boolean;
  }): Promise<void>;
  notify(input: {
    app: string;
    event: string;
    payload: Record<string, unknown>;
    title?: string;
    channels?: string[];
  }): Promise<void>;
  pluginEvent(input: {
    app: string;
    pluginId: string;
    event: string;
    data: Record<string, unknown>;
    room?: string;
    token?: string;
    url?: string;
  }): Promise<{ ok: boolean; status: number }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log?(
    level: 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ): void;
  // --- DANGEROUS execution seams (flag-gated; see boxes/executors) -----------
  /** Run a Node.js snippet in a node:vm sandbox (no require/process, hard timeout). */
  runCode?(input: {
    source: string;
    input: unknown;
    timeoutMs: number;
    maxOutputBytes: number;
  }): Promise<ExecResult>;
  /** Run a local command via execFile (argv array — no shell interpolation). */
  runShell?(input: {
    command: string;
    args: string[];
    timeoutMs: number;
    maxOutputBytes: number;
  }): Promise<ExecResult>;
  /** Run a command over SSH (private key already resolved from a secret ref). */
  runSsh?(input: {
    host: string;
    port: number;
    user: string;
    privateKey: string;
    passphrase?: string;
    command: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }): Promise<ExecResult>;
  /** Run a PARAMETERIZED SQL query (dsn already resolved from a secret ref). */
  runDb?(input: {
    engine: 'postgres' | 'mysql';
    dsn: string;
    query: string;
    params: unknown[];
    rowLimit: number;
    timeoutMs: number;
  }): Promise<ExecResult>;
}

/** Execution context threaded through a run. */
export interface BoxContext {
  app: string;
  appDir: string;
  /** Whether the app enabled dangerous execution nodes (streamflow.dangerousNodes). */
  dangerousEnabled?: boolean;
  /** The trigger that started the run. */
  trigger: { event: string; payload: Record<string, unknown> };
  /**
   * The mutable run bag flowing along edges:
   *   { event, trigger: <payload>, vars: {}, <boxId>: <output>, ... }
   * Executors read it through templates; the runner writes each box output.
   */
  bag: Record<string, unknown>;
}

export interface BoxOutput {
  /** Value stored into the bag under this box's id. */
  output?: unknown;
  /** Branch port that fired (default 'out'); condition→true|false, switch→case. */
  port?: string;
}

export type BoxExecutor = (
  box: BoxNode,
  ctx: BoxContext,
  deps: BoxDeps,
) => Promise<BoxOutput>;

/** Build a fresh run bag from a trigger. */
export function newBag(
  event: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { event, trigger: payload ?? {}, vars: {} };
}
