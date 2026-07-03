/**
 * Unit spec — LatencyMonitorService (mqtt module).
 *
 * Exercises the per-app stream latency monitor with a FAKE probe (no LiveKit,
 * no sockets) and the callbacks contract mock. Locks down the alert state
 * machine:
 *   - breach → ONE `stream.latency_high` through the callbacks funnel (which
 *     is the single pipe feeding webhooks + the MQTT tap),
 *   - latched while high (no duplicate alerts),
 *   - recovery → `stream.latency_recovered`,
 *   - cooldown between successive alerts for the same room,
 *   - per-app `intervalSeconds` pacing and the disabled-by-default gate,
 *   - never throws (probe/app failures are swallowed).
 */
import {
  LATENCY_METRIC,
  LatencyMonitorService,
  LatencyProbeResult,
} from './latency-monitor.service';
import {
  mockAppsService,
  mockCallbacksService,
  mockLogsService,
} from '../../../test/helpers';

const T0 = 1_000_000_000_000; // arbitrary epoch anchor

function alertCfg(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    thresholdMs: 1000,
    cooldownSeconds: 60,
    intervalSeconds: 10,
    ...overrides,
  };
}

describe('LatencyMonitorService', () => {
  let apps: ReturnType<typeof mockAppsService>;
  let callbacks: ReturnType<typeof mockCallbacksService>;
  let logs: ReturnType<typeof mockLogsService>;
  let probe: jest.Mock<Promise<LatencyProbeResult>, [string]>;
  let monitor: LatencyMonitorService;

  function rtt(ms: number, extra: Partial<LatencyProbeResult> = {}): void {
    probe.mockResolvedValue({ ok: true, rttMs: ms, ...extra });
  }

  function dispatched(): [string, string, Record<string, unknown>][] {
    return callbacks.dispatch.mock.calls as never;
  }

  beforeEach(() => {
    apps = mockAppsService();
    callbacks = mockCallbacksService();
    logs = mockLogsService();
    probe = jest.fn();

    apps.list.mockResolvedValue([{ name: 'live' } as never]);
    apps.getConfig.mockResolvedValue({ latencyAlert: alertCfg() } as never);

    monitor = new LatencyMonitorService(
      // db is only reached through activeRooms(), which is stubbed below.
      {} as never,
      apps as never,
      callbacks as never,
      logs as never,
      probe as never,
    );
    jest
      .spyOn(
        monitor as unknown as { activeRooms(app: string): string[] },
        'activeRooms',
      )
      .mockReturnValue(['live-1']);
  });

  afterEach(() => monitor.onModuleDestroy());

  it('emits stream.latency_high through the callbacks funnel on a breach', async () => {
    rtt(2500, { participants: 3, publishers: 1 });
    await monitor.tickOnce(T0);

    expect(callbacks.dispatch).toHaveBeenCalledTimes(1);
    const [app, event, payload] = dispatched()[0];
    expect(app).toBe('live');
    expect(event).toBe('stream.latency_high');
    expect(payload).toEqual({
      room: 'live-1',
      rttMs: 2500,
      thresholdMs: 1000,
      metric: LATENCY_METRIC,
      participants: 3,
      publishers: 1,
    });
  });

  it('stays latched while high — no duplicate alerts', async () => {
    rtt(2000);
    await monitor.tickOnce(T0);
    await monitor.tickOnce(T0 + 10_000);
    await monitor.tickOnce(T0 + 20_000);
    expect(callbacks.dispatch).toHaveBeenCalledTimes(1);
  });

  it('emits stream.latency_recovered when the rtt drops back under threshold', async () => {
    rtt(2000);
    await monitor.tickOnce(T0);
    rtt(120);
    await monitor.tickOnce(T0 + 10_000);

    expect(callbacks.dispatch).toHaveBeenCalledTimes(2);
    const [, event, payload] = dispatched()[1];
    expect(event).toBe('stream.latency_recovered');
    expect(payload).toEqual({
      room: 'live-1',
      rttMs: 120,
      thresholdMs: 1000,
      metric: LATENCY_METRIC,
    });
  });

  it('suppresses a re-breach within the cooldown, alerts again after it', async () => {
    rtt(2000);
    await monitor.tickOnce(T0); // alert #1
    rtt(100);
    await monitor.tickOnce(T0 + 10_000); // recovered
    rtt(2000);
    await monitor.tickOnce(T0 + 20_000); // re-breach 20s after alert → cooldown
    expect(
      dispatched().filter(([, e]) => e === 'stream.latency_high'),
    ).toHaveLength(1);

    await monitor.tickOnce(T0 + 70_000); // 70s after alert #1 → cooldown over
    expect(
      dispatched().filter(([, e]) => e === 'stream.latency_high'),
    ).toHaveLength(2);
  });

  it('does nothing when latencyAlert is disabled (default)', async () => {
    apps.getConfig.mockResolvedValue({
      latencyAlert: alertCfg({ enabled: false }),
    } as never);
    rtt(9999);
    await monitor.tickOnce(T0);
    expect(probe).not.toHaveBeenCalled();
    expect(callbacks.dispatch).not.toHaveBeenCalled();
  });

  it('honours the per-app sampling interval', async () => {
    rtt(100);
    await monitor.tickOnce(T0);
    await monitor.tickOnce(T0 + 4_000); // < intervalSeconds → skipped
    expect(probe).toHaveBeenCalledTimes(1);
    await monitor.tickOnce(T0 + 10_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('skips unprobeable samples without changing alert state', async () => {
    rtt(2000);
    await monitor.tickOnce(T0); // breached
    probe.mockResolvedValue({ ok: false, rttMs: 0, error: 'room gone' });
    await monitor.tickOnce(T0 + 10_000); // failed sample → no recovered
    expect(callbacks.dispatch).toHaveBeenCalledTimes(1);
  });

  it('never throws when the probe or an app config blows up', async () => {
    probe.mockRejectedValue(new Error('probe down'));
    await expect(monitor.tickOnce(T0)).resolves.toBeUndefined();

    apps.getConfig.mockRejectedValue(new Error('app gone'));
    await expect(monitor.tickOnce(T0 + 10_000)).resolves.toBeUndefined();
    expect(callbacks.dispatch).not.toHaveBeenCalled();
  });
});
