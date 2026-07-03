/**
 * Wave-5 authz/quotas — phased enforcement switch (CRITICAL back-compat).
 *
 * `STREAMHUB_AUTHZ_ENFORCE` controls how the PermissionGuard + QuotasService react
 * when a check would FAIL:
 *   - 'off'  → checks are skipped entirely (no log, no block).
 *   - 'log'  → checks run but only LOG what they *would* block; the request still
 *              passes. Deploying in this mode does NOT change the behaviour of a
 *              live system that was already running unenforced.
 *   - 'on'   → (DEFAULT for new installs) checks are enforced: owner/editor/viewer
 *              are gated, cross-app tokens are blocked and over-quota requests are
 *              rejected (403 / 429).
 *
 * Fase-0 security: the DEFAULT (unset env) is now 'on' so a fresh install is
 * secure-by-default. Existing deployments that pin `=log` KEEP the log-only
 * behaviour — the override always wins, so nothing changes for them until they
 * flip the flag. An unknown/typo value also resolves to the safe default ('on').
 *
 * In every mode, `isSuperadmin` and global `via:'api_token'` principals ALWAYS
 * bypass RBAC — the platform-owner credentials can never be locked out.
 */
export type EnforcementMode = 'off' | 'log' | 'on';

export const AUTHZ_ENFORCE_ENV = 'STREAMHUB_AUTHZ_ENFORCE';

/** Secure-by-default: unset/invalid resolves to 'on'. Explicit 'log'/'off' win. */
export function enforcementMode(): EnforcementMode {
  const raw = (process.env[AUTHZ_ENFORCE_ENV] || 'on').trim().toLowerCase();
  if (raw === 'off' || raw === 'on' || raw === 'log') return raw;
  return 'on';
}

/** True only when checks should actually block (mode 'on'). */
export function isEnforcing(): boolean {
  return enforcementMode() === 'on';
}

/** Roles in the RBAC-with-domains model (domain = tenantId). */
export const ROLES = ['superadmin', 'owner', 'editor', 'viewer', 'service'] as const;

/** Resources guarded by @RequirePermission. */
export type Resource =
  | 'app'
  | 'config'
  | 's3'
  | 'stream'
  | 'recording'
  | 'vod'
  | 'broadcast'
  | 'sample'
  | 'ingress'
  | 'tenant'
  | 'usage'
  | 'token';

/** Actions a principal can take on a resource. */
export type Action =
  | 'read'
  | 'create'
  | 'write'
  | 'delete'
  | 'start'
  | 'stop';
