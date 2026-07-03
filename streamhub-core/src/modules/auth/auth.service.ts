import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { DbService } from '../../shared/db/db.service';
import { ConfigService } from '../../shared/config/config.service';
import {
  AuthContext,
  AuthValidatorContract,
  signJwt,
  verifyJwt,
} from '../../shared/auth';
import {
  AuthContext as TenantAuthContext,
  AuthRole,
  PLATFORM_TENANT_ID,
  setAuthCtx,
} from '../../shared/auth-context';
import { TenancyService } from '../tenancy/tenancy.service';
import { hashPassword, verifyPassword } from './password.util';
import { TotpService } from './totp.service';

export interface LoginResult {
  /** Signed HS256 JWT (sub=user, ~12h expiry). */
  token: string;
}

export interface SignupInput {
  email: string;
  password: string;
  teamName?: string;
}

export interface CreateTokenInput {
  name: string;
  scope: 'global' | 'app';
  appId?: number | null;
  allowedIps?: string[];
}

export interface CreatedToken {
  id: number;
  /** Plaintext token — returned ONCE on creation; only the hash is stored. */
  token: string;
}

export interface TokenSummary {
  id: number;
  name: string;
  scope: 'global' | 'app';
  appId: number | null;
  lastUsedAt: string | null;
  createdAt: string;
  revoked: boolean;
}

/** Raw row shape of api_tokens (snake_case from SQLite). */
interface TokenRow {
  id: number;
  name: string;
  token_hash: string;
  scope: 'global' | 'app';
  app_id: number | null;
  tenant_id: string | null;
  allowed_ips_json: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked: number;
}

/** Prefix for human-readable plaintext tokens. */
const TOKEN_PREFIX = 'sk_';

/**
 * Path prefixes (relative to the request path, which includes the global
 * `/api/v1` prefix) that bypass Bearer auth even if a controller forgot the
 * `@Public()` decorator. Covers health, the OpenAPI docs and public player/asset
 * routes (SPEC §6). Defensive: the canonical mechanism is still `@Public()`.
 */
const PUBLIC_PATH_PREFIXES = [
  '/api/v1/health',
  '/api/v1/docs',
  '/api/v1/openapi.json',
  '/api/v1/play',
  '/api/v1/embed',
  '/api/v1/assets',
  '/api/v1/samples',
];

/** Synthetic context for public (token-less) requests. */
const PUBLIC_CONTEXT: AuthContext = { tokenId: 0, scope: 'global', appId: null };

/**
 * API tokens (Bearer) + IP whitelist (SPEC §5 auth, §6). Implements the guard's
 * AuthValidatorContract: validates `Authorization: Bearer <token>` against the
 * `api_tokens` table (sha256 hash compare), honours `revoked`, and enforces the
 * optional per-token `allowed_ips` whitelist (exact IP or IPv4 CIDR).
 *
 * Tokens are stored hashed only; the plaintext is shown once at creation.
 */
@Injectable()
export class AuthService implements AuthValidatorContract {
  private readonly logger = new Logger(AuthService.name);

