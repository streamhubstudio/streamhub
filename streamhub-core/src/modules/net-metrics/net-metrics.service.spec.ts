/**
 * Unit spec — NetMetricsService. Uses a REAL migrated temp SQLite (createTestDb)
 * so the accumulator → `net_samples` UPSERT math is exercised against the actual
 * schema, and a mocked `fetch` for the MediaMTX poller. Locks:
 *   - recordBytes accumulation + guard on non-positive/non-finite,
 *   - flushOnce UPSERT (INSERT then ON CONFLICT add) into the hour bucket,
 *   - MediaMTX delta logic (baseline anchor, delta, counter-reset, livekit skip),
 *   - summary windows + threshold posture, and bucketed history.
 */
import { NetMetricsService } from './net-metrics.service';
import { hourBucket } from './net-bucket.util';
import { createTestDb, TestDbContext, mockLogsService } from '../../../test/helpers';

const NOW = Date.UTC(2026, 6, 11, 14, 30, 0); // 2026-07-11 14:30 UTC
const BUCKET = hourBucket(NOW); // '2026-07-11T14'

function rows(ctx: TestDbContext, app: string) {
  return ctx.db
    .appDb(app)
    .prepare(
      `SELECT bucket, direction, source, bytes FROM net_samples
        ORDER BY bucket, direction, source`,
    )
    .all() as { bucket: string; direction: string; source: string; bytes: number }[];
}

