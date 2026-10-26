import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import {
  APPS_SERVICE,
  AppsServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import { VodsRepository } from './vods.repository';
import { RecordingService } from './recording.service';

/** Default sweep cadence (seconds) — retention is coarse, hourly is plenty. */
const DEFAULT_INTERVAL_S = 3600;
/** Max VODs deleted per app per sweep (drains a big backlog across passes). */
const BATCH_LIMIT = 500;

/** Outcome of one retention pass (returned for tests/observability). */
export interface RetentionResult {
  /** Apps with retention enabled that were inspected. */
  apps: number;
  /** VODs deleted (DB row removed; S3 delete best-effort inside deleteVod). */
  deleted: number;
}

/**
 * Compute the retention cutoff ISO timestamp: VODs whose `started_at` is
 * strictly older than this are expired. `retentionDays <= 0` returns null (OFF).
 * Exported (pure) so specs can assert the window math with a fixed clock.
 */
export function retentionCutoffIso(
  nowMs: number,
  retentionDays: number,
): string | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  return new Date(nowMs - retentionDays * 86_400_000).toISOString();
}

/**
 * Per-app VOD retention/rotation janitor (recording/VOD wave-2 §3). Mirrors the
 * HLS DVR watchdog pattern: a timer just calls `sweepOnce()`, which tests drive
 * directly with a fixed clock. Disabled under tests / by env so a spec never
 * spins the timer.
 *
 * For each app whose `recording.retentionDays` is > 0 it deletes VODs older than
 * the window. Deletion goes through `RecordingService.deleteVod`, whose ORDER is
 * deliberate: **S3 objects first (best-effort, per-object failures logged), then
 * the DB row unconditionally.** Rationale — the DB row is the index of record;
 * if we dropped it first a failed S3 delete would ORPHAN the object with no
 * pointer left to retry, so we attempt the remote delete while we still hold the
 * keys, then always reclaim the row even if S3 was unreachable (a re-run or a
 * lifecycle rule can mop up a stray object; a stuck row can never be cleared).
 *
 * Never throws — a per-app/per-VOD failure is logged and the pass continues.
 */
@Injectable()
export class VodRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VodRetentionService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly config: ConfigService,
    private readonly vods: VodsRepository,
    private readonly recording: RecordingService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
  ) {}

  onModuleInit(): void {
    if (this.config.nodeEnv === 'test') return;
    if ((this.config.env('STREAMHUB_VOD_RETENTION') || 'on') === 'off') return;
    const intervalMs = this.intervalSeconds() * 1000;
    this.timer = setInterval(() => void this.sweepOnce(), intervalMs);
    this.timer.unref?.();
    this.logger.log('VOD retention janitor armed');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private intervalSeconds(): number {
    const raw = Number(this.config.env('STREAMHUB_VOD_RETENTION_INTERVAL_S'));
    return Number.isFinite(raw) && raw >= 60
      ? Math.floor(raw)
      : DEFAULT_INTERVAL_S;
  }

  /**
   * One retention pass over every app. Public for tests; never throws and never
   * overlaps a slow pass.
   */
  async sweepOnce(now: number = Date.now()): Promise<RetentionResult> {
    const result: RetentionResult = { apps: 0, deleted: 0 };
    if (this.ticking) return result;
    this.ticking = true;
    try {
      let apps: Array<{ name: string }>;
      try {
        apps = await this.apps.list();
      } catch (err) {
        this.warn(null, 'app list failed', err);
        return result;
      }
      for (const app of apps) {
        await this.sweepApp(app.name, now, result);
      }
    } finally {
      this.ticking = false;
    }
    return result;
  }

  /** Sweep one app; increments the shared result. Never throws. */
  async sweepApp(
    appName: string,
    now: number,
    result: RetentionResult,
  ): Promise<void> {
    let retentionDays: number;
    try {
      retentionDays = (await this.apps.getConfig(appName)).recording
        .retentionDays ?? 0;
    } catch {
      return; // app vanished / unreadable config mid-pass
    }
    const cutoff = retentionCutoffIso(now, retentionDays);
    if (!cutoff) return; // retention OFF for this app

    result.apps++;

    let ids: number[];
    try {
      ids = this.vods.listExpired(appName, cutoff, BATCH_LIMIT);
    } catch (err) {
      this.warn(appName, 'listExpired failed', err);
      return;
    }
    if (!ids.length) return;

    let deleted = 0;
    for (const id of ids) {
      try {
        // deleteVod: S3 objects best-effort → DB row always (see class doc).
        await this.recording.deleteVod(appName, id);
        deleted++;
      } catch (err) {
        this.warn(appName, `deleteVod ${id} failed`, err);
      }
    }
    result.deleted += deleted;
    if (deleted) {
      this.logs.write('info', 'recording', 'vod retention pruned', {
        app: appName,
        deleted,
        retentionDays,
        cutoff,
      });
    }
  }

  private warn(appName: string | null, message: string, err: unknown): void {
    try {
      this.logs.write('warn', 'recording', `retention: ${message}`, {
        ...(appName ? { app: appName } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* never throw */
    }
  }
}
