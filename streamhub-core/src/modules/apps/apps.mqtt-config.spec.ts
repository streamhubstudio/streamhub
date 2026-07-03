/**
 * Unit spec — AppsService MQTT config block (per-app MQTT event publishing).
 *
 * Exercises the `mqtt:`/`latency_alert:` config machinery against a REAL
 * migrated temp SQLite DB + real SecretsStore (harness makeUnitContext — no
 * network anywhere). Locks down the credential invariants:
 *   - the broker password NEVER lands in config.yaml (secrets.json only),
 *   - masked-on-read (getMqtt/PATCH view) but resolved for internal consumers
 *     (getConfig → MqttService),
 *   - defaults (disabled, streamhub/<app> prefix, events ['all'], qos clamp),
 *   - raw-yaml editor warns on an inline mqtt.password,
 *   - latency_alert resolves with sane defaults.
 */
import * as fs from 'fs';
import * as path from 'path';

import { AppsService } from './apps.service';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

const APP = 'mqapp';

describe('AppsService — mqtt config', () => {
  let ctx: UnitContext;
  let apps: AppsService;
  let disconnectApp: jest.Mock;

  beforeEach(async () => {
    ctx = makeUnitContext();
    disconnectApp = jest.fn(async () => undefined);
    const samplesFake = { generate: jest.fn(async () => []) };
    // ModuleRef stub: hands out the samples fake AND the mqtt disconnect hook.
    const moduleRef = {
      get: jest.fn((token: symbol) =>
        String(token).includes('MQTT')
          ? { disconnectApp }
          : samplesFake,
      ),
    } as unknown as never;
    apps = ctx.newService(
      AppsService,
      ctx.config,
      ctx.db,
      new S3Service(),
      new SecretsStore(ctx.config),
      moduleRef,
    );
    await apps.create({ name: APP });
  });

  afterEach(() => ctx.cleanup());

  function yamlText(): string {
    return fs.readFileSync(
      path.join(apps.appDir(APP), 'config.yaml'),
      'utf8',
    );
  }

  function secretsJson(): Record<string, string> {
    try {
      return JSON.parse(
        fs.readFileSync(
          path.join(ctx.config.dataDir, 'data', 'secrets.json'),
          'utf8',
        ),
      );
    } catch {
      return {};
    }
  }

  it('resolves safe defaults: disabled, streamhub/<app> prefix, events [all]', async () => {
    const cfg = await apps.getConfig(APP);
    expect(cfg.mqtt).toEqual({
      enabled: false,
      url: '',
      username: '',
      password: '',
      topicPrefix: `streamhub/${APP}`,
      qos: 0,
      tls: false,
      events: ['all'],
      logs: { enabled: false, level: 'info' },
    });
    expect(cfg.latencyAlert).toEqual({
      enabled: false,
      thresholdMs: 1000,
      cooldownSeconds: 60,
      intervalSeconds: 10,
    });
  });

  it('setMqtt writes the block to the yaml but the password ONLY to secrets.json', async () => {
    const view = await apps.setMqtt(APP, {
      enabled: true,
      url: 'mqtt://broker.test:1883',
      username: 'user1',
      password: 'super-secret-password',
      qos: 1,
      events: ['vod_ready'],
      logs: { enabled: true, level: 'warn' },
      latencyAlert: { enabled: true, thresholdMs: 800, cooldownSeconds: 30 },
    });

    // yaml carries the ref, never the value.
    const yaml = yamlText();
    expect(yaml).not.toContain('super-secret-password');
    expect(yaml).toContain('password_env: APP_MQAPP_MQTT_PASSWORD');
    expect(secretsJson().APP_MQAPP_MQTT_PASSWORD).toBe('super-secret-password');

    // Masked view (never the clear password), config persisted.
    expect(view.password).toBe('su***rd');
    expect(view.hasPassword).toBe(true);
    expect(view.configured).toBe(true);
    expect(view.qos).toBe(1);
    expect(view.events).toEqual(['vod_ready']);
    expect(view.logs).toEqual({ enabled: true, level: 'warn' });
    expect(view.latencyAlert).toMatchObject({
      enabled: true,
      thresholdMs: 800,
      cooldownSeconds: 30,
    });

    // The live client is dropped so the next publish reconnects.
    expect(disconnectApp).toHaveBeenCalledWith(APP);
  });

  it('getMqtt masks and getConfig resolves the same password', async () => {
    await apps.setMqtt(APP, { password: 'abcd1234efgh' });

    const masked = await apps.getMqtt(APP);
    expect(masked.password).toBe('ab***gh');
    expect(masked.password).not.toContain('cd1234');

    const resolved = await apps.getConfig(APP);
    expect(resolved.mqtt?.password).toBe('abcd1234efgh');
  });

  it('setMqtt without a password keeps the stored one', async () => {
    await apps.setMqtt(APP, { password: 'keep-me-around' });
    await apps.setMqtt(APP, { url: 'mqtt://other.test:1883' });
    expect(secretsJson().APP_MQAPP_MQTT_PASSWORD).toBe('keep-me-around');
    expect((await apps.getMqtt(APP)).hasPassword).toBe(true);
  });

  it('updateConfig(mqtt patch) also routes the password to secrets.json', async () => {
    await apps.updateConfig(APP, {
      mqtt: { enabled: true, password: 'patched-secret' } as never,
    });
    expect(yamlText()).not.toContain('patched-secret');
    expect(secretsJson().APP_MQAPP_MQTT_PASSWORD).toBe('patched-secret');
  });

  it('sanitizes junk: invalid qos → 0, empty events → [all], bad level → info', async () => {
    await apps.setMqtt(APP, {
      qos: 7 as never,
      events: ['  ', ''],
      logs: { level: 'loud' as never },
    });
    const cfg = await apps.getConfig(APP);
    expect(cfg.mqtt?.qos).toBe(0);
    expect(cfg.mqtt?.events).toEqual(['all']);
    expect(cfg.mqtt?.logs.level).toBe('info');
  });

  it('raw config editor warns on an inline mqtt.password (and ignores it)', async () => {
    const raw = [
      `name: ${APP}`,
      'mqtt:',
      '  enabled: true',
      '  url: mqtt://broker.test:1883',
      '  password: should-not-be-here',
    ].join('\n');
    const res = await apps.putRawConfig(APP, raw);
    expect(res.warnings.join(' ')).toContain('mqtt.password');
    // The resolver never reads an inline password — only the *_env ref.
    const cfg = await apps.getConfig(APP);
    expect(cfg.mqtt?.password).toBe('');
  });

  it('404s on unknown apps', async () => {
    await expect(apps.getMqtt('nope')).rejects.toThrow('not found');
    await expect(apps.setMqtt('nope', {})).rejects.toThrow('not found');
  });
});
