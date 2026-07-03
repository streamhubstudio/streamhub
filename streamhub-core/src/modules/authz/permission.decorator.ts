import { SetMetadata } from '@nestjs/common';
import { Action, Resource } from './authz.constants';

/** Metadata key carrying the (resource, action) a handler requires. */
export const REQUIRE_PERMISSION_KEY = 'streamhub:requirePermission';

export interface RequiredPermission {
  resource: Resource;
  action: Action;
}

/**
 * Declare the permission a route needs: `@RequirePermission('app', 'create')`.
 *
 * The PermissionGuard reads this and enforces it against `req.authCtx` via
 * Casbin. Handlers WITHOUT this decorator are not permission-checked (they still
 * pass the global Bearer auth guard) — so adding the decorator is purely
 * additive and, until `STREAMHUB_AUTHZ_ENFORCE=on`, only logs.
 */
export const RequirePermission = (
  resource: Resource,
  action: Action,
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, { resource, action } as RequiredPermission);
