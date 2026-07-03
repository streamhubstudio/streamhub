import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Enforcer, newEnforcer, newModelFromString } from 'casbin';

import { DbService } from '../../shared/db/db.service';
import { AuthContext, PLATFORM_TENANT_ID } from '../../shared/auth-context';
import { Action, enforcementMode, Resource } from './authz.constants';
import { RBAC_MODEL, rbacPolicies } from './rbac-model';

/**
 * Casbin RBAC-with-domains enforcer + tenant-scope helper (wave-5).
 *
 * Owns the in-memory enforcer (model + static role policies). `can()` answers a
 * pure RBAC question (role × resource × action); `appBelongsToTenant()` answers
 * the data-scoping question (does this app live in the caller's tenant). The
 * PermissionGuard combines both. Superadmin/api_token bypass lives in the guard.
 */
@Injectable()
export class AuthzService implements OnModuleInit {
  private readonly logger = new Logger(AuthzService.name);
  private enforcer?: Enforcer;

  constructor(private readonly db: DbService) {}

  async onModuleInit(): Promise<void> {
    try {
      const model = newModelFromString(RBAC_MODEL);
      const e = await newEnforcer(model);
      e.enableAutoSave(false);
      await e.addPolicies(rbacPolicies());
      this.enforcer = e;
      this.logger.log(
        `casbin enforcer ready (${rbacPolicies().length} role policies)`,
      );
    } catch (err) {
      // A broken enforcer must not take the process down. In 'log'/'off' the
      // guard keeps back-compat (allow); in 'on' `can()` fails CLOSED (deny) so a
      // dead enforcer can never silently disable RBAC. See can().
      this.logger.error(
        `failed to init casbin enforcer: ${(err as Error).message}`,
      );
    }
  }

  /** True if the enforcer initialised. */
  get ready(): boolean {
    return !!this.enforcer;
  }

  /**
   * Pure RBAC check: may `role` perform `action` on `resource` in `tenant`?
   *
   * Fase-0 fail-closed: if the enforcer is unavailable (never initialised) or the
   * enforce call throws, the verdict depends on STREAMHUB_AUTHZ_ENFORCE:
   *   - 'on'        → deny (return false). Never fail OPEN when enforcing.
   *   - 'log'/'off' → allow (return true), preserving the phased back-compat.
   *
   * Superadmin / global api_token principals never reach here — the guard
   * short-circuits them before calling `can()`, so RBAC health can't lock them out.
   */
  async can(
    ctx: AuthContext,
    resource: Resource,
    action: Action,
  ): Promise<boolean> {
    const enforcing = enforcementMode() === 'on';
    if (!this.enforcer) {
      this.logger.error(
        `casbin enforcer unavailable — failing ${
          enforcing ? 'CLOSED (deny)' : 'open (allow, back-compat)'
        }`,
      );
      return !enforcing;
    }
    const dom = ctx.tenantId || PLATFORM_TENANT_ID;
    try {
      return await this.enforcer.enforce(ctx.role, dom, resource, action);
    } catch (err) {
      this.logger.warn(
        `casbin enforce error: ${(err as Error).message} — failing ${
          enforcing ? 'CLOSED (deny)' : 'open (allow, back-compat)'
        }`,
      );
      return !enforcing;
    }
  }

  /**
   * Resolve an app's numeric id by name; `null` if unknown or on any error.
   * Used by the PermissionGuard to bind an app-scoped token to a single app
   * (Fase-0 M2 tenant isolation).
   */
  appIdByName(appName: string): number | null {
    try {
      const row = this.db
        .global()
        .prepare('SELECT id FROM apps WHERE name = ?')
        .get(appName) as { id?: number } | undefined;
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Tenant data-scoping: does app `appName` belong to `ctx.tenantId`?
   *
   * Defensive about the tenancy schema (owned by another agent and rolled out in
   * phases): if the `apps.tenant_id` column does not exist yet, or the app is
   * unknown, this returns `true` (no scoping signal → don't block). When the
   * column exists it compares `apps.tenant_id` to the caller's tenant.
   */
  appBelongsToTenant(ctx: AuthContext, appName: string): boolean {
    if (ctx.isSuperadmin) return true;
    if (!ctx.tenantId) return true; // global/unscoped credential
    if (!this.appsHasTenantColumn()) return true; // pre-migration → no signal
    try {
      const row = this.db
        .global()
        .prepare('SELECT tenant_id FROM apps WHERE name = ?')
        .get(appName) as { tenant_id?: string | null } | undefined;
      if (!row) return true; // unknown app → let the handler 404 normally
      if (row.tenant_id == null) return true; // unassigned → don't block
      return String(row.tenant_id) === String(ctx.tenantId);
    } catch {
      return true;
    }
  }

  private hasTenantColumn?: boolean;
  private appsHasTenantColumn(): boolean {
    if (this.hasTenantColumn !== undefined) return this.hasTenantColumn;
    try {
      const cols = this.db
        .global()
        .prepare('PRAGMA table_info(apps)')
        .all() as Array<{ name: string }>;
      this.hasTenantColumn = cols.some((c) => c.name === 'tenant_id');
    } catch {
      this.hasTenantColumn = false;
    }
    return this.hasTenantColumn;
  }
}
