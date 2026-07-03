import {
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
import { hashPassword } from './password.util';

/** Outcome of requestReset — always generic to the caller (no enumeration). */
export interface ResetRequestResult {
  /** True when a reset email was actually dispatched (never surfaced). */
  dispatched: boolean;
  /** Why a link was NOT dispatched — for logs only. */
  reason?:
    | 'rate_limited'
    | 'invalid_email'
    | 'no_such_user'
    | 'send_failed'
    | 'not_configured';
}

/** Result of a successful reset — a session JWT (log the user straight in). */
export interface ResetResult {
  token: string;
}

/** Raw row shape of password_resets (snake_case from SQLite). */
interface ResetTokenRow {
  id: number;
  token_hash: string;
  user_id: string;
  email: string;
  request_ip: string | null;
  created_at: string;
  expires_at: string;
  used: number;
  used_at: string | null;
}

/**
 * Password-reset by email (mirrors {@link MagicLinkService} exactly — same token
 * model + rate-limit + generic-response contract, reusing EmailService for SMTP).
 *
 * Flow:
 *   1. POST /auth/reset-request { email } → if a RESETTABLE built-in user owns
 *      the email, mint a one-time token, store only its sha256 HASH + user id +
 *      expiry (30 min) + used flag, and email the link
 *      https://app.streamhub.studio/auth/reset?token=<token>. ALWAYS returns a
 *      generic 200 (no account enumeration). Rate-limited per email + per IP.
 *   2. POST /auth/reset { token, password } → validate (exists, unexpired,
 *      unused), atomically flip `used`, set the new scrypt password on the user,
 *      and mint the SAME session JWT the password login returns.
 *
 * BREAK-GLASS SAFETY: the configured ADMIN_USER and any is_superadmin user are
 * NEVER resettable through this flow. That keeps the env-based break-glass admin
 * (ADMIN_USER/ADMIN_PASS) authoritative and prevents an email-reset from writing
 * a password_hash on the mirrored `admin` row (which would otherwise open a
 * password-login path to a superadmin principal).
 *
 * TOKEN MODEL: 32 random bytes (base64url) shown ONLY in the emailed URL; the DB
 * stores sha256(token). Single-use (`used` flipped atomically) and short-lived.
 */
@Injectable()
export class ResetService implements OnModuleInit {
  private readonly logger = new Logger(ResetService.name);

  /** One-time reset token lifetime (shorter than magic-link on purpose). */
  static readonly TTL_MINUTES = 30;
  /** Session JWT lifetime (mirrors AuthService: ~12h). */
  private static readonly JWT_TTL_SECONDS = 12 * 60 * 60;

  /** Minimum new-password length (mirrors the DTO; defence-in-depth). */
  private static readonly MIN_PASSWORD_LEN = 8;

  /** Rate limits within a sliding window (anti email-bombing). */
  private static readonly RATE_WINDOW_MINUTES = 15;
  private static readonly MAX_PER_EMAIL = 3;
  private static readonly MAX_PER_IP = 10;

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly tenancy: TenancyService,
    private readonly email: EmailService,
  ) {}

  onModuleInit(): void {
    try {
      this.ensureSchema();
    } catch (err) {
      this.logger.error(
        `password_resets bootstrap failed (continuing): ${(err as Error).message}`,
      );
    }
  }

  private ensureSchema(): void {
    this.db.global().exec(
      `CREATE TABLE IF NOT EXISTS password_resets (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         token_hash TEXT NOT NULL UNIQUE,
         user_id TEXT NOT NULL,
         email TEXT NOT NULL,
         request_ip TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         expires_at TEXT NOT NULL,
         used INTEGER NOT NULL DEFAULT 0,
         used_at TEXT
       );
       CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);
       CREATE INDEX IF NOT EXISTS idx_password_resets_created ON password_resets(created_at);`,
    );
  }

  // ---------------------------------------------------------------------------
  // Request (POST /auth/reset-request)
  // ---------------------------------------------------------------------------

  /**
   * Issue a reset link for `email`. ALWAYS safe to expose a generic response:
   * every branch (invalid email, unknown user, rate-limited, SMTP down) collapses
   * into a {@link ResetRequestResult} whose `dispatched` flag the controller MUST
   * NOT leak. Rate-limited per email + per IP over a sliding window.
   */
  async requestReset(
    rawEmail: string,
    ip: string | null,
  ): Promise<ResetRequestResult> {
    const email = (rawEmail || '').trim().toLowerCase();
    if (!this.isValidEmail(email)) {
      return { dispatched: false, reason: 'invalid_email' };
    }

    // Rate-limit (email + IP) BEFORE any lookup/mint. Bounded by the email even
    // for non-existent accounts so it cannot be used to probe the user table.
    if (this.isRateLimited(email, ip)) {
      this.logger.warn(
        `reset rate-limited for <${this.mask(email)}> ip=${ip ?? '?'}`,
      );
      return { dispatched: false, reason: 'rate_limited' };
    }

    const user = this.resettableUser(email);
    if (!user) {
      // Generic to the caller; logged so ops can see reset probes.
      this.logger.log(`reset requested for non-resettable <${this.mask(email)}>`);
      return { dispatched: false, reason: 'no_such_user' };
    }

    const token = this.generateToken();
    const hash = this.hashToken(token);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(
      now + ResetService.TTL_MINUTES * 60_000,
    ).toISOString();

    this.db
      .global()
      .prepare(
        `INSERT INTO password_resets
           (token_hash, user_id, email, request_ip, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(hash, user.id, email, ip ?? null, createdAt, expiresAt);

    const url = this.buildResetUrl(token);
    const res = await this.email.sendPasswordReset(email, url);
    if (!res.ok) {
      return {
        dispatched: false,
        reason: res.skipped ? 'not_configured' : 'send_failed',
      };
    }
    this.logger.log(`reset link dispatched to <${this.mask(email)}>`);
    return { dispatched: true };
  }

  // ---------------------------------------------------------------------------
  // Reset (POST /auth/reset)
  // ---------------------------------------------------------------------------

  /**
   * Consume a reset token: validate (exists, unused, unexpired), atomically flip
   * `used`, set the new scrypt password on the target user, and mint a session
   * JWT. Throws UnauthorizedException on any invalid/expired/used token.
   */
  async reset(rawToken: string, newPassword: string): Promise<ResetResult> {
    const secret = this.requireSecret();
    const token = (rawToken || '').trim();
    if (!token) throw new UnauthorizedException('Invalid or expired link');
    if (!newPassword || newPassword.length < ResetService.MIN_PASSWORD_LEN) {
      throw new UnauthorizedException(
        `Password must be at least ${ResetService.MIN_PASSWORD_LEN} characters`,
      );
    }

    const hash = this.hashToken(token);
    const row = this.db
      .global()
      .prepare(`SELECT * FROM password_resets WHERE token_hash = ? LIMIT 1`)
      .get(hash) as ResetTokenRow | undefined;

    if (!row || row.used) {
      throw new UnauthorizedException('Invalid or expired link');
    }
    if (this.isExpired(row.expires_at)) {
      throw new UnauthorizedException('Invalid or expired link');
    }

    // Atomically claim the token: only the caller that flips used 0→1 wins, so a
    // double-submit / race cannot reset twice or mint two sessions from one link.
    const claim = this.db
      .global()
      .prepare(
        `UPDATE password_resets SET used = 1, used_at = datetime('now')
          WHERE id = ? AND used = 0`,
      )
      .run(row.id);
    if (claim.changes === 0) {
      throw new UnauthorizedException('Invalid or expired link');
    }

    // The user must still exist AND still be resettable (defence-in-depth in
    // case they were promoted to superadmin between request and reset).
    const user = this.tenancy.getUser(row.user_id);
    if (!user || !this.isResettable(user)) {
      throw new UnauthorizedException('Invalid or expired link');
    }

    this.tenancy.setPassword(user.id, hashPassword(newPassword));
    this.logger.log(`password reset completed for <${this.mask(row.email)}>`);
    return {
      token: signJwt({ sub: user.id }, secret, ResetService.JWT_TTL_SECONDS),
    };
  }

  // ---------------------------------------------------------------------------
  // User resolution
  // ---------------------------------------------------------------------------

  /** Resolve a resettable built-in user by email, or null (generic to caller). */
  private resettableUser(
    email: string,
  ): { id: string; email: string | null } | null {
    // The env break-glass admin is NEVER resettable via email.
    const adminUser = this.config.adminUser;
    if (adminUser && email === adminUser.trim().toLowerCase()) return null;

    const user = this.tenancy.getUserByEmail(email);
    if (!user || !this.isResettable(user)) return null;
    return { id: user.id, email: user.email };
  }

  /** Superadmins and the mirrored `admin` principal are excluded from reset. */
  private isResettable(user: {
    id: string;
    is_superadmin?: number | null;
  }): boolean {
    if (user.id === TenancyService.ADMIN_USER_ID) return false;
    if (user.is_superadmin) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Rate limiting (mirrors MagicLinkService)
  // ---------------------------------------------------------------------------

  private isRateLimited(email: string, ip: string | null): boolean {
    const since = new Date(
      Date.now() - ResetService.RATE_WINDOW_MINUTES * 60_000,
    ).toISOString();

    const perEmail = this.countSince('email', email, since);
    if (perEmail >= ResetService.MAX_PER_EMAIL) return true;

    if (ip) {
      const perIp = this.countSince('request_ip', ip, since);
      if (perIp >= ResetService.MAX_PER_IP) return true;
    }
    return false;
  }

  private countSince(
    column: 'email' | 'request_ip',
    value: string,
    sinceIso: string,
  ): number {
    const row = this.db
      .global()
      .prepare(
        `SELECT COUNT(*) AS n FROM password_resets
          WHERE ${column} = ? AND created_at >= ?`,
      )
      .get(value, sinceIso) as { n: number };
    return row.n;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireSecret(): string {
    const secret = this.config.jwtSecret;
    if (!secret) {
      this.logger.warn(
        'reset attempted but STREAMHUB_JWT_SECRET not configured',
      );
      throw new UnauthorizedException('Login is not configured');
    }
    return secret;
  }

  private appBaseUrl(): string {
    const v = this.config.env('STREAMHUB_APP_URL');
    return (v && v.trim()) || 'https://app.streamhub.studio';
  }

  private buildResetUrl(token: string): string {
    const base = this.appBaseUrl().replace(/\/+$/, '');
    return `${base}/auth/reset?token=${encodeURIComponent(token)}`;
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
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  private mask(email: string): string {
    const at = email.indexOf('@');
    if (at <= 0) return '***';
    return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
  }
}
