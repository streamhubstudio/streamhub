/**
 * IotMqttInService — generic per-app MQTT data-IN (internal design notes
 * section 3). The missing inbound half that makes Streamflow's `trigger.mqtt`
 * real.
 *
 * WHY A MODULE (like fleet, not a worker plugin): an always-on MQTT subscriber
 * has no HLS/RTSP stream to pull and nothing to spawn. It clones the fleet
 * subscriber pattern — REUSING the same broker config (the app's typed `mqtt:`
 * block) and the SAME SSRF-guarded client factory — but instead of writing a
 * private DB it converges every inbound broker message onto the ONE event
 * funnel: `dispatch(app,'iot.data',{topic, deviceId:undefined, data, source:
 * 'mqtt'})`. From there it fans out to MQTT-out + the signed webhook + Streamflow
 * for free (single emit site).
 *
 * Activation is config-driven (no plugin gating): an app opts in by adding a
 * `mqtt.subscribe: [{ topic }]` list to its config.yaml (read from the RAW yaml,
 * since `subscribe` is not part of the typed/frozen AppConfig — same additive
 * raw-read the notifier uses for its `notifications:` block). Every path is
 * best-effort and NEVER throws into boot or the caller.
 */
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as yaml from 'js-yaml';

import { ConfigService } from '../../shared/config/config.service';
import {
  APPS_SERVICE,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbacksServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  MqttConfig,
} from '../../shared/contracts';
import {
  FleetMqttClientFactory,
  FleetMqttClientLike,
} from '../fleet/fleet-mqtt.factory';
import { IOT_MQTT_FACTORY } from './iot-mqtt.factory';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** How often the reconcile runs (connect/drop subscribers as config changes). */
const RECONCILE_MS = 20_000;
/** Hard cap on subscriptions per app (a config typo can't open thousands). */
const MAX_SUBSCRIPTIONS = 64;
/** Max broker-message body forwarded as `data` (bytes) — bounds the event. */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** One resolved subscription from the app's `mqtt.subscribe` list. */
interface Subscription {
  /** MQTT topic filter to subscribe to (wildcards `+`/`#` allowed). */
  topic: string;
}

interface Subscriber {
  client: FleetMqttClientLike;
  fingerprint: string;
  attempts: number;
  errorLogged: boolean;
  topics: string[];
}

@Injectable()
export class IotMqttInService implements OnModuleInit, OnModuleDestroy {
  private readonly subs = new Map<string, Subscriber>();
  private timer?: ReturnType<typeof setInterval>;
  /** Set false in unit specs (constructed directly) to skip the boot loop. */
  autoReconcile = true;

  constructor(
    private readonly config: ConfigService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks: CallbacksServiceContract,
    @Inject(IOT_MQTT_FACTORY) private readonly factory: FleetMqttClientFactory,
  ) {}

  onModuleInit(): void {
    if (!this.autoReconcile) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    for (const [app] of this.subs) this.dropSubscriber(app);
  }

  // ---------------------------------------------------------------------------
  // Reconcile / connection management
  // ---------------------------------------------------------------------------

