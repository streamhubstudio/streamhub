import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { DbService } from '../../shared/db/db.service';
import { AuthContext } from '../../shared/auth-context';
import { enforcementMode } from '../authz/authz.constants';
import { PLAN_QUOTAS } from '../tenancy/tenancy.types';

/** Per-tenant quota limits. `-1` / `null` = unlimited. */
export interface TenantQuotas {
  maxApps: number;
  maxConcurrentStreams: number;
  maxRecordingMinutesMonth: number;
  maxEgressGbMonth: number;
  maxStorageGb: number;
}

/** Current consumption snapshot for a tenant. */
export interface TenantUsage {
  apps: number;
  concurrentStreams: number;
  recordingMinutesMonth: number;
  egressGbMonth: number;
  storageGb: number;
}

export interface UsageReport {
  tenantId: string;
  plan: string;
  quotas: TenantQuotas;
  usage: TenantUsage;
  /** Per-metric over-limit flags (informational; mirrors enforcement). */
  exceeded: Partial<Record<keyof TenantUsage, boolean>>;
}

/**
 * A tenant + its effective quota, shaped for the Superadmin Tenants screen
 * (matches the SPA `Tenant` type). `appCount` is a cheap convenience rollup.
 */
export interface TenantSummary {
  id: string;
  name: string;
  plan: string;
  createdAt: string;
  quotas: TenantQuotas;
  appCount: number;
}

/** Patch accepted by `setQuotas` (superadmin). Any subset; `-1` = unlimited. */
export interface UpdateQuotasInput {
  plan?: string;
  maxApps?: number;
  maxConcurrentStreams?: number;
  maxRecordingMinutesMonth?: number;
  maxEgressGbMonth?: number;
  maxStorageGb?: number;
}

/** Conservative free-plan defaults (wave-5 §quotas). */
const DEFAULT_QUOTAS: TenantQuotas = {
  maxApps: 2,
  maxConcurrentStreams: 2,
  maxRecordingMinutesMonth: 300,
  maxEgressGbMonth: 5,
  maxStorageGb: 5,
};

/** Row shape of the dedicated `quotas` table (tenancy control-plane). */
interface QuotaTableRow {
  tenant_id: string;
  max_apps: number;
  max_concurrent_streams: number;
  max_recording_minutes_month: number;
  max_egress_gb_month: number;
  max_storage_gb: number;
}

type QuotaMetric =
  | 'maxApps'
  | 'maxConcurrentStreams'
  | 'maxRecordingMinutesMonth'
  | 'maxEgressGbMonth';

/**
 * Tenant quota accounting + enforcement (wave-5).
 *
 * Phased exactly like authz: gated by `STREAMHUB_AUTHZ_ENFORCE` ('log' default =
 * only logs; 'on' = rejects with 429). Superadmin / api_token / unscoped
 * (no tenantId) callers are NEVER quota-limited.
 *
 * Defensive about the tenancy schema (owned by another agent, rolled out in
 * phases): every table/column it depends on is probed first; when absent the
 * service degrades to "unlimited / zero usage" rather than throwing.
 */
@Injectable()
export class QuotasService {
  private readonly logger = new Logger(QuotasService.name);

  constructor(private readonly db: DbService) {}

  // ---------------------------------------------------------------------------
  // Enforcement entry points (called from controllers)
  // ---------------------------------------------------------------------------

  /** Before creating an app: tenant must be under `maxApps`. */
  async enforceCreateApp(ctx?: AuthContext): Promise<void> {
    await this.enforce(ctx, 'maxApps', () =>
      Promise.resolve(this.countApps(ctx!.tenantId!)),
    );
  }

  /** Before opening a new live stream / ingress: under `maxConcurrentStreams`. */
  async enforceConcurrentStreams(ctx?: AuthContext): Promise<void> {
    await this.enforce(ctx, 'maxConcurrentStreams', () =>
      Promise.resolve(this.countConcurrentStreams(ctx!.tenantId!)),
    );
  }

  /** Before starting a recording: under the monthly recording-minutes budget. */
  async enforceRecordingMinutes(ctx?: AuthContext): Promise<void> {
    await this.enforce(ctx, 'maxRecordingMinutesMonth', () =>
      Promise.resolve(this.monthlyUsage(ctx!.tenantId!).recordingMinutesMonth),
    );
  }

  /** Before starting an egress/broadcast: under the monthly egress budget. */
  async enforceEgress(ctx?: AuthContext): Promise<void> {
    await this.enforce(ctx, 'maxEgressGbMonth', () =>
      Promise.resolve(this.monthlyUsage(ctx!.tenantId!).egressGbMonth),
    );
  }

