import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../shared/db/db.service';
import { ConfigService } from '../../shared/config/config.service';
import { PLATFORM_TENANT_ID } from '../../shared/auth-context';
import {
  FREE_PLAN_QUOTA,
  MembershipRole,
  QuotaRow,
  TeamMember,
  TenantRow,
  UserRow,
} from './tenancy.types';

/** Input for creating a built-in user (password already hashed by the caller). */
export interface CreateUserInput {
  email: string;
  /** scrypt hash string; null for a pending/invited user. */
  passwordHash?: string | null;
  isSuperadmin?: boolean;
  status?: 'active' | 'pending';
}

/**
 * Tenancy control-plane (Wave-5 §auth). Owns the SQLite control-plane: tenants,
 * the mirrored users table, memberships (role per tenant) and quotas.
 *
 * On boot it finishes the idempotent migration the SQL can't express:
 *  - ensures the built-in `platform` tenant + its (effectively unlimited) quota,
 *  - mirrors the break-glass admin (ADMIN_USER) as a superadmin user + owner of
 *    the platform tenant.
 *
 * The DDL, the `tenant_id` column adds and the platform tenant row itself are
 * created by DbService when the global DB opens (see migrations.ts); this
 * service is the runtime, env-aware finisher and the lookup surface used by the
 * auth guard to resolve a principal's tenant/role.
 */
@Injectable()
export class TenancyService implements OnModuleInit {
  private readonly logger = new Logger(TenancyService.name);

