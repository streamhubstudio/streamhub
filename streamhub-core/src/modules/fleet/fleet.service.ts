/**
 * FleetService — the in-core MQTT glue for the `fleet` plugin.
 *
 * WHY A MODULE, NOT A WORKER PLUGIN: a fleet needs an ALWAYS-ON MQTT subscriber
 * (agents publish telemetry/status unprompted) plus a command PUBLISHER — there
 * is no HLS/RTSP stream to pull and nothing to spawn, so the `needsWorker`
 * child-process machinery doesn't fit. This is pure MQTT I/O, so it lives as a
 * small feature module (`modules/fleet`) that REUSES the existing MQTT seam
 * (FLEET_MQTT_FACTORY → the same `mqtt` package + SSRF guard the mqtt module
 * uses) and the app's existing per-app `mqtt:` broker config (NO second broker).
 * The `fleet` plugin manifest (src/plugins/fleet) only provides the marketplace
 * entry + app-tab UI slot + config schema; this service does the work and only
 * activates for apps where that plugin is installed + enabled.
 *
 * Lifecycle: a periodic reconcile (RECONCILE_MS) — plus an on-demand
 * ensureForApp() when the dashboard reads — connects/drops one subscriber per
 * eligible app, subscribes to `<prefix>/agents/+/{telemetry,status,cmd/result}`
 * and maintains the per-app fleet.db (registry + rolling history + commands).
 * Every path is best-effort and never throws into the caller.
 */
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  APPS_SERVICE,
  AppsServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  MqttConfig,
} from '../../shared/contracts';
import { normalizePrefix } from '../mqtt/mqtt-events';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import {
  FLEET_MQTT_FACTORY,
  FleetMqttClientFactory,
  FleetMqttClientLike,
} from './fleet-mqtt.factory';
import {
  AgentStatus,
  FleetCommandResult,
  commandTopic,
  fleetSubscriptions,
  parseFleetTopic,
  parseTelemetry,
  validateCommand,
} from './fleet.protocol';
import { AgentRow, CommandRow, FleetStore, HistoryPoint } from './fleet.store';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** How often the reconcile + stale-reaper runs. */
const RECONCILE_MS = 20_000;

/** Resolved per-app fleet knobs (fleet plugin config, defaults applied). */
export interface FleetConfig {
  offlineAfterSec: number;
  historyPoints: number;
  commandTimeoutSec: number;
}

const DEFAULT_FLEET_CONFIG: FleetConfig = {
  offlineAfterSec: 90,
  historyPoints: 120,
  commandTimeoutSec: 30,
};

interface Subscriber {
  client: FleetMqttClientLike;
  fingerprint: string;
  attempts: number;
  errorLogged: boolean;
  /** The resolved topic prefix (e.g. `streamhub/<app>`). */
  prefix: string;
}

/** Serializable agent view returned by the data route. */
export interface AgentView {
  agentId: string;
  online: boolean;
  status: 'online' | 'offline';
  version: string | null;
  lastSeen: string;
  ageMs: number | null;
  metrics: {
    cpu: number | null;
    mem: number | null;
    temp: number | null;
    uptime: number | null;
    cameras: number | null;
    disk: number | null;
    relay: string | null;
  };
}

@Injectable()
export class FleetService implements OnModuleInit, OnModuleDestroy {
  private readonly subs = new Map<string, Subscriber>();
  private timer?: ReturnType<typeof setInterval>;
  /** Set false in unit specs (constructed directly) to skip the boot loop. */
  autoReconcile = true;

  constructor(
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    private readonly repo: AppPluginsRepository,
    private readonly store: FleetStore,
    @Inject(FLEET_MQTT_FACTORY) private readonly factory: FleetMqttClientFactory,
  ) {}