describe('NetMetricsService', () => {
  let ctx: TestDbContext;
  let svc: NetMetricsService;

  beforeEach(() => {
    ctx = createTestDb({
      STREAMHUB_MEDIAMTX_ENABLE: 'true',
      STREAMHUB_MEDIAMTX_API_URL: 'http://mtx.test',
    });
    svc = new NetMetricsService(ctx.db, ctx.config, mockLogsService());
  });

  afterEach(() => ctx.cleanup());

  describe('recordBytes + flushOnce', () => {
    it('accumulates and UPSERTs per (bucket,direction,source)', () => {
      svc.recordBytes('live', 'out', 'hls', 1000);
      svc.recordBytes('live', 'out', 'hls', 500);
      svc.recordBytes('live', 'in', 'mediamtx', 200);
      svc.flushOnce(NOW);

      expect(rows(ctx, 'live')).toEqual([
        { bucket: BUCKET, direction: 'in', source: 'mediamtx', bytes: 200 },
        { bucket: BUCKET, direction: 'out', source: 'hls', bytes: 1500 },
      ]);
    });

    it('adds to an existing row on a later flush in the same bucket', () => {
      svc.recordBytes('live', 'out', 'hls', 1000);
      svc.flushOnce(NOW);
      svc.recordBytes('live', 'out', 'hls', 250);
      svc.flushOnce(NOW);

      expect(rows(ctx, 'live')).toEqual([
        { bucket: BUCKET, direction: 'out', source: 'hls', bytes: 1250 },
      ]);
    });

    it('ignores non-positive / non-finite byte counts', () => {
      svc.recordBytes('live', 'out', 'hls', 0);
      svc.recordBytes('live', 'out', 'hls', -5);
      svc.recordBytes('live', 'out', 'hls', NaN);
      svc.flushOnce(NOW);
      expect(rows(ctx, 'live')).toEqual([]);
    });

    it('clears the accumulator so a no-op flush writes nothing new', () => {
      svc.recordBytes('live', 'out', 'hls', 100);
      svc.flushOnce(NOW);
      svc.flushOnce(NOW); // nothing pending
      expect(rows(ctx, 'live')).toEqual([
        { bucket: BUCKET, direction: 'out', source: 'hls', bytes: 100 },
      ]);
    });
  });

  describe('pollMediamtxOnce', () => {
    function mockFetch(items: unknown[]): jest.Mock {
      const fn = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items, pageCount: 1 }),
      });
      (global as { fetch: unknown }).fetch = fn;
      return fn;
    }

    afterEach(() => {
      delete (global as { fetch?: unknown }).fetch;
    });

    it('anchors a baseline on first sight then records deltas', async () => {
      mockFetch([{ name: 'demo/cam1', bytesReceived: 1000, bytesSent: 200 }]);
      await svc.pollMediamtxOnce(); // baseline — no bytes counted
      svc.flushOnce(NOW);
      expect(rows(ctx, 'demo')).toEqual([]);

      mockFetch([{ name: 'demo/cam1', bytesReceived: 1500, bytesSent: 250 }]);
      await svc.pollMediamtxOnce(); // delta: in=500, out=50
      svc.flushOnce(NOW);
      expect(rows(ctx, 'demo')).toEqual([
        { bucket: BUCKET, direction: 'in', source: 'mediamtx', bytes: 500 },
        { bucket: BUCKET, direction: 'out', source: 'mediamtx', bytes: 50 },
      ]);
    });

    it('counts the fresh cumulative when the counter resets (republish)', async () => {
      mockFetch([{ name: 'demo/cam1', bytesReceived: 5000, bytesSent: 0 }]);
      await svc.pollMediamtxOnce();
      mockFetch([{ name: 'demo/cam1', bytesReceived: 300, bytesSent: 0 }]); // reset
      await svc.pollMediamtxOnce();
      svc.flushOnce(NOW);
      const inRow = rows(ctx, 'demo').find((r) => r.direction === 'in');
      expect(inRow?.bytes).toBe(300);
    });

    it('skips livekit-plane paths (not app-attributable)', async () => {
      mockFetch([{ name: 'live/sk_abc', bytesReceived: 1000, bytesSent: 1000 }]);
      await svc.pollMediamtxOnce();
      mockFetch([{ name: 'live/sk_abc', bytesReceived: 2000, bytesSent: 2000 }]);
      await svc.pollMediamtxOnce();
      svc.flushOnce(NOW);
      expect(rows(ctx, 'live')).toEqual([]);
    });

    it('never throws when the MediaMTX API is unreachable', async () => {
      (global as { fetch: unknown }).fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(svc.pollMediamtxOnce()).resolves.toBeUndefined();
    });
  });

  describe('summary + history', () => {
    function seed(app: string, bucket: string, dir: string, src: string, bytes: number) {
      ctx.db
        .appDb(app)
        .prepare(
          `INSERT INTO net_samples (bucket, direction, source, bytes)
             VALUES (?, ?, ?, ?)`,
        )
        .run(bucket, dir, src, bytes);
    }

    it('rolls up today / 24h / 7d windows and per-source', () => {
      seed('live', BUCKET, 'out', 'hls', 1000); // today + 24h + 7d
      seed('live', BUCKET, 'in', 'mediamtx', 400); // today + 24h + 7d
      seed('live', hourBucket(NOW - 30 * 3_600_000), 'out', 'hls', 5000); // 7d only
      seed('live', hourBucket(NOW - 10 * 24 * 3_600_000), 'out', 'hls', 9); // outside 7d

      const s = svc.summary('live', NOW, 0);
      expect(s.today).toEqual({ in: 400, out: 1000, total: 1400 });
      expect(s.last24h).toEqual({ in: 400, out: 1000, total: 1400 });
      expect(s.last7d).toEqual({ in: 400, out: 6000, total: 6400 });
      expect(s.bySource).toEqual(
        expect.arrayContaining([
          { source: 'hls', in: 0, out: 1000 },
          { source: 'mediamtx', in: 400, out: 0 },
        ]),
      );
    });

    it('reports threshold posture when a cap is configured', () => {
      seed('live', BUCKET, 'out', 'hls', 2 * 1024 ** 3); // 2 GiB in the last 24h
      const under = svc.summary('live', NOW, 5); // 5 GB cap
      expect(under.threshold.exceeded).toBe(false);
      expect(under.threshold.thresholdBytes).toBe(5 * 1024 ** 3);
      expect(under.threshold.percent).toBeCloseTo(40, 1);

      const over = svc.summary('live', NOW, 1); // 1 GB cap
      expect(over.threshold.exceeded).toBe(true);
      expect(over.threshold.percent).toBeCloseTo(200, 1);
    });

    it('leaves threshold posture null with no cap', () => {
      const s = svc.summary('live', NOW, 0);
      expect(s.threshold.gbPerDay).toBe(0);
      expect(s.threshold.percent).toBeNull();
      expect(s.threshold.exceeded).toBe(false);
    });

    it('returns bucketed in/out history within the window', () => {
      seed('live', '2026-07-11T12', 'in', 'mediamtx', 100);
      seed('live', '2026-07-11T12', 'out', 'hls', 200);
      seed('live', '2026-07-11T14', 'out', 'hls', 300);
      const h = svc.history('live', 48, NOW);
      expect(h).toEqual([
        { bucket: '2026-07-11T12', in: 100, out: 200 },
        { bucket: '2026-07-11T14', in: 0, out: 300 },
      ]);
    });
  });
});
