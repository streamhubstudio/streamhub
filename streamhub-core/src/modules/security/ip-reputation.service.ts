import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DbService } from '../../shared/db/db.service';
import { ConfigService } from '../../shared/config/config.service';
import { setRateLimitOffenseReporter } from '../../shared/http/auth-rate-limit';
import { isPrivateOrLoopbackIp, normalizeIp, parseIp } from './ip-cidr.util';
import { IpRulesService } from './ip-rules.service';
import {
  resolveSecuritySettings,
  type SecuritySettings,
} from './security-settings';

/** What an IP did wrong. Wired from the real failure sites (see docs). */
export type OffenseKind =
  | 'login_failed'
  | 'magic_verify_failed'
  | 'invalid_token'
  | 'rate_limited'
  | 'not_found';

/** An active or recent ban as surfaced by the admin API. */
export interface BanView {
  ip: string;
  reason: string;
  firstSeen: string;
  offenseCount: number;
  bannedUntil: string;
  escalationLevel: number;
  active: boolean;
}

/** A recent offender (sliding-window counts, not yet necessarily banned). */
export interface OffenderView {
  ip: string;
  count: number;
  lastSeen: string;
  kinds: Partial<Record<OffenseKind, number>>;
}

interface BanEntry {
  reason: string;
  firstSeen: string;
  offenseCount: number;
  bannedUntilMs: number;
  escalationLevel: number;
}

interface BanRow {
  ip: string;
  reason: string;
  first_seen: string;
  offense_count: number;
  banned_until: string;
  escalation_level: number;
}

/** Escalated bans never exceed this (7 days). */
const MAX_BAN_TTL_S = 7 * 24 * 3600;
/** Expired ban rows are kept this long for the "recent" list, then purged. */
const BAN_HISTORY_RETENTION_MS = 7 * 24 * 3600 * 1000;
/** Periodic maintenance (flush active bans + prune) interval. */
const SWEEP_INTERVAL_MS = 60_000;
/** Cap the offender map so a spoofed-XFF flood can't grow memory unbounded. */
const MAX_TRACKED_OFFENDERS = 10_000;

/**
 * In-app fail2ban (network-security feature).
 *
 * Offenses are recorded per client IP into an in-memory sliding window; once an
 * IP accumulates `autobanMaxOffenses` within `autobanWindowS`, it is banned for
 * `autobanBaseTtlS` seconds — doubling per repeat ban (escalation), capped at 7
 * days. Active bans are persisted to the GLOBAL DB table `ip_bans` (written on
 * ban + refreshed by a periodic sweep) so they survive a core restart.
 *
 * GUARANTEES:
 *  - loopback / RFC1918 / link-local and explicitly allowlisted IPs are NEVER
 *    banned (offenses are still counted for the /offenses visibility surface);
 *  - {@link recordOffense} is fire-and-forget: it never throws, so a reporting
 *    failure can never break the request path that called it;
 *  - the hot-path {@link isBanned} is a pure in-memory Map lookup.
 */
