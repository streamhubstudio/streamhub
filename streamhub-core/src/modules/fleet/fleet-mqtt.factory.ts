/**
 * Fleet MQTT client factory — the ONE seam between FleetService and the `mqtt`
 * npm package for the SUBSCRIBE side (the outbound publish-only path lives in
 * the mqtt module's MqttClientLike). FleetService needs `subscribe` + inbound
 * `message` events, which MqttClientLike deliberately doesn't expose, so this
 * module defines a slightly richer surface. Unit tests bind FLEET_MQTT_FACTORY
 * to an EventEmitter fake — NOTHING in a spec opens a socket.
 *
 * The broker URL is TLS-resolved + SSRF-checked by REUSING the mqtt module's
 * helpers (single source of truth for the scheme allowlist + private-address
 * rejection) — this factory adds no new security policy.
 */
import {
  assertSafeBrokerUrl,
  resolveBrokerUrl,
} from '../mqtt/mqtt-client.factory';

export const FLEET_MQTT_FACTORY = Symbol('FLEET_MQTT_FACTORY');

/** Slice of `mqtt.MqttClient` the fleet subscriber uses (publish + subscribe). */
export interface FleetMqttClientLike {
  connected: boolean;
  options: { reconnectPeriod?: number };
  subscribe(
    topic: string | string[],
    opts: { qos: 0 | 1 | 2 },
    callback?: (err: Error | null) => void,
  ): unknown;
  publish(
    topic: string,
    payload: string,
    opts: { qos: 0 | 1 | 2; retain?: boolean },
    callback?: (err?: Error) => void,
  ): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  end(force?: boolean, opts?: object, callback?: () => void): unknown;
}

export interface FleetMqttConnectOptions {
  url: string;
  username?: string;
  password?: string;
  tls: boolean;
  clientId: string;
  reconnectPeriodMs: number;
  connectTimeoutMs: number;
}

export type FleetMqttClientFactory = (
  opts: FleetMqttConnectOptions,
) => FleetMqttClientLike;

/**
 * Production factory: `mqtt.connect` with auto-reconnect. Lazy-requires the
 * package so importing this file from a spec costs nothing. Reuses the mqtt
 * module's URL resolution + SSRF guard.
 */
export const defaultFleetMqttClientFactory: FleetMqttClientFactory = (opts) => {
  const target = resolveBrokerUrl(opts.url, opts.tls);
  assertSafeBrokerUrl(target);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mqtt = require('mqtt') as {
    connect: (url: string, o: object) => FleetMqttClientLike;
  };
  return mqtt.connect(target, {
    clientId: opts.clientId,
    clean: true,
    reconnectPeriod: opts.reconnectPeriodMs,
    connectTimeout: opts.connectTimeoutMs,
    ...(opts.username ? { username: opts.username } : {}),
    ...(opts.password ? { password: opts.password } : {}),
  });
};
