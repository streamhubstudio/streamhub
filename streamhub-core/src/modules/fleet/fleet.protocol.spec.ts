/**
 * Unit spec — fleet.protocol (pure). Locks down the topic layout, the topic
 * parser (agentId + message kind), command validation (allowlist + ota/config
 * arg rules) and telemetry parsing/clamping. No I/O, no broker.
 */
import {
  FLEET_COMMANDS,
  FleetCommandError,
  agentsRoot,
  commandTopic,
  fleetSubscriptions,
  num,
  parseFleetTopic,
  parseTelemetry,
  validateCommand,
} from './fleet.protocol';

const PREFIX = 'streamhub/live';

describe('fleet.protocol topics', () => {
  it('builds the three wildcard subscriptions', () => {
    expect(fleetSubscriptions(PREFIX)).toEqual([
      'streamhub/live/agents/+/telemetry',
      'streamhub/live/agents/+/status',
      'streamhub/live/agents/+/cmd/result',
    ]);
  });

  it('normalizes a trailing slash in the prefix', () => {
    expect(agentsRoot('streamhub/live/')).toBe('streamhub/live/agents/');
    expect(commandTopic('streamhub/live/', 'a1')).toBe(
      'streamhub/live/agents/a1/cmd',
    );
  });

  it('builds the command topic for an agent', () => {
    expect(commandTopic(PREFIX, 'b09994')).toBe(
      'streamhub/live/agents/b09994/cmd',
    );
  });

  it('parses telemetry/status/cmd_result topics into {agentId, kind}', () => {
    expect(parseFleetTopic(PREFIX, 'streamhub/live/agents/a1/telemetry')).toEqual({
      agentId: 'a1',
      kind: 'telemetry',
    });
    expect(parseFleetTopic(PREFIX, 'streamhub/live/agents/a1/status')).toEqual({
      agentId: 'a1',
      kind: 'status',
    });
    expect(
      parseFleetTopic(PREFIX, 'streamhub/live/agents/a1/cmd/result'),
    ).toEqual({ agentId: 'a1', kind: 'cmd_result' });
  });

  it('rejects foreign / malformed topics', () => {
    expect(parseFleetTopic(PREFIX, 'streamhub/other/agents/a1/telemetry')).toBeNull();
    expect(parseFleetTopic(PREFIX, 'streamhub/live/agents/a1/cmd')).toBeNull(); // inbound cmd is broker→agent, not ours
    expect(parseFleetTopic(PREFIX, 'streamhub/live/agents//telemetry')).toBeNull();
    expect(parseFleetTopic(PREFIX, 'streamhub/live/vod/x')).toBeNull();
  });
});

describe('fleet.protocol validateCommand', () => {
  it('exposes exactly the four supported commands', () => {
    expect(FLEET_COMMANDS).toEqual(['restart', 'ota', 'config', 'ping']);
  });

  it('accepts restart/ping with no args', () => {
    expect(validateCommand('restart', undefined)).toEqual({
      command: 'restart',
      args: {},
    });
    expect(validateCommand('ping', { junk: 1 })).toEqual({
      command: 'ping',
      args: {},
    });
  });

  it('rejects an unknown command', () => {
    expect(() => validateCommand('rmrf', {})).toThrow(FleetCommandError);
    expect(() => validateCommand(42, {})).toThrow(FleetCommandError);
  });

  it('requires url+version+sha256 for ota and lower-cases the hash', () => {
    const sha = 'A'.repeat(64);
    const out = validateCommand('ota', {
      url: 'https://assets.example.com/agent/1.13/streamhub-agent',
      version: '1.13',
      sha256: sha,
    });
    expect(out.command).toBe('ota');
    expect(out.args).toEqual({
      url: 'https://assets.example.com/agent/1.13/streamhub-agent',
      version: '1.13',
      sha256: 'a'.repeat(64),
    });
  });

  it('rejects ota with a bad url, missing version or bad sha256', () => {
    const good = { url: 'https://x/y', version: '1.13', sha256: 'a'.repeat(64) };
    expect(() => validateCommand('ota', { ...good, url: 'ftp://x/y' })).toThrow(
      /http/,
    );
    expect(() => validateCommand('ota', { ...good, version: '' })).toThrow(
      /version/,
    );
    expect(() => validateCommand('ota', { ...good, sha256: 'nope' })).toThrow(
      /sha256/,
    );
  });

  it('accepts config as {config:{…}} or a bare object, rejects empty', () => {
    expect(validateCommand('config', { config: { fps: 3 } })).toEqual({
      command: 'config',
      args: { config: { fps: 3 } },
    });
    expect(validateCommand('config', { fps: 3 })).toEqual({
      command: 'config',
      args: { config: { fps: 3 } },
    });
    expect(() => validateCommand('config', {})).toThrow(FleetCommandError);
  });
});

describe('fleet.protocol parseTelemetry', () => {
  it('clamps % metrics to 0–100 and keeps version/relay', () => {
    const t = parseTelemetry(
      JSON.stringify({
        cpu: 150,
        mem: -5,
        temp: 47.2,
        uptime: 3600,
        cameras: 2,
        disk: 61,
        agentVersion: '1.12',
        relay: 'running',
      }),
    );
    expect(t).toMatchObject({
      cpu: 100,
      mem: 0,
      temp: 47.2,
      uptime: 3600,
      cameras: 2,
      disk: 61,
      agentVersion: '1.12',
      relay: 'running',
    });
  });

  it('unwraps a {data:{…}} envelope', () => {
    const t = parseTelemetry(JSON.stringify({ data: { cpu: 10 } }));
    expect(t?.cpu).toBe(10);
  });

  it('returns null on non-JSON / non-object', () => {
    expect(parseTelemetry('not json')).toBeNull();
    expect(parseTelemetry('[1,2,3]')).toBeNull();
  });

  it('num() coerces + bounds', () => {
    expect(num('12.5', 0, 100)).toBe(12.5);
    expect(num(200, 0, 100)).toBe(100);
    expect(num('x')).toBeUndefined();
  });
});
