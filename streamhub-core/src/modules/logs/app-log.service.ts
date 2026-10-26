import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as path from 'path';

import { ConfigService } from '../../shared/config/config.service';
import { RotatingFileStream } from './rotating-file-stream';

/**
 * Per-app rotated application log (Vision-Edge §F).
 *
 * `appLog(app, line)` appends to a per-app rotating file at
 * `<dataDir>/apps/<app>/logs/app.log` — one {@link RotatingFileStream} per app,
 * created lazily and cached. Size/age rotation is env-tunable via the SAME
 * knobs as the global log sink (`LOG_MAX_BYTES`, `LOG_MAX_FILES`,
 * `LOG_RETENTION_DAYS`) so operators tune both consistently.
 *
 * ADDITIVE: this is a NEW sink alongside {@link LogsService} (console + global
 * rotating file + `server_logs`); it does not touch or restructure those. Wave-2
 * vision detections and the notifier fan-out write here so every app has a
 * self-contained, rotated audit trail on disk. Never throws — a logging failure
 * can never break the emitting flow (SPEC §15).
 */
@Injectable()
export class AppLogService implements OnModuleDestroy {
  /** app name → its lazily-opened rotating stream. */
  private readonly streams = new Map<string, RotatingFileStream>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Append one record to the app's `app.log`. A string is written verbatim (a
   * trailing newline is added when missing); an object is serialized as a single
   * JSON line with an ISO `ts` stamped first when absent. Never throws.
   */
  appLog(app: string, line: string | Record<string, unknown>): void {
    try {
      const text =
        typeof line === 'string'
          ? line
          : JSON.stringify({
              ts: new Date().toISOString(),
              ...line,
            });
      const withNewline = text.endsWith('\n') ? text : `${text}\n`;
      this.streamFor(app).write(withNewline);
    } catch {
      /* logging must never crash the process */
    }
  }

  /** Sweep aged/excess archives for every open app stream (retention pass). */
  sweep(): void {
    for (const stream of this.streams.values()) {
      try {
        stream.sweep();
      } catch {
        /* best-effort */
      }
    }
  }

  onModuleDestroy(): void {
    for (const stream of this.streams.values()) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    this.streams.clear();
  }

  /** Lazily open + cache the per-app rotating stream. */
  private streamFor(app: string): RotatingFileStream {
    let stream = this.streams.get(app);
    if (!stream) {
      stream = new RotatingFileStream({
        dir: path.join(this.config.dataDir, 'apps', app, 'logs'),
        baseName: 'app',
        maxBytes: AppLogService.int(process.env.LOG_MAX_BYTES, 10 * 1024 * 1024),
        maxFiles: AppLogService.int(process.env.LOG_MAX_FILES, 10),
        maxAgeDays: this.config.logRetentionDays,
      });
      this.streams.set(app, stream);
    }
    return stream;
  }

  private static int(value: string | undefined, fallback: number): number {
    if (value === undefined || value === '') return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
  }
}
