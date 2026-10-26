/**
 * Unit spec — IotMqttInService (generic MQTT data-IN). Drives the subscriber
 * with a FAKE mqtt client (no socket, no network — repo testing rule) + a real
 * temp config.yaml, and asserts that every inbound broker message converges on
 * `dispatch(app,'iot.data',…)`. This is the inbound half that makes Streamflow's
 * `trigger.mqtt` real end-to-end.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AppConfig, MqttConfig } from '../../shared/contracts';
import type { FleetMqttClientLike } from '../fleet/fleet-mqtt.factory';
import { IotMqttInService } from './iot-mqtt-in.service';

const APP = 'live';

class FakeClient implements FleetMqttClientLike {
  connected = true;
  options: { reconnectPeriod?: number } = { reconnectPeriod: 0 };
  subscribed: string[] = [];
  ended = false;
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  subscribe(topic: string | string[], _o: { qos: 0 | 1 | 2 }, cb?: (e: Error | null) => void): unknown {
    this.subscribed.push(...(Array.isArray(topic) ? topic : [topic]));
    cb?.(null);
    return this;
  }
  publish(): unknown {
    return this;
  }
  on(event: string, fn: (...a: unknown[]) => void): unknown {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  end(): unknown {
    this.ended = true;
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
}

function mqttCfg(over: Partial<MqttConfig> = {}): MqttConfig {
  return {
    enabled: true,
    url: 'mqtt://broker.example:1883',
    username: '',
    password: '',
    topicPrefix: '',
    qos: 0,
    tls: false,
    events: ['all'],
    logs: { enabled: false, level: 'info' },
    ...over,
  };
}

describe('IotMqttInService', () => {
  let ctx: UnitContext;
  let client: FakeClient;
  let factory: jest.Mock;
  let svc: IotMqttInService;

  function writeConfig(yamlBody: string): void {
    const dir = path.join(ctx.config.dataDir, 'apps', APP);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yaml'), yamlBody);
  }

  beforeEach(() => {
    ctx = makeUnitContext();
    client = new FakeClient();
    factory = jest.fn(() => client);
    ctx.mocks.apps.list.mockResolvedValue([{ name: APP }] as never);
    ctx.mocks.apps.getConfig.mockResolvedValue({ mqtt: mqttCfg() } as AppConfig);
    svc = new IotMqttInService(
      ctx.config,
      ctx.mocks.apps,
      ctx.mocks.logs,
      ctx.mocks.callbacks,
      factory as never,
    );
    svc.autoReconcile = false;
  });

  afterEach(() => {
    svc.onModuleDestroy();
    ctx.cleanup();
  });

  it('subscribes to the app mqtt.subscribe topics and routes messages as iot.data', async () => {
    writeConfig('mqtt:\n  subscribe:\n    - topic: sensors/+/temp\n    - topic: "devices/#"\n');
    const subs = await svc.ensureForApp(APP);
    expect(subs).toEqual([{ topic: 'sensors/+/temp' }, { topic: 'devices/#' }]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.subscribed).toEqual(['sensors/+/temp', 'devices/#']);

    // A JSON body → parsed object; deviceId undefined; source mqtt.
    client.emit('message', 'sensors/a/temp', Buffer.from('{"c":22}'));
    expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(APP, 'iot.data', {
      topic: 'sensors/a/temp',
      deviceId: undefined,
      data: { c: 22 },
      source: 'mqtt',
    });

    // A non-JSON body → forwarded as the raw string.
    ctx.mocks.callbacks.dispatch.mockClear();
    client.emit('message', 'devices/x', 'hello');
    expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(APP, 'iot.data', {
      topic: 'devices/x',
      deviceId: undefined,
      data: 'hello',
      source: 'mqtt',
    });
  });

  it('does nothing (no client) when there is no subscribe list', async () => {
    writeConfig('mqtt:\n  enabled: true\n');
    const subs = await svc.ensureForApp(APP);
    expect(subs).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('drops the subscriber when mqtt is disabled', async () => {
    writeConfig('mqtt:\n  subscribe:\n    - topic: a/b\n');
    await svc.ensureForApp(APP);
    expect(factory).toHaveBeenCalledTimes(1);

    ctx.mocks.apps.getConfig.mockResolvedValue({
      mqtt: mqttCfg({ enabled: false }),
    } as AppConfig);
    const subs = await svc.ensureForApp(APP);
    expect(subs).toBeNull();
    expect(client.ended).toBe(true);
  });

  it('ignores invalid subscribe entries (bad topic / non-object)', async () => {
    writeConfig(
      'mqtt:\n  subscribe:\n    - topic: "bad topic"\n    - nope: 1\n    - topic: good/one\n',
    );
    const subs = await svc.ensureForApp(APP);
    expect(subs).toEqual([{ topic: 'good/one' }]);
  });

  it('never throws on a malformed inbound message', () => {
    expect(() => svc.onMessage(APP, '', 'x')).not.toThrow();
    expect(ctx.mocks.callbacks.dispatch).not.toHaveBeenCalled();
  });
});
