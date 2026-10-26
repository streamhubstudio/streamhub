/**
 * Unit — edge/EdgeCapacityAlerter. One alert per reason per cooldown window
 * (so the 30s retry loop never spams), routed to BOTH the central log (warn,
 * source edge) and the notifier seam as `cluster.capacity`. Never throws when
 * the optional sinks are absent.
 */
import { COOLDOWN_MS, EdgeCapacityAlerter } from './edge-capacity-alerter';
import type { EdgeNotifier } from './edge-notifier';
import type { LogsServiceContract } from '../../shared/contracts';

const flush = () => new Promise((r) => setImmediate(r));

describe('edge/EdgeCapacityAlerter', () => {
  let now: number;
  let notifier: { notify: jest.Mock };
  let logs: { write: jest.Mock; query: jest.Mock };
  let alerter: EdgeCapacityAlerter;

  beforeEach(() => {
    now = 1_000_000;
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };
    logs = { write: jest.fn(), query: jest.fn() };
    alerter = new EdgeCapacityAlerter(
      notifier as unknown as EdgeNotifier,
      logs as unknown as LogsServiceContract,
      () => now,
    );
  });

  it('emits to the log (warn/edge) and the notifier (cluster.capacity)', async () => {
    expect(alerter.alert('no-eligible-node', { app: 'live' })).toBe(true);
    expect(logs.write).toHaveBeenCalledWith(
      'warn',
      'edge',
      expect.stringContaining('no-eligible-node'),
      expect.objectContaining({ reason: 'no-eligible-node', app: 'live' }),
    );
    await flush();
    expect(notifier.notify).toHaveBeenCalledWith(
      'cluster.capacity',
      expect.objectContaining({ reason: 'no-eligible-node', app: 'live' }),
    );
  });

  it('rate-limits repeated alerts of the same reason within the cooldown', () => {
    expect(alerter.alert('no-eligible-node')).toBe(true);
    now += 30_000; // a retryPending tick later
    expect(alerter.alert('no-eligible-node')).toBe(false);
    now += 30_000; // another tick — still well inside the 300s window
    expect(alerter.alert('no-eligible-node')).toBe(false);
    now += COOLDOWN_MS - 60_001; // 1ms short of the window edge
    expect(alerter.alert('no-eligible-node')).toBe(false);
    expect(logs.write).toHaveBeenCalledTimes(1);
  });

  it('emits again once the cooldown elapses', () => {
    expect(alerter.alert('no-eligible-node')).toBe(true);
    now += COOLDOWN_MS + 1;
    expect(alerter.alert('no-eligible-node')).toBe(true);
    expect(logs.write).toHaveBeenCalledTimes(2);
  });

  it('tracks each reason on its own cooldown key', () => {
    expect(alerter.alert('no-eligible-node')).toBe(true);
    expect(alerter.alert('failover-parked')).toBe(true); // different key → fires
    expect(alerter.alert('no-eligible-node')).toBe(false);
  });

  it('never throws when the optional sinks are absent', () => {
    const bare = new EdgeCapacityAlerter(undefined, undefined, () => now);
    expect(() => bare.alert('failover-parked')).not.toThrow();
    expect(bare.alert('failover-parked')).toBe(false); // already fired above
  });
});