  /** Stable synthetic id for the break-glass admin principal. */
  static readonly ADMIN_USER_ID = 'admin';

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    try {
      this.ensureUserAuthColumns();
      this.ensurePlatformTenant();
      this.ensureAdminSuperadmin();
    } catch (err) {
      // Never crash boot on tenancy seeding — back-compat is paramount.
      this.logger.error(
        `tenancy bootstrap failed (continuing): ${(err as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap / migration finisher
  // ---------------------------------------------------------------------------

  /** Ensure the built-in `platform` tenant + an (effectively unlimited) quota. */
  private ensurePlatformTenant(): void {
    const db = this.db.global();
    db.prepare(
      `INSERT OR IGNORE INTO tenants (id, name, plan) VALUES (?, 'Platform', 'platform')`,
    ).run(PLATFORM_TENANT_ID);
    db.prepare(
      `INSERT OR IGNORE INTO quotas
         (tenant_id, max_apps, max_concurrent_streams,
          max_recording_minutes_month, max_egress_gb_month, max_storage_gb)
       VALUES (?, 100000, 100000, 100000000, 100000, 100000)`,
    ).run(PLATFORM_TENANT_ID);
  }

  /**
   * Mirror the break-glass admin (ADMIN_USER) as a superadmin user and owner of
   * the platform tenant. Idempotent. The id is a stable synthetic value so the
   * admin_jwt (sub = ADMIN_USER) and this row line up via email.
   */
  private ensureAdminSuperadmin(): void {
    const adminUser = this.config.adminUser;
    if (!adminUser) return; // login disabled → nothing to mirror
    const db = this.db.global();
    db.prepare(
      `INSERT INTO users (id, email, is_superadmin) VALUES (?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET is_superadmin = 1, email = excluded.email`,
    ).run(TenancyService.ADMIN_USER_ID, adminUser);
    db.prepare(
      `INSERT OR IGNORE INTO memberships (user_id, tenant_id, role)
       VALUES (?, ?, 'owner')`,
    ).run(TenancyService.ADMIN_USER_ID, PLATFORM_TENANT_ID);
  }

  // ---------------------------------------------------------------------------
  // Lookups (used by the auth guard + future per-route checks)
  // ---------------------------------------------------------------------------

  /** Tenant that owns an app (by app name/slug). Null if unknown. */
  tenantForApp(appName: string): string | null {
    const row = this.db
      .global()
      .prepare(`SELECT tenant_id FROM apps WHERE name = ?`)
      .get(appName) as { tenant_id: string | null } | undefined;
    return row?.tenant_id ?? null;
  }

  /** Tenant that owns an app (by app id). Null if unknown. */
  tenantForAppId(appId: number): string | null {
    const row = this.db
      .global()
      .prepare(`SELECT tenant_id FROM apps WHERE id = ?`)
      .get(appId) as { tenant_id: string | null } | undefined;
    return row?.tenant_id ?? null;
  }

  /** A user's role within a tenant, or null if not a member. */
  roleInTenant(userId: string, tenantId: string): MembershipRole | null {
    const row = this.db
      .global()
      .prepare(
        `SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?`,
      )
      .get(userId, tenantId) as { role: MembershipRole } | undefined;
    return row?.role ?? null;
  }

  /** True when the user is flagged superadmin in the users table. */
  isSuperadmin(userId: string): boolean {
    const row = this.db
      .global()
      .prepare(`SELECT is_superadmin FROM users WHERE id = ?`)
      .get(userId) as { is_superadmin: number } | undefined;
    return !!row?.is_superadmin;
  }

  getTenant(tenantId: string): TenantRow | null {
    const row = this.db
      .global()
      .prepare(`SELECT * FROM tenants WHERE id = ?`)
      .get(tenantId) as TenantRow | undefined;
    return row ?? null;
  }

  getQuota(tenantId: string): QuotaRow | null {
    const row = this.db
      .global()
      .prepare(`SELECT * FROM quotas WHERE tenant_id = ?`)
      .get(tenantId) as QuotaRow | undefined;
    return row ?? null;
  }

  // ---------------------------------------------------------------------------
  // Provisioning (used as signup/tenant lands; safe to call from auth)
  // ---------------------------------------------------------------------------

  /**
   * Ensure a tenant exists (used by signup/createTeam) with a `free`-plan
   * quota. Idempotent. Returns the tenant id.
   */
  ensureTenant(tenantId: string, name?: string, plan = 'free'): string {
    const db = this.db.global();
    db.prepare(
      `INSERT OR IGNORE INTO tenants (id, name, plan) VALUES (?, ?, ?)`,
    ).run(tenantId, name || tenantId, plan);
    const q = FREE_PLAN_QUOTA;
    db.prepare(
      `INSERT OR IGNORE INTO quotas
         (tenant_id, max_apps, max_concurrent_streams,
          max_recording_minutes_month, max_egress_gb_month, max_storage_gb)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      tenantId,
      q.max_apps,
      q.max_concurrent_streams,
      q.max_recording_minutes_month,
      q.max_egress_gb_month,
      q.max_storage_gb,
    );
    return tenantId;
  }

  /** Mirror a user by id (idempotent, no password change). */
  ensureUser(userId: string, email?: string): void {
    this.db
      .global()
      .prepare(
        `INSERT INTO users (id, email) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET email = COALESCE(excluded.email, users.email)`,
      )
      .run(userId, email ?? null);
  }

  // ---------------------------------------------------------------------------
  // Built-in user/password (Wave-6: OIDC dropped, StreamHub is identity-of-record)
  // ---------------------------------------------------------------------------

  /**
   * Add the password/profile/2FA columns the built-in auth needs to the `users`
   * table. The base DDL (users/tenants/memberships/quotas) lives in shared
   * migrations; SQLite has no `ADD COLUMN IF NOT EXISTS`, so we guard on PRAGMA
   * table_info exactly like DbService.applyColumnAdds. Idempotent; every boot.
   */
  private ensureUserAuthColumns(): void {
    const db = this.db.global();
    const cols = (db.prepare('PRAGMA table_info(users)').all() as {
      name: string;
    }[]).map((c) => c.name);
    const add = (name: string, ddl: string): void => {
      if (!cols.includes(name)) {
        db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
        this.logger.log(`migrated users: added ${name}`);
      }
    };
    add('password_hash', 'password_hash TEXT');
    add('status', "status TEXT NOT NULL DEFAULT 'active'");
    // Cuenta y auth: profile display name + TOTP 2FA (secret encrypted at rest).
    add('name', 'name TEXT');
    add('totp_secret', 'totp_secret TEXT');
    add('totp_pending_secret', 'totp_pending_secret TEXT');
    add('totp_enabled', 'totp_enabled INTEGER NOT NULL DEFAULT 0');
  }

  getUser(userId: string): UserRow | null {
    const row = this.db
      .global()
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(userId) as UserRow | undefined;
    return row ?? null;
  }

  /** Case-insensitive email lookup (built-in login). Null if unknown. */
  getUserByEmail(email: string): UserRow | null {
    const row = this.db
      .global()
      .prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE LIMIT 1`)
      .get(email) as UserRow | undefined;
    return row ?? null;
  }

  /**
   * Create a built-in user. Generates a stable `usr_<uuid>` id. Throws nothing
   * on its own — the caller checks email uniqueness first. Returns the new id.
   */
  createUser(input: CreateUserInput): string {
    const id = `usr_${randomUUID()}`;
    this.db
      .global()
      .prepare(
        `INSERT INTO users (id, email, is_superadmin, password_hash, status)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.email,
        input.isSuperadmin ? 1 : 0,
        input.passwordHash ?? null,
        input.status ?? 'active',
      );
    return id;
  }

  /** Set/replace a user's password hash and mark them active. */
  setPassword(userId: string, passwordHash: string): void {
    this.db
      .global()
      .prepare(
        `UPDATE users SET password_hash = ?, status = 'active' WHERE id = ?`,
      )
      .run(passwordHash, userId);
  }

