/**
 * Unit specs for VisionSinkService — routes a dispatched vision event into the
 * right vision.db table + the rotated app log. Store + AppLogService + apps are
 * fakes, so no infra: this only checks routing + best-effort safety.
 */
import { VisionSinkService } from './vision.sink';

function fakes() {
  const store = {
    recordOccupancy: jest.fn(),
    recordCount: jest.fn(),
    recordCrowd: jest.fn(),
    recordDemography: jest.fn(),
  };
  const appLog = { appLog: jest.fn() };
  const apps = { appDir: jest.fn((a: string) => `/tmp/${a}`) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sink = new VisionSinkService(store as any, appLog as any, apps as any);
  return { store, appLog, apps, sink };
}

describe('VisionSinkService', () => {
  it('routes each event family to its table + always writes the app log', () => {
    const { store, appLog, sink } = fakes();
    sink.record('live', 'occupancy.session_started', { room: 'gate', tag: 't' });
    sink.record('live', 'count.in', { room: 'gate' });
    sink.record('live', 'crowd.threshold', { room: 'gate', count: 9 });
    sink.record('live', 'demography.face', { room: 'gate', age: 30 });

    expect(store.recordOccupancy).toHaveBeenCalledTimes(1);
    expect(store.recordCount).toHaveBeenCalledWith('live', '/tmp/live', 'gate', 'count.in', expect.any(Object));
    expect(store.recordCrowd).toHaveBeenCalledTimes(1);
    expect(store.recordDemography).toHaveBeenCalledTimes(1);
    expect(appLog.appLog).toHaveBeenCalledTimes(4);
  });

  it('ignores a non-vision event (no table, no log)', () => {
    const { store, appLog, sink } = fakes();
    sink.record('live', 'vod_ready', { room: 'gate' });
    expect(store.recordOccupancy).not.toHaveBeenCalled();
    expect(store.recordCount).not.toHaveBeenCalled();
    expect(appLog.appLog).not.toHaveBeenCalled();
  });

  it('never throws when the store fails (best-effort)', () => {
    const { store, sink } = fakes();
    store.recordCount.mockImplementation(() => {
      throw new Error('db down');
    });
    expect(() => sink.record('live', 'count.out', { room: 'gate' })).not.toThrow();
  });
});
