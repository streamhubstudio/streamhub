/** Tenancy control-plane row shapes + plan defaults (Wave-5 §auth). */

export type MembershipRole = 'owner' | 'editor' | 'viewer';

export interface TenantRow {
  id: string;
  name: string;
  plan: string;
  created_at: string;
}

export interface UserRow {
  id: string;
  email: string | null;
  is_superadmin: number;
  created_at: string;
  /** scrypt password hash (`scrypt$…`). Null for pending/invited or admin. */
  password_hash: string | null;
  /** 'active' | 'pending' — pending = invited, has no password yet. */
  status: string;
  /** Optional display name (profile). */
  name: string | null;
  /** TOTP 2FA — secrets are stored ENCRYPTED (auth/secret-cipher.util). */
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_enabled: number;
  /**
   * Per-user SMTP override (owner item 29) — used for mail the user THEMSELF
   * initiates (their own magic-link sign-in, an invite THEY send as inviter).
   * `smtp_pass_enc` is ENCRYPTED at rest (auth/secret-cipher.util,
   * `encryptUserSmtpSecret`), never plaintext. Precedence: user > app > global.
   */
  smtp_enabled: number;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_from: string | null;
  smtp_pass_enc: string | null;
}

/** A team member as returned by GET /teams/mine (flattened membership + user). */
export interface TeamMember {
  userId: string;
  email: string | null;
  name: string | null;
  role: MembershipRole;
  status: string;
  isSuperadmin: boolean;
  createdAt: string;
}

export interface MembershipRow {
  user_id: string;
  tenant_id: string;
  role: MembershipRole;
  created_at: string;
}

export interface QuotaRow {
  tenant_id: string;
  max_apps: number;
  max_concurrent_streams: number;
  max_recording_minutes_month: number;
  max_egress_gb_month: number;
  max_storage_gb: number;
}

/** Conservative defaults for the open-signup `free` plan (Wave-5 §cuotas). */
export const FREE_PLAN_QUOTA: Omit<QuotaRow, 'tenant_id'> = {
  max_apps: 2,
  max_concurrent_streams: 2,
  max_recording_minutes_month: 300,
  max_egress_gb_month: 5,
  max_storage_gb: 5,
};

/**
 * "Broadcaster / linear" plan preset (endless-radio Tier 1, QW-3). For tenants
 * running 24/7 linear channels: unlimited concurrent streams (`-1`) so a
 * long-running channel never trips the per-tenant stream cap, plus a generous
 * app allowance and unlimited monthly usage. `-1` means unlimited everywhere in
 * QuotasService (see `enforce`). Assign with
 * `PATCH /tenants/:id/quotas { plan: "broadcaster" }`.
 */
export const BROADCASTER_PLAN_QUOTA: Omit<QuotaRow, 'tenant_id'> = {
  max_apps: 50,
  max_concurrent_streams: -1,
  max_recording_minutes_month: -1,
  max_egress_gb_month: -1,
  max_storage_gb: -1,
};

/**
 * Named quota presets a tenant can be assigned by plan label. Assigning a known
 * plan applies its limits as the baseline (explicit per-metric overrides in the
 * same PATCH still win). Unknown plan labels leave the current limits untouched.
 */
export const PLAN_QUOTAS: Record<string, Omit<QuotaRow, 'tenant_id'>> = {
  free: FREE_PLAN_QUOTA,
  broadcaster: BROADCASTER_PLAN_QUOTA,
  linear: BROADCASTER_PLAN_QUOTA,
};