  // ---------------------------------------------------------------------------
  // Per-APP and per-STREAM quotas (owner: "cuotas por app y por streams, por
  // defecto ilimitadas"). Complements the per-tenant quotas above. `limit < 0`
  // (or 0) means UNLIMITED, so an unconfigured app is never blocked. Same
  // enforcement-mode + bypass invariants as the tenant path.
  // ---------------------------------------------------------------------------

  /**
   * Before opening a new live stream for `app`: under the app's
   * `quotas.maxConcurrentStreams`. `limit <= 0` ⇒ unlimited ⇒ no-op.
   */
  async enforceAppConcurrentStreams(
    app: string,
    limit: number,
    ctx?: AuthContext,
  ): Promise<void> {
    await this.enforceScoped(ctx, 'app', 'maxConcurrentStreams', limit, () =>
      Promise.resolve(this.countAppConcurrentStreams(app)),
    );
  }

  /**
   * Per-stream cap (e.g. max viewers on one stream). The caller supplies the
   * current count. `limit <= 0` ⇒ unlimited ⇒ no-op.
   */
  async enforceStreamViewers(
    limit: number,
    current: number,
    ctx?: AuthContext,
  ): Promise<void> {
    await this.enforceScoped(ctx, 'stream', 'maxViewersPerStream', limit, () =>
      Promise.resolve(current),
    );
  }

