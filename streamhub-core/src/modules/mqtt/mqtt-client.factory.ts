/**
 * MQTT client factory — the ONE seam between the mqtt module and the `mqtt`
 * npm package. MqttService only ever talks to the tiny `MqttClientLike`
 * surface below, so unit tests bind MQTT_CLIENT_FACTORY to a fake and NOTHING
 * in the suite can open a real socket (CLAUDE.md: a spec that dials the
 * network is a bug).
 */

/** DI token for the factory (bound in MqttModule; overridden in tests). */
export const MQTT_CLIENT_FACTORY = Symbol('MQTT_CLIENT_FACTORY');

/** Minimal slice of `mqtt.MqttClient` the service uses. */
export interface MqttClientLike {
  /** True while the broker connection is up. */
  connected: boolean;
  /**
   * Live options bag. `reconnectPeriod` is read by mqtt.js each time it
   * schedules a reconnect, so mutating it implements incremental backoff.
   */
  options: { reconnectPeriod?: number };
  publish(
    topic: string,
    payload: string,
    opts: { qos: 0 | 1 | 2; retain?: boolean },
    callback?: (err?: Error) => void,
  ): unknown;
  end(force?: boolean, opts?: object, callback?: () => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Connection parameters resolved from the app's `mqtt:` config block. */
export interface MqttConnectOptions {
  /** Broker URL (mqtt:// | mqtts:// | ws:// | wss://). */
  url: string;
  username?: string;
  password?: string;
  /** Force TLS: mqtt://→mqtts:// and ws://→wss:// before connecting. */
  tls: boolean;
  clientId: string;
  /** Initial reconnect period in ms (mutated later for backoff). */
  reconnectPeriodMs: number;
  connectTimeoutMs: number;
}

export type MqttClientFactory = (opts: MqttConnectOptions) => MqttClientLike;

/** Apply the `tls` flag by upgrading plaintext schemes. */
export function resolveBrokerUrl(url: string, tls: boolean): string {
  const trimmed = url.trim();
  if (!tls) return trimmed;
  return trimmed
    .replace(/^mqtt:\/\//i, 'mqtts://')
    .replace(/^tcp:\/\//i, 'mqtts://')
    .replace(/^ws:\/\//i, 'wss://');
}

/**
 * Production factory: `mqtt.connect` with auto-reconnect on. Lazy-requires the
 * package so merely importing this file (e.g. from a spec) costs nothing.
 */
export const defaultMqttClientFactory: MqttClientFactory = (opts) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mqtt = require('mqtt') as {
    connect: (url: string, o: object) => MqttClientLike;
  };
  return mqtt.connect(resolveBrokerUrl(opts.url, opts.tls), {
    clientId: opts.clientId,
    clean: true,
    reconnectPeriod: opts.reconnectPeriodMs,
    connectTimeout: opts.connectTimeoutMs,
    ...(opts.username ? { username: opts.username } : {}),
    ...(opts.password ? { password: opts.password } : {}),
  });
};
