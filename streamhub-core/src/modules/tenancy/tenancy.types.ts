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
