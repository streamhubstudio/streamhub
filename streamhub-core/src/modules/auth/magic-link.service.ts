import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { DbService } from '../../shared/db/db.service';
import { ConfigService } from '../../shared/config/config.service';
import { signJwt } from '../../shared/auth';
import { TenancyService } from '../tenancy/tenancy.service';
import { EmailService } from '../email/email.service';
import { hashRandomPassword } from './password.util';
import { TotpService } from './totp.service';
import { SessionContext, SessionService } from './session.service';

/** Outcome of requestMagicLink — always generic to the caller (no enumeration). */
export interface MagicRequestResult {
  /** True when a link was actually dispatched (never surfaced to the client). */
  dispatched: boolean;
  /** Reason a link was NOT dispatched (rate-limited / invalid / smtp) — for logs. */
  reason?:
    | 'rate_limited'
    | 'cooldown'
    | 'invalid_email'
    | 'send_failed'
    | 'not_configured';
  /**
   * Only with reason 'cooldown': seconds until the same email may request
   * another link. The controller surfaces this as a 429 (the ONE non-generic
   * branch — it leaks nothing about account existence, only request recency).
   */
  retryAfterSeconds?: number;
}

/** Result of a successful verify — a session JWT (same as password login). */
export interface MagicVerifyResult {
  token: string;
}

/** Raw row shape of magic_tokens (snake_case from SQLite). */
interface MagicTokenRow {
  id: number;
  token_hash: string;
  email: string;
  request_ip: string | null;
  created_at: string;
  expires_at: string;
  used: number;
  used_at: string | null;
  /** 'login' (self-requested) | 'invite' (owner-issued, longer TTL). */
  kind: string;
}

/**
 * Passwordless magic-link auth (Wave-7 §auth).
 *
 * Flow:
 *   1. POST /auth/magic-link { email } → generate a one-time token, store only
 *      its sha256 HASH + email + expiry (15 min) + used flag, and email the
 *      link https://app.streamhub.studio/auth/magic?token=<token>. The endpoint
 *      ALWAYS returns a generic 200 (no account enumeration). Rate-limited per
 *      email and per IP to stop email-bombing.
 *   2. POST /auth/magic/verify { token } → validate (exists, unexpired, unused),
 *      mark used, resolve-or-create the user (+ owner team for a new email;
 *      superadmin when the email is the configured superadmin), mint the same
 *      session JWT the password login returns.
 *
 * TOKEN MODEL: 32 random bytes (base64url, ~43 chars) shown ONLY in the emailed
 * URL; the DB stores sha256(token) so a DB leak cannot reconstruct live links.
 * Single-use (the `used` flag is flipped atomically on verify) and short-lived
 * (TTL_MINUTES). Verification is a constant work hash+lookup by hash.
 */
@Injectable()
export class MagicLinkService implements OnModuleInit {
  private readonly logger = new Logger(MagicLinkService.name);

  /** One-time token lifetime. */
  static readonly TTL_MINUTES = 15;
  /** Invite links live longer — the invitee may open the email days later. */
  static readonly INVITE_TTL_MINUTES = 72 * 60;
  /** Session JWT lifetime (mirrors AuthService: ~12h). */
  private static readonly JWT_TTL_SECONDS = 12 * 60 * 60;

  /** Rate limits within a sliding window (anti email-bombing). */
  private static readonly RATE_WINDOW_MINUTES = 15;
  private static readonly MAX_PER_EMAIL = 3;
  private static readonly MAX_PER_IP = 10;
  /** Minimum spacing between two self-requested links for the SAME email. */
  static readonly RESEND_COOLDOWN_SECONDS = 60;

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly tenancy: TenancyService,
    private readonly email: EmailService,
    private readonly totp: TotpService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Create the magic_tokens table idempotently on boot (mirrors TenancyService:
   * SQLite has no ADD COLUMN/TABLE IF NOT EXISTS in a numbered migration this
   * module owns, so it seeds its own control-plane table on the global DB).
   */
  onModuleInit(): void {
    try {
      this.ensureSchema();
    } catch (err) {
      this.logger.error(
        `magic_tokens bootstrap failed (continuing): ${(err as Error).message}`,
      );
    }
  }

