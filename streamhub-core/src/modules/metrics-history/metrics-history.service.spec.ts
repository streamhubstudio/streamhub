/**
 * Unit — metrics-history/MetricsHistoryService (sampler + retention + read API).
 *
 * Runs against a real (migrated, temp) global SQLite DB via makeUnitContext.
 * The `resource_samples` table is created at runtime by the service itself
 * (CREATE TABLE IF NOT EXISTS — no shared-migration edit). Invariants:
 *  - sample() writes ONE hour-aligned row with the documented shape,
 *  - two samples in the same hour collapse (upsert on the bucket),
 *  - retention prunes rows older than N days, and 0 disables pruning,
 *  - history() returns bucketed series (cpu/mem/disk/net) with net rendered as
 *    per-bucket DELTAS of the cumulative counters (first point + resets → null),
 *  - the metric filter narrows to a single series,
 *  - null disk/net columns surface as null points (macOS-safe).
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { MetricsHistoryService } from './metrics-history.service';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface RawRow {
  ts: number;
  cpu?: number | null;
  memU?: number | null;
  memT?: number | null;
  diskU?: number | null;
  diskT?: number | null;
  rx?: number | null;
  tx?: number | null;
}

function insert(ctx: UnitContext, r: RawRow): void {
  ctx.db
    .global()
    .prepare(
      `INSERT OR REPLACE INTO resource_samples
         (ts, cpu_pct, mem_used_bytes, mem_total_bytes,
          disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.ts,
      r.cpu ?? null,
      r.memU ?? null,
      r.memT ?? null,
      r.diskU ?? null,
      r.diskT ?? null,
      r.rx ?? null,
      r.tx ?? null,
    );
}

function rowCount(ctx: UnitContext): number {
  return (
    ctx.db
      .global()
      .prepare('SELECT COUNT(*) AS n FROM resource_samples')
      .get() as { n: number }
  ).n;
}

const ENV_KEYS = [
  'STREAMHUB_METRICS_HISTORY_ENABLED',
  'STREAMHUB_METRICS_HISTORY_RETENTION_DAYS',
  'STREAMHUB_METRICS_HISTORY_CRON',
];

describe('metrics-history/MetricsHistoryService', () => {
  let ctx: UnitContext;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
  });

  beforeEach(() => {
    // makeTestConfig writes overrides into process.env without restoring them;
    // clear our keys before each case so one suite's override can't leak.
    for (const k of ENV_KEYS) delete process.env[k];
  });

  function build(overrides: Record<string, string> = {}): MetricsHistoryService {
    ctx = makeUnitContext(overrides);
    const svc = ctx.newService(MetricsHistoryService, ctx.config, ctx.db);
    svc.onModuleInit();
    return svc;
  }

  afterEach(() => {
    ctx?.cleanup();
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('bucketFor aligns an instant down to the top of the hour', () => {
    const now = Date.UTC(2026, 0, 15, 10, 37, 42, 500);
    const bucket = MetricsHistoryService.bucketFor(now);
    expect(bucket).toBe(Date.UTC(2026, 0, 15, 10, 0, 0, 0));
    expect(bucket % HOUR).toBe(0);
  });

  it('sample() writes one hour-aligned row with the documented shape', () => {
    const svc = build();
    const now = Date.UTC(2026, 0, 15, 10, 30);
    const result = svc.sample(now);

    expect(result).not.toBeNull();
    expect(rowCount(ctx)).toBe(1);

    const bucket = MetricsHistoryService.bucketFor(now);
    const row = ctx.db
      .global()
      .prepare('SELECT * FROM resource_samples WHERE ts = ?')
      .get(bucket) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.ts).toBe(bucket);
    // Memory always available via os.* on any platform.
    expect(typeof row.mem_total_bytes).toBe('number');
    expect((row.mem_total_bytes as number) > 0).toBe(true);
    expect(typeof row.mem_used_bytes).toBe('number');
    // cpu_pct is number|null; disk/net may be null on platforms without them.
    expect(['number', 'object']).toContain(typeof row.cpu_pct);
    expect(typeof row.created_at).toBe('string');
  });

  it('collapses two samples in the same hour into one row (upsert)', () => {
    const svc = build();
    const t = Date.UTC(2026, 0, 15, 10, 5);
    svc.sample(t);
    svc.sample(t + 20 * 60 * 1000); // still hour 10
    expect(rowCount(ctx)).toBe(1);

    // A sample in the NEXT hour adds a second row.
    svc.sample(t + HOUR);
    expect(rowCount(ctx)).toBe(2);
  });

  it('prunes samples older than the retention window (default 30d)', () => {
    const svc = build();
    const now = Date.UTC(2026, 0, 31, 12, 0);
    insert(ctx, { ts: now - 40 * DAY, memU: 1, memT: 2 }); // expired
    insert(ctx, { ts: now - 10 * DAY, memU: 1, memT: 2 }); // kept
    insert(ctx, { ts: now - 1 * DAY, memU: 1, memT: 2 }); // kept

    const removed = svc.prune(now);
    expect(removed).toBe(1);
    expect(rowCount(ctx)).toBe(2);
    const oldest = ctx.db
      .global()
      .prepare('SELECT MIN(ts) AS ts FROM resource_samples')
      .get() as { ts: number };
    expect(oldest.ts).toBe(now - 10 * DAY);
  });

  it('retentionDays=0 disables pruning entirely', () => {
    const svc = build({ STREAMHUB_METRICS_HISTORY_RETENTION_DAYS: '0' });
    expect(svc.settings.retentionDays).toBe(0);
    const now = Date.UTC(2026, 0, 31, 12, 0);
    insert(ctx, { ts: now - 400 * DAY, memU: 1, memT: 2 });
    expect(svc.prune(now)).toBe(0);
    expect(rowCount(ctx)).toBe(1);
  });

  it('history() returns bucketed series with net as per-bucket deltas', () => {
    const svc = build();
    const t0 = Date.UTC(2026, 0, 15, 8, 0);
    // Cumulative net counters climb: rx 100→300→700, tx 10→30→90.
    insert(ctx, { ts: t0, cpu: 12, memU: 40, memT: 100, diskU: 25, diskT: 50, rx: 100, tx: 10 });
    insert(ctx, { ts: t0 + HOUR, cpu: 30, memU: 60, memT: 100, diskU: 30, diskT: 50, rx: 300, tx: 30 });
    insert(ctx, { ts: t0 + 2 * HOUR, cpu: 45, memU: 80, memT: 100, diskU: 40, diskT: 50, rx: 700, tx: 90 });

    const res = svc.history('30d', undefined, t0 + 2 * HOUR + 1);

    expect(res.range).toBe('30d');
    expect(res.retentionDays).toBe(30);
    expect(res.bucketMs).toBe(HOUR);

    expect(res.series.cpu).toEqual([
      { ts: t0, value: 12 },
      { ts: t0 + HOUR, value: 30 },
      { ts: t0 + 2 * HOUR, value: 45 },
    ]);

    expect(res.series.mem?.[0]).toEqual({ ts: t0, used: 40, total: 100, pct: 40 });
    expect(res.series.disk?.[2]).toEqual({ ts: t0 + 2 * HOUR, value: 80 });

    // Net: first bucket has no predecessor → null; then deltas 200/20, 400/60.
    expect(res.series.net).toEqual([
      { ts: t0, rx: null, tx: null },
      { ts: t0 + HOUR, rx: 200, tx: 20 },
      { ts: t0 + 2 * HOUR, rx: 400, tx: 60 },
    ]);
  });

  it('net delta clamps a counter reset (reboot) to null instead of a spike', () => {
    const svc = build();
    const t0 = Date.UTC(2026, 0, 15, 8, 0);
    insert(ctx, { ts: t0, rx: 5000, tx: 5000 });
    insert(ctx, { ts: t0 + HOUR, rx: 100, tx: 100 }); // reboot: counter reset
    const res = svc.history('24h', 'net', t0 + HOUR + 1);
    expect(res.series.net).toEqual([
      { ts: t0, rx: null, tx: null },
      { ts: t0 + HOUR, rx: null, tx: null },
    ]);
  });

  it('the metric filter narrows the response to a single series', () => {
    const svc = build();
    const t0 = Date.UTC(2026, 0, 15, 8, 0);
    insert(ctx, { ts: t0, cpu: 20, memU: 1, memT: 2, rx: 1, tx: 1 });
    const res = svc.history('24h', 'cpu', t0 + 1);
    expect(res.series.cpu).toBeDefined();
    expect(res.series.mem).toBeUndefined();
    expect(res.series.disk).toBeUndefined();
    expect(res.series.net).toBeUndefined();
  });

  it('excludes samples outside the requested window', () => {
    const svc = build();
    const now = Date.UTC(2026, 0, 31, 12, 0);
    insert(ctx, { ts: now - 10 * DAY, cpu: 1 }); // outside 24h
    insert(ctx, { ts: now - 2 * HOUR, cpu: 2 }); // inside 24h
    const res = svc.history('24h', 'cpu', now);
    expect(res.series.cpu).toHaveLength(1);
    expect(res.series.cpu?.[0].ts).toBe(now - 2 * HOUR);
  });

  it('renders null disk/net columns as null points (macOS-safe)', () => {
    const svc = build();
    const t0 = Date.UTC(2026, 0, 15, 8, 0);
    insert(ctx, { ts: t0, cpu: 5, memU: 1, memT: 2, diskU: null, diskT: null, rx: null, tx: null });
    const res = svc.history('24h', undefined, t0 + 1);
    expect(res.series.disk?.[0]).toEqual({ ts: t0, value: null });
    expect(res.series.net?.[0]).toEqual({ ts: t0, rx: null, tx: null });
  });

  it('unknown range falls back to the 30d default', () => {
    const svc = build();
    const res = svc.history('bogus', 'cpu', Date.now());
    expect(res.range).toBe('30d');
  });

  it('newestSampleAgeMs is Infinity when empty, else the gap to now', () => {
    const svc = build();
    const now = Date.UTC(2026, 0, 15, 8, 0);
    expect(svc.newestSampleAgeMs(now)).toBe(Number.POSITIVE_INFINITY);
    insert(ctx, { ts: now - 3 * HOUR });
    expect(svc.newestSampleAgeMs(now)).toBe(3 * HOUR);
  });
});
