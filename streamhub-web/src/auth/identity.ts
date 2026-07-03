/**
 * Identity derived from the bearer JWT (client-side, UNVERIFIED — the backend
 * verifies the signature and is the real source of truth for scoping). Used only
 * to render the UI: who am I, which tenants, what role, am I a superadmin. The
 * Account pages still hit /tenants/* for authoritative data.
 */
import type { TenantRole } from '@/api'

/** Role used to gate the UI. `superadmin` is the global platform owner. */
export type UiRole = TenantRole | 'superadmin'

export interface Identity {
  sub: string
  email?: string
  name?: string
  isSuperadmin: boolean
  /** Tenant ids the user belongs to. */
  tenants: string[]
  /** role per tenant id. */
  roleByTenant: Record<string, TenantRole>
}

/** Decode a JWT payload without verifying the signature. Returns {} on failure. */
export function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length < 2) return {}
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
    const json = decodeURIComponent(
      atob(b64 + pad)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    )
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Identity from a core JWT (email/password or break-glass admin login). Tenants
 * and role come from the token when present; the platform owner (admin JWT, no
 * explicit flag) is treated as superadmin. A backend-issued account token may
 * set `is_superadmin: false` to scope the UI down.
 */
export function adminIdentity(token: string): Identity {
  const claims = decodeJwt(token)
  const explicit = claims.is_superadmin ?? claims.isSuperadmin
  return {
    sub: String(claims.sub ?? claims.user ?? 'admin'),
    email: typeof claims.email === 'string' ? claims.email : undefined,
    name:
      (typeof claims.name === 'string' && claims.name) ||
      (typeof claims.user === 'string' && claims.user) ||
      'admin',
    isSuperadmin: typeof explicit === 'boolean' ? explicit : true,
    tenants: [],
    roleByTenant: {},
  }
}

/** Resolve the UI role for a given tenant (or superadmin/none). */
export function roleForTenant(
  identity: Identity | null,
  tenantId: string | undefined,
): UiRole | null {
  if (!identity) return null
  if (identity.isSuperadmin) return 'superadmin'
  if (!tenantId) return null
  return identity.roleByTenant[tenantId] ?? null
}

/** Whether a role may mutate resources (create/edit/delete). */
export function canEditRole(role: UiRole | null): boolean {
  return role === 'superadmin' || role === 'owner' || role === 'editor'
}

/** Whether a role may manage members + quotas of a tenant. */
export function canManageTenantRole(role: UiRole | null): boolean {
  return role === 'superadmin' || role === 'owner'
}
