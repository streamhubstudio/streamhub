/**
 * FLEET MQTT PROTOCOL — the ONE definition of the topic layout + JSON payload
 * schemas the StreamHub `fleet` plugin and the StreamHub Agent share.
 *
 * Pure (no I/O, no Nest) so it runs under jest and can be referenced by the
 * docs generator. The full spec lives in https://streamhub.studio/docs/features/fleet.
 *
 * Topic namespace (per app, rooted at the app's MQTT `topicPrefix`, default
 * `streamhub/<app>`):
 *
 *   <prefix>/agents/<agentId>/telemetry    agent → broker   (retained: last)
 *   <prefix>/agents/<agentId>/status       agent → broker   (retained, MQTT LWT)
 *   <prefix>/agents/<agentId>/cmd           broker → agent
 *   <prefix>/agents/<agentId>/cmd/result   agent → broker
 *
 * The core subscribes to the wildcard forms (`.../agents/+/telemetry` etc.) so
 * a single subscription covers every agent in the app.
 */

/** MQTT wildcard subscriptions the core opens per app (one subscribe covers all agents). */
export function fleetSubscriptions(prefix: string): string[] {
  const base = normalizeFleetPrefix(prefix);
  return [
    `${base}/agents/+/telemetry`,
    `${base}/agents/+/status`,
    `${base}/agents/+/cmd/result`,
  ];
}

/** Topic the core publishes a command to for a specific agent. */
export function commandTopic(prefix: string, agentId: string): string {
  return `${normalizeFleetPrefix(prefix)}/agents/${agentId}/cmd`;
}

/** The agents-root a topic must sit under to be a fleet topic. */
export function agentsRoot(prefix: string): string {
  return `${normalizeFleetPrefix(prefix)}/agents/`;
}

/** Strip a trailing slash from a topic prefix (mirrors mqtt-events.normalizePrefix). */
export function normalizeFleetPrefix(prefix: string): string {
  return (prefix || '').replace(/\/+$/, '');
}

/**
 * Parse an inbound fleet topic into `{ agentId, kind }`. Returns null when the
 * topic is not one of ours (wrong prefix / shape). `kind` is the message class:
 *   telemetry | status | cmd_result
 */
export function parseFleetTopic(
  prefix: string,
  topic: string,
): { agentId: string; kind: 'telemetry' | 'status' | 'cmd_result' } | null {
  const root = agentsRoot(prefix);
  if (!topic.startsWith(root)) return null;
  const rest = topic.slice(root.length); // "<agentId>/telemetry" | "<id>/status" | "<id>/cmd/result"
  const parts = rest.split('/');
  const agentId = parts[0];
  if (!agentId) return null;
  const tail = parts.slice(1).join('/');
  if (tail === 'telemetry') return { agentId, kind: 'telemetry' };
  if (tail === 'status') return { agentId, kind: 'status' };
  if (tail === 'cmd/result') return { agentId, kind: 'cmd_result' };
  return null;
}

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

/** Telemetry snapshot an agent publishes on `.../telemetry` (retained). */
export interface AgentTelemetry {
  /** Percent 0–100. */
  cpu?: number;
  /** Percent 0–100. */
  mem?: number;
  /** Degrees C (SoC/CPU temp) — optional (not all boards expose it). */
  temp?: number;
  /** Seconds the agent process (or host) has been up. */
  uptime?: number;
  /** Agent build/version string (drives OTA compare). */
  agentVersion?: string;
  /** Number of cameras/relays the agent is currently running. */
  cameras?: number;
  /** RTSP→RTMP relay state, e.g. 'running' | 'idle' | 'error'. */
  relay?: string;
  /** Root-filesystem usage percent 0–100. */
  disk?: number;
  /** Free-form extras (ignored by the core registry but stored in the raw JSON). */
  [k: string]: unknown;
}

/** Status message an agent publishes on `.../status` (retained; LWT = offline). */
export interface AgentStatus {
  status: 'online' | 'offline';
  agentVersion?: string;
  ts?: string;
}

