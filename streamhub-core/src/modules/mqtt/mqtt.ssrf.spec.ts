/**
 * Unit spec — MQTT broker URL SSRF guard (fix P0-1).
 *
 * The per-app `mqtt.url` is TENANT-controlled and the core CONNECTS to it —
 * an SSRF/port-probe sink toward metadata & internal services. Locks down:
 *   - MqttService.mqttConfig() (the async, authoritative gate): a broker URL
 *     that is / resolves to a private address builds NO client and publishes
 *     nothing (never throws),
 *   - the sync factory-level check (assertSafeBrokerUrl) blocks private IP
 *     literals + forbidden schemes with zero DNS,
 *   - STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER=1 (default off) is the on-prem
 *     escape; schemes stay enforced.
 *
 * Factory + DNS are fakes — nothing opens a socket.
 */
import { BadRequestException } from '@nestjs/common';

import { MqttService } from './mqtt.service';
import { assertSafeBrokerUrl } from './mqtt-client.factory';
import { ALLOW_PRIVATE_MQTT_BROKER_ENV } from '../security/egress-url.guard';
import type { MqttConfig } from '../../shared/contracts';
import { mockAppsService, mockLogsService } from '../../../test/helpers';

function mqttConfig(url: string): MqttConfig {
  return {
    enabled: true,
    url,
    username: '',
    password: '',
    topicPrefix: 'streamhub/live',
    qos: 0,
    tls: false,
    events: ['all'],
    logs: { enabled: false, level: 'info' },
  };
}

describe('MqttService — broker URL SSRF guard (fire-time)', () => {
  let apps: ReturnType<typeof mockAppsService>;
  let logs: ReturnType<typeof mockLogsService>;
  let factory: jest.Mock;
  let svc: MqttService;
  const prevEscape = process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV];

  beforeEach(() => {
    apps = mockAppsService();
    logs = mockLogsService();
    factory = jest.fn(() => ({
      connected: true,
      options: {},
      publish: jest.fn((_t: string, _p: string, _o: object, cb?: () => void) => cb?.()),
      end: jest.fn(),
      on: jest.fn(),
    }));
    svc = new MqttService(apps as never, logs as never, factory as never);
    svc.hostResolver = async (hostname: string) => {
      if (hostname === 'broker.internal.lan') return ['10.20.30.40'];
      if (hostname === 'broker.example.com') return ['93.184.216.34'];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    delete process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV];
  });

  afterEach(() => {
    svc.onModuleDestroy();
    if (prevEscape === undefined) delete process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV];
    else process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV] = prevEscape;
  });

  async function publishWith(url: string): Promise<void> {
    apps.getConfig.mockResolvedValue({ mqtt: mqttConfig(url) } as never);
    await svc.publishEvent('live', 'stream_started', { room: 'live-1' });
  }

  it('builds NO client for a metadata-IP broker URL', async () => {
    await publishWith('mqtt://169.254.169.254:1883');
    expect(factory).not.toHaveBeenCalled();
    expect(logs.write).toHaveBeenCalledWith(
      'warn',
      'mqtt',
      expect.stringContaining('SSRF'),
      expect.anything(),
    );
  });

  it('builds NO client when the broker hostname RESOLVES to RFC1918', async () => {
    await publishWith('mqtt://broker.internal.lan:1883');
    expect(factory).not.toHaveBeenCalled();
  });

  it('still connects + publishes to a public broker', async () => {
    await publishWith('mqtt://broker.example.com:1883');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER=1 admits an on-prem broker', async () => {
    process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV] = '1';
    await publishWith('mqtt://192.168.1.20:1883');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('never throws on a blocked broker (best-effort contract)', async () => {
    apps.getConfig.mockResolvedValue({
      mqtt: mqttConfig('mqtt://127.0.0.1:1883'),
    } as never);
    await expect(
      svc.publishEvent('live', 'vod_ready', {}),
    ).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('assertSafeBrokerUrl — sync factory-level check (no DNS)', () => {
  const prevEscape = process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV];
  beforeEach(() => delete process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV]);
  afterEach(() => {
    if (prevEscape === undefined) delete process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV];
    else process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV] = prevEscape;
  });

  it.each([
    'mqtt://169.254.169.254:1883',
    'mqtt://127.0.0.1:1883',
    'mqtt://10.0.0.5:1883',
    'ws://[::1]:9001/mqtt',
  ])('throws on the private IP literal %s', (url) => {
    expect(() => assertSafeBrokerUrl(url)).toThrow(BadRequestException);
  });

  it('throws on a non-broker scheme, even with the escape set', () => {
    process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV] = '1';
    expect(() => assertSafeBrokerUrl('http://broker:1883')).toThrow(
      BadRequestException,
    );
  });

  it('passes public literals/hostnames; the escape admits private literals', () => {
    expect(() => assertSafeBrokerUrl('mqtts://93.184.216.34:8883')).not.toThrow();
    expect(() => assertSafeBrokerUrl('mqtt://broker.lan:1883')).not.toThrow();
    process.env[ALLOW_PRIVATE_MQTT_BROKER_ENV] = '1';
    expect(() => assertSafeBrokerUrl('mqtt://192.168.0.2:1883')).not.toThrow();
  });
});
