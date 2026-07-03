import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthzService } from './authz.service';
import { PermissionGuard } from './permission.guard';

/**
 * Authorization module (wave-5). Global so `@RequirePermission` + AuthzService
 * are usable from any controller without per-module wiring.
 *
 * Registers PermissionGuard as a SECOND global guard. It runs after the auth
 * module's guard (which authenticates and populates `req.authCtx`); the
 * PermissionGuard reads that context and enforces RBAC + tenant scope. It fails
 * open when `req.authCtx` is absent, so registering it never changes behaviour
 * until `STREAMHUB_AUTHZ_ENFORCE=on`.
 */
@Global()
@Module({
  providers: [
    AuthzService,
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AuthzService],
})
export class AuthzModule {}
