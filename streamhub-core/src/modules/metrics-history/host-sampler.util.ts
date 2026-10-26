/**
 * Host resource sampler — cross-platform, dependency-free.
 *
 * Reads CPU / memory / disk / network usage from Node's `os`/`fs` modules and,
 * where available, Linux `/proc`. Every reader DEGRADES GRACEFULLY: on a
 * platform (e.g. macOS dev laptops) where a source is unavailable it returns
 * `null`/`0` rather than throwing, so the sampler — and the whole test suite —
 * runs anywhere.
 *
 * The number-crunching (`cpuPercent`, `parseProcNetDev`) is split into PURE
 * functions so it can be unit-tested without touching the real host.
 */
import * as fs from 'fs';
import * as os from 'os';

/** Cumulative CPU time (ms) since boot, summed across all cores. */
export interface CpuTimes {
  totalMs: number;
  idleMs: number;
}

export interface MemReading {
  usedBytes: number;
  totalBytes: number;
}

export interface DiskReading {
  usedBytes: number;
  totalBytes: number;
}

/** Cumulative network byte counters since boot (Linux /proc/net/dev). */
export interface NetReading {
  rxBytes: number;
  txBytes: number;
}

/** A single point-in-time host reading (raw, cumulative where applicable). */
export interface HostReading {
  cpu: CpuTimes;
  mem: MemReading;
  disk: DiskReading | null;
  net: NetReading | null;
  /** loadavg[0] / cores * 100, clamped 0..100 — the CPU% fallback. */
  loadPercent: number | null;
}

/** A finished sample row, ready to persist. */
export interface HostSample {
  cpuPercent: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

/** Sum `os.cpus()` times into cumulative total/idle (ms). Works everywhere. */
export function readCpuTimes(): CpuTimes {
  let totalMs = 0;
  let idleMs = 0;
  for (const cpu of os.cpus() ?? []) {
    const t = cpu.times;
    totalMs += t.user + t.nice + t.sys + t.idle + t.irq;
    idleMs += t.idle;
  }
  return { totalMs, idleMs };
}

/** Total/used physical memory from `os` (portable). */
export function readMem(): MemReading {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return { usedBytes: Math.max(0, totalBytes - freeBytes), totalBytes };
}

/** loadavg[0] as a percentage of core count, clamped. `null` if unusable. */
export function readLoadPercent(): number | null {
  const cores = (os.cpus() ?? []).length;
  const load = os.loadavg?.()[0];
  if (!cores || load == null || !Number.isFinite(load)) return null;
  return clampPct((load / cores) * 100);
}

/**
 * Disk usage of a filesystem via `fs.statfsSync` (Node >=18.15). Returns `null`
 * on older runtimes or any error — same defensive shape as HealthService.
 */
export function readDisk(dir: string): DiskReading | null {
  try {
    const statfs = (fs as unknown as { statfsSync?: typeof fs.statfsSync })
      .statfsSync;
    if (typeof statfs !== 'function') return null;
    const s = statfs(dir);
    const totalBytes = s.bsize * s.blocks;
    const freeBytes = s.bsize * s.bavail;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return { usedBytes: Math.max(0, totalBytes - freeBytes), totalBytes };
  } catch {
    return null;
  }
}

/**
 * Cumulative network rx/tx bytes from Linux `/proc/net/dev`. Returns `null`
 * on non-Linux hosts (the file does not exist) — the graceful degradation the
 * spec calls for.
 */
export function readNet(): NetReading | null {
  if (process.platform !== 'linux') return null;
  try {
    const text = fs.readFileSync('/proc/net/dev', 'utf8');
    return parseProcNetDev(text);
  } catch {
    return null;
  }
}

/**
 * PURE: sum rx/tx bytes across every real interface in a `/proc/net/dev` dump,
 * skipping the loopback (`lo`) and virtual/bridge/veth/docker interfaces so the
 * counters reflect genuine host traffic. Column layout (kernel doc):
 *   iface: rxBytes rxPackets ... (col 0) ... txBytes (col 8) ...
 */
export function parseProcNetDev(text: string): NetReading {
  let rxBytes = 0;
  let txBytes = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue; // header rows have no "iface:" prefix
    const iface = line.slice(0, colon).trim();
    if (isVirtualIface(iface)) continue;
    const cols = line.slice(colon + 1).trim().split(/\s+/);
    const rx = Number.parseInt(cols[0], 10);
    const tx = Number.parseInt(cols[8], 10);
    if (Number.isFinite(rx)) rxBytes += rx;
    if (Number.isFinite(tx)) txBytes += tx;
  }
  return { rxBytes, txBytes };
}

/** Loopback + common virtual/container interfaces we never want to count. */
function isVirtualIface(iface: string): boolean {
  return (
    iface === 'lo' ||
    /^(veth|docker|br-|virbr|vnet|tap|tun|kube|cni|flannel|cali)/.test(iface)
  );
}

/**
 * PURE: average CPU utilisation (%) between two cumulative readings. With a
 * usable delta it is `(1 - idleDelta/totalDelta) * 100`; otherwise (first
 * sample, counter reset/rollover) it falls back to the loadavg estimate, and
 * finally `null` when nothing is knowable.
 */
export function cpuPercent(
  prev: CpuTimes | undefined,
  cur: CpuTimes,
  loadFallback: number | null,
): number | null {
  if (prev) {
    const totalDelta = cur.totalMs - prev.totalMs;
    const idleDelta = cur.idleMs - prev.idleMs;
    if (totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta) {
      return clampPct((1 - idleDelta / totalDelta) * 100);
    }
  }
  return loadFallback;
}

/** Snapshot every source at once (defensive per-source). */
export function readHost(dataDir: string): HostReading {
  return {
    cpu: readCpuTimes(),
    mem: readMem(),
    disk: readDisk(dataDir),
    net: readNet(),
    loadPercent: readLoadPercent(),
  };
}

/**
 * PURE: fold a raw host reading (+ the previous CPU snapshot) into a persistable
 * sample. Keeping this pure makes the row shape trivially testable.
 */
export function toSample(
  reading: HostReading,
  prevCpu: CpuTimes | undefined,
): HostSample {
  return {
    cpuPercent: cpuPercent(prevCpu, reading.cpu, reading.loadPercent),
    memUsedBytes: reading.mem.usedBytes,
    memTotalBytes: reading.mem.totalBytes,
    diskUsedBytes: reading.disk?.usedBytes ?? null,
    diskTotalBytes: reading.disk?.totalBytes ?? null,
    netRxBytes: reading.net?.rxBytes ?? null,
    netTxBytes: reading.net?.txBytes ?? null,
  };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
}