/** The four commands the fleet supports (broker → agent). */
export type FleetCommandName = 'restart' | 'ota' | 'config' | 'ping';

export const FLEET_COMMANDS: readonly FleetCommandName[] = [
  'restart',
  'ota',
  'config',
  'ping',
] as const;

/** Command envelope the core publishes on `.../cmd`. */
export interface FleetCommand {
  /** Correlation id echoed back on `.../cmd/result`. */
  id: string;
  command: FleetCommandName;
  args: Record<string, unknown>;
  /** ISO-8601 issue time. */
  ts: string;
}

/** Result envelope the agent publishes on `.../cmd/result`. */
export interface FleetCommandResult {
  id: string;
  command?: string;
  ok: boolean;
  message?: string;
  ts?: string;
  [k: string]: unknown;
}

/** OTA command args (`ota`): download URL + target version + integrity hash. */
export interface OtaArgs {
  url: string;
  version: string;
  sha256: string;
}

export class FleetCommandError extends Error {}

/**
 * Validate + normalize a `{command, args}` request into the args that will be
 * published. Throws FleetCommandError (→ 400 at the controller) on an unknown
 * command or missing required args. Keeping this pure makes the auth/route
 * behaviour unit-testable without a broker.
 */
export function validateCommand(
  command: unknown,
  args: unknown,
): { command: FleetCommandName; args: Record<string, unknown> } {
  if (typeof command !== 'string' || !FLEET_COMMANDS.includes(command as FleetCommandName)) {
    throw new FleetCommandError(
      `unknown command '${String(command)}' (allowed: ${FLEET_COMMANDS.join(', ')})`,
    );
  }
  const name = command as FleetCommandName;
  const bag: Record<string, unknown> =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  if (name === 'ota') {
    const url = str(bag.url);
    const version = str(bag.version);
    const sha256 = str(bag.sha256).toLowerCase();
    if (!url) throw new FleetCommandError("ota requires 'url'");
    if (!/^https?:\/\//i.test(url)) {
      throw new FleetCommandError('ota url must be http(s)');
    }
    if (!version) throw new FleetCommandError("ota requires 'version'");
    // A 64-hex SHA-256 is mandatory: the agent refuses to swap a build whose
    // hash does not match (integrity is the ONLY thing gating a remote binary
    // replace — see the OTA security model in fleet.md).
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new FleetCommandError('ota requires a 64-hex sha256');
    }
    return { command: name, args: { url, version, sha256 } };
  }

  if (name === 'config') {
    const cfg =
      bag.config && typeof bag.config === 'object' && !Array.isArray(bag.config)
        ? (bag.config as Record<string, unknown>)
        : bag;
    if (!cfg || Object.keys(cfg).length === 0) {
      throw new FleetCommandError('config requires a non-empty object');
    }
    return { command: name, args: { config: cfg } };
  }

  // restart / ping take no args.
  return { command: name, args: {} };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Coerce a value to a finite number in [min,max], or undefined. */
export function num(v: unknown, min = -Infinity, max = Infinity): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** Parse an inbound telemetry JSON buffer/string into a normalized snapshot. */
export function parseTelemetry(raw: string): AgentTelemetry | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  // Some agents wrap the metrics under a `data` key (the core's own MQTT
  // envelope shape); unwrap it so both shapes work.
  const src =
    o.data && typeof o.data === 'object' && !Array.isArray(o.data)
      ? (o.data as Record<string, unknown>)
      : o;
  return {
    ...src,
    cpu: num(src.cpu, 0, 100),
    mem: num(src.mem, 0, 100),
    temp: num(src.temp),
    uptime: num(src.uptime, 0),
    cameras: num(src.cameras, 0),
    disk: num(src.disk, 0, 100),
    agentVersion:
      typeof src.agentVersion === 'string' ? src.agentVersion : undefined,
    relay: typeof src.relay === 'string' ? src.relay : undefined,
  };
}