  onModuleInit(): void {
    if (!this.autoReconcile) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS);
    // Don't keep the event loop alive just for the reconcile timer.
    (this.timer as { unref?: () => void }).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    for (const [app] of this.subs) this.dropSubscriber(app);
  }

  // ---------------------------------------------------------------------------
  // Reconcile / connection management
  // ---------------------------------------------------------------------------

  /** Bring subscribers in line with install state for every app. */
  async reconcile(): Promise<void> {
    let apps: string[] = [];
    try {
      apps = (await this.apps.list()).map((a) => a.name);
    } catch {
      return;
    }
    for (const app of apps) {
      try {
        await this.ensureForApp(app);
      } catch (err) {
        this.warn(app, 'reconcile failed', err);
      }
    }
    // Drop subscribers for apps that vanished.
    for (const app of [...this.subs.keys()]) {
      if (!apps.includes(app)) this.dropSubscriber(app);
    }
  }

  /**
   * Ensure a subscriber exists (and is current) for `app` iff the fleet plugin
   * is installed + enabled AND the app has an MQTT broker configured; otherwise
   * drop any existing one. Also reaps stale agents to offline. Returns the
   * resolved prefix (or null when fleet is inactive for the app).
   */
  async ensureForApp(app: string): Promise<string | null> {
    const row = this.repo.get(app, 'fleet');
    if (!row || !row.enabled) {
      this.dropSubscriber(app);
      return null;
    }
    let cfg: MqttConfig | undefined;
    let appDir = '';
    try {
      const appCfg = await this.apps.getConfig(app);
      cfg = appCfg.mqtt;
      appDir = this.apps.appDir(app);
    } catch {
      this.dropSubscriber(app);
      return null;
    }
    if (!cfg || !cfg.enabled || !cfg.url?.trim()) {
      this.dropSubscriber(app);
      return null;
    }
    const prefix = normalizePrefix(cfg.topicPrefix?.trim() || '') ||
      `streamhub/${app}`;

    // Reap agents that stopped sending telemetry (offline without a clean LWT).
    const fleetCfg = this.fleetConfig(app);
    try {
      const flipped = this.store.reapStale(
        app,
        appDir,
        fleetCfg.offlineAfterSec * 1000,
      );
      for (const id of flipped) {
        this.logs.write('info', 'fleet', `agent '${id}' went offline (stale)`, {
          app,
        });
      }
    } catch (err) {
      this.warn(app, 'stale reap failed', err);
    }

    this.ensureClient(app, cfg, prefix);
    return prefix;
  }

  private ensureClient(app: string, cfg: MqttConfig, prefix: string): void {
    const fingerprint = [cfg.url, cfg.username, cfg.password, cfg.tls, prefix]
      .map(String)
      .join(' ');
    const existing = this.subs.get(app);
    if (existing && existing.fingerprint === fingerprint) return;
    if (existing) this.dropSubscriber(app);

    let client: FleetMqttClientLike;
    try {
      client = this.factory({
        url: cfg.url,
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        tls: !!cfg.tls,
        clientId: `streamhub-fleet-${app}-${randomUUID().slice(0, 8)}`,
        reconnectPeriodMs: RECONNECT_BASE_MS,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      this.warn(app, 'fleet mqtt client creation failed', err);
      return;
    }

    const sub: Subscriber = {
      client,
      fingerprint,
      attempts: 0,
      errorLogged: false,
      prefix,
    };
    this.subs.set(app, sub);

    const subscribe = () => {
      try {
        client.subscribe(
          fleetSubscriptions(prefix),
          { qos: MqttConfigQos(cfg.qos) },
          (err) => {
            if (err) this.warn(app, 'fleet subscribe failed', err);
          },
        );
      } catch (err) {
        this.warn(app, 'fleet subscribe threw', err);
      }
    };

    try {
      client.on('connect', () => {
        sub.attempts = 0;
        sub.errorLogged = false;
        client.options.reconnectPeriod = RECONNECT_BASE_MS;
        subscribe();
        this.logs.write('info', 'fleet', 'subscribed to agent telemetry', {
          app,
          prefix,
        });
      });
      client.on('message', (...args: unknown[]) => {
        const topic = String(args[0] ?? '');
        const payload = args[1];
        const text =
          typeof payload === 'string'
            ? payload
            : payload != null && typeof (payload as { toString?: unknown }).toString === 'function'
              ? (payload as { toString: () => string }).toString()
              : '';
        this.onMessage(app, prefix, topic, text);
      });
      client.on('close', () => {
        sub.attempts += 1;
        client.options.reconnectPeriod = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** Math.max(0, sub.attempts - 1),
        );
      });
      client.on('error', (err) => {
        if (sub.errorLogged) return;
        sub.errorLogged = true;
        this.warn(app, 'fleet broker connection error', err);
      });
      // A client that is already connected (fake in tests) won't fire 'connect';
      // subscribe immediately so it's wired up regardless.
      if (client.connected) subscribe();
    } catch (err) {
      this.warn(app, 'fleet client wiring failed', err);
    }
  }

  private dropSubscriber(app: string): void {
    const sub = this.subs.get(app);
    if (!sub) return;
    this.subs.delete(app);
    try {
      sub.client.end(true);
    } catch {
      /* already dead */
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound message routing
  // ---------------------------------------------------------------------------

  /** Route one inbound MQTT message into the store. Public for unit tests. */
  onMessage(app: string, prefix: string, topic: string, payload: string): void {
    const parsed = parseFleetTopic(prefix, topic);
    if (!parsed) return;
    let appDir = '';
    try {
      appDir = this.apps.appDir(app);
    } catch {
      return;
    }
    const cfg = this.fleetConfig(app);
    try {
      if (parsed.kind === 'telemetry') {
        const t = parseTelemetry(payload);
        if (!t) return;
        this.store.recordTelemetry(
          app,
          appDir,
          parsed.agentId,
          t,
          cfg.historyPoints,
        );
      } else if (parsed.kind === 'status') {
        const s = parseStatus(payload);
        this.store.setStatus(
          app,
          appDir,
          parsed.agentId,
          s.status,
          s.agentVersion ?? null,
        );
      } else if (parsed.kind === 'cmd_result') {
        const res = parseResult(payload);
        if (res && res.id) {
          const applied = this.store.resolveCommand(app, appDir, res);
          if (applied) {
            this.logs.write(
              'info',
              'fleet',
              `command '${res.id}' resolved (${res.ok ? 'ok' : 'error'})`,
              { app, agentId: parsed.agentId },
            );
          }
        }
      }
    } catch (err) {
      this.warn(app, `failed to handle ${parsed.kind}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (controller)
  // ---------------------------------------------------------------------------

  /** Agents + latest metrics for the data route (wakes the subscriber). */
  async getData(app: string): Promise<{ agents: AgentView[]; generatedAt: string }> {
    const prefix = await this.ensureForApp(app);
    const appDir = this.apps.appDir(app);
    if (prefix === null) {
      // Fleet inactive: still surface whatever history exists (may be empty).
    }
    const rows = this.store.listAgents(app, appDir);
    return {
      agents: rows.map((r) => this.toView(r)),
      generatedAt: new Date().toISOString(),
    };
  }

  /** One agent + its metric history + recent commands. */
  async getAgent(
    app: string,
    agentId: string,
  ): Promise<{
    agent: AgentView | null;
    history: HistoryPoint[];
    commands: CommandRow[];
  }> {
    await this.ensureForApp(app);
    const appDir = this.apps.appDir(app);
    const row = this.store.getAgent(app, appDir, agentId);
    const cfg = this.fleetConfig(app);
    return {
      agent: row ? this.toView(row) : null,
      history: this.store.history(app, appDir, agentId, cfg.historyPoints),
      commands: this.store.commandsFor(app, appDir, agentId, 20),
    };
  }

  /**
   * Publish a command to an agent and record it (pending). The async result
   * arrives on `.../cmd/result` and resolves the row. Throws on validation /
   * when fleet has no live broker (→ mapped to 400/409 at the controller via
   * FleetCommandError / the returned error string). Returns the command record.
   */
  async sendCommand(
    app: string,
    agentId: string,
    command: unknown,
    args: unknown,
  ): Promise<CommandRow> {
    const id = randomUUID();
    const { command: name, args: normArgs } = validateCommand(command, args);
    const prefix = await this.ensureForApp(app);
    const sub = this.subs.get(app);
    if (prefix === null || !sub) {
      throw new FleetInactiveError(
        `fleet is not active for app '${app}' (install+enable the fleet plugin and configure mqtt)`,
      );
    }
    const appDir = this.apps.appDir(app);
    this.store.recordCommand(app, appDir, id, agentId, name, normArgs);

    const envelope = JSON.stringify({
      id,
      command: name,
      args: normArgs,
      ts: new Date().toISOString(),
    });
    try {
      sub.client.publish(
        commandTopic(prefix, agentId),
        envelope,
        { qos: 1, retain: false },
        (err) => {
          if (err) this.warn(app, `command publish to '${agentId}' failed`, err);
        },
      );
    } catch (err) {
      this.warn(app, `command publish to '${agentId}' threw`, err);
    }
    this.logs.write(
      'info',
      'fleet',
      `command '${name}' → agent '${agentId}' (${id})`,
      { app, agentId, command: name },
    );
    return this.store.getCommand(app, appDir, id) as CommandRow;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private fleetConfig(app: string): FleetConfig {
    const row = this.repo.get(app, 'fleet');
    const c = (row?.config ?? {}) as Record<string, unknown>;
    return {
      offlineAfterSec: numCfg(c.offlineAfterSec, DEFAULT_FLEET_CONFIG.offlineAfterSec),
      historyPoints: numCfg(c.historyPoints, DEFAULT_FLEET_CONFIG.historyPoints),
      commandTimeoutSec: numCfg(
        c.commandTimeoutSec,
        DEFAULT_FLEET_CONFIG.commandTimeoutSec,
      ),
    };
  }

  private toView(r: AgentRow): AgentView {
    const t = r.telemetry ?? {};
    const ageMs = r.lastSeen ? Date.now() - Date.parse(r.lastSeen) : null;
    return {
      agentId: r.agentId,
      online: r.status === 'online',
      status: r.status,
      version: r.version ?? (typeof t.agentVersion === 'string' ? t.agentVersion : null),
      lastSeen: r.lastSeen,
      ageMs: Number.isFinite(ageMs as number) ? (ageMs as number) : null,
      metrics: {
        cpu: numMetric(t.cpu),
        mem: numMetric(t.mem),
        temp: numMetric(t.temp),
        uptime: numMetric(t.uptime),
        cameras: numMetric(t.cameras),
        disk: numMetric(t.disk),
        relay: typeof t.relay === 'string' ? t.relay : null,
      },
    };
  }

  private warn(app: string, message: string, err: unknown): void {
    try {
      this.logs.write('warn', 'fleet', message, {
        app,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* logging must never throw */
    }
  }
}

/** Thrown when a command is issued but fleet has no live broker for the app. */
export class FleetInactiveError extends Error {}

function MqttConfigQos(v: unknown): 0 | 1 | 2 {
  return v === 1 || v === 2 ? v : 0;
}

function numCfg(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function numMetric(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseStatus(raw: string): AgentStatus {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const status = o.status === 'online' ? 'online' : 'offline';
    return {
      status,
      agentVersion: typeof o.agentVersion === 'string' ? o.agentVersion : undefined,
    };
  } catch {
    // A bare LWT payload like "offline"/"online".
    const s = raw.trim().toLowerCase();
    return { status: s === 'online' ? 'online' : 'offline' };
  }
}

function parseResult(raw: string): FleetCommandResult | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || typeof o.id !== 'string') return null;
    return {
      ...o,
      id: o.id,
      command: typeof o.command === 'string' ? o.command : undefined,
      ok: o.ok === true,
      message: typeof o.message === 'string' ? o.message : undefined,
      ts: typeof o.ts === 'string' ? o.ts : undefined,
    } as FleetCommandResult;
  } catch {
    return null;
  }
}
