import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import {
  MetricsHistorySettings,
  resolveMetricsHistorySettings,
} from './metrics-history-settings';
import {
  CpuTimes,
  HostSample,
  readHost,
  toSample,
} from './host-sampler.util';

/** One persisted sample row (snake_case mirrors the SQLite columns). */
interface SampleRow {
  ts: number;
  cpu_pct: number | null;
  mem_used_bytes: number | null;
  mem_total_bytes: number | null;
  disk_used_bytes: number | null;
  disk_total_bytes: number | null;
  net_rx_bytes: number | null;
  net_tx_bytes: number | null;
}

/** A single dot in the returned series (`ts` = bucket start, epoch ms). */
export interface HistoryPoint {
  ts: number;
  value: number | null;
}

export interface MemPoint {
  ts: number;
  used: number | null;
  total: number | null;
  pct: number | null;
}

export interface NetPoint {
  ts: number;
  /** Bytes received during this bucket (delta of the cumulative counter). */
  rx: number | null;
  /** Bytes transmitted during this bucket. */
  tx: number | null;
}

export type MetricKey = 'cpu' | 'mem' | 'disk' | 'net';

export interface MetricsHistoryResponse {
  range: string;
  retentionDays: number;
  /** Query time (epoch ms). */
  now: number;
  /** Bucket width in ms (fixed 1h). */
  bucketMs: number;
  /** Only the requested metric(s) are present. */
  series: {
    cpu?: HistoryPoint[];
    mem?: MemPoint[];
    disk?: HistoryPoint[];
    net?: NetPoint[];
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Named windows accepted by the API `range` param → milliseconds. */
const RANGES: Record<string, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
};

export const DEFAULT_RANGE = '30d';

/**
 * In-app host resource-usage history (lightweight, complementary to the
 * Prometheus/Grafana stack).
 *
 * Samples CPU / RAM / Disk / Network ONCE PER HOUR into a single table in the
 * GLOBAL DB (`resource_samples`, created idempotently at boot — no edit to the
 * shared migrations file needed, mirroring the network-security module's
 * runtime-`CREATE TABLE IF NOT EXISTS`). Rows are keyed by the hour bucket
 * (epoch ms, hour-aligned) so an on-the-hour job and a boot catch-up in the
 * same hour collapse to one row (`INSERT OR REPLACE`). Retention prunes rows
 * older than `retentionDays` (default 30) after every sample.
 *
 * Network rx/tx are stored as the CUMULATIVE `/proc/net/dev` counters; the read
 * API derives per-bucket deltas (clamped ≥0 to survive reboots/counter resets).
 * CPU% is the average over the hour, computed from the delta of the cumulative
 * `os.cpus()` idle/total times between consecutive samples (kept in memory),
 * with a loadavg estimate as the first-sample / cross-platform fallback.
 *
 * Fully defensive: a failed sample is logged and skipped, never crashing the
 * scheduler or a request.
 */
@Injectable()
export class MetricsHistoryService implements OnModuleInit {
  private readonly logger = new Logger(MetricsHistoryService.name);
  readonly settings: MetricsHistorySettings;

  /** Previous cumulative CPU snapshot, for the per-hour utilisation delta. */
  private prevCpu?: CpuTimes;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
  ) {
    this.settings = resolveMetricsHistorySettings(config);
  }

  onModuleInit(): void {
    try {
      this.ensureSchema();
    } catch (err) {
      this.logger.error(
        `resource_samples bootstrap failed (continuing): ${String(err)}`,
      );
    }
  }

  private ensureSchema(): void {
    this.db.global().exec(
      `CREATE TABLE IF NOT EXISTS resource_samples (
         ts INTEGER PRIMARY KEY,
         cpu_pct REAL,
         mem_used_bytes INTEGER,
         mem_total_bytes INTEGER,
         disk_used_bytes INTEGER,
         disk_total_bytes INTEGER,
         net_rx_bytes INTEGER,
         net_tx_bytes INTEGER,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       );
       CREATE INDEX IF NOT EXISTS idx_resource_samples_ts ON resource_samples(ts);`,
    );
  }

  /** Align an epoch-ms instant down to the start of its hour. */
  static bucketFor(nowMs: number): number {
    return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  }