  /**
   * Update a user's profile (display name and/or email). Fields set to
   * `undefined` are left untouched; email is stored as passed (the caller
   * normalises + checks uniqueness). No-op when nothing changes.
   */
  updateProfile(
    userId: string,
    patch: { name?: string | null; email?: string },
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      args.push(patch.name);
    }
    if (patch.email !== undefined) {
      sets.push('email = ?');
      args.push(patch.email);
    }
    if (sets.length === 0) return;
    args.push(userId);
    this.db
      .global()
      .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args);
  }

  // ---------------------------------------------------------------------------
  // TOTP 2FA columns (secret stored ENCRYPTED by auth/TotpService)
  // ---------------------------------------------------------------------------

  /** Raw TOTP state of a user (secrets are encrypted strings, not plaintext). */
  getTotpState(userId: string): {
    enabled: boolean;
    secret: string | null;
    pendingSecret: string | null;
  } {
    const row = this.db
      .global()
      .prepare(
        `SELECT totp_enabled, totp_secret, totp_pending_secret
           FROM users WHERE id = ?`,
      )
      .get(userId) as
      | {
          totp_enabled: number;
          totp_secret: string | null;
          totp_pending_secret: string | null;
        }
      | undefined;
    return {
      enabled: !!row?.totp_enabled,
      secret: row?.totp_secret ?? null,
      pendingSecret: row?.totp_pending_secret ?? null,
    };
  }

  /** Store an (encrypted) enrolment-pending TOTP secret. */
  setTotpPending(userId: string, encryptedSecret: string): void {
    this.db
      .global()
      .prepare(`UPDATE users SET totp_pending_secret = ? WHERE id = ?`)
      .run(encryptedSecret, userId);
  }

  /** Activate 2FA: promote the pending secret to active and flip the flag. */
  activateTotp(userId: string): void {
    this.db
      .global()
      .prepare(
        `UPDATE users
            SET totp_secret = totp_pending_secret,
                totp_pending_secret = NULL,
                totp_enabled = 1
          WHERE id = ? AND totp_pending_secret IS NOT NULL`,
      )
      .run(userId);
  }

  /** Disable 2FA and wipe both secrets. */
  clearTotp(userId: string): void {
    this.db
      .global()
      .prepare(
        `UPDATE users
            SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0
          WHERE id = ?`,
      )
      .run(userId);
  }

  /**
   * Create a new team (tenant) with a generated `tnt_<uuid>` id and a free-plan
   * quota (reuses ensureTenant, which seeds the quotas row). Returns the id.
   */
  createTeam(name: string, plan = 'free'): string {
    const id = `tnt_${randomUUID()}`;
    this.ensureTenant(id, name, plan);
    return id;
  }

  /** Add (or upgrade) a membership. Idempotent on (user, tenant). */
  addMembership(
    userId: string,
    tenantId: string,
    role: MembershipRole,
  ): void {
    this.db
      .global()
      .prepare(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?)
         ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role`,
      )
      .run(userId, tenantId, role);
  }

  /**
   * The user's primary team: their `owner` membership if any, else the earliest
   * membership. Used to resolve a login JWT to a tenant + role.
   */
  primaryMembership(
    userId: string,
  ): { tenantId: string; role: MembershipRole } | null {
    const row = this.db
      .global()
      .prepare(
        `SELECT tenant_id, role FROM memberships
          WHERE user_id = ?
          ORDER BY (role = 'owner') DESC, created_at ASC
          LIMIT 1`,
      )
      .get(userId) as { tenant_id: string; role: MembershipRole } | undefined;
    return row ? { tenantId: row.tenant_id, role: row.role } : null;
  }

  /** Remove a membership. Returns true when a row was deleted. */
  removeMembership(userId: string, tenantId: string): boolean {
    const res = this.db
      .global()
      .prepare(`DELETE FROM memberships WHERE user_id = ? AND tenant_id = ?`)
      .run(userId, tenantId);
    return res.changes > 0;
  }

  /** How many teams the user belongs to. */
  membershipCount(userId: string): number {
    const row = this.db
      .global()
      .prepare(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?`)
      .get(userId) as { n: number };
    return row.n;
  }

  /** Hard-delete a user row (used when revoking a never-accepted invite). */
  deleteUser(userId: string): void {
    this.db.global().prepare(`DELETE FROM users WHERE id = ?`).run(userId);
  }

  /** All members of a team (flattened membership + user), oldest first. */
  listMembers(tenantId: string): TeamMember[] {
    const rows = this.db
      .global()
      .prepare(
        `SELECT u.id AS userId, u.email AS email, u.name AS name, m.role AS role,
                u.status AS status, u.is_superadmin AS isSuperadmin,
                m.created_at AS createdAt
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = ?
          ORDER BY m.created_at ASC`,
      )
      .all(tenantId) as Array<{
      userId: string;
      email: string | null;
      name: string | null;
      role: MembershipRole;
      status: string;
      isSuperadmin: number;
      createdAt: string;
    }>;
    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.role,
      status: r.status ?? 'active',
      isSuperadmin: !!r.isSuperadmin,
      createdAt: r.createdAt,
    }));
  }
}
