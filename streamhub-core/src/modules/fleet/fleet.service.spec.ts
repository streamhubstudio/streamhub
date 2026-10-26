/**
 * Unit spec — FleetService (fleet module).
 *
 * Drives the full in-core MQTT glue in-process: the FLEET_MQTT_FACTORY seam is
 * an EventEmitter fake (no socket), FleetStore writes to a temp fleet.db, and
 * the plugins repo + apps service are jest fakes. Locks down:
 *   - ensureForApp: connects a subscriber + subscribes to the 3 wildcards only
 *     when fleet is enabled AND mqtt is configured; drops it otherwise,
 *   - telemetry ingest → agent registry + latest metrics + history,
 *   - status/LWT → online/offline,
 *   - the command route: validates, publishes the RIGHT payload to the agent
 *     cmd topic, records it pending, then resolves it from cmd/result,
 *   - command validation (ota needs sha256) + the fleet-inactive guard,
 *   - never throws on garbage input.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FleetInactiveError, FleetService } from './fleet.service';
import { FleetCommandError } from './fleet.protocol';
import { FleetStore } from './fleet.store';
import type {
  FleetMqttClientLike,
  FleetMqttConnectOptions,
} from './fleet-mqtt.factory';
import { mockAppsService, mockLogsService } from '../../../test/helpers';

class FakeClient extends EventEmitter implements FleetMqttClientLike {
  connected = true;
  options: { reconnectPeriod?: number } = {};
  subscribe = jest.fn(
    (_t: string | string[], _o: unknown, cb?: (e: Error | null) => void) => {
      cb?.(null);
      return this;
    },
  );
  publish = jest.fn(
    (
      _t: string,
      _p: string,
      _o: unknown,
      cb?: (e?: Error) => void,
    ) => {
      cb?.();
      return this;
    },
  );
  end = jest.fn(() => this);
  constructor(public readonly connectOpts: FleetMqttConnectOptions) {
    super();
  }
}

const APP = 'live';

describe('FleetService', () => {
  let tmp: string;
  let store: FleetStore;
  let apps: ReturnType<typeof mockAppsService>;
  let logs: ReturnType<typeof mockLogsService>;
  let created: FakeClient[];
  let factory: jest.Mock;
  let repoGet: jest.Mock;
  let svc: FleetService;

  const PREFIX = 'streamhub/live';

  function setFleetEnabled(enabled: boolean, config: Record<string, unknown> = {}) {
    repoGet.mockImplementation((_app: string, id: string) =>
      id === 'fleet'
        ? { pluginId: 'fleet', enabled, config, installedAt: '', updatedAt: '' }
        : null,
    );
  }

  function setMqtt(mqtt: Record<string, unknown> | undefined) {
    apps.getConfig.mockResolvedValue({ mqtt } as never);
  }

  function lastClient(): FakeClient {
    expect(created.length).toBeGreaterThan(0);
    return created[created.length - 1];
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-svc-'));
    store = new FleetStore();
    store.fileFor = () => path.join(tmp, 'fleet.db');

    apps = mockAppsService({ appDir: () => tmp });
    apps.list.mockResolvedValue([{ name: APP } as never]);
    setMqtt({ enabled: true, url: 'mqtt://broker.test:1883', topicPrefix: '', qos: 0 });

    logs = mockLogsService();
    created = [];
    factory = jest.fn((opts: FleetMqttConnectOptions) => {
      const c = new FakeClient(opts);
      created.push(c);
      return c;
    });
    repoGet = jest.fn();
    setFleetEnabled(true);

    svc = new FleetService(
      apps as never,
      logs as never,
      { get: repoGet } as never,
      store,
      factory as never,
    );
    svc.autoReconcile = false;
  });

  afterEach(() => {
    svc.onModuleDestroy();
    store.onModuleDestroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // ensureForApp
  // ---------------------------------------------------------------------------

  it('connects + subscribes to the 3 wildcards when fleet+mqtt are on', async () => {
    const prefix = await svc.ensureForApp(APP);
    expect(prefix).toBe(PREFIX);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(lastClient().subscribe).toHaveBeenCalled();
    const [topics] = lastClient().subscribe.mock.calls[0] as [string[]];
    expect(topics).toEqual([
      'streamhub/live/agents/+/telemetry',
      'streamhub/live/agents/+/status',
      'streamhub/live/agents/+/cmd/result',
    ]);
  });

  it('does not connect when the fleet plugin is disabled', async () => {
    setFleetEnabled(false);
    expect(await svc.ensureForApp(APP)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not connect when mqtt is disabled / has no url', async () => {
    setMqtt({ enabled: false, url: 'mqtt://x:1883' });
    expect(await svc.ensureForApp(APP)).toBeNull();
    setMqtt({ enabled: true, url: '   ' });
    expect(await svc.ensureForApp(APP)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('reuses the same client across reads (stable fingerprint)', async () => {
    await svc.getData(APP);
    await svc.getData(APP);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Telemetry / status ingest
  // ---------------------------------------------------------------------------

  it('ingests telemetry from a broker message into the registry + history', async () => {
    await svc.ensureForApp(APP);
    const client = lastClient();
    client.emit(
      'message',
      'streamhub/live/agents/b09994/telemetry',
      Buffer.from(
        JSON.stringify({
          cpu: 12,
          mem: 40,
          temp: 45,
          uptime: 7200,
          cameras: 3,
          disk: 55,
          agentVersion: '1.12',
          relay: 'running',
        }),
      ),
    );

    const { agents } = await svc.getData(APP);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agentId: 'b09994',
      online: true,
      status: 'online',
      version: '1.12',
      metrics: {
        cpu: 12,
        mem: 40,
        temp: 45,
        uptime: 7200,
        cameras: 3,
        disk: 55,
        relay: 'running',
      },
    });

    const detail = await svc.getAgent(APP, 'b09994');
    expect(detail.agent?.online).toBe(true);
    expect(detail.history).toHaveLength(1);
    expect(detail.history[0].cpu).toBe(12);
  });

  it('applies a status LWT message → offline', async () => {
    await svc.ensureForApp(APP);
    const client = lastClient();
    client.emit(
      'message',
      'streamhub/live/agents/b09994/telemetry',
      Buffer.from(JSON.stringify({ cpu: 1, agentVersion: '1.12' })),
    );
    client.emit(
      'message',
      'streamhub/live/agents/b09994/status',
      Buffer.from(JSON.stringify({ status: 'offline' })),
    );
    const { agents } = await svc.getData(APP);
    expect(agents[0]).toMatchObject({ agentId: 'b09994', online: false });
  });

  it('caps history to the configured historyPoints', async () => {
    setFleetEnabled(true, { historyPoints: 3 });
    await svc.ensureForApp(APP);
    const client = lastClient();
    for (let i = 0; i < 6; i++) {
      client.emit(
        'message',
        'streamhub/live/agents/a1/telemetry',
        Buffer.from(JSON.stringify({ cpu: i })),
      );
    }
    const detail = await svc.getAgent(APP, 'a1');
    expect(detail.history).toHaveLength(3);
    expect(detail.history.map((h) => h.cpu)).toEqual([3, 4, 5]); // newest kept
  });

  it('ignores foreign topics and malformed payloads without throwing', async () => {
    await svc.ensureForApp(APP);
    const client = lastClient();
    expect(() => {
      client.emit('message', 'streamhub/live/vod/x', Buffer.from('{}'));
      client.emit(
        'message',
        'streamhub/live/agents/a1/telemetry',
        Buffer.from('not json'),
      );
    }).not.toThrow();
    const { agents } = await svc.getData(APP);
    expect(agents).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  it('publishes a ping command to the agent cmd topic + records it pending', async () => {
    const rec = await svc.sendCommand(APP, 'b09994', 'ping', {});
    expect(rec.status).toBe('pending');
    expect(rec.command).toBe('ping');

    const client = lastClient();
    expect(client.publish).toHaveBeenCalledTimes(1);
    const [topic, payload, opts] = client.publish.mock.calls[0] as [
      string,
      string,
      { qos: number; retain?: boolean },
    ];
    expect(topic).toBe('streamhub/live/agents/b09994/cmd');
    expect(opts).toEqual({ qos: 1, retain: false });
    const body = JSON.parse(payload);
    expect(body).toMatchObject({ id: rec.id, command: 'ping', args: {} });
    expect(new Date(body.ts).toISOString()).toBe(body.ts);
  });

  it('publishes the ota payload with url/version/sha256', async () => {
    const sha = 'a'.repeat(64);
    const rec = await svc.sendCommand(APP, 'a1', 'ota', {
      url: 'https://assets.example.com/agent/1.13/streamhub-agent',
      version: '1.13',
      sha256: sha,
    });
    const body = JSON.parse(lastClient().publish.mock.calls[0][1] as string);
    expect(body).toMatchObject({
      id: rec.id,
      command: 'ota',
      args: {
        url: 'https://assets.example.com/agent/1.13/streamhub-agent',
        version: '1.13',
        sha256: sha,
      },
    });
  });

  it('resolves a pending command from a cmd/result message', async () => {
    const rec = await svc.sendCommand(APP, 'a1', 'restart', {});
    const client = lastClient();
    client.emit(
      'message',
      'streamhub/live/agents/a1/cmd/result',
      Buffer.from(JSON.stringify({ id: rec.id, command: 'restart', ok: true, message: 'restarting' })),
    );
    const detail = await svc.getAgent(APP, 'a1');
    const resolved = detail.commands.find((c) => c.id === rec.id);
    expect(resolved?.status).toBe('ok');
    expect(resolved?.result).toMatchObject({ ok: true, message: 'restarting' });
  });

  it('rejects an unknown command and a bad ota (validation)', async () => {
    await expect(svc.sendCommand(APP, 'a1', 'nuke', {})).rejects.toBeInstanceOf(
      FleetCommandError,
    );
    await expect(
      svc.sendCommand(APP, 'a1', 'ota', { url: 'https://x/y', version: '1' }),
    ).rejects.toBeInstanceOf(FleetCommandError);
  });

  it('refuses to send a command when fleet is inactive for the app', async () => {
    setFleetEnabled(false);
    await expect(svc.sendCommand(APP, 'a1', 'ping', {})).rejects.toBeInstanceOf(
      FleetInactiveError,
    );
    expect(factory).not.toHaveBeenCalled();
  });
});