  /** Bring subscribers in line with each app's `mqtt.subscribe` config. */
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
    for (const app of [...this.subs.keys()]) {
      if (!apps.includes(app)) this.dropSubscriber(app);
    }
  }

  /**
   * Ensure a subscriber exists (and is current) for `app` iff its `mqtt:` block
   * is enabled with a broker URL AND its `mqtt.subscribe` list is non-empty;
   * otherwise drop any existing one. Returns the resolved subscriptions (or null
   * when data-in is inactive for the app).
   */
  async ensureForApp(app: string): Promise<Subscription[] | null> {
    let cfg: MqttConfig | undefined;
    try {
      const appCfg = await this.apps.getConfig(app);
      cfg = appCfg.mqtt;
    } catch {
      this.dropSubscriber(app);
      return null;
    }
    if (!cfg || !cfg.enabled || !cfg.url?.trim()) {
      this.dropSubscriber(app);
      return null;
    }
    const topics = this.readSubscriptions(app);
    if (topics.length === 0) {
      this.dropSubscriber(app);
      return null;
    }
    this.ensureClient(app, cfg, topics);
    return topics.map((topic) => ({ topic }));
  }

  private ensureClient(app: string, cfg: MqttConfig, topics: string[]): void {
    const fingerprint = [
      cfg.url,
      cfg.username,
      cfg.password,
      cfg.tls,
      topics.slice().sort().join(','),
    ]
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
        clientId: `streamhub-iot-${app}-${randomUUID().slice(0, 8)}`,
        reconnectPeriodMs: RECONNECT_BASE_MS,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      // A rejected/unsafe broker URL (SSRF guard in the factory) lands here.
      this.warn(app, 'iot mqtt client creation failed', err);
      return;
    }

    const sub: Subscriber = {
      client,
      fingerprint,
      attempts: 0,
      errorLogged: false,
      topics,
    };
    this.subs.set(app, sub);

    const subscribe = () => {
      try {
        client.subscribe(topics, { qos: qosOf(cfg.qos) }, (err) => {
          if (err) this.warn(app, 'iot subscribe failed', err);
        });
      } catch (err) {
        this.warn(app, 'iot subscribe threw', err);
      }
    };

    try {
      client.on('connect', () => {
        sub.attempts = 0;
        sub.errorLogged = false;
        client.options.reconnectPeriod = RECONNECT_BASE_MS;
        subscribe();
        this.logs.write('info', 'iot', 'subscribed to inbound MQTT topics', {
          app,
          topics,
        });
      });
      client.on('message', (...args: unknown[]) => {
        const topic = String(args[0] ?? '');
        const payload = args[1];
        const text =
          typeof payload === 'string'
            ? payload
            : payload != null &&
                typeof (payload as { toString?: unknown }).toString ===
                  'function'
              ? (payload as { toString: () => string }).toString()
              : '';
        this.onMessage(app, topic, text);
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
        this.warn(app, 'iot broker connection error', err);
      });
      // A client already connected (fake in tests) won't fire 'connect'.
      if (client.connected) subscribe();
    } catch (err) {
      this.warn(app, 'iot client wiring failed', err);
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

  /**
   * Route one inbound broker message into the event funnel as `iot.data`. The
   * broker already filtered by the subscription, so `topic` is the concrete
   * topic. `data` is the parsed JSON when the body is valid JSON, else the raw
   * string (bounded). Public for unit tests; never throws.
   */
  onMessage(app: string, topic: string, payload: string): void {
    try {
      if (!topic) return;
      const raw =
        payload.length > MAX_MESSAGE_BYTES
          ? payload.slice(0, MAX_MESSAGE_BYTES)
          : payload;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
      void this.callbacks
        .dispatch(app, 'iot.data', {
          topic,
          deviceId: undefined,
          data,
          source: 'mqtt',
        })
        .catch(() => undefined);
    } catch (err) {
      this.warn(app, 'iot message handling failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Read the per-app `mqtt.subscribe` list from the RAW config.yaml (the typed
   * AppConfig doesn't carry it). Each entry is `{ topic: string }` (or a bare
   * string); invalid/empty entries are dropped, the list is deduped + capped.
   * Best-effort -> [].
   */
  private readSubscriptions(app: string): string[] {
    try {
      const file = path.join(this.config.dataDir, 'apps', app, 'config.yaml');
      const parsed = yaml.load(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return [];
      const mqtt = (parsed as Record<string, unknown>).mqtt;
      if (!mqtt || typeof mqtt !== 'object') return [];
      const list = (mqtt as Record<string, unknown>).subscribe;
      if (!Array.isArray(list)) return [];
      const topics: string[] = [];
      for (const entry of list) {
        const topic = topicOf(entry);
        if (topic && !topics.includes(topic)) topics.push(topic);
        if (topics.length >= MAX_SUBSCRIPTIONS) break;
      }
      return topics;
    } catch {
      return [];
    }
  }

  private warn(app: string, message: string, err: unknown): void {
    try {
      this.logs.write('warn', 'iot', message, {
        app,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* logging must never throw */
    }
  }
}

/** Extract a bounded, non-empty topic filter from a subscribe-list entry. */
function topicOf(entry: unknown): string | null {
  const raw =
    typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>).topic
        : undefined;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  // Reject whitespace/oversize; MQTT topic filters may contain +, #, /, ., -.
  if (!t || t.length > 256 || /\s/.test(t)) return null;
  return t;
}

function qosOf(v: unknown): 0 | 1 | 2 {
  return v === 1 || v === 2 ? v : 0;
}
