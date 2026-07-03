import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * STREAMHUB MULTI-TENANT AUTH CONTRACT (Wave-5 §auth).
 *
 * This is the ONE shape every module reads to know *who* is calling and *in
 * which tenant*. The global AuthGuard authenticates the request and leaves a
 * resolved `AuthContext` on `req.authCtx`. The guard ONLY authenticates +
 * builds this context — per-route permission checks (Casbin) live elsewhere and
 * read this same object. STABLE CONTRACT — do not change field meanings.
 *
 * NOTE: this is distinct from the legacy `AuthContext` in
 * `shared/auth/auth.guard.ts` ({ tokenId, scope, appId }) which still rides on
 * `req.auth` for back-compat. New tenancy-aware code reads `req.authCtx`.
 */

/** Coarse role of the principal. `service` = machine token, not a human. */
export type AuthRole =
  | 'superadmin'
  | 'owner'
  | 'editor'
  | 'viewer'
  | 'service';

/** Breadth of the credential. */
export type AuthScope = 'global' | 'app' | 'user';

/** How the principal proved identity. */
export type AuthVia = 'api_token' | 'admin_jwt' | 'user_jwt';

export interface AuthContext {
  /** Stable principal id: user id (built-in user / admin) or `token:<id>` for tokens. */
  userId: string;
  /** Tenant the request acts within. `platform` for superadmin/global creds. */
  tenantId: string | null;
  /** Coarse role of the principal in `tenantId`. */
  role: AuthRole;
  /** True for the platform owner — bypasses tenant scoping. */
  isSuperadmin: boolean;
  /** Credential breadth. */
  scope: AuthScope;
  /** Authentication mechanism that produced this context. */
  via: AuthVia;
  /** Email when known (built-in user / admin). */
  email?: string;
}

/** Canonical id of the built-in tenant that owns the platform's own apps. */
export const PLATFORM_TENANT_ID = 'platform';

/** Request augmented by the guard with the resolved auth context. */
export type RequestWithAuthCtx = Request & { authCtx?: AuthContext };

/** Read the resolved AuthContext off a request (undefined on public routes). */
export function getAuthCtx(req: Request): AuthContext | undefined {
  return (req as RequestWithAuthCtx).authCtx;
}

/** Attach the resolved AuthContext to a request (used by the guard/validator). */
export function setAuthCtx(req: Request, ctx: AuthContext): void {
  (req as RequestWithAuthCtx).authCtx = ctx;
}

/**
 * Param decorator: inject the AuthContext into a handler argument.
 * `@CurrentAuth() ctx: AuthContext`. Resolves `undefined` on public routes.
 */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext | undefined =>
    getAuthCtx(ctx.switchToHttp().getRequest<Request>()),
);