  /**
   * Take ONE sample of the host and upsert it into the current hour bucket,
   * then prune expired rows. Returns the persisted sample (or `null` on error).
   */
  sample(nowMs: number = Date.now()): HostSample | null {
    try {
      this.ensureSchema();
      const reading = readHost(this.config.dataDir);
      const sample = toSample(reading, this.prevCpu);
      // Advance the CPU baseline AFTER computing this sample's %.
      this.prevCpu = reading.cpu;

      const bucket = MetricsHistoryService.bucketFor(nowMs);
      this.db
        .global()
        .prepare(
          `INSERT INTO resource_samples
             (ts, cpu_pct, mem_used_bytes, mem_total_bytes,
              disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ts) DO UPDATE SET
             cpu_pct = excluded.cpu_pct,
             mem_used_bytes = excluded.mem_used_bytes,
             mem_total_bytes = excluded.mem_total_bytes,
             disk_used_bytes = excluded.disk_used_bytes,
             disk_total_bytes = excluded.disk_total_bytes,
             net_rx_bytes = excluded.net_rx_bytes,
             net_tx_bytes = excluded.net_tx_bytes`,
        )
        .run(
          bucket,
          sample.cpuPercent,
          sample.memUsedBytes,
          sample.memTotalBytes,
          sample.diskUsedBytes,
          sample.diskTotalBytes,
          sample.netRxBytes,
          sample.netTxBytes,
        );

      this.prune(nowMs);
      return sample;
    } catch (err) {
      this.logger.error(`resource sample failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Delete samples older than `retentionDays`. `0` disables pruning. Returns
   * the number of rows removed.
   */
  prune(nowMs: number = Date.now()): number {
    const days = this.settings.retentionDays;
    if (days <= 0) return 0;
    const cutoff = nowMs - days * DAY_MS;
    try {
      const res = this.db
        .global()
        .prepare('DELETE FROM resource_samples WHERE ts < ?')
        .run(cutoff);
      return res.changes ?? 0;
    } catch (err) {
      this.logger.warn(`resource prune failed: ${String(err)}`);
      return 0;
    }
  }

  /** Milliseconds since the newest sample; `Infinity` when the table is empty. */
  newestSampleAgeMs(nowMs: number = Date.now()): number {
    try {
      const row = this.db
        .global()
        .prepare('SELECT MAX(ts) AS ts FROM resource_samples')
        .get() as { ts: number | null } | undefined;
      const ts = row?.ts;
      return ts == null ? Number.POSITIVE_INFINITY : nowMs - ts;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /** Resolve a `range` param to milliseconds (defaults to 30d). */
  static rangeMs(range?: string): number {
    if (!range) return RANGES[DEFAULT_RANGE];
    return RANGES[range] ?? RANGES[DEFAULT_RANGE];
  }

  /**
   * Bucketed series over the window, ready for a dot chart. `metric` narrows to
   * a single series; omitted → every series. Points are ascending by time.
   */
  history(
    range: string = DEFAULT_RANGE,
    metric?: MetricKey,
    nowMs: number = Date.now(),
  ): MetricsHistoryResponse {
    const normalizedRange = RANGES[range] ? range : DEFAULT_RANGE;
    const since = nowMs - MetricsHistoryService.rangeMs(range);
    const rows = this.rowsSince(since);

    const wantAll = !metric;
    const series: MetricsHistoryResponse['series'] = {};
    if (wantAll || metric === 'cpu') {
      series.cpu = rows.map((r) => ({ ts: r.ts, value: r.cpu_pct }));
    }
    if (wantAll || metric === 'mem') {
      series.mem = rows.map((r) => ({
        ts: r.ts,
        used: r.mem_used_bytes,
        total: r.mem_total_bytes,
        pct: pct(r.mem_used_bytes, r.mem_total_bytes),
      }));
    }
    if (wantAll || metric === 'disk') {
      series.disk = rows.map((r) => ({
        ts: r.ts,
        value: pct(r.disk_used_bytes, r.disk_total_bytes),
      }));
    }
    if (wantAll || metric === 'net') {
      series.net = deltaNet(rows);
    }

    return {
      range: normalizedRange,
      retentionDays: this.settings.retentionDays,
      now: nowMs,
      bucketMs: HOUR_MS,
      series,
    };
  }

  private rowsSince(sinceMs: number): SampleRow[] {
    try {
      return this.db
        .global()
        .prepare(
          'SELECT ts, cpu_pct, mem_used_bytes, mem_total_bytes, ' +
            'disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes ' +
            'FROM resource_samples WHERE ts >= ? ORDER BY ts ASC',
        )
        .all(sinceMs) as SampleRow[];
    } catch (err) {
      this.logger.warn(`resource history read failed: ${String(err)}`);
      return [];
    }
  }
}

/** Percentage helper (null-safe). */
function pct(used: number | null, total: number | null): number | null {
  if (used == null || total == null || total <= 0) return null;
  return Math.round((used / total) * 10000) / 100;
}

/**
 * Turn cumulative rx/tx counters into per-bucket deltas. The first point (and
 * any point after a reboot/counter reset, which would go negative) is clamped
 * to `null` so the chart shows a gap rather than a spike.
 */
function deltaNet(rows: SampleRow[]): NetPoint[] {
  const out: NetPoint[] = [];
  let prev: SampleRow | undefined;
  for (const row of rows) {
    let rx: number | null = null;
    let tx: number | null = null;
    if (
      prev &&
      row.net_rx_bytes != null &&
      prev.net_rx_bytes != null &&
      row.net_tx_bytes != null &&
      prev.net_tx_bytes != null
    ) {
      const dRx = row.net_rx_bytes - prev.net_rx_bytes;
      const dTx = row.net_tx_bytes - prev.net_tx_bytes;
      rx = dRx >= 0 ? dRx : null;
      tx = dTx >= 0 ? dTx : null;
    }
    out.push({ ts: row.ts, rx, tx });
    prev = row;
  }
  return out;
}