@Injectable()
export class IpReputationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IpReputationService.name);
  readonly settings: SecuritySettings;

  /** ip → offense timestamps+kinds inside (roughly) the sliding window. */
  private readonly offenses = new Map<
    string,
    Array<{ ts: number; kind: OffenseKind }>
  >();
  /** ip → active ban (authoritative for the hot path). */
  private readonly bans = new Map<string, BanEntry>();

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DbService,
    config: ConfigService,
    private readonly rules: IpRulesService,
  ) {
    this.settings = resolveSecuritySettings(config);
  }

  onModuleInit(): void {
    try {
      this.ensureSchema();
      this.loadPersistedBans();
    } catch (err) {
      this.logger.error(
        `ip_bans bootstrap failed (continuing): ${(err as Error).message}`,
      );
    }
    // 429s from the express-rate-limit middleware (built in main.ts, outside
    // DI) are reported through the shared slot.
    setRateLimitOffenseReporter((ip) => this.recordOffense(ip, 'rate_limited'));
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    setRateLimitOffenseReporter(null);
  }

  private ensureSchema(): void {
    this.db.global().exec(
      `CREATE TABLE IF NOT EXISTS ip_bans (
         ip TEXT PRIMARY KEY,
         reason TEXT NOT NULL,
         first_seen TEXT NOT NULL,
         offense_count INTEGER NOT NULL DEFAULT 0,
         banned_until TEXT NOT NULL,
         escalation_level INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX IF NOT EXISTS idx_ip_bans_until ON ip_bans(banned_until);`,
    );
  }

  /** Re-arm still-active bans after a restart. */
  private loadPersistedBans(): void {
    const now = Date.now();
    const rows = this.db
      .global()
      .prepare(`SELECT * FROM ip_bans`)
      .all() as BanRow[];
    let restored = 0;
    for (const row of rows) {
      const until = Date.parse(row.banned_until);
      if (Number.isNaN(until) || until <= now) continue;
      this.bans.set(row.ip, {
        reason: row.reason,
        firstSeen: row.first_seen,
        offenseCount: row.offense_count,
        bannedUntilMs: until,
        escalationLevel: row.escalation_level,
      });
      restored++;
    }
    if (restored > 0) {
      this.logger.log(`restored ${restored} active IP ban(s) from ip_bans`);
    }
  }

  // ---------------------------------------------------------------------------
  // Recording (fire-and-forget — called from the auth failure sites)
  // ---------------------------------------------------------------------------

  /**
   * Record one offense for `ip`. NEVER throws and never bans loopback/private/
   * allowlisted addresses. A no-op when STREAMHUB_AUTOBAN_ENABLED is off.
   */
  recordOffense(ip: string | null | undefined, kind: OffenseKind): void {
    try {
      if (!this.settings.autobanEnabled) return;
      const normalized = normalizeIp(ip || '');
      if (!normalized || !parseIp(normalized)) return;

      const now = Date.now();
      const windowMs = this.settings.autobanWindowS * 1000;
      const list = (this.offenses.get(normalized) ?? []).filter(
        (o) => now - o.ts < windowMs,
      );
      list.push({ ts: now, kind });
      if (
        !this.offenses.has(normalized) &&
        this.offenses.size >= MAX_TRACKED_OFFENDERS
      ) {
        // Bounded memory: drop the oldest tracked offender before adding.
        const oldest = this.offenses.keys().next().value;
        if (oldest !== undefined) this.offenses.delete(oldest);
      }
      this.offenses.set(normalized, list);

      // The never-ban guarantee: private/loopback and allowlisted IPs are
      // counted (visibility) but never cross into a ban.
      if (isPrivateOrLoopbackIp(normalized)) return;
      if (this.rules.isAllowlisted(normalized)) return;
      if (this.isBanned(normalized)) return; // already banned — idempotent

      if (list.length >= this.settings.autobanMaxOffenses) {
        this.ban(normalized, kind, list.length);
      }
    } catch (err) {
      // Absolute guarantee: reputation tracking never breaks a request.
      this.logger.debug(`recordOffense failed: ${(err as Error).message}`);
    }
  }

  private ban(ip: string, lastKind: OffenseKind, offenseCount: number): void {
    const now = Date.now();
    // Escalation: any prior ban row (even expired) bumps the level → 2^level.
    const prior = this.db
      .global()
      .prepare(`SELECT escalation_level, first_seen FROM ip_bans WHERE ip = ?`)
      .get(ip) as
      | { escalation_level: number; first_seen: string }
      | undefined;
    const level = prior ? prior.escalation_level + 1 : 0;
    const ttlS = Math.min(
      this.settings.autobanBaseTtlS * 2 ** level,
      MAX_BAN_TTL_S,
    );
    const entry: BanEntry = {
      reason: lastKind,
      firstSeen: prior?.first_seen ?? new Date(now).toISOString(),
      offenseCount,
      bannedUntilMs: now + ttlS * 1000,
      escalationLevel: level,
    };
    this.bans.set(ip, entry);
    this.offenses.delete(ip);
    this.persistBan(ip, entry);
    this.logger.warn(
      `auto-ban ip=${ip} reason=${lastKind} offenses=${offenseCount} ttl=${ttlS}s level=${level}`,
    );
  }

  private persistBan(ip: string, entry: BanEntry): void {
    try {
      this.db
        .global()
        .prepare(
          `INSERT INTO ip_bans (ip, reason, first_seen, offense_count, banned_until, escalation_level)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(ip) DO UPDATE SET
             reason = excluded.reason,
             offense_count = excluded.offense_count,
             banned_until = excluded.banned_until,
             escalation_level = excluded.escalation_level`,
        )
        .run(
          ip,
          entry.reason,
          entry.firstSeen,
          entry.offenseCount,
          new Date(entry.bannedUntilMs).toISOString(),
          entry.escalationLevel,
        );
    } catch (err) {
      this.logger.error(`failed to persist ban for ${ip}: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Hot path
  // ---------------------------------------------------------------------------

  /** In-memory lookup; expired entries are dropped lazily. */
  isBanned(ip: string): boolean {
    const entry = this.bans.get(ip);
    if (!entry) return false;
    if (entry.bannedUntilMs <= Date.now()) {
      this.bans.delete(ip);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Admin surface
  // ---------------------------------------------------------------------------

  activeBans(): BanView[] {
    const now = Date.now();
    const out: BanView[] = [];
    for (const [ip, e] of this.bans) {
      if (e.bannedUntilMs <= now) continue;
      out.push({
        ip,
        reason: e.reason,
        firstSeen: e.firstSeen,
        offenseCount: e.offenseCount,
        bannedUntil: new Date(e.bannedUntilMs).toISOString(),
        escalationLevel: e.escalationLevel,
        active: true,
      });
    }
    return out.sort((a, b) => (a.bannedUntil < b.bannedUntil ? 1 : -1));
  }

  /** Expired bans still inside the history retention (newest first). */
  recentBans(limit = 50): BanView[] {
    const nowIso = new Date(Date.now()).toISOString();
    const rows = this.db
      .global()
      .prepare(
        `SELECT * FROM ip_bans WHERE banned_until <= ?
          ORDER BY banned_until DESC LIMIT ?`,
      )
      .all(nowIso, limit) as BanRow[];
    return rows.map((r) => ({
      ip: r.ip,
      reason: r.reason,
      firstSeen: r.first_seen,
      offenseCount: r.offense_count,
      bannedUntil: r.banned_until,
      escalationLevel: r.escalation_level,
      active: false,
    }));
  }

  /**
   * Lift a ban (admin action) — a CLEAN SLATE: clears the in-memory ban, the
   * offense window AND the persisted ban row, so the next ban (if any) starts
   * back at escalation level 0. Returns false when the IP was neither banned
   * nor known.
   */
  unban(rawIp: string): boolean {
    const ip = normalizeIp(rawIp);
    const hadMemory = this.bans.delete(ip);
    this.offenses.delete(ip);
    const res = this.db
      .global()
      .prepare(`DELETE FROM ip_bans WHERE ip = ?`)
      .run(ip);
    const had = hadMemory || res.changes > 0;
    if (had) this.logger.log(`ip ${ip} unbanned by operator`);
    return had;
  }

  /** Recent offenders (window counts), heaviest first. */
  offenders(limit = 50): OffenderView[] {
    const now = Date.now();
    const windowMs = this.settings.autobanWindowS * 1000;
    const out: OffenderView[] = [];
    for (const [ip, list] of this.offenses) {
      const fresh = list.filter((o) => now - o.ts < windowMs);
      if (fresh.length === 0) {
        this.offenses.delete(ip);
        continue;
      }
      this.offenses.set(ip, fresh);
      const kinds: Partial<Record<OffenseKind, number>> = {};
      let last = 0;
      for (const o of fresh) {
        kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
        if (o.ts > last) last = o.ts;
      }
      out.push({
        ip,
        count: fresh.length,
        lastSeen: new Date(last).toISOString(),
        kinds,
      });
    }
    return out.sort((a, b) => b.count - a.count).slice(0, limit);
  }

  counts(): { activeBans: number; trackedOffenders: number } {
    return {
      activeBans: this.activeBans().length,
      trackedOffenders: this.offenses.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Periodic: flush active bans, drop expired memory, prune old history. */
  private sweep(): void {
    try {
      const now = Date.now();
      for (const [ip, e] of this.bans) {
        if (e.bannedUntilMs <= now) this.bans.delete(ip);
        else this.persistBan(ip, e); // refresh — bans survive restarts
      }
      const windowMs = this.settings.autobanWindowS * 1000;
      for (const [ip, list] of this.offenses) {
        const fresh = list.filter((o) => now - o.ts < windowMs);
        if (fresh.length === 0) this.offenses.delete(ip);
        else this.offenses.set(ip, fresh);
      }
      this.db
        .global()
        .prepare(`DELETE FROM ip_bans WHERE banned_until < ?`)
        .run(new Date(now - BAN_HISTORY_RETENTION_MS).toISOString());
    } catch (err) {
      this.logger.debug(`sweep failed: ${(err as Error).message}`);
    }
  }
}