  private ensureSchema(): void {
    const db = this.db.global();
    db.exec(
      `CREATE TABLE IF NOT EXISTS magic_tokens (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         token_hash TEXT NOT NULL UNIQUE,
         email TEXT NOT NULL,
         request_ip TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         expires_at TEXT NOT NULL,
         used INTEGER NOT NULL DEFAULT 0,
         used_at TEXT
       );
       CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);
       CREATE INDEX IF NOT EXISTS idx_magic_tokens_created ON magic_tokens(created_at);`,
    );
    // `kind` distinguishes self-requested login links from owner-issued invite
    // links (longer TTL; excluded from the login cooldown/rate-limit windows).
    const cols = (db.prepare('PRAGMA table_info(magic_tokens)').all() as {
      name: string;
    }[]).map((c) => c.name);
    if (!cols.includes('kind')) {
      db.exec(
        "ALTER TABLE magic_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'login'",
      );
      this.logger.log('migrated magic_tokens: added kind');
    }
  }

  // ---------------------------------------------------------------------------
  // Request (POST /auth/magic-link)
  // ---------------------------------------------------------------------------

  /**
   * Issue a magic link for `email`. ALWAYS safe to expose a generic response:
   * this method swallows every branch (invalid email, rate-limited, SMTP down)
   * into a {@link MagicRequestResult} whose `dispatched` flag the controller
   * MUST NOT leak. Rate-limited per email + per IP over a sliding window.
   */
  async requestMagicLink(
    rawEmail: string,
    ip: string | null,
  ): Promise<MagicRequestResult> {
    const email = (rawEmail || '').trim().toLowerCase();
    if (!this.isValidEmail(email)) {
      return { dispatched: false, reason: 'invalid_email' };
    }

    // Resend cooldown: a SECOND link for the same email within 60s is refused
    // with the remaining wait. Applies to every email (existing or not), so it
    // cannot be used to enumerate accounts. Checked BEFORE the window limits so
    // the client gets an actionable retryAfterSeconds instead of the generic 200.
    const retryAfterSeconds = this.cooldownRemainingSeconds(email);
    if (retryAfterSeconds > 0) {
      this.logger.warn(
        `magic-link cooldown for <${this.mask(email)}> (${retryAfterSeconds}s left)`,
      );
      return { dispatched: false, reason: 'cooldown', retryAfterSeconds };
    }

    // Rate-limit (email + IP) BEFORE minting/storing anything.
    if (this.isRateLimited(email, ip)) {
      this.logger.warn(
        `magic-link rate-limited for <${this.mask(email)}> ip=${ip ?? '?'}`,
      );
      return { dispatched: false, reason: 'rate_limited' };
    }

    // Mint the one-time token; persist only its hash. Timestamps are stored as
    // explicit ISO-8601 UTC strings (…Z) — NOT SQLite's space-separated
    // datetime('now') — so the rate-limit window and expiry comparisons are
    // lexicographically consistent (and JS Date.parse reads them unambiguously).
    const token = this.generateToken();
    const hash = this.hashToken(token);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(
      now + MagicLinkService.TTL_MINUTES * 60_000,
    ).toISOString();

    this.db
      .global()
      .prepare(
        `INSERT INTO magic_tokens (token_hash, email, request_ip, created_at, expires_at, kind)
         VALUES (?, ?, ?, ?, ?, 'login')`,
      )
      .run(hash, email, ip ?? null, createdAt, expiresAt);

    const url = this.buildMagicUrl(token);
    const res = await this.email.sendMagicLink(email, url);
    if (!res.ok) {
      return {
        dispatched: false,
        reason: res.skipped ? 'not_configured' : 'send_failed',
      };
    }
    this.logger.log(`magic-link dispatched to <${this.mask(email)}>`);
    return { dispatched: true };
  }

  // ---------------------------------------------------------------------------
  // Invite links (issued by /tenant/invites — an authenticated owner action)
  // ---------------------------------------------------------------------------

  /**
   * Mint an INVITE link for `email` and return its full URL (the caller emails
   * it). Same one-time hashed-at-rest token model as a login link, but with a
   * 72h TTL and kind='invite' so it neither consumes nor is blocked by the
   * self-request cooldown/rate-limit windows. Verification is identical:
   * /auth/magic?token=… → verify() promotes the pending invitee to active.
   */
  issueInviteLink(rawEmail: string): string {
    const email = (rawEmail || '').trim().toLowerCase();
    if (!this.isValidEmail(email)) {
      throw new BadRequestException('invalid email');
    }
    const token = this.generateToken();
    const hash = this.hashToken(token);
    const now = Date.now();
    this.db
      .global()
      .prepare(
        `INSERT INTO magic_tokens (token_hash, email, request_ip, created_at, expires_at, kind)
         VALUES (?, ?, NULL, ?, ?, 'invite')`,
      )
      .run(
        hash,
        email,
        new Date(now).toISOString(),
        new Date(
          now + MagicLinkService.INVITE_TTL_MINUTES * 60_000,
        ).toISOString(),
      );
    return this.buildMagicUrl(token);
  }

