import { Injectable } from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import { isPrivateOrLoopbackIp, normalizeIp } from './ip-cidr.util';
import { IpReputationService } from './ip-reputation.service';
import { IpRulesService } from './ip-rules.service';
import {
  resolveSecuritySettings,
  type SecuritySettings,
} from './security-settings';

/** Why a connection upgrade would be rejected (null = allowed through). */
export type UpgradeRejectReason = 'banned' | 'blocked';

/**
 * NetworkGuardService — the network-security verdict for NON-HTTP entry points
 * (WebSocket upgrades), reusing the SAME allow/blocklist + auto-ban state and
 * env-driven settings as {@link SecurityMiddleware}, but returning a plain
 * boolean verdict instead of writing an HTTP response.
 *
 * The middleware still owns the per-request HTTP plane (bodies, 404-storm
 * offense recording, `log`-mode annotation); this service only answers the one
 * question a socket-upgrade handler needs — "reject this IP?" — with the exact
 * same precedence:
 *   loopback/RFC1918 → never reject; explicit allow → never reject; active
 *   auto-ban → reject('banned'); blocklist / allowlist-only default-deny in
 *   `enforce` mode → reject('blocked'). In `log`/`off` mode nothing is rejected
 *   (non-breaking — Flag B in internal design notes).
 */
@Injectable()
export class NetworkGuardService {
  private readonly settings: SecuritySettings;

  constructor(
    config: ConfigService,
    private readonly rules: IpRulesService,
    private readonly reputation: IpReputationService,
  ) {
    this.settings = resolveSecuritySettings(config);
  }

  /**
   * Should this peer IP be rejected at a connection upgrade? Returns the reason
   * (`banned`/`blocked`) or null to let it through. A missing/unparseable IP is
   * always allowed (fail-open — same as the middleware, which cannot lock out a
   * client it cannot identify). Never throws.
   */
  rejectUpgradeReason(ip: string | undefined): UpgradeRejectReason | null {
    const s = this.settings;
    // Fully dormant: no rules and no auto-ban → zero work, never reject.
    if (s.mode === 'off' && !s.autobanEnabled) return null;
    if (!ip) return null;
    try {
      const norm = normalizeIp(ip);
      // The lock-out guarantee — local/private traffic is never touched.
      if (isPrivateOrLoopbackIp(norm)) return null;
      // Explicit allow wins over everything else (incl. an existing ban).
      const match = this.rules.evaluate(norm);
      if (match === 'allow') return null;
      // Active auto-ban.
      if (s.autobanEnabled && this.reputation.isBanned(norm)) return 'banned';
      // Blocklist / allowlist-only default-deny — only in enforce mode.
      if (s.mode === 'enforce' && (match === 'block' || s.allowlistOnly)) {
        return 'blocked';
      }
      return null;
    } catch {
      return null;
    }
  }
}