  /** Active live streams for a single app (from its per-app `streams` table). */
  countAppConcurrentStreams(app: string): number {
    try {
      const row = this.db
        .appDb(app)
        .prepare("SELECT COUNT(*) AS n FROM streams WHERE status = 'active'")
        .get() as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      // App db missing/locked → treat as 0 (never block on a counting failure).
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Reporting (GET /tenants/:id/usage)
  // ---------------------------------------------------------------------------

  getUsage(tenantId: string): UsageReport {
    const quotas = this.quotasFor(tenantId);
    const monthly = this.monthlyUsage(tenantId);
    const usage: TenantUsage = {
      apps: this.countApps(tenantId),
      concurrentStreams: this.countConcurrentStreams(tenantId),
      recordingMinutesMonth: monthly.recordingMinutesMonth,
      egressGbMonth: monthly.egressGbMonth,
      storageGb: monthly.storageGb,
    };
    const exceeded: UsageReport['exceeded'] = {
      apps: this.over(usage.apps, quotas.maxApps),
      concurrentStreams: this.over(
        usage.concurrentStreams,
        quotas.maxConcurrentStreams,
      ),
      recordingMinutesMonth: this.over(
        usage.recordingMinutesMonth,
        quotas.maxRecordingMinutesMonth,
      ),
      egressGbMonth: this.over(usage.egressGbMonth, quotas.maxEgressGbMonth),
      storageGb: this.over(usage.storageGb, quotas.maxStorageGb),
    };
    return {
      tenantId,
      plan: this.planFor(tenantId),
      quotas,
      usage,
      exceeded,
    };
  }

  // ---------------------------------------------------------------------------
  // Tenant administration (GET /tenants, PATCH /tenants/:id/quotas — superadmin)
  // ---------------------------------------------------------------------------

  /**
   * Every tenant + its effective quota, oldest first. Superadmin surface (the
   * caller gates). Degrades to `[]` when the tenancy schema is absent — same
   * defensive posture as the rest of this service.
   */
  listTenants(): TenantSummary[] {
    if (!this.tableExists('tenants')) return [];
    let rows: Array<{
      id: string;
      name: string;
      plan: string | null;
      created_at: string;
    }>;
    try {
      rows = this.db
        .global()
        .prepare(
          'SELECT id, name, plan, created_at FROM tenants ORDER BY created_at ASC, id ASC',
        )
        .all() as typeof rows;
    } catch {
      return [];
    }
    return rows.map((r) => this.summaryFromRow(r));
  }

  /** One tenant summary, or null when the id is unknown. */
  getTenantSummary(tenantId: string): TenantSummary | null {
    if (!this.tableExists('tenants')) return null;
    const row = this.db
      .global()
      .prepare('SELECT id, name, plan, created_at FROM tenants WHERE id = ?')
      .get(tenantId) as
      | { id: string; name: string; plan: string | null; created_at: string }
      | undefined;
    return row ? this.summaryFromRow(row) : null;
  }

  /**
   * Raise/lower a tenant's plan label and/or per-metric limits (superadmin).
   * Merges the patch onto the tenant's current effective quota and upserts the
   * dedicated `quotas` row, so a partial body only changes the fields it names.
   * Throws `NotFoundException` when the tenant does not exist.
   */
  setQuotas(tenantId: string, patch: UpdateQuotasInput): TenantSummary {
    const existing = this.getTenantSummary(tenantId);
    if (!existing) {
      throw new NotFoundException(`tenant '${tenantId}' not found`);
    }

    if (patch.plan !== undefined) {
      this.db
        .global()
        .prepare('UPDATE tenants SET plan = ? WHERE id = ?')
        .run(patch.plan, tenantId);
    }

    if (this.tableExists('quotas')) {
      // When the patch names a KNOWN plan preset (e.g. "broadcaster"/"linear")
      // use its limits as the baseline, so assigning the plan actually applies
      // its quotas (QW-3). An explicit per-metric override in the same patch
      // still wins; an unknown plan label keeps the tenant's current limits.
      const preset =
        patch.plan !== undefined ? PLAN_QUOTAS[patch.plan] : undefined;
      const baseline: TenantQuotas = preset
        ? {
            maxApps: preset.max_apps,
            maxConcurrentStreams: preset.max_concurrent_streams,
            maxRecordingMinutesMonth: preset.max_recording_minutes_month,
            maxEgressGbMonth: preset.max_egress_gb_month,
            maxStorageGb: preset.max_storage_gb,
          }
        : existing.quotas;
      const merged: TenantQuotas = {
        maxApps: patch.maxApps ?? baseline.maxApps,
        maxConcurrentStreams:
          patch.maxConcurrentStreams ?? baseline.maxConcurrentStreams,
        maxRecordingMinutesMonth:
          patch.maxRecordingMinutesMonth ?? baseline.maxRecordingMinutesMonth,
        maxEgressGbMonth: patch.maxEgressGbMonth ?? baseline.maxEgressGbMonth,
        maxStorageGb: patch.maxStorageGb ?? baseline.maxStorageGb,
      };
      this.db
        .global()
        .prepare(
          `INSERT INTO quotas
             (tenant_id, max_apps, max_concurrent_streams,
              max_recording_minutes_month, max_egress_gb_month, max_storage_gb)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id) DO UPDATE SET
             max_apps = excluded.max_apps,
             max_concurrent_streams = excluded.max_concurrent_streams,
             max_recording_minutes_month = excluded.max_recording_minutes_month,
             max_egress_gb_month = excluded.max_egress_gb_month,
             max_storage_gb = excluded.max_storage_gb`,
        )
        .run(
          tenantId,
          merged.maxApps,
          merged.maxConcurrentStreams,
          merged.maxRecordingMinutesMonth,
          merged.maxEgressGbMonth,
          merged.maxStorageGb,
        );
    }

    // Re-read so the response reflects exactly what was persisted.
    return this.getTenantSummary(tenantId)!;
  }

  private summaryFromRow(row: {
    id: string;
    name: string;
    plan: string | null;
    created_at: string;
  }): TenantSummary {
    return {
      id: row.id,
      name: row.name,
      plan: row.plan ?? 'free',
      createdAt: row.created_at,
      quotas: this.quotasFor(row.id),
      appCount: this.countApps(row.id),
    };
  }

  // ---------------------------------------------------------------------------
  // Core enforce
  // ---------------------------------------------------------------------------

  private async enforce(
    ctx: AuthContext | undefined,
    metric: QuotaMetric,
    current: () => Promise<number>,
  ): Promise<void> {
    const mode = enforcementMode();
    if (mode === 'off') return;
    // Bypass: no context, platform owner, machine token, or unscoped credential.
    if (!ctx) return;
    if (ctx.isSuperadmin || ctx.via === 'api_token') return;
    if (!ctx.tenantId) return;

    const limit = this.quotasFor(ctx.tenantId)[metric];
    if (limit < 0) return; // unlimited

    let used: number;
    try {
      used = await current();
    } catch (err) {
      // Counting failed (e.g. schema not migrated yet) → don't block.
      this.logger.debug(
        `quota count for ${metric} failed: ${(err as Error).message}`,
      );
      return;
    }

    if (used < limit) return;

    const msg = `tenant '${ctx.tenantId}' over quota ${metric}: ${used}/${limit}`;
    if (mode === 'on') {
      this.logger.warn(`QUOTA-DENY ${msg}`);
      throw new HttpException(
        { error: 'quota_exceeded', metric, limit, used },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.logger.warn(`QUOTA-WOULD-DENY ${msg}`);
  }

  /**
   * Enforce a per-app / per-stream numeric cap with the SAME bypass invariants
   * as the tenant path (mode off / no ctx / superadmin / api_token). The limit is
   * supplied by the caller (resolved from the app's config.yaml `quotas:` block);
   * `limit <= 0` means unlimited → no-op. On breach in mode 'on' throws 429.
   */
  private async enforceScoped(
    ctx: AuthContext | undefined,
    scope: 'app' | 'stream',
    metric: string,
    limit: number,
    current: () => Promise<number>,
  ): Promise<void> {
    if (!Number.isFinite(limit) || limit <= 0) return; // unlimited (default)
    const mode = enforcementMode();
    if (mode === 'off') return;
    if (!ctx) return;
    if (ctx.isSuperadmin || ctx.via === 'api_token') return;

    let used: number;
    try {
      used = await current();
    } catch (err) {
      this.logger.debug(`${scope} quota count for ${metric} failed: ${(err as Error).message}`);
      return;
    }
    if (used < limit) return;

    const msg = `${scope} over quota ${metric}: ${used}/${limit}`;
    if (mode === 'on') {
      this.logger.warn(`QUOTA-DENY ${msg}`);
      throw new HttpException(
        { error: `${scope}_quota_exceeded`, scope, metric, limit, used },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.logger.warn(`QUOTA-WOULD-DENY ${msg}`);
  }

  private over(used: number, limit: number): boolean {
    return limit >= 0 && used >= limit;
  }

  // ---------------------------------------------------------------------------
  // Quota config resolution (defensive about the tenants table)
  // ---------------------------------------------------------------------------

  private quotasFor(tenantId: string): TenantQuotas {
    // Wave-5 seam: the tenancy control-plane stores per-tenant limits in the
    // dedicated `quotas` table (one column per metric — see migrations.ts +
    // TenancyService). Prefer that. The `tenants.quotas_json` blob below is a
    // forward-compat fallback (not currently emitted by tenancy); DEFAULT_QUOTAS
    // is the last resort. Each layer is probed defensively.
    const limitsRow = this.quotaTableRow(tenantId);
    if (limitsRow) {
      const n = (v: unknown, fallback: number): number =>
        typeof v === 'number' && v >= 0 ? v : v === -1 ? -1 : fallback;
      return {
        maxApps: n(limitsRow.max_apps, DEFAULT_QUOTAS.maxApps),
        maxConcurrentStreams: n(
          limitsRow.max_concurrent_streams,
          DEFAULT_QUOTAS.maxConcurrentStreams,
        ),
        maxRecordingMinutesMonth: n(
          limitsRow.max_recording_minutes_month,
          DEFAULT_QUOTAS.maxRecordingMinutesMonth,
        ),
        maxEgressGbMonth: n(
          limitsRow.max_egress_gb_month,
          DEFAULT_QUOTAS.maxEgressGbMonth,
        ),
        maxStorageGb: n(limitsRow.max_storage_gb, DEFAULT_QUOTAS.maxStorageGb),
      };
    }
    const row = this.tenantRow(tenantId);
    if (!row) return { ...DEFAULT_QUOTAS };
    let parsed: Partial<Record<string, number>> = {};
    if (row.quotas_json) {
      try {
        parsed = JSON.parse(row.quotas_json) as Record<string, number>;
      } catch {
        parsed = {};
      }
    }
    const pick = (snake: string, camel: keyof TenantQuotas): number => {
      const v = parsed[snake] ?? parsed[camel as string];
      return typeof v === 'number' ? v : DEFAULT_QUOTAS[camel];
    };
    return {
      maxApps: pick('max_apps', 'maxApps'),
      maxConcurrentStreams: pick(
        'max_concurrent_streams',
        'maxConcurrentStreams',
      ),
      maxRecordingMinutesMonth: pick(
        'max_recording_minutes_month',
        'maxRecordingMinutesMonth',
      ),
      maxEgressGbMonth: pick('max_egress_gb_month', 'maxEgressGbMonth'),
      maxStorageGb: pick('max_storage_gb', 'maxStorageGb'),
    };
  }

  private planFor(tenantId: string): string {
    return this.tenantRow(tenantId)?.plan || 'free';
  }

  private tenantRow(
    tenantId: string,
  ): { plan?: string; quotas_json?: string } | undefined {
    if (!this.tableExists('tenants')) return undefined;
    try {
      const cols = this.columns('tenants');
      const sel: string[] = [];
      if (cols.has('plan')) sel.push('plan');
      if (cols.has('quotas_json')) sel.push('quotas_json');
      if (sel.length === 0) return {};
      return this.db
        .global()
        .prepare(`SELECT ${sel.join(', ')} FROM tenants WHERE id = ?`)
        .get(tenantId) as { plan?: string; quotas_json?: string } | undefined;
    } catch {
      return undefined;
    }
  }

  /** Per-tenant limits from the dedicated `quotas` table (tenancy control-plane). */
  private quotaTableRow(
    tenantId: string,
  ): Partial<Record<keyof QuotaTableRow, number>> | undefined {
    if (!this.tableExists('quotas')) return undefined;
    try {
      return this.db
        .global()
        .prepare(`SELECT * FROM quotas WHERE tenant_id = ?`)
        .get(tenantId) as
        | Partial<Record<keyof QuotaTableRow, number>>
        | undefined;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Usage counting (defensive)
  // ---------------------------------------------------------------------------

  /** App names owned by a tenant (empty if `apps.tenant_id` not present). */
  private appsForTenant(tenantId: string): string[] {
    if (!this.columns('apps').has('tenant_id')) return [];
    try {
      const rows = this.db
        .global()
        .prepare('SELECT name FROM apps WHERE tenant_id = ?')
        .all(tenantId) as Array<{ name: string }>;
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  private countApps(tenantId: string): number {
    if (!this.columns('apps').has('tenant_id')) return 0;
    try {
      const row = this.db
        .global()
        .prepare('SELECT COUNT(*) AS n FROM apps WHERE tenant_id = ?')
        .get(tenantId) as { n: number };
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Active streams across all the tenant's apps (per-app vods.db). */
  private countConcurrentStreams(tenantId: string): number {
    let total = 0;
    for (const app of this.appsForTenant(tenantId)) {
      try {
        const row = this.db
          .appDb(app)
          .prepare("SELECT COUNT(*) AS n FROM streams WHERE status = 'active'")
          .get() as { n: number };
        total += row?.n ?? 0;
      } catch {
        /* per-app db may be missing/locked — skip */
      }
    }
    return total;
  }

  /**
   * Monthly usage from the `quota_usage` table (owned by the tenancy agent).
   * Returns zeros when the table/columns are absent.
   */
  private monthlyUsage(tenantId: string): {
    recordingMinutesMonth: number;
    egressGbMonth: number;
    storageGb: number;
  } {
    const zero = {
      recordingMinutesMonth: 0,
      egressGbMonth: 0,
      storageGb: 0,
    };
    if (!this.tableExists('quota_usage')) return zero;
    try {
      const cols = this.columns('quota_usage');
      const period = new Date().toISOString().slice(0, 7); // YYYY-MM
      const hasPeriod = cols.has('period');
      const sql = hasPeriod
        ? 'SELECT * FROM quota_usage WHERE tenant_id = ? AND period = ?'
        : 'SELECT * FROM quota_usage WHERE tenant_id = ?';
      const stmt = this.db.global().prepare(sql);
      const row = (
        hasPeriod ? stmt.get(tenantId, period) : stmt.get(tenantId)
      ) as Record<string, number> | undefined;
      if (!row) return zero;
      const num = (k: string): number =>
        typeof row[k] === 'number' ? row[k] : 0;
      return {
        recordingMinutesMonth: num('recording_minutes_month'),
        egressGbMonth: num('egress_gb_month'),
        storageGb: num('storage_gb'),
      };
    } catch {
      return zero;
    }
  }

  // ---------------------------------------------------------------------------
  // Schema probes
  // ---------------------------------------------------------------------------

  private tableCache = new Map<string, boolean>();
  private colCache = new Map<string, Set<string>>();

  private tableExists(table: string): boolean {
    const cached = this.tableCache.get(table);
    if (cached !== undefined) return cached;
    let exists = false;
    try {
      const row = this.db
        .global()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        )
        .get(table) as { name?: string } | undefined;
      exists = !!row?.name;
    } catch {
      exists = false;
    }
    this.tableCache.set(table, exists);
    return exists;
  }

  private columns(table: string): Set<string> {
    const cached = this.colCache.get(table);
    if (cached) return cached;
    const set = new Set<string>();
    try {
      const cols = this.db
        .global()
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      for (const c of cols) set.add(c.name);
    } catch {
      /* table missing → empty set */
    }
    this.colCache.set(table, set);
    return set;
  }
}
