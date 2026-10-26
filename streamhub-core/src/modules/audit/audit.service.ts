import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request } from 'express';

import { AuthContext } from '../../shared/auth-context';
import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';

/** Who performed an audited action. */
export type AuditActorType =
  | 'user'
  | 'token'
  | 'admin'
  | 'system'
  | 'anonymous';

/** Outcome of the audited action. */
export type AuditResult = 'success' | 'failure' | 'deny';

/** One security-relevant event to append to the audit trail. */
export interface AuditEvent {
  /** Dotted verb, e.g. 'auth.login', 'token.create', 'authz.deny', 'db.purge'. */
  action: string;
  actorType?: AuditActorType;
  /** Stable principal id (`userId` / `token:<id>` / submitted login user). */
  actorId?: string | null;
  tenantId?: string | null;
  /** What was acted on, e.g. { targetType: 'app', targetId: 'live' }. */
  targetType?: string | null;
  targetId?: string | null;
  /** Source IP (see {@link requestIp}). */
  ip?: string | null;
  result?: AuditResult;
  /** Small structured detail. MUST NEVER contain secrets/credentials. */
  meta?: Record<string, unknown> | null;
}

/** A persisted audit entry as surfaced by GET /system/audit. */
export interface AuditEntry {
  id: number;
  ts: string;
  actorType: AuditActorType;
  actorId: string | null;
  tenantId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  result: AuditResult;
  meta: Record<string, unknown> | null;
}

/** Read filters accepted by {@link AuditService.query}. */
export interface AuditQuery {
  /** Prefix match on `action` (e.g. 'auth.' matches auth.login/auth.logout). */
  action?: string;
  /** Exact match on `actor_id`. */
  actor?: string;
  result?: AuditResult;
  /** ISO date/datetime lower bound (inclusive). */
  from?: string;
  /** ISO date/datetime upper bound (inclusive). */
  to?: string;
  limit?: number;
  offset?: number;
}

/** Hash-chain verification report (GET /system/audit/verify). */
export interface AuditChainReport {
  ok: boolean;
  checked: number;
  /** Row id of the first entry whose hash/linkage fails, null when ok. */
  brokenAt: number | null;
}