  /** JWT lifetime for UI login tokens (~12h, in seconds). */
  private static readonly JWT_TTL_SECONDS = 12 * 60 * 60;

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly tenancy: TenancyService,
    private readonly totp: TotpService,
  ) {}

  // ---------------------------------------------------------------------------
  // Built-in auth (POST /auth/signup, POST /auth/login)
  // ---------------------------------------------------------------------------

  /**
   * Whether PUBLIC self-signup is enabled (STREAMHUB_ALLOW_SIGNUP env flag,
   * default OFF → invite-only). Surfaced to the SPA via GET /auth/config so the
   * login screen only offers "Create account" when it will actually work.
   */
  get allowSignup(): boolean {
    const v = (this.config.env('STREAMHUB_ALLOW_SIGNUP') || '')
      .trim()
      .toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
  }

  /**
   * Open signup (POST /auth/signup). Creates a built-in user (scrypt-hashed
   * password), a new team (tenant) on the free plan and an `owner` membership,
   * then mints a login JWT (sub = user id). Teams are isolated — the tenant
   * scoping enforced by Casbin/quotas already keeps a user to their own team.
   *
   * Gated by STREAMHUB_ALLOW_SIGNUP: when OFF, only a previously-invited
   * PENDING user may "sign up" (that completes their invite by attaching a
   * password); a brand-new email is refused with 403.
   */
  async signup(input: SignupInput): Promise<LoginResult> {
    const secret = this.requireSecret();
    const email = input.email.trim().toLowerCase();
    const password = input.password;
    if (!email || !password) {
      throw new BadRequestException('email and password are required');
    }

    // Reject if the email is already taken (by a real, password-holding user or
    // the break-glass admin). A previously-invited *pending* user (no password)
    // is allowed to complete signup: we set their password instead.
    if (this.config.adminUser &&
        email === this.config.adminUser.trim().toLowerCase()) {
      throw new BadRequestException('email already in use');
    }
    const existing = this.tenancy.getUserByEmail(email);

    // Public-signup gate: with the flag OFF, only an invited pending user may
    // complete signup. Checked before any write so nothing is half-created.
    const completesInvite =
      !!existing && !existing.password_hash && existing.status === 'pending';
    if (!this.allowSignup && !completesInvite) {
      throw new ForbiddenException('signup_disabled');
    }
    let userId: string;
    if (existing) {
      if (existing.password_hash) {
        throw new BadRequestException('email already in use');
      }
      // pending invite completing signup → attach password to the existing user
      userId = existing.id;
      this.tenancy.setPassword(userId, hashPassword(password));
    } else {
      userId = this.tenancy.createUser({
        email,
        passwordHash: hashPassword(password),
        status: 'active',
      });
    }

    // A brand-new user always gets their own team unless they were an invited
    // pending user who already belongs to one.
    if (!this.tenancy.primaryMembership(userId)) {
      const teamName = (input.teamName || '').trim() || email;
      const tenantId = this.tenancy.createTeam(teamName);
      this.tenancy.addMembership(userId, tenantId, 'owner');
    }

    return { token: signJwt({ sub: userId }, secret, AuthService.JWT_TTL_SECONDS) };
  }

  /**
   * Log in with email/password. Priority:
   *   1. Break-glass superadmin: ADMIN_USER/ADMIN_PASS (constant-time compare) →
   *      JWT with sub = 'admin' (the mirrored superadmin user). Kept so the
   *      platform owner can NEVER be locked out.
   *   2. A built-in user (scrypt hash in the users table) → JWT with sub = id.
   *
   * On success mints a short-lived JWT signed with STREAMHUB_JWT_SECRET, accepted
   * by `validate` on subsequent requests.
   *
   * 2FA: a built-in user with TOTP enabled must ALSO supply a valid `code`
   * (401 `totp_required` / `totp_invalid` otherwise). The break-glass path is
   * deliberately exempt — ADMIN_USER/ADMIN_PASS can never be locked out.
   */
  async login(user: string, pass: string, code?: string): Promise<LoginResult> {
    const secret = this.requireSecret();
    const adminUser = this.config.adminUser;
    const adminPass = this.config.adminPass;

    // 1) Break-glass superadmin (constant-time compare; only when configured).
    if (adminUser && adminPass) {
      const userOk = this.safeEqual(user, adminUser);
      const passOk = this.safeEqual(pass, adminPass);
      if (userOk && passOk) {
        return {
          token: signJwt(
            { sub: TenancyService.ADMIN_USER_ID },
            secret,
            AuthService.JWT_TTL_SECONDS,
          ),
        };
      }
    }

    // 2) Built-in user by email.
    const email = (user || '').trim().toLowerCase();
    const row = email ? this.tenancy.getUserByEmail(email) : null;
    if (
      row &&
      row.password_hash &&
      row.status !== 'pending' &&
      verifyPassword(pass, row.password_hash)
    ) {
      // Second factor AFTER the password checks out (never leaks which failed).
      this.totp.assertLoginCode(row.id, code);
      return {
        token: signJwt({ sub: row.id }, secret, AuthService.JWT_TTL_SECONDS),
      };
    }

    throw new UnauthorizedException('Invalid username or password');
  }

  /** Resolve STREAMHUB_JWT_SECRET or refuse to mint/verify (login disabled). */
  private requireSecret(): string {
    const secret = this.config.jwtSecret;
    if (!secret) {
      this.logger.warn('auth attempted but STREAMHUB_JWT_SECRET not configured');
      throw new UnauthorizedException('Login is not configured');
    }
    return secret;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }

  // ---------------------------------------------------------------------------
  // Guard delegate
  // ---------------------------------------------------------------------------

  /**
   * Validate a request's credentials (SPEC §6 + Wave-5 §auth). On success it
   * ALSO leaves the resolved multi-tenant `AuthContext` on `req.authCtx`
   * (back-compat: the legacy `{tokenId,scope,appId}` still rides on `req.auth`,
   * set by the guard from this method's return value).
   *
   * Three credential kinds, in priority order:
   *   1. `sk_...` API tokens  → via:'api_token'. The GLOBAL token stays
   *      superadmin/global so the deployed automation never locks out.
   *   2. HS256 login JWT for a built-in user → via:'user_jwt', mapped to their
   *      team (tenant) + role.
   *   3. HS256 login JWT for the break-glass admin → via:'admin_jwt', superadmin.
   */
  async validate(req: Request): Promise<AuthContext> {
    // Defensive public-path bypass (health/docs/player assets).
    if (this.isPublicPath(req)) return PUBLIC_CONTEXT;

    const token = this.extractBearer(req);
    if (!token) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    // Non-`sk_` → an HS256 login JWT. `sk_` → API token table.
    if (!token.startsWith(TOKEN_PREFIX)) {
      return this.validateJwt(req, token);
    }

    const hash = this.hashToken(token);
    const row = this.findActiveByHash(hash);
    if (!row) {
      throw new UnauthorizedException('Invalid or revoked API token');
    }

    if (!this.ipAllowed(row, req)) {
      this.logger.warn(
        `token ${row.id} (${row.name}) rejected: client IP not in whitelist`,
      );
      throw new UnauthorizedException('Client IP not allowed for this token');
    }

    this.touchLastUsed(row.id);

    // BACK-COMPAT: the global `sk_` token must remain superadmin/global so the
    // deployed automation keeps working. App-scoped tokens are a non-superadmin
    // service principal bound to their app's tenant.
    const isGlobal = row.scope === 'global';
    setAuthCtx(req, {
      userId: `token:${row.id}`,
      tenantId: row.tenant_id ?? PLATFORM_TENANT_ID,
      role: 'service',
      isSuperadmin: isGlobal,
      scope: isGlobal ? 'global' : 'app',
      via: 'api_token',
    });

    return {
      tokenId: row.id,
      scope: row.scope,
      appId: row.app_id ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Token management (/tokens)
  // ---------------------------------------------------------------------------

  async listTokens(): Promise<TokenSummary[]> {
    const rows = this.db
      .global()
      .prepare(
        `SELECT id, name, token_hash, scope, app_id, tenant_id, allowed_ips_json,
                last_used_at, created_at, revoked
           FROM api_tokens
          ORDER BY id DESC`,
      )
      .all() as TokenRow[];
    return rows.map((r) => this.toSummary(r));
  }

  async createToken(input: CreateTokenInput): Promise<CreatedToken> {
    const scope = input.scope;
    let appId: number | null = null;

    // Fase-0 M2: an app-scoped token is pinned to its app's tenant; a global
    // token belongs to the platform tenant. Previously the INSERT omitted
    // tenant_id and every token inherited the column default ('platform'),
    // leaving app-scoped tokens unscoped — the "createToken() no setea tenant_id"
    // finding. We now set it explicitly.
    let tenantId: string = PLATFORM_TENANT_ID;

    if (scope === 'app') {
      if (input.appId == null) {
        throw new BadRequestException('appId is required when scope=app');
      }
      const exists = this.db
        .global()
        .prepare('SELECT id FROM apps WHERE id = ?')
        .get(input.appId) as { id: number } | undefined;
      if (!exists) {
        throw new BadRequestException(`app ${input.appId} does not exist`);
      }
      appId = input.appId;
      // The app's tenant (falls back to platform when the app is unassigned,
      // mirroring the migration-6 backfill so the value is never NULL).
      tenantId = this.tenancy.tenantForAppId(appId) ?? PLATFORM_TENANT_ID;
    } else if (input.appId != null) {
      throw new BadRequestException('appId is only valid when scope=app');
    }

    const allowedIps = this.normalizeIps(input.allowedIps);

    const plaintext = this.generateToken();
    const hash = this.hashToken(plaintext);

    const result = this.db
      .global()
      .prepare(
        `INSERT INTO api_tokens (name, token_hash, scope, app_id, tenant_id, allowed_ips_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        hash,
        scope,
        appId,
        tenantId,
        allowedIps ? JSON.stringify(allowedIps) : null,
      );

    return { id: Number(result.lastInsertRowid), token: plaintext };
  }

  async revokeToken(id: number): Promise<void> {
    const result = this.db
      .global()
      .prepare('UPDATE api_tokens SET revoked = 1 WHERE id = ?')
      .run(id);
    if (result.changes === 0) {
      throw new BadRequestException(`token ${id} not found`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private isPublicPath(req: Request): boolean {
    const p = (req.path || req.url || '').split('?')[0];
    return PUBLIC_PATH_PREFIXES.some(
      (prefix) => p === prefix || p.startsWith(prefix + '/'),
    );
  }

  /**
   * Validate a non-`sk_` Bearer JWT (an HS256 login token minted by
   * signup/login). Verifies the signature+expiry, then resolves `sub` to a
   * principal:
   *
   *   - the break-glass admin (sub = 'admin', or a legacy token whose sub is the
   *     configured ADMIN_USER) OR any user flagged is_superadmin → superadmin
   *     context on the platform tenant (via:'admin_jwt'). Never lockable.
   *   - a built-in user → their team (primary membership) + role (via:'user_jwt').
   *
   * Populates `req.authCtx` and returns the legacy context. Throws
   * UnauthorizedException on any failure.
   */
  private async validateJwt(req: Request, token: string): Promise<AuthContext> {
    const secret = this.requireSecret();
    let payload: { sub?: string };
    try {
      payload = verifyJwt(token, secret);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) throw new UnauthorizedException('Invalid or expired token');

    const user = this.tenancy.getUser(sub);

    // Superadmin / break-glass admin → platform superadmin context. Covers:
    //  - sub = 'admin' (current admin login),
    //  - any user row flagged is_superadmin,
    //  - legacy admin tokens whose sub is the configured ADMIN_USER value.
    const isLegacyAdmin =
      !!this.config.adminUser && sub === this.config.adminUser;
    if (
      sub === TenancyService.ADMIN_USER_ID ||
      isLegacyAdmin ||
      (user && user.is_superadmin)
    ) {
      setAuthCtx(req, {
        userId: TenancyService.ADMIN_USER_ID,
        tenantId: PLATFORM_TENANT_ID,
        role: 'superadmin',
        isSuperadmin: true,
        scope: 'global',
        via: 'admin_jwt',
        email: user?.email ?? this.config.adminUser ?? undefined,
      });
      return { tokenId: 0, scope: 'global', appId: null };
    }

    // Regular built-in user. Unknown sub (deleted user) → reject.
    if (!user) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const membership = this.tenancy.primaryMembership(user.id);
    const role: AuthRole = membership?.role ?? 'viewer';
    const ctx: TenantAuthContext = {
      userId: user.id,
      tenantId: membership?.tenantId ?? null,
      role,
      isSuperadmin: false,
      scope: 'user',
      via: 'user_jwt',
      email: user.email ?? undefined,
    };
    setAuthCtx(req, ctx);
    return { tokenId: 0, scope: 'app', appId: null };
  }

  private extractBearer(req: Request): string | null {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return null;
    const value = match[1].trim();
    return value.length > 0 ? value : null;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private generateToken(): string {
    return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  }

  private findActiveByHash(hash: string): TokenRow | undefined {
    return this.db
      .global()
      .prepare(
        `SELECT id, name, token_hash, scope, app_id, tenant_id, allowed_ips_json,
                last_used_at, created_at, revoked
           FROM api_tokens
          WHERE token_hash = ? AND revoked = 0
          LIMIT 1`,
      )
      .get(hash) as TokenRow | undefined;
  }

  private touchLastUsed(id: number): void {
    try {
      this.db
        .global()
        .prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?")
        .run(id);
    } catch (err) {
      // last_used_at is best-effort; never fail the request on it.
      this.logger.debug(`failed to update last_used_at for token ${id}: ${err}`);
    }
  }

  private toSummary(r: TokenRow): TokenSummary {
    return {
      id: r.id,
      name: r.name,
      scope: r.scope,
      appId: r.app_id ?? null,
      lastUsedAt: r.last_used_at ?? null,
      createdAt: r.created_at,
      revoked: !!r.revoked,
    };
  }

  // ---------------------------------------------------------------------------
  // IP whitelist
  // ---------------------------------------------------------------------------

  private normalizeIps(ips?: string[]): string[] | null {
    if (!ips || ips.length === 0) return null;
    const cleaned = ips.map((s) => s.trim()).filter((s) => s.length > 0);
    return cleaned.length > 0 ? cleaned : null;
  }

  /** True if the token has no whitelist OR the client IP matches an entry. */
  private ipAllowed(row: TokenRow, req: Request): boolean {
    let whitelist: string[];
    try {
      whitelist = row.allowed_ips_json
        ? (JSON.parse(row.allowed_ips_json) as string[])
        : [];
    } catch {
      // Corrupt JSON → treat as no restriction rather than locking out.
      whitelist = [];
    }
    if (!Array.isArray(whitelist) || whitelist.length === 0) return true;

    const clientIp = this.normalizeIp(this.clientIp(req));
    if (!clientIp) return false;

    return whitelist.some((entry) => this.ipMatches(clientIp, entry.trim()));
  }

  /** Resolve the real client IP, honouring nginx's X-Forwarded-For. */
  private clientIp(req: Request): string {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      return fwd.split(',')[0].trim();
    }
    if (Array.isArray(fwd) && fwd.length > 0) {
      return fwd[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || '';
  }

  /** Strip the IPv4-mapped IPv6 prefix so "::ffff:1.2.3.4" → "1.2.3.4". */
  private normalizeIp(ip: string): string {
    if (!ip) return '';
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }

  /** Exact-match, or IPv4 CIDR match when `entry` is in a.b.c.d/n form. */
  private ipMatches(clientIp: string, entry: string): boolean {
    if (!entry) return false;
    if (entry === clientIp) return true;
    if (entry.includes('/')) {
      return this.cidrMatch(clientIp, entry);
    }
    return false;
  }

  private cidrMatch(ip: string, cidr: string): boolean {
    const [range, bitsStr] = cidr.split('/');
    const bits = Number.parseInt(bitsStr, 10);
    if (Number.isNaN(bits) || bits < 0 || bits > 32) return false;
    const ipNum = this.ipv4ToInt(ip);
    const rangeNum = this.ipv4ToInt(range);
    if (ipNum === null || rangeNum === null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  }

  private ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let num = 0;
    for (const part of parts) {
      const octet = Number(part);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
      num = (num << 8) | octet;
    }
    return num >>> 0;
  }
}
