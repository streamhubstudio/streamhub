/**
 * Unit spec — MqttService (mqtt module).
 *
 * Exercises the per-app MQTT client manager + publisher fully in-process: the
 * MQTT_CLIENT_FACTORY seam is a jest fake (EventEmitter-backed), so NOTHING in
 * this suite can open a socket. Locks down:
 *   - the publish envelope `{event, app, timestamp, data}` + topic layout,
 *   - "disabled / no URL → no client, no publish",
 *   - the `events` filter,
 *   - lazy reconfigure (fingerprint change → clean end + fresh client) and
 *     disconnectApp (clean disconnect on config change / app delete),
 *   - reconnect backoff (reconnectPeriod grows on close, resets on connect),
 *   - log forwarding gates (enabled, min level, 'mqtt' source loop guard),
 *   - the never-throws contract.
 */
import { EventEmitter } from 'node:events';

import { MqttService } from './mqtt.service';
import type {
  MqttClientLike,
  MqttConnectOptions,
} from './mqtt-client.factory';
import type { MqttConfig } from '../../shared/contracts';
import { mockAppsService, mockLogsService } from '../../../test/helpers';

class FakeMqttClient extends EventEmitter implements MqttClientLike {
  connected = false;
  options: { reconnectPeriod?: number };
  publish = jest.fn(
    (
      _topic: string,
      _payload: string,
      _opts: { qos: 0 | 1 | 2; retain?: boolean },
      cb?: (err?: Error) => void,
    ) => {
      cb?.();
      return this;
    },
  );
  end = jest.fn(() => this);

  constructor(public readonly connectOpts: MqttConnectOptions) {
    super();
    this.options = { reconnectPeriod: connectOpts.reconnectPeriodMs };
  }
}

function mqttConfig(overrides: Partial<MqttConfig> = {}): MqttConfig {
  return {
    enabled: true,
    url: 'mqtt://broker.test:1883',
    username: 'user1',
    password: 'pw-secret',
    topicPrefix: 'streamhub/live',
    qos: 0,
    tls: false,
    events: ['all'],
    logs: { enabled: false, level: 'info' },
    ...overrides,
  };
}

