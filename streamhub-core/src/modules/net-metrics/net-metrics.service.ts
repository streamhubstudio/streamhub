/**
 * Per-app network I/O counter (Vision Edge design §J, Wave 1C).
 *
 * Counts bytes that flow THROUGH an app's media planes — NOT host-wide traffic:
 *   - HLS egress  → {@link makeHlsByteCounter} calls `recordBytes(app,'out','hls')`
 *   - MediaMTX ingest/delivery → a 60 s poller deltas `/v3/paths/list` bytes
 *   - LiveKit egress output → the webhook sink taps `recordBytes(...,'livekit-egress')`
 *
 * All collectors funnel through {@link recordBytes} into an in-memory
 * accumulator; every 60 s {@link flushOnce} UPSERTs the accumulated bytes into
 * the per-app `net_samples` table keyed by the current UTC hour bucket. Reads
 * (dashboard card + controller) are served by {@link summary} / {@link history}.
 *
 * KNOWN GAPS (documented follow-ups, out of Wave 1C scope):
 *   - ws-ingest (ESP32 gateway) bytes are not counted.
 *   - The raw :1937 remux/passthrough fallback plane (MediaMTX OFF) is not
 *     counted — only the MediaMTX single-port source is polled.
 *   - LiveKit INGRESS webhook byte accounting: IngressState carries no
 *     cumulative byte field, so ingest via LiveKit ingress is not counted here.
 */
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { LOGS_SERVICE, LogsServiceContract } from '../../shared/contracts';
import { classifyMediamtxPath } from '../passthrough/mediamtx-path.util';
import {
  NetDirection,
  NetMetricsServiceContract,
} from './net-metrics.contract';
import { hourBucket, windowStartBucket } from './net-bucket.util';

/** Flush + MediaMTX poll cadence (design §J: "every 60s"). */
const FLUSH_MS = 60_000;
/** Abort a MediaMTX API probe after this long (mirrors the passthrough front). */
const MEDIAMTX_API_TIMEOUT_MS = 3_000;
/** Defensive cap on `/v3/paths/list` pages walked. */
const MEDIAMTX_API_MAX_PAGES = 100;
/** Field separator for the in-memory accumulator key (NUL — never in a name). */
const SEP = '\u0000';

/** One `/v3/paths/list` item we care about (bytes are cumulative counters). */
interface MediamtxPathItem {
  name?: string;
  bytesReceived?: number;
  bytesSent?: number;
}
interface MediamtxPathsPage {
  pageCount?: number;
  items?: MediamtxPathItem[];
}

/** A per-direction rollup returned by {@link summary}. */
export interface NetWindow {
  in: number;
  out: number;
  total: number;
}

/** Threshold posture attached to a summary (instantaneous; events use hysteresis). */
export interface NetThresholdState {
  /** Configured rolling-24h cap in GB (GiB); 0 = unset. */
  gbPerDay: number;
  /** Cap expressed in bytes (0 = unset). */
  thresholdBytes: number;
  /** Rolling-24h ingress+egress bytes (the metered value). */
  usage24hBytes: number;
  /** usage / threshold as a percent (null when no threshold configured). */
  percent: number | null;
  /** Instantaneous breach (usage >= threshold). False when unset. */
  exceeded: boolean;
}

export interface NetSummary {
  today: NetWindow;
  last24h: NetWindow;
  last7d: NetWindow;
  /** last-24h breakdown by source (`hls`, `mediamtx`, `livekit-egress`, …). */
  bySource: { source: string; in: number; out: number }[];
  threshold: NetThresholdState;
}

export interface NetHistoryBucket {
  bucket: string;
  in: number;
  out: number;
}

