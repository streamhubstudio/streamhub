/**
 * Unit spec — NetThresholdMonitorService. Drives the latched threshold state
 * machine directly (no DB, no config file) with a mocked net summary + config
 * reader + callbacks funnel. Locks the hysteresis:
 *   - breach → ONE `network.threshold_exceeded`, latched (no duplicates),
 *   - held between 90–100% (no recovery flap),
 *   - drop < 90% → `network.threshold_recovered`, unlatched,
 *   - no threshold configured → skipped + latch cleared,
 *   - the interval invokes a pass (fake timers).
 */
import { NetThresholdMonitorService } from './net-threshold-monitor.service';
import { GB_BYTES } from './net-bucket.util';
import { readNetworkConfig } from './net-config.util';
import type { NetMetricsService } from './net-metrics.service';
import {
  mockAppsService,
  mockCallbacksService,
  mockLogsService,
} from '../../../test/helpers';

jest.mock('./net-config.util', () => ({
  readNetworkConfig: jest.fn(),
}));
const readCfg = readNetworkConfig as jest.Mock;

describe('NetThresholdMonitorService', () => {
  let apps: ReturnType<typeof mockAppsService>;
  let callbacks: ReturnType<typeof mockCallbacksService>;
  let logs: ReturnType<typeof mockLogsService>;
  let net: { summary: jest.Mock };
  let monitor: NetThresholdMonitorService;

  function usage(total: number): void {
    net.summary.mockReturnValue({ last24h: { total } } as never);
  }
  function events(): [string, string, Record<string, unknown>][] {
    return callbacks.dispatch.mock.calls as never;
  }

  beforeEach(() => {
    apps = mockAppsService();
    callbacks = mockCallbacksService();
    logs = mockLogsService();
    net = { summary: jest.fn() };
    apps.list.mockResolvedValue([{ name: 'live' } as never]);
    readCfg.mockReturnValue({ thresholdGbDay: 1 }); // 1 GiB cap
    monitor = new NetThresholdMonitorService(
      net as unknown as NetMetricsService,
      apps,
      callbacks,
      logs,
    );
  });

  it('fires threshold_exceeded once on breach and latches', async () => {
    usage(1.2 * GB_BYTES);
    await monitor.tickOnce();
    await monitor.tickOnce(); // still high — no duplicate

    expect(events()).toHaveLength(1);
    const [app, event, payload] = events()[0];
    expect(app).toBe('live');
    expect(event).toBe('network.threshold_exceeded');
    expect(payload).toMatchObject({
      thresholdBytes: GB_BYTES,
      thresholdGbDay: 1,
      windowHours: 24,
    });
  });

  it('stays latched between 90% and 100% (no flap)', async () => {
    usage(1.2 * GB_BYTES);
    await monitor.tickOnce(); // exceeded
    usage(0.95 * GB_BYTES); // above the 90% recovery line
    await monitor.tickOnce();
    expect(events().map((e) => e[1])).toEqual(['network.threshold_exceeded']);
  });

  it('recovers once usage drops below 90% of the threshold', async () => {
    usage(1.2 * GB_BYTES);
    await monitor.tickOnce();
    usage(0.8 * GB_BYTES); // below 90%
    await monitor.tickOnce();
    await monitor.tickOnce(); // no duplicate recovery

    expect(events().map((e) => e[1])).toEqual([
      'network.threshold_exceeded',
      'network.threshold_recovered',
    ]);
  });

  it('never fires below the threshold from the start', async () => {
    usage(0.5 * GB_BYTES);
    await monitor.tickOnce();
    expect(events()).toEqual([]);
  });

  it('skips apps with no threshold configured and clears any latch', async () => {
    usage(5 * GB_BYTES);
    await monitor.tickOnce(); // exceeded (threshold 1)
    readCfg.mockReturnValue({}); // threshold removed
    await monitor.tickOnce(); // should NOT emit recovered — just forget
    expect(events().map((e) => e[1])).toEqual(['network.threshold_exceeded']);
  });

  it('never throws when the apps list blows up', async () => {
    apps.list.mockRejectedValue(new Error('db gone'));
    await expect(monitor.tickOnce()).resolves.toBeUndefined();
  });

  it('the interval drives a pass (fake timers)', () => {
    jest.useFakeTimers();
    try {
      usage(2 * GB_BYTES);
      const spy = jest.spyOn(monitor, 'tickOnce').mockResolvedValue();
      monitor.onModuleInit();
      jest.advanceTimersByTime(5 * 60_000);
      expect(spy).toHaveBeenCalledTimes(1);
      monitor.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
