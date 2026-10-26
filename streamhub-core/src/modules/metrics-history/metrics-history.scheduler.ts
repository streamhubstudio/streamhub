import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

import { ConfigService } from '../../shared/config/config.service';
import { bullConnectionOptions } from '../recording/bull-conn.util';
import { MetricsHistoryService } from './metrics-history.service';

export const METRICS_HISTORY_QUEUE = 'streamhub-metrics-history';

/**
 * How stale the newest sample may be before boot enqueues a catch-up run.
 * Slightly over an hour so a healthy hourly schedule never double-samples.
 */
const CATCH_UP_AFTER_MS = 70 * 60 * 1000;

/**
 * Hourly host resource-usage sampler on the existing BullMQ/Redis setup (same
 * wiring shape as the backups scheduler: options-based connection, boot never
 * crashes when Redis is down).
 *
 * Two job flavours on one queue:
 *  - `hourly`   — a repeatable job on `settings.cron` (default `0 * * * *`),
 *  - `catch-up` — enqueued once at boot when the newest sample is older than
 *    ~an hour (covers servers that were off at the scheduled time).
 *
 * Disabled entirely with STREAMHUB_METRICS_HISTORY_ENABLED=false. In tests
 * bullmq is the in-memory fake (jest moduleNameMapper), so nothing dials Redis
 * and an added job executes inline.
 */
@Injectable()
export class MetricsHistoryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsHistoryScheduler.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly history: MetricsHistoryService,
  ) {}

  onModuleInit(): void {
    if (!this.history.settings.enabled) {
      this.logger.log(
        'resource-usage sampler disabled (STREAMHUB_METRICS_HISTORY_ENABLED)',
      );
      return;
    }
    try {
      const connection = bullConnectionOptions(this.config.redisUrl);
      this.queue = new Queue(METRICS_HISTORY_QUEUE, {
        connection,
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: 20,
          removeOnFail: 50,
        },
      });
      this.queue.on('error', (e) =>
        this.logger.warn(`metrics-history queue error: ${e.message}`),
      );
      this.worker = new Worker(
        METRICS_HISTORY_QUEUE,
        async () => {
          this.history.sample();
        },
        {
          connection: bullConnectionOptions(this.config.redisUrl),
          concurrency: 1,
        },
      );
      this.worker.on('error', (e) =>
        this.logger.warn(`metrics-history worker error: ${e.message}`),
      );
      this.worker.on('failed', (job, e) =>
        this.logger.error(
          `metrics-history job ${job?.name ?? '?'} failed: ${e?.message ?? e}`,
        ),
      );
      void this.schedule();
      this.logger.log(
        `resource-usage sampler ready (cron '${this.history.settings.cron}', ` +
          `retention ${this.history.settings.retentionDays}d)`,
      );
    } catch (e) {
      // Never crash boot — the read API still serves stored history.
      this.logger.error(
        `failed to init metrics-history queue: ${(e as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.safeClose(() => this.worker?.close());
    await this.safeClose(() => this.queue?.close());
  }

  /** Register the repeatable hourly job + a one-shot catch-up when stale. */
  private async schedule(): Promise<void> {
    if (!this.queue) return;
    // Decide catch-up BEFORE any job can run (the in-memory test fake executes
    // adds inline, and a fresh 'hourly' sample must not mask a stale boot).
    const needsCatchUp =
      this.history.newestSampleAgeMs() > CATCH_UP_AFTER_MS;
    try {
      await this.queue.add(
        'hourly',
        {},
        {
          repeat: { pattern: this.history.settings.cron },
          jobId: 'metrics-history-hourly',
        },
      );
      if (needsCatchUp) await this.queue.add('catch-up', {});
    } catch (e) {
      this.logger.warn(
        `metrics-history scheduling failed: ${(e as Error).message}`,
      );
    }
  }

  private async safeClose(fn: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.warn(`shutdown cleanup error: ${(e as Error).message}`);
    }
  }
}
