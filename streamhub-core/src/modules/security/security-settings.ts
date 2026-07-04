/**
 * Env-driven configuration of the network-security module. Resolved once per
 * service (ConfigService snapshots process.env at construction, and these
 * settings are read through it so tests can pin values per suite).
 *
 * Documented in streamhub-docs/operations/ENV.md and .env.example.
 */
import { ConfigService } from '../../shared/config/config.service';

export type IpAccessMode = 'off' | 'log' | 'enforce';

export interface SecuritySettings {
  /** STREAMHUB_IP_ACCESS_MODE — off (default) | log | enforce. */
  mode: IpAccessMode;
  /** STREAMHUB_IP_ALLOWLIST_ONLY — default-deny public IPs not allowlisted. */
  allowlistOnly: boolean;
  /** STREAMHUB_AUTOBAN_ENABLED — the in-app fail2ban on/off (default off). */
  autobanEnabled: boolean;
  /** STREAMHUB_AUTOBAN_MAX_OFFENSES — offenses within the window → ban (10). */
  autobanMaxOffenses: number;
  /** STREAMHUB_AUTOBAN_WINDOW_S — sliding offense window in seconds (300). */
  autobanWindowS: number;
  /** STREAMHUB_AUTOBAN_BASE_TTL_S — first ban duration in seconds (900). */
  autobanBaseTtlS: number;
  /** STREAMHUB_AUTOBAN_404_ENABLED — count 404 responses as offenses (off). */
  autoban404Enabled: boolean;
}

function flag(config: ConfigService, name: string): boolean {
  const v = (config.env(name) || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function int(config: ConfigService, name: string, fallback: number): number {
  const raw = config.env(name);
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n <= 0 ? fallback : n;
}

export function resolveSecuritySettings(
  config: ConfigService,
): SecuritySettings {
  const rawMode = (config.env('STREAMHUB_IP_ACCESS_MODE') || 'off')
    .trim()
    .toLowerCase();
  const mode: IpAccessMode =
    rawMode === 'log' || rawMode === 'enforce' ? rawMode : 'off';
  return {
    mode,
    allowlistOnly: flag(config, 'STREAMHUB_IP_ALLOWLIST_ONLY'),
    autobanEnabled: flag(config, 'STREAMHUB_AUTOBAN_ENABLED'),
    autobanMaxOffenses: int(config, 'STREAMHUB_AUTOBAN_MAX_OFFENSES', 10),
    autobanWindowS: int(config, 'STREAMHUB_AUTOBAN_WINDOW_S', 300),
    autobanBaseTtlS: int(config, 'STREAMHUB_AUTOBAN_BASE_TTL_S', 900),
    autoban404Enabled: flag(config, 'STREAMHUB_AUTOBAN_404_ENABLED'),
  };
}