  /** Invalidate every outstanding invite link for an email (invite revoked). */
  revokeInviteLinks(rawEmail: string): void {
    const email = (rawEmail || '').trim().toLowerCase();
    this.db
      .global()
      .prepare(
        `UPDATE magic_tokens SET used = 1, used_at = datetime('now')
          WHERE email = ? AND kind = 'invite' AND used = 0`,
      )
      .run(email);
  }

  // ---------------------------------------------------------------------------
  // Verify (POST /auth/magic/verify)
  // ---------------------------------------------------------------------------

  /**
   * Consume a magic token: validate (exists, unused, unexpired), flip `used`
   * atomically, resolve-or-create the user, and mint a session JWT. Throws
   * UnauthorizedException on any invalid/expired/used token.
   *
   * 2FA: when the email belongs to a user with TOTP enabled, a valid `code` is
   * required. The requirement is asserted BEFORE the token is claimed, so a
   * missing/wrong code (401 `totp_required` / `totp_invalid`) does NOT burn the
   * single-use link — the SPA re-submits the same token with the code.
   */
  async verify(
    rawToken: string,
    code?: string,
    session?: SessionContext,
  ): Promise<MagicVerifyResult> {
    const secret = this.requireSecret();
    const token = (rawToken || '').trim();
    if (!token) throw new UnauthorizedException('Invalid or expired link');

    const hash = this.hashToken(token);
    const row = this.db
      .global()
      .prepare(`SELECT * FROM magic_tokens WHERE token_hash = ? LIMIT 1`)
      .get(hash) as MagicTokenRow | undefined;

    if (!row || row.used) {
      throw new UnauthorizedException('Invalid or expired link');
    }
    if (this.isExpired(row.expires_at)) {
      throw new UnauthorizedException('Invalid or expired link');
    }

    // Second factor BEFORE claiming (keeps the link reusable for the retry).
    const holder = this.tenancy.getUserByEmail(row.email);
    if (holder) {
      this.totp.assertLoginCode(holder.id, code);
    }

    // Atomically claim the token: only the caller that flips used 0→1 wins,
    // so a double-submit / race cannot mint two sessions from one link.
    const claim = this.db
      .global()
      .prepare(
        `UPDATE magic_tokens SET used = 1, used_at = datetime('now')
          WHERE id = ? AND used = 0`,
      )
      .run(row.id);
    if (claim.changes === 0) {
      throw new UnauthorizedException('Invalid or expired link');
    }

    const userId = this.resolveOrCreateUser(row.email);
    const sid = this.sessions.create({
      userId,
      email: row.email,
      ip: session?.ip ?? null,
      userAgent: session?.userAgent ?? null,
    });
    return {
      token: signJwt(
        { sub: userId, sid },
        secret,
        MagicLinkService.JWT_TTL_SECONDS,
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // User resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve the user for a verified email, creating one on first sign-in:
   *   - the configured superadmin email → the mirrored `admin` principal (sub
   *     resolves to a superadmin context in AuthService.validateJwt). Idempotent.
   *   - an existing user → their id (magic-link is passwordless, so a null
   *     password is fine; a pending invite is promoted to active).
   *   - a brand-new email → a fresh user + an `owner` team.
   */
  private resolveOrCreateUser(email: string): string {
    const normalized = email.trim().toLowerCase();

    // Superadmin: the platform owner. Mirror as the stable `admin` principal +
    // flag superadmin so validateJwt lifts them to the superadmin context.
    if (normalized === this.superadminEmail()) {
      this.tenancy.ensureUser(TenancyService.ADMIN_USER_ID, normalized);
      this.db
        .global()
        .prepare(`UPDATE users SET is_superadmin = 1 WHERE id = ?`)
        .run(TenancyService.ADMIN_USER_ID);
      // Ensure they own the platform tenant (idempotent).
      this.tenancy.addMembership(
        TenancyService.ADMIN_USER_ID,
        'platform',
        'owner',
      );
      return TenancyService.ADMIN_USER_ID;
    }

    const existing = this.tenancy.getUserByEmail(normalized);
    if (existing) {
      // Promote a pending invite to active on first successful magic sign-in.
      if (existing.status === 'pending') {
        this.db
          .global()
          .prepare(`UPDATE users SET status = 'active' WHERE id = ?`)
          .run(existing.id);
      }
      if (!this.tenancy.primaryMembership(existing.id)) {
        const tenantId = this.tenancy.createTeam(normalized);
        this.tenancy.addMembership(existing.id, tenantId, 'owner');
      }
      return existing.id;
    }

    // Brand-new email → user + owner team. We seed a STRONG RANDOM scrypt
    // password (not NULL) so password login is closed-by-default for accounts
    // born from a magic link: the plaintext is never known, so verifyPassword
    // can never succeed until the user runs the reset flow. Magic-link sign-in
    // itself is unaffected (it does not check the password).
    const userId = this.tenancy.createUser({
      email: normalized,
      passwordHash: hashRandomPassword(),
      status: 'active',
    });
    const tenantId = this.tenancy.createTeam(normalized);
    this.tenancy.addMembership(userId, tenantId, 'owner');
    return userId;
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  /** True when either the email or the IP exceeded its window quota. */
  private isRateLimited(email: string, ip: string | null): boolean {
    const since = new Date(
      Date.now() - MagicLinkService.RATE_WINDOW_MINUTES * 60_000,
    ).toISOString();

    const perEmail = this.countSince('email', email, since);
    if (perEmail >= MagicLinkService.MAX_PER_EMAIL) return true;

    if (ip) {
      const perIp = this.countSince('request_ip', ip, since);
      if (perIp >= MagicLinkService.MAX_PER_IP) return true;
    }
    return false;
  }

  private countSince(
    column: 'email' | 'request_ip',
    value: string,
    sinceIso: string,
  ): number {
    // Only self-requested login links count against the anti-bombing windows —
    // owner-issued invites are an authenticated action with its own gate.
    const row = this.db
      .global()
      .prepare(
        `SELECT COUNT(*) AS n FROM magic_tokens
          WHERE ${column} = ? AND created_at >= ? AND kind = 'login'`,
      )
      .get(value, sinceIso) as { n: number };
    return row.n;
  }

  /**
   * Seconds left before `email` may self-request another login link (0 = may
   * request now). Derived from the most recent kind='login' row, so it needs no
   * extra state and restarts survive.
   */
  private cooldownRemainingSeconds(email: string): number {
    const row = this.db
      .global()
      .prepare(
        `SELECT MAX(created_at) AS last FROM magic_tokens
          WHERE email = ? AND kind = 'login'`,
      )
      .get(email) as { last: string | null };
    if (!row.last) return 0;
    const last = Date.parse(row.last);
    if (Number.isNaN(last)) return 0;
    const elapsed = (Date.now() - last) / 1000;
    const remaining = MagicLinkService.RESEND_COOLDOWN_SECONDS - elapsed;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireSecret(): string {
    const secret = this.config.jwtSecret;
    if (!secret) {
      this.logger.warn(
        'magic-link verify attempted but STREAMHUB_JWT_SECRET not configured',
      );
      throw new UnauthorizedException('Login is not configured');
    }
    return secret;
  }

  /** Configured public app base URL (where the SPA handles /auth/magic). */
  private appBaseUrl(): string {
    const v = this.config.env('STREAMHUB_APP_URL');
    return (v && v.trim()) || 'https://app.streamhub.studio';
  }

  /** Configured superadmin email (magic link to this = superadmin). */
  private superadminEmail(): string {
    const v = this.config.env('STREAMHUB_SUPERADMIN_EMAIL');
    return ((v && v.trim()) || 'info@streamhub.studio').toLowerCase();
  }

  private buildMagicUrl(token: string): string {
    const base = this.appBaseUrl().replace(/\/+$/, '');
    return `${base}/auth/magic?token=${encodeURIComponent(token)}`;
  }

  private generateToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private isExpired(expiresAtIso: string): boolean {
    const exp = Date.parse(expiresAtIso);
    if (Number.isNaN(exp)) return true;
    return Date.now() >= exp;
  }

  private isValidEmail(email: string): boolean {
    if (!email || email.length > 200) return false;
    // Deliberately permissive: one @, non-empty local + dotted domain.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  private mask(email: string): string {
    const at = email.indexOf('@');
    if (at <= 0) return '***';
    return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
  }
}
