import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';

import { ConfigService } from '../../shared/config/config.service';
import { bullConnectionOptions } from '../recording/bull-conn.util';
import { BackupsService } from './backups.service';

export const BACKUPS_QUEUE = 'streamhub-backups';

/**
 * How stale the newest snapshot may be before boot enqueues a catch-up run.
 * Slightly over a day so a healthy daily schedule never double-runs.
 */
const CATCH_UP_AFTER_MS = 26 * 60 * 60 * 1000;

/**
 * Daily backup schedule on the existing BullMQ/Redis setup (same wiring shape
 * as the recording upload queue: options-based connection, boot never crashes
 * when Redis is down — the on-demand POST /system/backups path still works).
 *
 * Two job flavours on one queue:
 *  - `daily`    — a repeatable job on `settings.cron` (default 03:30),
 *  - `catch-up` — enqueued once at boot when the newest snapshot is older
 *    than ~a day (covers servers that were off at the scheduled time).
 *
 * Disabled entirely with STREAMHUB_BACKUPS_ENABLED=false. In tests bullmq is
 * the in-memory fake (jest moduleNameMapper), so nothing dials Redis.
 */
@Injectable()
export class BackupsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupsScheduler.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly backups: BackupsService,
  ) {}

  onModuleInit(): void {
    if (!this.backups.settings.enabled) {
      this.logger.log('scheduled backups disabled (STREAMHUB_BACKUPS_ENABLED)');
      return;
    }
    try {
      const connection = bullConnectionOptions(this.config.redisUrl);
      this.queue = new Queue(BACKUPS_QUEUE, {
        connection,
        defaultJobOptions: { attempts: 1, removeOnComplete: 20, removeOnFail: 50 },
      });
      this.queue.on('error', (e) =>
        this.logger.warn(`backups queue error: ${e.message}`),
      );
      this.worker = new Worker(
        BACKUPS_QUEUE,
        async (job: Job) => this.backups.runBackup(job.name),
        { connection: bullConnectionOptions(this.config.redisUrl), concurrency: 1 },
      );
      this.worker.on('error', (e) =>
        this.logger.warn(`backups worker error: ${e.message}`),
      );
      this.worker.on('failed', (job, e) =>
        this.logger.error(
          `backup job ${job?.name ?? '?'} failed: ${e?.message ?? e}`,
        ),
      );
      void this.schedule();
      this.logger.log(
        `backups queue ready (daily '${this.backups.settings.cron}', ` +
          `retention ${this.backups.settings.retentionDays}d)`,
      );
    } catch (e) {
      // Never crash boot — on-demand backups via the API still work.
      this.logger.error(
        `failed to init backups queue: ${(e as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.safeClose(() => this.worker?.close());
    await this.safeClose(() => this.queue?.close());
  }

  /** Register the repeatable daily job + a one-shot catch-up when stale. */
  private async schedule(): Promise<void> {
    if (!this.queue) return;
    // Decide catch-up BEFORE any job can run (the in-memory test fake executes
    // adds inline, and a fresh 'daily' snapshot must not mask a stale boot).
    const needsCatchUp =
      this.backups.newestSnapshotAgeMs() > CATCH_UP_AFTER_MS;
    try {
      await this.queue.add(
        'daily',
        {},
        {
          repeat: { pattern: this.backups.settings.cron },
          jobId: 'backups-daily',
        },
      );
      if (needsCatchUp) await this.queue.add('catch-up', {});
    } catch (e) {
      this.logger.warn(`backup scheduling failed: ${(e as Error).message}`);
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
