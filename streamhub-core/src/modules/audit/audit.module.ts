import { Global, Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';

/**
 * Security audit trail + compliance posture (ISO 27002 §8.15/§8.16;
 * FIX-BACKLOG P1-1 / readiness gap I-1).
 *
 * - {@link AuditService}: append-only, hash-chained `audit_log` on the GLOBAL
 *   DB every module records security events into (auth outcomes, token
 *   mint/revoke, RBAC denials, config/secret changes, destructive ops).
 * - `GET /system/audit` (+ `/verify`): superadmin read API over the trail.
 * - `GET /system/compliance`: live posture of the §8 technological controls.
 *
 * @Global so wired call-sites (login controller, tokens controller, the
 * PermissionGuard, apps/db-admin/security controllers) inject AuditService
 * without per-module imports — the same pattern AuthzModule uses. The module
 * itself enters the app graph via SystemModule's `imports` (feature modules
 * must not edit the scaffolder-owned app.module.ts).
 */
@Global()
@Module({
  controllers: [AuditController, ComplianceController],
  providers: [AuditService, ComplianceService],
  exports: [AuditService, ComplianceService],
})
export class AuditModule {}
