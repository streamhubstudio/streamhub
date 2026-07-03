import {
  Injectable,
  Logger as NestLogger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as path from 'path';
import pino from 'pino';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import {
  LogEntry,
  LogLevel,
  LogQuery,
  LogsServiceContract,
  MQTT_SERVICE,
  MqttServiceContract,
} from '../../shared/contracts';
import { RotatingFileStream } from './rotating-file-stream';

const VALID_LEVELS: ReadonlySet<LogLevel> = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** How long a resolved app name→id (or a null miss) stays cached. */
const APP_ID_TTL_MS = 60_000;
/** Delay before the first retention pass after boot. */
const PURGE_KICKOFF_MS = 60_000;
/** Interval between subsequent retention passes. */
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Read filters accepted by {@link LogsService.query}/{@link LogsService.count}.
 * Superset of the {@link LogQuery} contract with two extra optional filters
 * (`source` exact-match, `q` free-text over the message). Kept module-local so
 * the cross-module contract stays minimal.
 */
export interface LogFilters extends LogQuery {
  /** Exact match on the emitting subsystem. */
  source?: string;
  /** Free-text LIKE over `message` (escaped, wrapped in `%…%`). */
  q?: string;
}

/** Raw row shape of the `server_logs` table. */
interface ServerLogRow {
  id: number;
  ts: string;
  level: string;
  source: string | null;
  app_id: number | null;
  message: string;
  meta_json: string | null;
}

/**
 * Structured logging → console (pino) + rotating file (`<dataDir>/logs/`) +
 * `server_logs` table (SPEC §5 logs). `write` is fire-and-forget and must never
 * throw; `query` powers the log viewers (`GET /logs`, `GET /apps/:app/logs`)
 * with app/level/source/date/text filters + pagination.
 *
 * Per-app attribution: callers rarely pass an explicit `appId`, but most already
 * carry the app name in `meta.app`. `write` resolves that name→id (cached) and
 * stamps `server_logs.app_id`, so the per-app viewer works without touching the
 * ~46 existing call-sites. An explicit `appId` always wins.
 *
 * Retention: rows older than `LOG_RETENTION_DAYS` (default 30, `0` = keep
 * forever) are purged 1 min after boot and every 6h thereafter; the same pass
 * sweeps aged rotated files.
 */
@Injectable()
export class LogsService
  implements LogsServiceContract, OnModuleInit, OnModuleDestroy
{
  /** Last-resort logger for failures inside the logging pipeline itself. */
  private readonly fallback = new NestLogger('LogsService');
  private readonly console: pino.Logger;
  private readonly file: RotatingFileStream;

  /** app name → { id | null, expiry }. Null entries cache known misses. */
  private readonly appIdCache = new Map<
    string,
    { id: number | null; exp: number }
  >();

  /**
   * Lazily-resolved MQTT sink (per-app log forwarding). `undefined` = not yet
   * looked up, `null` = unavailable in this process (module set is static, so
   * a miss is cached forever). Resolved via ModuleRef instead of constructor
   * injection to avoid a provider cycle (MqttService itself logs through us).
   */
  private mqttSink: MqttServiceContract | null | undefined;

  private purgeKickoff?: ReturnType<typeof setTimeout>;
  private purgeTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    // Structured console output. Synchronous destination on fd 1 keeps lines
    // ordered and avoids worker-thread transports (the framework logger handles
    // pretty-printing for HTTP logs separately).
    this.console = pino(
      { level: 'trace', base: { service: 'streamhub-core' } },
      pino.destination({ fd: 1, sync: true }),
    );

    this.file = new RotatingFileStream({
      dir: path.join(this.config.dataDir, 'logs'),
      baseName: 'streamhub',
      // Extra legacy base names (from a previous rename) still count for retention.
      legacyBaseNames: [],
      maxBytes: this.int(process.env.LOG_MAX_BYTES, 10 * 1024 * 1024),
      maxFiles: this.int(process.env.LOG_MAX_FILES, 10),
      maxAgeDays: this.config.logRetentionDays,
    });
  }

  onModuleInit(): void {
    // Self-log so the file/DB sinks are exercised on boot.
    this.write('info', 'logs', 'LogsService ready', {
      dir: path.join(this.config.dataDir, 'logs'),
      retentionDays: this.config.logRetentionDays,
    });

    // Schedule retention: a first pass shortly after boot, then every 6h. Timers
    // are unref'd so they never keep the process (or a test run) alive.
    this.purgeKickoff = setTimeout(
      () => this.runRetention(),
      PURGE_KICKOFF_MS,
    );
    this.purgeKickoff.unref?.();
    this.purgeTimer = setInterval(() => this.runRetention(), PURGE_EVERY_MS);
    this.purgeTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.purgeKickoff) clearTimeout(this.purgeKickoff);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.file.close();
  }

  /** Emit a structured log to console + file + server_logs. Never throws. */
  write(
    level: LogLevel,
    source: string,
    message: string,
    meta?: Record<string, unknown>,
    appId: number | null = null,
  ): void {
    const lvl: LogLevel = VALID_LEVELS.has(level) ? level : 'info';
    const ts = new Date().toISOString();
    const src = source || 'app';
    // Explicit appId wins; otherwise attribute from meta.app (name→id, cached).
    const aid =
      appId ?? (typeof meta?.app === 'string' ? this.resolveAppId(meta.app) : null);

    // 1) console (structured)
    try {
      this.console[lvl]({ source: src, appId: aid, ...(meta ? { meta } : {}) }, message);
    } catch {
      /* ignore console failures */
    }

    // 2) rotating file (one JSON object per line)
    try {
      const record = {
        ts,
        level: lvl,
        source: src,
        appId: aid,
        message,
        ...(meta ? { meta } : {}),
      };
      this.file.write(JSON.stringify(record) + '\n');
    } catch {
      /* ignore file failures */
    }

    // 3) server_logs table
    try {
      this.db
        .global()
        .prepare(
          `INSERT INTO server_logs (ts, level, source, app_id, message, meta_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(ts, lvl, src, aid, message, meta ? JSON.stringify(meta) : null);
    } catch (err) {
      this.fallback.error(
        `server_logs insert failed: ${(err as Error).message}`,
      );
    }

    // 4) per-app MQTT log forwarding (mqtt.logs) — only app-attributed lines.
    //    The sink itself gates on enabled/level and skips source 'mqtt' (loop
    //    guard). Fire-and-forget: MQTT trouble never breaks logging.
    if (typeof meta?.app === 'string' && src !== 'mqtt') {
      const sink = this.resolveMqttSink();
      if (sink) {
        try {
          void sink
            .publishLog(meta.app, lvl, src, message, meta)
            .catch(() => undefined);
        } catch {
          /* never throw from the logging pipeline */
        }
      }
    }
  }

  /**
   * Resolve + memoize the optional MQTT sink. No ModuleRef (bare unit
   * construction) → cached null. A ModuleRef miss (e.g. very early boot,
   * before MqttService is instantiated) is NOT cached, so later writes retry.
   */
  private resolveMqttSink(): MqttServiceContract | null {
    if (this.mqttSink !== undefined) return this.mqttSink;
    if (!this.moduleRef) {
      this.mqttSink = null;
      return null;
    }
    try {
      const sink = this.moduleRef.get<MqttServiceContract>(MQTT_SERVICE, {
        strict: false,
      });
      if (sink) this.mqttSink = sink;
      return sink ?? null;
    } catch {
      return null; // not instantiated yet — retry on a later write
    }
  }

  /** Filtered, paginated read of `server_logs` (newest first). Never throws. */
  async query(q: LogFilters): Promise<LogEntry[]> {
    try {
      const { where, params } = this.buildWhere(q);
      const limit = this.clampLimit(q.limit);
      const offset = Math.max(this.int(q.offset, 0), 0);

      const sql = `SELECT id, ts, level, source, app_id, message, meta_json
                     FROM server_logs
                     ${where}
                     ORDER BY ts DESC, id DESC
                     LIMIT ? OFFSET ?`;
      const rows = this.db
        .global()
        .prepare(sql)
        .all(...params, limit, offset) as ServerLogRow[];
      return rows.map((r) => this.toEntry(r));
    } catch (err) {
      this.fallback.error(`logs query failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Total rows matching the same filters (ignores limit/offset). Used by the
   * controller to build pagination metadata. Additive helper, never throws.
   */
  async count(q: LogFilters): Promise<number> {
    try {
      const { where, params } = this.buildWhere(q);
      const row = this.db
        .global()
        .prepare(`SELECT COUNT(*) AS n FROM server_logs ${where}`)
        .get(...params) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch (err) {
      this.fallback.error(`logs count failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Delete `server_logs` rows older than `LOG_RETENTION_DAYS`. Returns how many
   * rows were removed. No-op when retention is disabled (`0`). Never throws.
   */
  purgeOldLogs(): number {
    const days = this.config.logRetentionDays;
    if (!(days > 0)) return 0;
    try {
      const info = this.db
        .global()
        .prepare(
          `DELETE FROM server_logs WHERE ts < datetime('now', ? || ' days')`,
        )
        .run(`-${days}`);
      const deleted = Number(info.changes) || 0;
      if (deleted > 0) {
        this.write('info', 'logs', `purged ${deleted} expired log rows`, {
          retentionDays: days,
          deleted,
        });
      }
      return deleted;
    } catch (err) {
      this.fallback.error(`logs purge failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /** One retention pass: DB row purge + rotated-file sweep. Never throws. */
  private runRetention(): void {
    this.purgeOldLogs();
    try {
      this.file.sweep();
    } catch {
      /* file sweep is best-effort */
    }
  }

  /**
   * Resolve an app name → id via `apps`, memoized for {@link APP_ID_TTL_MS}.
   * Misses are cached as `null` too (so a bogus `meta.app` doesn't hit the DB on
   * every log line). A failed SELECT clears the cache and attributes to `null`.
   */
  private resolveAppId(name: string): number | null {
    const now = Date.now();
    const hit = this.appIdCache.get(name);
    if (hit && hit.exp > now) return hit.id;
    try {
      const row = this.db
        .global()
        .prepare('SELECT id FROM apps WHERE name = ?')
        .get(name) as { id: number } | undefined;
      const id = row?.id ?? null;
      this.appIdCache.set(name, { id, exp: now + APP_ID_TTL_MS });
      return id;
    } catch {
      // Invalidate everything on failure — the next call re-resolves.
      this.appIdCache.clear();
      return null;
    }
  }

  private buildWhere(q: LogFilters): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.app) {
      // Resolve app name → id within the same global DB (apps + server_logs).
      clauses.push('app_id = (SELECT id FROM apps WHERE name = ?)');
      params.push(q.app);
    }
    if (q.level && VALID_LEVELS.has(q.level)) {
      clauses.push('level = ?');
      params.push(q.level);
    }
    if (q.source) {
      clauses.push('source = ?');
      params.push(q.source);
    }
    if (q.q) {
      // Free-text over the message; escape LIKE metacharacters so `%`/`_` in the
      // needle match literally.
      clauses.push("message LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(q.q)}%`);
    }
    if (q.since) {
      clauses.push('ts >= ?');
      params.push(q.since);
    }
    if (q.until) {
      clauses.push('ts <= ?');
      params.push(q.until);
    }
    return {
      where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }

  private toEntry(r: ServerLogRow): LogEntry {
    return {
      id: r.id,
      ts: r.ts,
      level: (VALID_LEVELS.has(r.level as LogLevel)
        ? (r.level as LogLevel)
        : 'info'),
      source: r.source ?? 'app',
      appId: r.app_id ?? null,
      message: r.message,
      metaJson: r.meta_json ?? null,
    };
  }

  private clampLimit(limit?: number): number {
    const n = this.int(limit, DEFAULT_LIMIT);
    if (n < 1) return 1;
    if (n > MAX_LIMIT) return MAX_LIMIT;
    return n;
  }

  private int(value: unknown, fallback: number): number {
    const n =
      typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : fallback;
  }
}

/** Escape SQLite LIKE metacharacters (`\`, `%`, `_`) for use with `ESCAPE '\'`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
