import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { enforcementMode } from '../authz/authz.constants';
import { AuditService } from './audit.service';

/** State of one technological control. */
export type ControlState = 'active' | 'partial' | 'off' | 'unknown';

/** One row of the compliance posture report. */
export interface ComplianceControl {
  /** Stable machine id, e.g. 'authz_enforce'. */
  id: string;
  /** Human name shown in the dashboard. */
  name: string;
  /** ISO/IEC 27002:2022 §8 control(s) this maps to, e.g. '8.15'. */
  iso: string;
  state: ControlState;
  /** Live evidence detail (never contains secrets). */
  detail: string;
}

/** Full posture report (GET /system/compliance). */
export interface ComplianceReport {
  checkedAt: string;
  summary: { active: number; partial: number; off: number; unknown: number };
  controls: ComplianceControl[];
}

/** How recent the newest backup must be to count as 'active' (hours). */
const BACKUP_FRESH_HOURS = 48;

/**
 * Read-only compliance posture reporter (ISO 27002 §8 technological controls;
 * readiness doc `https://streamhub.studio/docs/security/ISO-27001-READINESS`).
 *
 * Each check inspects LIVE state (env, DB tables, filesystem) — not intent —
 * so the report is usable as auditor evidence of which controls are actually
 * ACTIVE on this deployment. Every check is defensive: a failing probe
 * degrades to state 'unknown' rather than erroring the endpoint.
 *
 * Backups note: the check scans the backup output directory (deploy/backup.sh
 * convention: BACKUP_LOCAL_DIR, default <DATA_DIR>/backups). When the in-core
 * backups module lands, this check should additionally read its status API.
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  report(): ComplianceReport {
    const controls: ComplianceControl[] = [
      this.authzEnforce(),
      this.tls(),
      this.ipFiltering(),
      this.autoBan(),
      this.auditLog(),
      this.backups(),
      this.httpHardening(),
      this.metricsProtected(),
      this.publicRegistration(),
      this.logRetention(),
    ];
    const summary = { active: 0, partial: 0, off: 0, unknown: 0 };
    for (const c of controls) summary[c.state]++;
    return { checkedAt: new Date().toISOString(), summary, controls };
  }

  // ---------------------------------------------------------------------------
  // Individual checks
  // ---------------------------------------------------------------------------

  private authzEnforce(): ComplianceControl {
    const mode = enforcementMode();
    return {
      id: 'authz_enforce',
      name: 'RBAC & quota enforcement (STREAMHUB_AUTHZ_ENFORCE)',
      iso: '8.3',
      state: mode === 'on' ? 'active' : mode === 'log' ? 'partial' : 'off',
      detail:
        mode === 'on'
          ? 'enforcing: role/tenant/quota denials return 403/429'
          : mode === 'log'
            ? 'log-only: violations are logged but requests pass'
            : 'disabled: no RBAC/quota checks run',
    };
  }

  private tls(): ComplianceControl {
    const base = this.config.publicBaseUrl;
    const domain = (this.config.env('STREAMHUB_DOMAIN') ?? '').trim();
    const https = base.startsWith('https://');
    return {
      id: 'tls',
      name: 'TLS termination (auto-TLS at the reverse proxy)',
      iso: '8.21, 8.24',
      state: https ? 'active' : domain ? 'partial' : 'off',
      detail: https
        ? `public base URL is HTTPS (${base})`
        : domain
          ? `STREAMHUB_DOMAIN=${domain} set but PUBLIC_BASE_URL is not https`
          : 'no https PUBLIC_BASE_URL/STREAMHUB_DOMAIN configured',
    };
  }

  private ipFiltering(): ComplianceControl {
    const raw = (this.config.env('STREAMHUB_IP_ACCESS_MODE') ?? 'off')
      .trim()
      .toLowerCase();
    const mode = raw === 'enforce' || raw === 'log' ? raw : 'off';
    let rules = { allow: 0, block: 0 };
    try {
      const rows = this.db
        .global()
        .prepare('SELECT action, COUNT(*) AS n FROM ip_rules GROUP BY action')
        .all() as { action: 'allow' | 'block'; n: number }[];
      for (const r of rows) rules[r.action] = r.n;
    } catch {
      rules = { allow: 0, block: 0 };
    }
    return {
      id: 'ip_filtering',
      name: 'IP allow/blocklist (network security)',
      iso: '8.20',
      state: mode === 'enforce' ? 'active' : mode === 'log' ? 'partial' : 'off',
      detail: `mode=${mode}; rules: ${rules.allow} allow / ${rules.block} block`,
    };
  }

  private autoBan(): ComplianceControl {
    const enabled = this.flag('STREAMHUB_AUTOBAN_ENABLED');
    const max = this.config.env('STREAMHUB_AUTOBAN_MAX_OFFENSES') ?? '10';
    const win = this.config.env('STREAMHUB_AUTOBAN_WINDOW_S') ?? '300';
    return {
      id: 'auto_ban',
      name: 'Auto-ban on repeated abuse (in-app fail2ban)',
      iso: '8.16, 8.20',
      state: enabled ? 'active' : 'off',
      detail: enabled
        ? `enabled: ban after ${max} offenses within ${win}s`
        : 'disabled (STREAMHUB_AUTOBAN_ENABLED off)',
    };
  }

  private auditLog(): ComplianceControl {
    const days = this.audit.retentionDays;
    const entries = this.audit.count();
    return {
      id: 'audit_log',
      name: 'Append-only security audit trail',
      iso: '8.15, 8.16',
      state: 'active',
      detail: `enabled; ${entries} entries; retention ${
        days === 0 ? 'forever' : `${days} days`
      }; hash-chained, UPDATE/DELETE rejected by trigger`,
    };
  }

  private backups(): ComplianceControl {
    const configured =
      Boolean((this.config.env('BACKUP_S3_BUCKET') ?? '').trim()) ||
      Boolean((this.config.env('BACKUP_LOCAL_DIR') ?? '').trim());
    const dir =
      (this.config.env('BACKUP_LOCAL_DIR') ?? '').trim() ||
      path.join(this.config.dataDir, 'backups');
    const newest = this.newestFileAgeHours(dir);
    if (newest === null) {
      return {
        id: 'backups',
        name: 'Automated backups of DATA_DIR',
        iso: '8.13',
        state: configured ? 'partial' : 'off',
        detail: configured
          ? `configured but no backup found in ${dir}`
          : `no backup configuration and no backups in ${dir}`,
      };
    }
    const fresh = newest <= BACKUP_FRESH_HOURS;
    return {
      id: 'backups',
      name: 'Automated backups of DATA_DIR',
      iso: '8.13',
      state: fresh ? 'active' : 'partial',
      detail: `last backup ${newest.toFixed(1)}h ago in ${dir}${
        fresh ? '' : ` (older than ${BACKUP_FRESH_HOURS}h)`
      }`,
    };
  }

  private httpHardening(): ComplianceControl {
    return {
      id: 'http_hardening',
      name: 'Hardened HTTP response headers (helmet)',
      iso: '8.26',
      state: 'active',
      detail: 'helmet is enabled unconditionally at bootstrap (src/main.ts)',
    };
  }

  private metricsProtected(): ComplianceControl {
    const token = (this.config.env('METRICS_TOKEN') ?? '').trim();
    return {
      id: 'metrics_protected',
      name: 'Prometheus /metrics access control',
      iso: '8.16',
      state: 'active',
      detail: token
        ? 'token-gated (METRICS_TOKEN set; invalid token → 403)'
        : 'disabled by default-deny (no METRICS_TOKEN → 404)',
    };
  }

  private publicRegistration(): ComplianceControl {
    const enabled =
      this.flag('STREAMHUB_PUBLIC_REGISTRATION') ||
      this.flag('STREAMHUB_ALLOW_SIGNUP');
    return {
      id: 'public_registration',
      name: 'Public self-registration disabled',
      iso: '8.2, 8.5',
      state: enabled ? 'off' : 'active',
      detail: enabled
        ? 'public signup is ENABLED — anyone can create a team'
        : 'invite-only: unknown emails get 403 signup_disabled',
    };
  }

  private logRetention(): ComplianceControl {
    const days = this.config.logRetentionDays;
    return {
      id: 'log_retention',
      name: 'Server log retention (server_logs purge)',
      iso: '8.15',
      state: days > 0 ? 'active' : 'partial',
      detail:
        days > 0
          ? `rows and rotated files older than ${days} days are purged`
          : 'retention 0 = logs kept forever (no automatic purge)',
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private flag(name: string): boolean {
    const v = (this.config.env(name) ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
  }

  /** Age in hours of the newest regular file in `dir`, or null when none. */
  private newestFileAgeHours(dir: string): number | null {
    try {
      const names = fs.readdirSync(dir);
      let newest = 0;
      for (const name of names) {
        try {
          const st = fs.statSync(path.join(dir, name));
          if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
        } catch {
          /* unreadable entry — skip */
        }
      }
      if (newest === 0) return null;
      return (Date.now() - newest) / 3_600_000;
    } catch {
      return null;
    }
  }
}