@Injectable()
export class NetMetricsService
  implements NetMetricsServiceContract, OnModuleInit, OnModuleDestroy
{
  /** app\0direction\0source → accumulated bytes since the last flush. */
  private readonly acc = new Map<string, number>();
  /** MediaMTX path name → last-seen cumulative {received,sent} (delta anchor). */
  private readonly mediamtxSeen = new Map<
    string,
    { received: number; sent: number }
  >();
  private flushTimer?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private flushing = false;
  private polling = false;

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    @Optional()
    @Inject(LOGS_SERVICE)
    private readonly logs?: LogsServiceContract,
  ) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => void this.flushOnce(), FLUSH_MS);
    this.flushTimer.unref?.();
    if (this.config.mediamtxEnable) {
      this.pollTimer = setInterval(() => void this.pollMediamtxOnce(), FLUSH_MS);
      this.pollTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    // Best-effort final flush so a graceful shutdown doesn't drop counted bytes.
    this.flushOnce();
  }

  // ---------------------------------------------------------------------------
  // Collector sink
  // ---------------------------------------------------------------------------

  /** {@inheritdoc NetMetricsServiceContract.recordBytes} */
  recordBytes(
    app: string,
    direction: NetDirection,
    source: string,
    bytes: number,
  ): void {
    if (!app || !source) return;
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const key = `${app}${SEP}${direction}${SEP}${source}`;
    this.acc.set(key, (this.acc.get(key) ?? 0) + Math.floor(bytes));
  }

  // ---------------------------------------------------------------------------
  // Flush (accumulator → per-app net_samples). Public for tests; never throws.
  // ---------------------------------------------------------------------------

  flushOnce(now: number = Date.now()): void {
    if (this.flushing || this.acc.size === 0) return;
    this.flushing = true;
    try {
      const bucket = hourBucket(now);
      // Snapshot then clear up-front: better-sqlite3 is synchronous, so no
      // record can arrive mid-flush, and a per-app failure can't replay bytes.
      const entries = [...this.acc.entries()];
      this.acc.clear();
      for (const [key, bytes] of entries) {
        const [app, direction, source] = key.split(SEP);
        try {
          this.db
            .appDb(app)
            .prepare(
              `INSERT INTO net_samples (bucket, direction, source, bytes)
                 VALUES (?, ?, ?, ?)
               ON CONFLICT(bucket, direction, source)
                 DO UPDATE SET bytes = bytes + excluded.bytes`,
            )
            .run(bucket, direction, source, bytes);
        } catch (err) {
          // Re-accumulate so the next flush retries (app db momentarily gone).
          this.acc.set(key, (this.acc.get(key) ?? 0) + bytes);
          this.warn(app, 'net_samples flush failed', err);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // MediaMTX poller (design §J ingest plane). Public for tests; never throws.
  // ---------------------------------------------------------------------------

  async pollMediamtxOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const items = await this.fetchMediamtxPaths();
      const seenNow = new Set<string>();
      for (const item of items) {
        if (!item?.name) continue;
        const cls = classifyMediamtxPath(item.name);
        if (cls.kind !== 'passthrough') continue; // only app-attributable paths
        seenNow.add(item.name);
        const cur = {
          received: Math.max(0, Number(item.bytesReceived) || 0),
          sent: Math.max(0, Number(item.bytesSent) || 0),
        };
        const prev = this.mediamtxSeen.get(item.name);
        this.mediamtxSeen.set(item.name, cur);
        if (!prev) continue; // first sight: anchor the baseline, count no history
        // Counter reset (path republished) → the fresh cumulative IS the delta.
        const dIn = cur.received >= prev.received ? cur.received - prev.received : cur.received;
        const dOut = cur.sent >= prev.sent ? cur.sent - prev.sent : cur.sent;
        this.recordBytes(cls.app, 'in', 'mediamtx', dIn);
        this.recordBytes(cls.app, 'out', 'mediamtx', dOut);
      }
      // Forget paths that vanished so a later reappearance re-anchors cleanly.
      for (const name of [...this.mediamtxSeen.keys()]) {
        if (!seenNow.has(name)) this.mediamtxSeen.delete(name);
      }
    } catch (err) {
      this.warn(null, 'MediaMTX poll failed', err);
    } finally {
      this.polling = false;
    }
  }

  /** Page through the MediaMTX `/v3/paths/list` API (short per-request timeout). */
  private async fetchMediamtxPaths(): Promise<MediamtxPathItem[]> {
    const base = this.config.mediamtxApiUrl.replace(/\/+$/, '');
    const items: MediamtxPathItem[] = [];
    for (let page = 0; page < MEDIAMTX_API_MAX_PAGES; page += 1) {
      const url = `${base}/v3/paths/list?page=${page}&itemsPerPage=100`;
      const body = (await this.getJson(url)) as MediamtxPathsPage;
      for (const it of body?.items ?? []) items.push(it);
      const pageCount = typeof body?.pageCount === 'number' ? body.pageCount : 1;
      if (page + 1 >= pageCount) break;
    }
    return items;
  }

  /** GET + JSON-parse with an AbortController timeout. Throws on non-2xx/timeout. */
  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIAMTX_API_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Reads (dashboard card + controller)
  // ---------------------------------------------------------------------------

  /** Rolling summary: today / 24h / 7d windows + per-source + threshold posture. */
  summary(app: string, now: number = Date.now(), thresholdGbDay = 0): NetSummary {
    const todayStart = `${hourBucket(now).slice(0, 10)}T00`;
    const today = this.windowSince(app, todayStart);
    const last24h = this.windowSince(app, windowStartBucket(now, 24));
    const last7d = this.windowSince(app, windowStartBucket(now, 168));
    const bySource = this.sourcesSince(app, windowStartBucket(now, 24));

    const gbPerDay = thresholdGbDay > 0 ? thresholdGbDay : 0;
    const thresholdBytes = gbPerDay > 0 ? gbPerDay * 1024 ** 3 : 0;
    const usage24hBytes = last24h.total;
    return {
      today,
      last24h,
      last7d,
      bySource,
      threshold: {
        gbPerDay,
        thresholdBytes,
        usage24hBytes,
        percent: thresholdBytes > 0 ? (usage24hBytes / thresholdBytes) * 100 : null,
        exceeded: thresholdBytes > 0 && usage24hBytes >= thresholdBytes,
      },
    };
  }

  /** Bucketed history (newest last) for the dashboard sparkline. */
  history(app: string, hours = 48, now: number = Date.now()): NetHistoryBucket[] {
    const clamped = Math.min(Math.max(1, Math.floor(hours)), 24 * 30);
    const start = windowStartBucket(now, clamped);
    let rows: { bucket: string; direction: string; bytes: number }[] = [];
    try {
      rows = this.db
        .appDb(app)
        .prepare(
          `SELECT bucket, direction, SUM(bytes) AS bytes
             FROM net_samples
            WHERE bucket >= ?
            GROUP BY bucket, direction
            ORDER BY bucket ASC`,
        )
        .all(start) as typeof rows;
    } catch (err) {
      this.warn(app, 'net history query failed', err);
      return [];
    }
    const byBucket = new Map<string, NetHistoryBucket>();
    for (const r of rows) {
      const b = byBucket.get(r.bucket) ?? { bucket: r.bucket, in: 0, out: 0 };
      if (r.direction === 'in') b.in += r.bytes;
      else if (r.direction === 'out') b.out += r.bytes;
      byBucket.set(r.bucket, b);
    }
    return [...byBucket.values()];
  }

  /** {in,out,total} bytes since a bucket lower bound (inclusive). */
  private windowSince(app: string, startBucket: string): NetWindow {
    let rows: { direction: string; bytes: number }[] = [];
    try {
      rows = this.db
        .appDb(app)
        .prepare(
          `SELECT direction, SUM(bytes) AS bytes
             FROM net_samples WHERE bucket >= ? GROUP BY direction`,
        )
        .all(startBucket) as typeof rows;
    } catch (err) {
      this.warn(app, 'net window query failed', err);
      return { in: 0, out: 0, total: 0 };
    }
    let inB = 0;
    let outB = 0;
    for (const r of rows) {
      if (r.direction === 'in') inB += r.bytes;
      else if (r.direction === 'out') outB += r.bytes;
    }
    return { in: inB, out: outB, total: inB + outB };
  }

  /** Per-source in/out breakdown since a bucket lower bound. */
  private sourcesSince(
    app: string,
    startBucket: string,
  ): { source: string; in: number; out: number }[] {
    let rows: { source: string; direction: string; bytes: number }[] = [];
    try {
      rows = this.db
        .appDb(app)
        .prepare(
          `SELECT source, direction, SUM(bytes) AS bytes
             FROM net_samples WHERE bucket >= ? GROUP BY source, direction`,
        )
        .all(startBucket) as typeof rows;
    } catch (err) {
      this.warn(app, 'net sources query failed', err);
      return [];
    }
    const map = new Map<string, { source: string; in: number; out: number }>();
    for (const r of rows) {
      const e = map.get(r.source) ?? { source: r.source, in: 0, out: 0 };
      if (r.direction === 'in') e.in += r.bytes;
      else if (r.direction === 'out') e.out += r.bytes;
      map.set(r.source, e);
    }
    return [...map.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
  }

  private warn(app: string | null, message: string, err: unknown): void {
    try {
      this.logs?.write('warn', 'net-metrics', message, {
        ...(app ? { app } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* never throw */
    }
  }
}
