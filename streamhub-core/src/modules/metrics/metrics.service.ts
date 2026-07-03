import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { QuotasService } from '../quotas/quotas.service';

const PREFIX = 'streamhub_';

/** Buckets tuned for a management API (fast JSON) + a few slow media ops. */
const HTTP_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Quota/usage metric keys surfaced as Prometheus labels. */
const QUOTA_METRICS: readonly string[] = [
  'maxApps',
  'maxConcurrentStreams',
  'maxRecordingMinutesMonth',
  'maxEgressGbMonth',
  'maxStorageGb',
];
const USAGE_METRICS: readonly string[] = [
  'apps',
  'concurrentStreams',
  'recordingMinutesMonth',
  'egressGbMonth',
  'storageGb',
];

/**
 * Central Prometheus facade for streamhub-core (observability module).
 *
 * Owns a single {@link Registry}. Two kinds of metrics live here:
 *
 *  - EVENT metrics (counters/histograms) that the app increments in-line via the
 *    typed hooks below (`observeHttp`, `s3Upload`, `vodGenerated`, …). Business
 *    services inject this service `@Optional()` and call these — a missing
 *    MetricsService therefore never breaks a business flow.
 *
 *  - DB-derived GAUGES (active streams, VOD status distribution, upload-queue
 *    depth, per-tenant quota/usage) that are refreshed at scrape time from the
 *    already-migrated SQLite state via {@link refreshDbGauges}. This keeps the
 *    hot path free of gauge bookkeeping and guarantees the exported numbers match
 *    the source of truth without extra wiring in the business modules.
 *
 * Nothing here throws to callers: every DB read is defensively wrapped so a
 * scrape can never take the process down.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();

  // -- HTTP -----------------------------------------------------------------
  private readonly httpRequests: Counter<string>;
  private readonly httpDuration: Histogram<string>;
  private readonly httpInFlight: Gauge<string>;

  // -- streams --------------------------------------------------------------
  private readonly activeStreams: Gauge<string>;
  private readonly streamViewers: Gauge<string>;
  private readonly streamEvents: Counter<string>;

  // -- recording / VODs -----------------------------------------------------
  private readonly recordingsStarted: Counter<string>;
  private readonly vodsGenerated: Counter<string>;
  private readonly recordingFailures: Counter<string>;
  private readonly uploadQueueDepth: Gauge<string>;
  private readonly vodsByStatus: Gauge<string>;

  // -- S3 -------------------------------------------------------------------
  private readonly s3Uploads: Counter<string>;
  private readonly s3UploadBytes: Counter<string>;
  private readonly s3Errors: Counter<string>;

  // -- callbacks ------------------------------------------------------------
  private readonly callbacks: Counter<string>;

  // -- transcoding / GPU (SPEC §5 transcoding, GPU-optional) -----------------
  private readonly mediaTranscode: Counter<string>;
  private readonly gpuAvailable: Gauge<string>;

  // -- tenants / quotas -----------------------------------------------------
  private readonly tenantQuota: Gauge<string>;
  private readonly tenantUsage: Gauge<string>;
  private readonly appsTotal: Gauge<string>;

  // -- generic errors -------------------------------------------------------
  private readonly errors: Counter<string>;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    @Optional() private readonly quotas?: QuotasService,
  ) {
    const registers = [this.registry];

    if (this.config.env('METRICS_DEFAULT_METRICS') !== 'off') {
      // process_* / nodejs_* (cpu, memory, event-loop lag, gc, handles).
      collectDefaultMetrics({ register: this.registry });
    }

    this.httpRequests = new Counter({
      name: `${PREFIX}http_requests_total`,
      help: 'Total HTTP requests handled by streamhub-core.',
      labelNames: ['method', 'route', 'status'],
      registers,
    });
    this.httpDuration = new Histogram({
      name: `${PREFIX}http_request_duration_seconds`,
      help: 'HTTP request latency in seconds.',
      labelNames: ['method', 'route', 'status'],
      buckets: HTTP_BUCKETS,
      registers,
    });
    this.httpInFlight = new Gauge({
      name: `${PREFIX}http_requests_in_flight`,
      help: 'HTTP requests currently being processed.',
      registers,
    });

    this.activeStreams = new Gauge({
      name: `${PREFIX}active_streams`,
      help: 'Currently active (live) streams, by app.',
      labelNames: ['app'],
      registers,
    });
    this.streamViewers = new Gauge({
      name: `${PREFIX}stream_viewers`,
      help: 'Last observed subscriber (viewer) count for a live stream.',
      labelNames: ['app', 'room'],
      registers,
    });
    this.streamEvents = new Counter({
      name: `${PREFIX}stream_events_total`,
      help: 'Stream lifecycle events (stop, snapshot).',
      labelNames: ['app', 'event'],
      registers,
    });

    this.recordingsStarted = new Counter({
      name: `${PREFIX}recordings_started_total`,
      help: 'Recording sessions started.',
      labelNames: ['app'],
      registers,
    });
    this.vodsGenerated = new Counter({
      name: `${PREFIX}vods_generated_total`,
      help: 'VODs successfully uploaded and marked ready.',
      labelNames: ['app'],
      registers,
    });
    this.recordingFailures = new Counter({
      name: `${PREFIX}recording_failures_total`,
      help: 'Recording/upload flow failures, by reason.',
      labelNames: ['app', 'reason'],
      registers,
    });
    this.uploadQueueDepth = new Gauge({
      name: `${PREFIX}upload_queue_depth`,
      help: 'VODs pending upload (status recording|uploading), by app.',
      labelNames: ['app'],
      registers,
    });
    this.vodsByStatus = new Gauge({
      name: `${PREFIX}vods`,
      help: 'VOD rows by status, by app.',
      labelNames: ['app', 'status'],
      registers,
    });

    this.s3Uploads = new Counter({
      name: `${PREFIX}s3_uploads_total`,
      help: 'S3 object uploads, by provider and result (ok|fail).',
      labelNames: ['provider', 'result'],
      registers,
    });
    this.s3UploadBytes = new Counter({
      name: `${PREFIX}s3_upload_bytes_total`,
      help: 'Total bytes uploaded to S3, by provider.',
      labelNames: ['provider'],
      registers,
    });
    this.s3Errors = new Counter({
      name: `${PREFIX}s3_errors_total`,
      help: 'S3 operation errors, by op (upload|presign|delete|exists).',
      labelNames: ['op'],
      registers,
    });

    this.callbacks = new Counter({
      name: `${PREFIX}callbacks_total`,
      help: 'Outbound app callbacks, by event and result (delivered|failed|dropped).',
      labelNames: ['app', 'event', 'result'],
      registers,
    });

    this.tenantQuota = new Gauge({
      name: `${PREFIX}tenant_quota`,
      help: 'Configured quota limit per tenant and metric (-1 = unlimited).',
      labelNames: ['tenant', 'metric'],
      registers,
    });
    this.tenantUsage = new Gauge({
      name: `${PREFIX}tenant_usage`,
      help: 'Current consumption per tenant and metric.',
      labelNames: ['tenant', 'metric'],
      registers,
    });
    this.appsTotal = new Gauge({
      name: `${PREFIX}apps`,
      help: 'Registered apps, by tenant.',
      labelNames: ['tenant'],
      registers,
    });

    this.errors = new Counter({
      name: `${PREFIX}errors_total`,
      help: 'Errors surfaced to clients, by source and code.',
      labelNames: ['source', 'code'],
      registers,
    });

    this.mediaTranscode = new Counter({
      name: `${PREFIX}media_transcode_total`,
      help: 'Media pipeline ops by kind (egress|ingress), accel (gpu|cpu) and GPU type.',
      labelNames: ['kind', 'accel', 'type'],
      registers,
    });
    this.gpuAvailable = new Gauge({
      name: `${PREFIX}gpu_available`,
      help: 'Whether the node has a usable hardware-transcoding GPU (1/0), by type.',
      labelNames: ['type'],
      registers,
    });
  }

  // ==========================================================================
  // Event hooks (called from the interceptor + business services)
  // ==========================================================================

  httpStart(): void {
    this.httpInFlight.inc();
  }

  observeHttp(
    method: string,
    route: string,
    status: number,
    durationSeconds: number,
  ): void {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSeconds);
    this.httpInFlight.dec();
    if (status >= 500) this.errors.inc({ source: 'http', code: String(status) });
  }

  /** A stream was explicitly stopped. */
  streamStopped(app: string): void {
    this.streamEvents.inc({ app, event: 'stopped' });
  }

  /** A snapshot was captured for an app. */
  snapshotTaken(app: string): void {
    this.streamEvents.inc({ app, event: 'snapshot' });
  }

  /** Best-effort live viewer count for a room (from streams.get enrichment). */
  setViewers(app: string, room: string, viewers: number): void {
    if (Number.isFinite(viewers)) {
      this.streamViewers.set({ app, room }, viewers);
    }
  }

  recordingStarted(app: string): void {
    this.recordingsStarted.inc({ app });
  }

  vodGenerated(app: string): void {
    this.vodsGenerated.inc({ app });
  }

  recordingFailed(app: string, reason: string): void {
    this.recordingFailures.inc({ app, reason: reason || 'unknown' });
  }

  s3Upload(provider: string, ok: boolean, bytes = 0): void {
    const p = provider || 'unknown';
    this.s3Uploads.inc({ provider: p, result: ok ? 'ok' : 'fail' });
    if (ok && bytes > 0) this.s3UploadBytes.inc({ provider: p }, bytes);
    if (!ok) this.s3Errors.inc({ op: 'upload' });
  }

  s3Error(op: string): void {
    this.s3Errors.inc({ op: op || 'unknown' });
  }

  callbackResult(
    app: string,
    event: string,
    result: 'delivered' | 'failed' | 'dropped',
  ): void {
    this.callbacks.inc({ app, event, result });
  }

  /**
   * Record which acceleration path a media op used (SPEC §5 transcoding). Called
   * from the ingress/egress wiring after hwaccel resolves + falls back.
   */
  recordTranscode(
    kind: 'egress' | 'ingress',
    accel: 'gpu' | 'cpu',
    type: string,
  ): void {
    this.mediaTranscode.inc({ kind, accel, type: type || 'none' });
  }

  /**
   * Publish the node's GPU availability as a gauge. Sets exactly one active
   * `type` label to 1 and clears the others so a scrape shows the current state.
   */
  setGpuAvailable(status: {
    available: boolean;
    type: 'nvidia' | 'vaapi' | 'none';
  }): void {
    this.gpuAvailable.set({ type: 'nvidia' }, 0);
    this.gpuAvailable.set({ type: 'vaapi' }, 0);
    this.gpuAvailable.set({ type: 'none' }, 0);
    this.gpuAvailable.set(
      { type: status.type },
      status.available && status.type !== 'none' ? 1 : 0,
    );
    if (!status.available || status.type === 'none') {
      this.gpuAvailable.set({ type: 'none' }, 1);
    }
  }

  // ==========================================================================
  // Scrape
  // ==========================================================================

  get contentType(): string {
    return this.registry.contentType;
  }

  /** Render the exposition format, refreshing DB-derived gauges first. */
  async scrape(): Promise<string> {
    this.refreshDbGauges();
    return this.registry.metrics();
  }

  /**
   * Recompute gauges that mirror durable SQLite state: active streams, VOD
   * status distribution / upload backlog (per app), and per-tenant quota/usage.
   * Fully defensive — any failure is logged at debug and skipped.
   */
  private refreshDbGauges(): void {
    this.activeStreams.reset();
    this.streamViewers.reset();
    this.uploadQueueDepth.reset();
    this.vodsByStatus.reset();
    this.appsTotal.reset();
    this.tenantQuota.reset();
    this.tenantUsage.reset();

    let apps: { name: string; tenant_id: string | null }[] = [];
    try {
      apps = this.listApps();
    } catch (err) {
      this.logger.debug(`metrics: listApps failed: ${String(err)}`);
      return;
    }

    // Per-app stream/VOD gauges (only touch app DBs that already exist).
    const perTenantApps = new Map<string, number>();
    for (const app of apps) {
      const tenant = app.tenant_id ?? 'unknown';
      perTenantApps.set(tenant, (perTenantApps.get(tenant) ?? 0) + 1);
      if (!this.appDbExists(app.name)) {
        this.activeStreams.set({ app: app.name }, 0);
        continue;
      }
      try {
        const adb = this.db.appDb(app.name);
        const active = adb
          .prepare("SELECT COUNT(*) AS n FROM streams WHERE status = 'active'")
          .get() as { n: number };
        this.activeStreams.set({ app: app.name }, active?.n ?? 0);

        const byStatus = adb
          .prepare('SELECT status, COUNT(*) AS n FROM vods GROUP BY status')
          .all() as { status: string; n: number }[];
        let backlog = 0;
        for (const r of byStatus) {
          this.vodsByStatus.set({ app: app.name, status: r.status }, r.n);
          if (r.status === 'recording' || r.status === 'uploading') {
            backlog += r.n;
          }
        }
        this.uploadQueueDepth.set({ app: app.name }, backlog);
      } catch (err) {
        this.logger.debug(`metrics: app '${app.name}' gauges failed: ${String(err)}`);
      }
    }
    for (const [tenant, n] of perTenantApps) {
      this.appsTotal.set({ tenant }, n);
    }

    // Per-tenant quota + usage (best-effort; QuotasService is optional).
    if (this.quotas) {
      for (const tenant of perTenantApps.keys()) {
        if (tenant === 'unknown') continue;
        try {
          const report = this.quotas.getUsage(tenant);
          const q = report.quotas as unknown as Record<string, number>;
          const u = report.usage as unknown as Record<string, number>;
          for (const m of QUOTA_METRICS) {
            if (typeof q[m] === 'number') {
              this.tenantQuota.set({ tenant, metric: m }, q[m]);
            }
          }
          for (const m of USAGE_METRICS) {
            if (typeof u[m] === 'number') {
              this.tenantUsage.set({ tenant, metric: m }, u[m]);
            }
          }
        } catch (err) {
          this.logger.debug(`metrics: quota usage for '${tenant}' failed: ${String(err)}`);
        }
      }
    }
  }

  /** Read the app registry; tolerate the tenant_id column being absent. */
  private listApps(): { name: string; tenant_id: string | null }[] {
    const g = this.db.global();
    try {
      return g
        .prepare('SELECT name, tenant_id FROM apps')
        .all() as { name: string; tenant_id: string | null }[];
    } catch {
      const rows = g.prepare('SELECT name FROM apps').all() as {
        name: string;
      }[];
      return rows.map((r) => ({ name: r.name, tenant_id: null }));
    }
  }

  private appDbExists(appName: string): boolean {
    try {
      // Per-app DB filename is now app.db (consolidated from legacy vods.db).
      return fs.existsSync(
        path.join(this.config.dataDir, 'apps', appName, 'app.db'),
      );
    } catch {
      return false;
    }
  }
}
