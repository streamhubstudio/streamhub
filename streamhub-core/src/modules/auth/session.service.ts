import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import * as crypto from 'crypto';
import { DbService } from '../../shared/db/db.service';

/** Client fingerprint captured when a session (JWT) is minted. */
export interface SessionContext {
  /** Real client IP (X-Forwarded-For first hop), or null when unknown. */
  ip: string | null;
  /** Raw User-Agent header (truncated), or null. */
  userAgent: string | null;
}

/** Input to {@link SessionService.create}. */
export interface CreateSessionInput {
  userId: string;
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** A session as surfaced to its owner (GET /auth/sessions). */
export interface SessionSummary {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeen: string | null;
  /** True for the session backing the request that is listing. */
  current: boolean;
}

/** Raw row shape of sessions (snake_case from SQLite). */
interface SessionRow {
  id: string;
  user_id: string;
  email: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen: string | null;
  revoked_at: string | null;
}

/** Property the auth validator stashes the resolved session id on. */
interface RequestWithSid extends Request {
  sessionId?: string | null;
}

/** Attach the resolved session id to a request (used by the auth validator). */
export function setRequestSessionId(req: Request, sid: string | null): void {
  (req as RequestWithSid).sessionId = sid;
}

/** Read the resolved session id off a request (null on public/legacy tokens). */
export function getRequestSessionId(req: Request): string | null {
  return (req as RequestWithSid).sessionId ?? null;
}

/** Real client IP, honouring the proxy's X-Forwarded-For (first hop). */
export function clientIpFromRequest(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  let ip = '';
  if (typeof fwd === 'string' && fwd.length > 0) ip = fwd.split(',')[0].trim();
  else if (Array.isArray(fwd) && fwd.length > 0) ip = fwd[0].trim();
  else ip = req.ip || req.socket?.remoteAddress || '';
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** User-Agent header, trimmed and capped so a hostile client can't bloat the row. */
export function userAgentFromRequest(req: Request): string | null {
  const ua = req.headers['user-agent'];
  if (typeof ua !== 'string' || ua.length === 0) return null;
  return ua.slice(0, 400);
}

/** Build the {@link SessionContext} for the request that is minting a JWT. */
export function sessionContextFromRequest(req: Request): SessionContext {
  return {
    ip: clientIpFromRequest(req),
    userAgent: userAgentFromRequest(req),
  };
}

/**
 * Active login sessions (Active Sessions, "Mi cuenta"). Every human JWT
 * (password login, magic-link, signup — 2FA rides inside those) mints a row
 * here whose id is embedded in the token as `sid`; the auth validator rejects a
 * token whose `sid` is revoked or missing from this table, so a user can end a
 * session from another device.
 *
 * The table lives on the GLOBAL DB and is seeded idempotently on boot, mirroring
 * the other auth control-plane tables (magic_tokens): SQLite has no numbered
 * migration this module owns, so it CREATEs its own table IF NOT EXISTS.
 *
 * HOT PATH: {@link isActive} runs on every authenticated request, so it is
 * backed by a tiny in-memory TTL cache to spare the DB a lookup per request; the
 * cache is cleared on any revoke so a revocation takes effect immediately.
 */
@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);

  /** sid → epoch-ms until which the sid is known-active (cache miss = re-check). */
  private readonly activeCache = new Map<string, number>();
  private static readonly ACTIVE_CACHE_TTL_MS = 10_000;

  /** sid → epoch-ms of the last last_seen write (throttles the touch write). */
  private readonly lastTouch = new Map<string, number>();
  private static readonly TOUCH_INTERVAL_MS = 60_000;

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    try {
      this.ensureSchema();
    } catch (err) {
      this.logger.error(
        `sessions bootstrap failed (continuing): ${(err as Error).message}`,
      );
    }
  }

  private ensureSchema(): void {
    this.db.global().exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         email TEXT,
         ip TEXT,
         user_agent TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         last_seen TEXT,
         revoked_at TEXT
       );
       CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`,
    );
  }

  // ---------------------------------------------------------------------------
  // Mint
  // ---------------------------------------------------------------------------

  /** Create a session row and return its id (goes into the JWT as `sid`). */
  create(input: CreateSessionInput): string {
    const id = crypto.randomBytes(18).toString('base64url');
    const now = new Date().toISOString();
    this.db
      .global()
      .prepare(
        `INSERT INTO sessions (id, user_id, email, ip, user_agent, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.email ?? null,
        input.ip ?? null,
        input.userAgent ?? null,
        now,
        now,
      );
    this.activeCache.set(id, Date.now() + SessionService.ACTIVE_CACHE_TTL_MS);
    return id;
  }

  // ---------------------------------------------------------------------------
  // Guard delegate (hot path)
  // ---------------------------------------------------------------------------

  /** True when `sid` maps to a live (non-revoked, existing) session. */
  isActive(sid: string): boolean {
    if (!sid) return false;
    const cached = this.activeCache.get(sid);
    if (cached !== undefined && cached > Date.now()) return true;

    const row = this.db
      .global()
      .prepare(`SELECT revoked_at FROM sessions WHERE id = ? LIMIT 1`)
      .get(sid) as { revoked_at: string | null } | undefined;
    const active = !!row && !row.revoked_at;
    if (active) {
      this.activeCache.set(sid, Date.now() + SessionService.ACTIVE_CACHE_TTL_MS);
    } else {
      this.activeCache.delete(sid);
    }
    return active;
  }

  /** Best-effort last_seen bump (throttled; never fails the request). */
  touch(sid: string): void {
    if (!sid) return;
    const now = Date.now();
    const last = this.lastTouch.get(sid) ?? 0;
    if (now - last < SessionService.TOUCH_INTERVAL_MS) return;
    this.lastTouch.set(sid, now);
    try {
      this.db
        .global()
        .prepare(
          `UPDATE sessions SET last_seen = datetime('now')
            WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(sid);
    } catch (err) {
      this.logger.debug(`failed to touch session ${sid}: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Owner surface (/auth/sessions)
  // ---------------------------------------------------------------------------

  /** The caller's own live sessions, newest first, flagging the current one. */
  listForUser(userId: string, currentSid: string | null): SessionSummary[] {
    const rows = this.db
      .global()
      .prepare(
        `SELECT id, user_id, email, ip, user_agent, created_at, last_seen, revoked_at
           FROM sessions
          WHERE user_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .all(userId) as SessionRow[];
    return rows.map((r) => ({
      id: r.id,
      ip: r.ip,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSeen: r.last_seen,
      current: r.id === currentSid,
    }));
  }

  /**
   * Revoke ONE of the caller's own sessions. Returns false when the session
   * does not exist, is already revoked, or belongs to another user — the caller
   * can never revoke a session that isn't theirs (the user_id predicate).
   */
  revoke(userId: string, sid: string): boolean {
    const res = this.db
      .global()
      .prepare(
        `UPDATE sessions SET revoked_at = datetime('now')
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .run(sid, userId);
    this.activeCache.delete(sid);
    return res.changes > 0;
  }

  /** Revoke every other live session of the caller; returns how many were closed. */
  revokeOthers(userId: string, exceptSid: string | null): number {
    const res = this.db
      .global()
      .prepare(
        `UPDATE sessions SET revoked_at = datetime('now')
          WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`,
      )
      .run(userId, exceptSid ?? '');
    // A bulk revoke may touch cached sids we can't cheaply enumerate → clear all.
    this.activeCache.clear();
    if (exceptSid) {
      this.activeCache.set(
        exceptSid,
        Date.now() + SessionService.ACTIVE_CACHE_TTL_MS,
      );
    }
    return res.changes;
  }
}