/** Raw row shape of the `audit_log` table. */
interface AuditRow {
  id: number;
  ts: string;
  actor_type: string;
  actor_id: string | null;
  tenant_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  result: string;
  meta_json: string | null;
  prev_hash: string | null;
  hash: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Meta payloads are truncated to keep the trail lean (and index-friendly). */
const MAX_META_BYTES = 4096;
/** Retention: rows older than this many days are purged. 0 = keep forever. */
export const AUDIT_RETENTION_ENV = 'STREAMHUB_AUDIT_RETENTION_DAYS';
export const AUDIT_RETENTION_DEFAULT_DAYS = 90;
/** Delay before the first retention pass after boot. */
const PURGE_KICKOFF_MS = 90_000;
/** Interval between subsequent retention passes. */
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
/** Chain verification cap — bounded work even on huge trails. */
const VERIFY_MAX_ROWS = 10_000;

/**
 * Resolve the client IP for audit purposes from Express's proxy-validated
 * `req.ip` (trust-proxy is configured at bootstrap). NEVER reads raw
 * `X-Forwarded-For` — that header is client-spoofable (FIX-BACKLOG P0-2).
 * Once the security-fixes wave lands its shared `clientIpOf()` helper in
 * `modules/security/ip-cidr.util.ts`, this should delegate to it.
 */
export function requestIp(req: Request | undefined): string | null {
  return req?.ip ?? null;
}

/** Map the resolved AuthContext onto audit actor fields. */
export function actorFromCtx(ctx: AuthContext | undefined): {
  actorType: AuditActorType;
  actorId: string | null;
  tenantId: string | null;
} {
  if (!ctx) return { actorType: 'anonymous', actorId: null, tenantId: null };
  const actorType: AuditActorType =
    ctx.via === 'api_token'
      ? 'token'
      : ctx.via === 'admin_jwt'
        ? 'admin'
        : 'user';
  return {
    actorType,
    actorId: ctx.userId ?? null,
    tenantId: ctx.tenantId ?? null,
  };
}

/**
 * Append-only security audit trail (ISO 27002 §8.15 logging / §8.16
 * monitoring; FIX-BACKLOG P1-1; readiness gap I-1).
 *
 * Every security-relevant event — auth outcome, token mint/revoke, RBAC
 * permission DENY, config/secret change, destructive op — is appended to the
 * GLOBAL DB table `audit_log` as `{actor, action, target, tenant, ip, ts,
 * result}`. The table is tamper-evident and append-only:
 *
 *  - SQLite triggers reject UPDATE and DELETE (`audit_log_no_update` /
 *    `audit_log_no_delete`), so no code path — including this service — can
 *    silently rewrite history. The service exposes NO update/delete API.
 *  - Each row carries a hash chain (`hash = sha256(prev_hash ‖ canonical
 *    row)`), the same design the billing panel's audit_logs uses
 *    (BILLING-DESIGN.md), so truncation/edit attempts are detectable via
 *    {@link verifyChain}.
 *  - The ONLY sanctioned deletion is the retention pass (default 90 days,
 *    `STREAMHUB_AUDIT_RETENTION_DAYS`, 0 = keep forever), which briefly drops
 *    and recreates the delete-guard trigger inside a transaction. After a
 *    purge the oldest surviving row is the new chain anchor.
 *
 * `record()` is fire-and-forget and NEVER throws — an audit failure must not
 * break the audited action (mirrors LogsService.write).
 */
@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private purgeKickoff?: ReturnType<typeof setTimeout>;
  private purgeTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
  ) {}

  onModuleInit(): void {
    try {
      this.ensureSchema();
    } catch (err) {
      this.logger.error(
        `audit_log bootstrap failed (continuing): ${(err as Error).message}`,
      );
    }
    // Retention: first pass shortly after boot, then every 6h. Unref'd so the
    // timers never keep a test/CLI process alive.
    this.purgeKickoff = setTimeout(() => this.purgeExpired(), PURGE_KICKOFF_MS);
    this.purgeKickoff.unref?.();
    this.purgeTimer = setInterval(() => this.purgeExpired(), PURGE_EVERY_MS);
    this.purgeTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.purgeKickoff) clearTimeout(this.purgeKickoff);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }

  /** Effective retention in days (0 = keep forever). */
  get retentionDays(): number {
    const raw = this.config.env(AUDIT_RETENTION_ENV);
    if (raw === undefined || raw.trim() === '') {
      return AUDIT_RETENTION_DEFAULT_DAYS;
    }
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) || n < 0 ? AUDIT_RETENTION_DEFAULT_DAYS : n;
  }

  /** Total number of entries currently in the trail. */
  count(): number {
    try {
      const row = this.db
        .global()
        .prepare('SELECT COUNT(*) AS n FROM audit_log')
        .get() as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  }

  /**
   * Append one event. Fire-and-forget: any failure is logged and swallowed so
   * the audited action itself never fails because of the audit trail.
   */
  record(event: AuditEvent): void {
    try {
      const db = this.db.global();
      const ts = new Date().toISOString();
      const actorType = event.actorType ?? 'system';
      const actorId = event.actorId ?? null;
      const tenantId = event.tenantId ?? null;
      const targetType = event.targetType ?? null;
      const targetId = event.targetId ?? null;
      const ip = event.ip ?? null;
      const result: AuditResult = event.result ?? 'success';
      const metaJson = this.serializeMeta(event.meta);

      const insert = db.transaction(() => {
        const last = db
          .prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')
          .get() as { hash: string } | undefined;
        const prevHash = last?.hash ?? null;
        const hash = AuditService.chainHash(prevHash, {
          ts,
          actorType,
          actorId,
          tenantId,
          action: event.action,
          targetType,
          targetId,
          ip,
          result,
          metaJson,
        });
        db.prepare(
          `INSERT INTO audit_log
             (ts, actor_type, actor_id, tenant_id, action, target_type,
              target_id, ip, result, meta_json, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          ts,
          actorType,
          actorId,
          tenantId,
          event.action,
          targetType,
          targetId,
          ip,
          result,
          metaJson,
          prevHash,
          hash,
        );
      });
      insert();
    } catch (err) {
      this.logger.warn(
        `audit record failed for '${event.action}': ${(err as Error).message}`,
      );
    }
  }

  /** Query the trail (newest first) with filters + pagination. */
  query(q: AuditQuery = {}): {
    entries: AuditEntry[];
    total: number;
    limit: number;
    offset: number;
  } {
    const limit = Math.min(
      Math.max(1, Math.trunc(q.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    const offset = Math.max(0, Math.trunc(q.offset ?? 0));

    const where: string[] = [];
    const params: unknown[] = [];
    if (q.action) {
      where.push(`action LIKE ? ESCAPE '\\'`);
      params.push(`${q.action.replace(/([\\%_])/g, '\\$1')}%`);
    }
    if (q.actor) {
      where.push('actor_id = ?');
      params.push(q.actor);
    }
    if (q.result) {
      where.push('result = ?');
      params.push(q.result);
    }
    if (q.from) {
      where.push('ts >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('ts <= ?');
      params.push(q.to);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const db = this.db.global();
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM audit_log${clause}`)
        .get(...params) as { n: number }
    ).n;
    const rows = db
      .prepare(
        `SELECT id, ts, actor_type, actor_id, tenant_id, action, target_type,
                target_id, ip, result, meta_json, prev_hash, hash
           FROM audit_log${clause}
          ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as AuditRow[];

    return { entries: rows.map((r) => this.toView(r)), total, limit, offset };
  }

  /**
   * Verify the hash chain over the most recent rows (up to 10k). Each row must
   * satisfy `hash === sha256(prev_hash ‖ canonical(row))` and link to its
   * predecessor's hash. The oldest surviving row is the anchor: its stored
   * `prev_hash` participates in its own hash but is not required to resolve
   * (its predecessor may have been purged by retention).
   */
  verifyChain(): AuditChainReport {
    try {
      const rows = this.db
        .global()
        .prepare(
          `SELECT * FROM (
             SELECT id, ts, actor_type, actor_id, tenant_id, action,
                    target_type, target_id, ip, result, meta_json, prev_hash, hash
               FROM audit_log ORDER BY id DESC LIMIT ?
           ) ORDER BY id ASC`,
        )
        .all(VERIFY_MAX_ROWS) as AuditRow[];

      let prev: AuditRow | undefined;
      for (const row of rows) {
        const expected = AuditService.chainHash(row.prev_hash, {
          ts: row.ts,
          actorType: row.actor_type,
          actorId: row.actor_id,
          tenantId: row.tenant_id,
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id,
          ip: row.ip,
          result: row.result,
          metaJson: row.meta_json,
        });
        const linked = !prev || row.prev_hash === prev.hash;
        if (row.hash !== expected || !linked) {
          return { ok: false, checked: rows.length, brokenAt: row.id };
        }
        prev = row;
      }
      return { ok: true, checked: rows.length, brokenAt: null };
    } catch (err) {
      this.logger.warn(`audit verify failed: ${(err as Error).message}`);
      return { ok: false, checked: 0, brokenAt: null };
    }
  }

  /**
   * Retention pass: delete rows older than the configured window. The ONLY
   * sanctioned delete path — performed inside a transaction that drops and
   * recreates the append-only delete guard. Returns rows purged.
   */
  purgeExpired(): number {
    const days = this.retentionDays;
    if (days === 0) return 0;
    try {
      const db = this.db.global();
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      let purged = 0;
      const run = db.transaction(() => {
        db.exec('DROP TRIGGER IF EXISTS audit_log_no_delete');
        purged = db
          .prepare('DELETE FROM audit_log WHERE ts < ?')
          .run(cutoff).changes;
        db.exec(AuditService.DELETE_GUARD_SQL);
      });
      run();
      if (purged > 0) {
        this.logger.log(`audit retention: purged ${purged} rows (> ${days}d)`);
      }
      return purged;
    } catch (err) {
      this.logger.warn(`audit retention failed: ${(err as Error).message}`);
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private static readonly DELETE_GUARD_SQL = `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
       BEFORE DELETE ON audit_log
       BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`;

  /** Idempotent schema bootstrap on the GLOBAL DB (mirrors ip_rules). */
  private ensureSchema(): void {
    const db = this.db.global();
    db.exec(
      `CREATE TABLE IF NOT EXISTS audit_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         actor_type TEXT NOT NULL,
         actor_id TEXT,
         tenant_id TEXT,
         action TEXT NOT NULL,
         target_type TEXT,
         target_id TEXT,
         ip TEXT,
         result TEXT NOT NULL DEFAULT 'success'
           CHECK (result IN ('success', 'failure', 'deny')),
         meta_json TEXT,
         prev_hash TEXT,
         hash TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
       CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
       CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
       CREATE TRIGGER IF NOT EXISTS audit_log_no_update
         BEFORE UPDATE ON audit_log
         BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
       ${AuditService.DELETE_GUARD_SQL};`,
    );
  }

  /** sha256(prev_hash ‖ canonical row content) — field order is the contract. */
  private static chainHash(
    prevHash: string | null,
    c: {
      ts: string;
      actorType: string;
      actorId: string | null;
      tenantId: string | null;
      action: string;
      targetType: string | null;
      targetId: string | null;
      ip: string | null;
      result: string;
      metaJson: string | null;
    },
  ): string {
    const canonical = JSON.stringify([
      c.ts,
      c.actorType,
      c.actorId,
      c.tenantId,
      c.action,
      c.targetType,
      c.targetId,
      c.ip,
      c.result,
      c.metaJson,
    ]);
    return createHash('sha256')
      .update((prevHash ?? '') + canonical)
      .digest('hex');
  }

  /** Serialize + truncate meta. Never throws (circular refs → note). */
  private serializeMeta(
    meta: Record<string, unknown> | null | undefined,
  ): string | null {
    if (!meta) return null;
    let json: string;
    try {
      json = JSON.stringify(meta);
    } catch {
      return JSON.stringify({ note: 'meta not serializable' });
    }
    if (json.length > MAX_META_BYTES) {
      return JSON.stringify({ note: 'meta truncated', head: json.slice(0, 512) });
    }
    return json;
  }

  private toView(r: AuditRow): AuditEntry {
    let meta: Record<string, unknown> | null = null;
    if (r.meta_json) {
      try {
        meta = JSON.parse(r.meta_json) as Record<string, unknown>;
      } catch {
        meta = null;
      }
    }
    return {
      id: r.id,
      ts: r.ts,
      actorType: r.actor_type as AuditActorType,
      actorId: r.actor_id,
      tenantId: r.tenant_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      ip: r.ip,
      result: r.result as AuditResult,
      meta,
    };
  }
}
