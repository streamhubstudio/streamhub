/**
 * Unit — audit/ComplianceService (GET /system/compliance posture reporter).
 *
 * Invariants locked down:
 *  - reports the full fixed control set, each mapped to an ISO 27002 §8
 *    control, with a summary that adds up,
 *  - authz_enforce mirrors STREAMHUB_AUTHZ_ENFORCE (on→active, log→partial,
 *    off→off),
 *  - tls reflects PUBLIC_BASE_URL scheme (https→active),
 *  - ip_filtering / auto_ban mirror the network-security env,
 *  - public_registration is 'off' (insecure) when signup is enabled and
 *    'active' when invite-only,
 *  - backups: off with nothing configured, active with a fresh file in
 *    <dataDir>/backups, partial when the newest backup is stale,
 *  - every check is defensive — no probe failure errors the report.
 */
import * as fs from 'fs';
import * as path from 'path';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AuditService } from './audit.service';
import { ComplianceService, type ComplianceReport } from './compliance.service';

const ENV_KEYS = [
  'STREAMHUB_AUTHZ_ENFORCE',
  'STREAMHUB_IP_ACCESS_MODE',
  'STREAMHUB_AUTOBAN_ENABLED',
  'STREAMHUB_PUBLIC_REGISTRATION',
  'STREAMHUB_ALLOW_SIGNUP',
  'METRICS_TOKEN',
  'BACKUP_S3_BUCKET',
  'BACKUP_LOCAL_DIR',
  'PUBLIC_BASE_URL',
  'STREAMHUB_DOMAIN',
];

function control(report: ComplianceReport, id: string) {
  const c = report.controls.find((c) => c.id === id);
  if (!c) throw new Error(`control ${id} missing from report`);
  return c;
}

describe('audit/ComplianceService', () => {
  let ctx: UnitContext;
  let audit: AuditService;
  let compliance: ComplianceService;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
  });

  afterEach(() => {
    audit.onModuleDestroy();
    ctx.cleanup();
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  /** Build the service graph with pinned env. */
  function build(overrides: Record<string, string> = {}): void {
    // Neutral baseline so ambient env (test harness defaults) can't skew a case.
    const base: Record<string, string> = {
      STREAMHUB_AUTHZ_ENFORCE: 'on',
      STREAMHUB_IP_ACCESS_MODE: '',
      STREAMHUB_AUTOBAN_ENABLED: '',
      STREAMHUB_PUBLIC_REGISTRATION: '',
      STREAMHUB_ALLOW_SIGNUP: '',
      METRICS_TOKEN: '',
      BACKUP_S3_BUCKET: '',
      BACKUP_LOCAL_DIR: '',
      PUBLIC_BASE_URL: '',
      STREAMHUB_DOMAIN: '',
    };
    ctx = makeUnitContext({ ...base, ...overrides });
    audit = ctx.newService(AuditService, ctx.config, ctx.db);
    audit.onModuleInit();
    compliance = ctx.newService(ComplianceService, ctx.config, ctx.db, audit);
  }

  it('reports the full control set with ISO mappings and a consistent summary', () => {
    build();
    const report = compliance.report();
    const ids = report.controls.map((c) => c.id);
    expect(ids).toEqual([
      'authz_enforce',
      'tls',
      'ip_filtering',
      'auto_ban',
      'audit_log',
      'backups',
      'http_hardening',
      'metrics_protected',
      'public_registration',
      'log_retention',
    ]);
    for (const c of report.controls) {
      expect(c.iso).toMatch(/^8\.\d+/);
      expect(['active', 'partial', 'off', 'unknown']).toContain(c.state);
      expect(c.detail).toBeTruthy();
    }
    const { active, partial, off, unknown } = report.summary;
    expect(active + partial + off + unknown).toBe(report.controls.length);
    expect(report.checkedAt).toBeTruthy();
  });

  it('authz_enforce mirrors the enforcement mode', () => {
    build({ STREAMHUB_AUTHZ_ENFORCE: 'on' });
    expect(control(compliance.report(), 'authz_enforce').state).toBe('active');
    process.env.STREAMHUB_AUTHZ_ENFORCE = 'log';
    expect(control(compliance.report(), 'authz_enforce').state).toBe('partial');
    process.env.STREAMHUB_AUTHZ_ENFORCE = 'off';
    expect(control(compliance.report(), 'authz_enforce').state).toBe('off');
  });

  it('tls is active on an https PUBLIC_BASE_URL, off when unset', () => {
    build({ PUBLIC_BASE_URL: 'https://stream.example.com' });
    expect(control(compliance.report(), 'tls').state).toBe('active');
    audit.onModuleDestroy();
    ctx.cleanup();
    build();
    expect(control(compliance.report(), 'tls').state).toBe('off');
  });

  it('ip_filtering and auto_ban mirror the network-security env', () => {
    build({
      STREAMHUB_IP_ACCESS_MODE: 'enforce',
      STREAMHUB_AUTOBAN_ENABLED: 'true',
    });
    const report = compliance.report();
    expect(control(report, 'ip_filtering').state).toBe('active');
    expect(control(report, 'auto_ban').state).toBe('active');
    process.env.STREAMHUB_IP_ACCESS_MODE = 'log';
    process.env.STREAMHUB_AUTOBAN_ENABLED = '';
    const report2 = compliance.report();
    expect(control(report2, 'ip_filtering').state).toBe('partial');
    expect(control(report2, 'auto_ban').state).toBe('off');
  });

  it('public_registration is the INSECURE state when signup is open', () => {
    build({ STREAMHUB_PUBLIC_REGISTRATION: '1' });
    expect(control(compliance.report(), 'public_registration').state).toBe(
      'off',
    );
    process.env.STREAMHUB_PUBLIC_REGISTRATION = '';
    expect(control(compliance.report(), 'public_registration').state).toBe(
      'active',
    );
  });

  it('audit_log is active and reports retention + entry count', () => {
    build();
    audit.record({ action: 'x.y' });
    const c = control(compliance.report(), 'audit_log');
    expect(c.state).toBe('active');
    expect(c.detail).toContain('1 entries');
    expect(c.detail).toContain('90 days');
  });

  it('metrics_protected explains token-gated vs default-deny', () => {
    build({ METRICS_TOKEN: 'mtk_test' });
    expect(control(compliance.report(), 'metrics_protected').detail).toContain(
      'token-gated',
    );
    process.env.METRICS_TOKEN = '';
    expect(control(compliance.report(), 'metrics_protected').detail).toContain(
      'default-deny',
    );
  });

  describe('backups', () => {
    it('off with nothing configured and no backup files', () => {
      build();
      expect(control(compliance.report(), 'backups').state).toBe('off');
    });

    it('active with a fresh file, partial when stale', () => {
      build();
      const dir = path.join(ctx.dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'streamhub-backup.tar.gz');
      fs.writeFileSync(file, 'x');
      expect(control(compliance.report(), 'backups').state).toBe('active');

      // Age the backup past the freshness window (48h).
      const old = new Date(Date.now() - 72 * 3_600_000);
      fs.utimesSync(file, old, old);
      expect(control(compliance.report(), 'backups').state).toBe('partial');
    });

    it('partial when S3 is configured but no local backup exists yet', () => {
      build({ BACKUP_S3_BUCKET: 'my-backups' });
      expect(control(compliance.report(), 'backups').state).toBe('partial');
    });
  });
});
