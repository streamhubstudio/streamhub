/**
 * Unit spec — CallbacksService MQTT tap (per-app MQTT event publishing).
 *
 * dispatch() is the single funnel every outbound event flows through; the tap
 * mirrors each event to MQTT_SERVICE.publishEvent. Locks down:
 *   - every dispatched event reaches the MQTT sink (same app/event/payload),
 *   - MQTT fan-out happens EVEN WITHOUT a webhook URL (an app may be
 *     MQTT-only) and when config loading fails,
 *   - the webhook POST still fires alongside the tap,
 *   - an exploding MQTT sink never breaks webhook delivery (never-throws).
 *
 * global.fetch is stubbed and the MQTT sink is the contract mock — nothing in
 * this suite touches the network.
 */
import { CallbacksService } from './callbacks.service';
import {
  mockAppsService,
  mockLogsService,
  mockMqttService,
} from '../../../test/helpers';

describe('CallbacksService — MQTT tap', () => {
  let apps: ReturnType<typeof mockAppsService>;
  let logs: ReturnType<typeof mockLogsService>;
  let mqtt: ReturnType<typeof mockMqttService>;
  let svc: CallbacksService;
  let realFetch: typeof global.fetch;

  beforeEach(() => {
    apps = mockAppsService();
    logs = mockLogsService();
    mqtt = mockMqttService();
    svc = new CallbacksService(apps as never, logs as never, undefined, mqtt);
    realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }) as never);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('mirrors a dispatched event to MQTT with the same app/event/payload', async () => {
    apps.getConfig.mockResolvedValue({
      callbacks: { url: 'https://hook.test/cb', secret: 's' },
    } as never);

    await svc.dispatch('live', 'vod_ready', { room: 'live-1', vodId: 7 });

    expect(mqtt.publishEvent).toHaveBeenCalledWith('live', 'vod_ready', {
      room: 'live-1',
      vodId: 7,
    });
    // The webhook POST still fires alongside the tap.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('publishes to MQTT even when NO callback URL is configured', async () => {
    apps.getConfig.mockResolvedValue({ callbacks: { url: '' } } as never);

    await svc.dispatch('live', 'stream_started', { room: 'live-1' });

    expect(mqtt.publishEvent).toHaveBeenCalledWith('live', 'stream_started', {
      room: 'live-1',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('publishes to MQTT even when the callbacks config load fails', async () => {
    apps.getConfig.mockRejectedValue(new Error('no such app'));

    await svc.dispatch('live', 'stream_ended', { room: 'live-1' });

    // The MQTT sink does its own config gating — the tap always forwards.
    expect(mqtt.publishEvent).toHaveBeenCalledWith('live', 'stream_ended', {
      room: 'live-1',
    });
  });

  it('an exploding MQTT sink never breaks webhook delivery', async () => {
    apps.getConfig.mockResolvedValue({
      callbacks: { url: 'https://hook.test/cb', secret: 's' },
    } as never);
    mqtt.publishEvent.mockRejectedValue(new Error('broker down'));

    await expect(
      svc.dispatch('live', 'recording_ready', { room: 'live-1' }),
    ).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('works without an MQTT sink at all (optional dependency)', async () => {
    const bare = new CallbacksService(apps as never, logs as never);
    apps.getConfig.mockResolvedValue({
      callbacks: { url: 'https://hook.test/cb' },
    } as never);
    await expect(
      bare.dispatch('live', 'stream_started', { room: 'r' }),
    ).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
