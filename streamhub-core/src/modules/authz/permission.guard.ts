import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { getAuthCtx, RequestWithAuthCtx } from '../../shared/auth-context';
import { EnforcementMode, enforcementMode } from './authz.constants';
import { AuthzService } from './authz.service';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from './permission.decorator';

/** Legacy auth context ({tokenId,scope,appId}) the AuthGuard leaves on req.auth. */
interface LegacyAuth {
  tokenId?: number;
  scope?: 'global' | 'app';
  appId?: number | null;
}

/**
 * Global authorization guard (runs AFTER the auth guard that populates
 * `req.authCtx`). Phased + back-compat by design:
 *
 *  - Handlers without `@RequirePermission` are not checked.
 *  - `isSuperadmin` and global `via:'api_token'` principals ALWAYS pass RBAC.
 *  - Missing `req.authCtx` → pass (the auth guard already authenticated; this is
 *    the pre-wiring back-compat path so deploying authz changes nothing).
 *  - `STREAMHUB_AUTHZ_ENFORCE`: 'off' skips, 'log' only logs what it would block,
 *    'on' (default for new installs) actually throws 403.
 *
 * Three checks compose (in this order):
 *   1. Fase-0 M2 — app-scoped isolation: an app-scoped credential (scope:'app',
 *      i.e. a per-app `sk_` token) may ONLY act on its OWN app. This runs BEFORE
 *      the api_token bypass so a token for app A cannot mint tokens / purge /
 *      read config or S3 of app B. Superadmin & global tokens are unaffected.
 *   2. the Casbin RBAC verdict (role × resource × action);
 *   3. the tenant data-scope (the `:app` belongs to the caller's tenant).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthzService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No declared permission → nothing to enforce here.
    if (!required) return true;

    const mode = enforcementMode();
    if (mode === 'off') return true;

    const req = context.switchToHttp().getRequest<RequestWithAuthCtx>();
    const ctx = getAuthCtx(req);

    // Back-compat: auth guard not yet wiring authCtx, or a public route. The
    // request is already authenticated upstream — don't introduce a new block.
    if (!ctx) return true;

    const app = this.appParam(req);

    // 1) M2 — app-scoped token isolation. Runs even for api_token principals
    //    (which otherwise bypass RBAC below) so a per-app token is confined to
    //    its own app. Superadmin / global credentials never trip this.
    if (this.crossAppViolation(req, ctx, app)) {
      return this.decide(
        mode,
        req,
        ctx,
        `app '${app}' is outside this credential's app scope`,
      );
    }

    // 2) Platform-owner / global credentials always pass RBAC (never lock them
    //    out). App-scoped tokens that reached here are already on their own app.
    if (ctx.isSuperadmin || ctx.via === 'api_token') return true;

    const rbacOk = await this.authz.can(ctx, required.resource, required.action);
    const scopeOk = app ? this.authz.appBelongsToTenant(ctx, app) : true;
    if (rbacOk && scopeOk) return true;

    const reason = !rbacOk
      ? `role '${ctx.role}' lacks ${required.resource}:${required.action}`
      : `app '${app}' is outside tenant '${ctx.tenantId}'`;
    return this.decide(mode, req, ctx, reason);
  }

  /**
   * True when an app-scoped credential is acting on an app that is NOT its own.
   * Only constrains non-superadmin, `scope:'app'` credentials (per-app tokens);
   * fails SAFE (no block) when the token's app or the route's app can't be
   * resolved, so a legitimate request is never blocked on missing signal.
   */
  private crossAppViolation(
    req: RequestWithAuthCtx,
    ctx: NonNullable<ReturnType<typeof getAuthCtx>>,
    app: string | null,
  ): boolean {
    if (ctx.isSuperadmin || ctx.scope !== 'app') return false; // global/superadmin/user
    if (!app) return false; // route isn't app-specific → nothing to isolate
    const tokenAppId = this.tokenAppId(req);
    if (tokenAppId == null) return false; // token's app unknown → don't block
    const routeAppId = this.authz.appIdByName(app);
    if (routeAppId == null) return false; // unknown app → let the handler 404
    return routeAppId !== tokenAppId;
  }

  /** The app id carried by the legacy AuthContext the AuthGuard put on req.auth. */
  private tokenAppId(req: RequestWithAuthCtx): number | null {
    const legacy = (req as unknown as { auth?: LegacyAuth }).auth;
    return legacy?.appId ?? null;
  }

  /** Enforce ('on' → 403) or report-only ('log' → warn + allow) a denial. */
  private decide(
    mode: EnforcementMode,
    req: RequestWithAuthCtx,
    ctx: NonNullable<ReturnType<typeof getAuthCtx>>,
    reason: string,
  ): boolean {
    const where = `${req.method} ${req.originalUrl || req.url}`;
    if (mode === 'on') {
      this.logger.warn(`DENY ${where} — ${reason} (user=${ctx.userId})`);
      throw new ForbiddenException(reason);
    }
    // mode === 'log': report what WOULD be blocked, but allow.
    this.logger.warn(
      `WOULD-DENY ${where} — ${reason} (user=${ctx.userId}, tenant=${ctx.tenantId})`,
    );
    return true;
  }

  /** Extract the `:app` route param (controllers use `/apps/:app/...`). */
  private appParam(req: RequestWithAuthCtx): string | null {
    const params = (req.params || {}) as Record<string, string>;
    return params.app || params.name || null;
  }
}