describe('MqttService', () => {
  let apps: ReturnType<typeof mockAppsService>;
  let logs: ReturnType<typeof mockLogsService>;
  let created: FakeMqttClient[];
  let factory: jest.Mock;
  let svc: MqttService;

  function withConfig(cfg: MqttConfig | undefined): void {
    apps.getConfig.mockResolvedValue({ mqtt: cfg } as never);
  }

  function lastClient(): FakeMqttClient {
    expect(created.length).toBeGreaterThan(0);
    return created[created.length - 1];
  }

  beforeEach(() => {
    apps = mockAppsService();
    logs = mockLogsService();
    created = [];
    factory = jest.fn((opts: MqttConnectOptions) => {
      const c = new FakeMqttClient(opts);
      created.push(c);
      return c;
    });
    svc = new MqttService(apps as never, logs as never, factory as never);
  });

  afterEach(() => {
    svc.onModuleDestroy();
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Publish on stream event (happy path)
  // ---------------------------------------------------------------------------

  it('publishes the {event, app, timestamp, data} envelope on a stream event', async () => {
    withConfig(mqttConfig());
    await svc.publishEvent('live', 'stream_started', {
      room: 'live-1',
      streamId: 'live-1/pub',
    });

    const client = lastClient();
    expect(client.publish).toHaveBeenCalledTimes(1);
    const [topic, payload, opts] = client.publish.mock.calls[0] as [
      string,
      string,
      { qos: number; retain?: boolean },
    ];
    expect(topic).toBe('streamhub/live/connection/stream_started');
    expect(opts).toEqual({ qos: 0, retain: false });
    const body = JSON.parse(payload);
    expect(body).toMatchObject({
      event: 'stream_started',
      app: 'live',
      data: { room: 'live-1', streamId: 'live-1/pub' },
    });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    // Exactly the specified envelope — no extra top-level keys.
    expect(Object.keys(body).sort()).toEqual([
      'app',
      'data',
      'event',
      'timestamp',
    ]);
  });

  it('routes events into their topic categories', async () => {
    withConfig(mqttConfig());
    await svc.publishEvent('live', 'vod_ready', { room: 'live-1' });
    await svc.publishEvent('live', 'plugin_worker_error', { plugin: 'yolo' });
    await svc.publishEvent('live', 'stream.latency_high', { room: 'live-1' });
    await svc.publishEvent('live', 'chat_message', { room: 'live-1' });
    await svc.publishEvent('live', 'ingress_started', { room: 'live-1' });

    const topics = lastClient().publish.mock.calls.map((c) => c[0]);
    expect(topics).toEqual([
      'streamhub/live/vod/vod_ready',
      'streamhub/live/plugin/plugin_worker_error',
      'streamhub/live/alert/stream.latency_high',
      'streamhub/live/interaction/chat_message',
      'streamhub/live/connection/ingress_started',
    ]);
  });

  it('connects with the app credentials and honours qos', async () => {
    withConfig(mqttConfig({ qos: 1 }));
    await svc.publishEvent('live', 'stream_started', { room: 'r' });

    expect(factory).toHaveBeenCalledTimes(1);
    const opts = lastClient().connectOpts;
    expect(opts.url).toBe('mqtt://broker.test:1883');
    expect(opts.username).toBe('user1');
    expect(opts.password).toBe('pw-secret');
    expect(lastClient().publish.mock.calls[0][2]).toEqual({
      qos: 1,
      retain: false,
    });
  });

  it('falls back to streamhub/<app> when topicPrefix is empty', async () => {
    withConfig(mqttConfig({ topicPrefix: '' }));
    await svc.publishEvent('cam', 'stream_started', { room: 'r' });
    expect(lastClient().publish.mock.calls[0][0]).toBe(
      'streamhub/cam/connection/stream_started',
    );
  });

  // ---------------------------------------------------------------------------
  // Disabled / missing config → no client, no publish
  // ---------------------------------------------------------------------------

  it('does not create a client nor publish when mqtt is disabled', async () => {
    withConfig(mqttConfig({ enabled: false }));
    await svc.publishEvent('live', 'stream_started', { room: 'r' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not publish when the URL is empty', async () => {
    withConfig(mqttConfig({ url: '  ' }));
    await svc.publishEvent('live', 'stream_started', { room: 'r' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not publish (and never throws) when the app is gone', async () => {
    apps.getConfig.mockRejectedValue(new Error('no such app'));
    await expect(
      svc.publishEvent('ghost', 'stream_started', { room: 'r' }),
    ).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('drops the live client when the app turns mqtt off', async () => {
    jest.useFakeTimers();
    withConfig(mqttConfig());
    await svc.publishEvent('live', 'stream_started', { room: 'r' });
    const client = lastClient();

    withConfig(mqttConfig({ enabled: false }));
    jest.advanceTimersByTime(11_000); // expire the config cache
    await svc.publishEvent('live', 'stream_ended', { room: 'r' });

    expect(client.end).toHaveBeenCalled();
    expect(client.publish).toHaveBeenCalledTimes(1); // only the first event
  });

  // ---------------------------------------------------------------------------
  // Event filter
  // ---------------------------------------------------------------------------

  it('publishes only listed events when events is an explicit list', async () => {
    withConfig(mqttConfig({ events: ['vod_ready', 'stream.latency_high'] }));
    await svc.publishEvent('live', 'stream_started', { room: 'r' });
    await svc.publishEvent('live', 'vod_ready', { room: 'r' });
    await svc.publishEvent('live', 'stream.latency_high', { room: 'r' });

    const topics = lastClient().publish.mock.calls.map((c) => c[0]);
    expect(topics).toEqual([
      'streamhub/live/vod/vod_ready',
      'streamhub/live/alert/stream.latency_high',
    ]);
  });

  // ---------------------------------------------------------------------------
  // Reconfigure + disconnect
  // ---------------------------------------------------------------------------

  it('ends the old client and builds a new one when the broker config changes', async () => {
    jest.useFakeTimers();
    withConfig(mqttConfig());
    await svc.publishEvent('live', 'stream_started', { room: 'r' });
    const first = lastClient();

    withConfig(mqttConfig({ url: 'mqtts://other.test:8883', tls: true }));
    jest.advanceTimersByTime(11_000); // expire the config cache
    await svc.publishEvent('live', 'stream_ended', { room: 'r' });

    expect(created).toHaveLength(2);
    expect(first.end).toHaveBeenCalled();
    expect(created[1].connectOpts.url).toBe('mqtts://other.test:8883');
    expect(created[1].publish).toHaveBeenCalledTimes(1);
  });

  it('disconnectApp cleanly ends the client and the next publish reconnects', async () => {
    withConfig(mqttConfig());
    await svc.publishEvent('live', 'stream_started', { room: 'r' });
    const first = lastClient();

    await svc.disconnectApp('live');
    expect(first.end).toHaveBeenCalled();

    await svc.publishEvent('live', 'stream_ended', { room: 'r' });
    expect(created).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Reconnect backoff
  // ---------------------------------------------------------------------------

  it('backs off reconnects exponentially (capped) and resets on connect', async () => {
    withConfig(mqttConfig());
    await svc.publishEvent('live', 'stream_started', { room: 'r' });
    const client = lastClient();

    expect(client.options.reconnectPeriod).toBe(1000);
    client.emit('close');
    expect(client.options.reconnectPeriod).toBe(1000);
    client.emit('close');
    expect(client.options.reconnectPeriod).toBe(2000);
    client.emit('close');
    expect(client.options.reconnectPeriod).toBe(4000);
    for (let i = 0; i < 10; i++) client.emit('close');
    expect(client.options.reconnectPeriod).toBe(30_000); // capped

    client.emit('connect');
    expect(client.options.reconnectPeriod).toBe(1000);
  });

  it('logs a broker error only once per disconnected episode', async () => {
    withConfig(mqttConfig());
    await svc.publishEvent('live', 'stream_started', { room: 'r' });
    const client = lastClient();

    client.emit('error', new Error('ECONNREFUSED'));
    client.emit('error', new Error('ECONNREFUSED'));
    const errorLogs = logs.write.mock.calls.filter(
      (c) => c[1] === 'mqtt' && String(c[2]).includes('broker connection error'),
    );
    expect(errorLogs).toHaveLength(1);

    client.emit('connect'); // episode over → next error logs again
    client.emit('error', new Error('boom'));
    expect(
      logs.write.mock.calls.filter(
        (c) =>
          c[1] === 'mqtt' && String(c[2]).includes('broker connection error'),
      ),
    ).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Log forwarding
  // ---------------------------------------------------------------------------

  it('forwards app logs at/above the configured level to <prefix>/log/<level>', async () => {
    withConfig(mqttConfig({ logs: { enabled: true, level: 'warn' } }));
    await svc.publishLog('live', 'info', 'recording', 'below level');
    await svc.publishLog('live', 'error', 'recording', 'upload failed', {
      app: 'live',
    });

    const calls = lastClient().publish.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('streamhub/live/log/error');
    const body = JSON.parse(calls[0][1] as string);
    expect(body).toMatchObject({
      event: 'log',
      app: 'live',
      data: { level: 'error', source: 'recording', message: 'upload failed' },
    });
  });

  it('does not forward logs when mqtt.logs is disabled', async () => {
    withConfig(mqttConfig({ logs: { enabled: false, level: 'info' } }));
    await svc.publishLog('live', 'error', 'recording', 'x');
    expect(factory).not.toHaveBeenCalled();
  });

  it("skips the mqtt module's own log lines (loop guard)", async () => {
    withConfig(mqttConfig({ logs: { enabled: true, level: 'trace' } }));
    await svc.publishLog('live', 'warn', 'mqtt', 'publish failed');
    expect(factory).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Never throws
  // ---------------------------------------------------------------------------

  it('never throws when the client factory blows up', async () => {
    withConfig(mqttConfig());
    factory.mockImplementation(() => {
      throw new Error('cannot connect');
    });
    await expect(
      svc.publishEvent('live', 'stream_started', { room: 'r' }),
    ).resolves.toBeUndefined();
    expect(logs.write).toHaveBeenCalledWith(
      'warn',
      'mqtt',
      expect.stringContaining('client creation failed'),
      expect.objectContaining({ app: 'live' }),
    );
  });

  it('never throws when publish itself throws', async () => {
    withConfig(mqttConfig());
    await svc.publishEvent('live', 'stream_started', { room: 'r' }); // create client
    lastClient().publish.mockImplementation(() => {
      throw new Error('not connected');
    });
    await expect(
      svc.publishEvent('live', 'stream_ended', { room: 'r' }),
    ).resolves.toBeUndefined();
  });
});
