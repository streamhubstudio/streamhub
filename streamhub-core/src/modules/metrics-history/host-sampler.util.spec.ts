/**
 * Unit — metrics-history/host-sampler (pure host readers + math).
 *
 * The number-crunching is split out of the I/O so it runs on ANY platform with
 * no /proc, no torch, no network. Invariants locked down:
 *  - parseProcNetDev sums only REAL interfaces (skips lo + veth/docker/…),
 *  - cpuPercent uses the idle/total delta, and falls back on the first sample
 *    and on a counter reset (rollover) — the cross-platform safety net,
 *  - toSample folds a reading into the persisted shape, degrading a missing
 *    disk/net source to null columns (macOS-safe),
 *  - the real readers return finite numbers / null without throwing, and
 *    readNet is null on any non-Linux host (graceful degradation).
 */
import {
  cpuPercent,
  parseProcNetDev,
  readCpuTimes,
  readDisk,
  readMem,
  readNet,
  toSample,
  type HostReading,
} from './host-sampler.util';

const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 123456     100    0    0    0     0          0         0  123456     100    0    0    0     0       0          0
  eth0: 1000     10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
  eth1:  500      5    0    0    0     0          0         0      700       7    0    0    0     0       0          0
veth9a: 999     99    0    0    0     0          0         0      999      99    0    0    0     0       0          0
docker0: 888    88    0    0    0     0          0         0      888      88    0    0    0     0       0          0`;

describe('metrics-history/host-sampler — parseProcNetDev', () => {
  it('sums bytes across real interfaces only (skips lo + virtual)', () => {
    const net = parseProcNetDev(PROC_NET_DEV);
    // eth0 + eth1 only: rx 1000+500, tx 2000+700.
    expect(net.rxBytes).toBe(1500);
    expect(net.txBytes).toBe(2700);
  });

  it('tolerates an empty / header-only dump', () => {
    expect(parseProcNetDev('')).toEqual({ rxBytes: 0, txBytes: 0 });
    expect(parseProcNetDev('Inter-|  Receive\n face |bytes')).toEqual({
      rxBytes: 0,
      txBytes: 0,
    });
  });
});

describe('metrics-history/host-sampler — cpuPercent', () => {
  it('computes utilisation from the idle/total delta', () => {
    const prev = { totalMs: 1000, idleMs: 800 };
    const cur = { totalMs: 2000, idleMs: 1300 };
    // idleDelta 500 / totalDelta 1000 = 50% idle → 50% busy.
    expect(cpuPercent(prev, cur, null)).toBe(50);
  });

  it('falls back to the load estimate on the first sample (no prev)', () => {
    expect(cpuPercent(undefined, { totalMs: 10, idleMs: 5 }, 42)).toBe(42);
    expect(cpuPercent(undefined, { totalMs: 10, idleMs: 5 }, null)).toBeNull();
  });

  it('falls back when the counter goes backwards (reset/rollover)', () => {
    const prev = { totalMs: 5000, idleMs: 4000 };
    const cur = { totalMs: 1000, idleMs: 900 }; // reboot → smaller
    expect(cpuPercent(prev, cur, 7)).toBe(7);
  });

  it('clamps to the 0..100 range', () => {
    const prev = { totalMs: 0, idleMs: 0 };
    const cur = { totalMs: 100, idleMs: 0 }; // 100% busy
    expect(cpuPercent(prev, cur, null)).toBe(100);
  });
});

describe('metrics-history/host-sampler — toSample', () => {
  const baseReading: HostReading = {
    cpu: { totalMs: 2000, idleMs: 1000 },
    mem: { usedBytes: 4_000, totalBytes: 8_000 },
    disk: { usedBytes: 50, totalBytes: 100 },
    net: { rxBytes: 10, txBytes: 20 },
    loadPercent: 33,
  };

  it('folds a full reading into the persisted shape', () => {
    const prev = { totalMs: 1000, idleMs: 800 };
    const s = toSample(baseReading, prev);
    expect(s.memUsedBytes).toBe(4_000);
    expect(s.memTotalBytes).toBe(8_000);
    expect(s.diskUsedBytes).toBe(50);
    expect(s.diskTotalBytes).toBe(100);
    expect(s.netRxBytes).toBe(10);
    expect(s.netTxBytes).toBe(20);
    // idleDelta 200 / totalDelta 1000 = 20% idle → 80% busy.
    expect(s.cpuPercent).toBe(80);
  });

  it('degrades a missing disk/net source to null columns (macOS-safe)', () => {
    const reading: HostReading = { ...baseReading, disk: null, net: null };
    const s = toSample(reading, undefined);
    expect(s.diskUsedBytes).toBeNull();
    expect(s.diskTotalBytes).toBeNull();
    expect(s.netRxBytes).toBeNull();
    expect(s.netTxBytes).toBeNull();
    // No prev CPU → the loadavg fallback (33) is used.
    expect(s.cpuPercent).toBe(33);
  });
});

describe('metrics-history/host-sampler — real readers (any platform)', () => {
  it('readCpuTimes / readMem return finite, sane numbers', () => {
    const cpu = readCpuTimes();
    expect(cpu.totalMs).toBeGreaterThanOrEqual(cpu.idleMs);
    const mem = readMem();
    expect(mem.totalBytes).toBeGreaterThan(0);
    expect(mem.usedBytes).toBeGreaterThanOrEqual(0);
    expect(mem.usedBytes).toBeLessThanOrEqual(mem.totalBytes);
  });

  it('readDisk returns a valid reading or null (never throws)', () => {
    const disk = readDisk(process.cwd());
    if (disk !== null) {
      expect(disk.totalBytes).toBeGreaterThan(0);
      expect(disk.usedBytes).toBeLessThanOrEqual(disk.totalBytes);
    }
  });

  it('readNet is null on any non-Linux host (graceful degradation)', () => {
    const net = readNet();
    if (process.platform !== 'linux') {
      expect(net).toBeNull();
    } else if (net !== null) {
      expect(net.rxBytes).toBeGreaterThanOrEqual(0);
      expect(net.txBytes).toBeGreaterThanOrEqual(0);
    }
  });
});
