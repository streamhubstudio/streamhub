/**
 * Env-driven configuration of the backups module (versioned + compressed
 * SQLite snapshots). Resolved once per service (settings are read through
 * ConfigService so tests can pin values per suite).
 *
 * Documented in https://streamhub.studio/docs/operations/ENV, .env.example and
 * https://streamhub.studio/docs/operations/BACKUPS.
 */
import * as path from 'path';
import { ConfigService } from '../../shared/config/config.service';

export interface BackupSettings {
  /** STREAMHUB_BACKUPS_ENABLED — daily scheduled snapshots (default ON). */
  enabled: boolean;
  /**
   * STREAMHUB_BACKUP_RETENTION_DAYS — snapshots older than this are pruned
   * after every run (default 7). `0` disables age-based pruning entirely.
   */
  retentionDays: number;
  /** STREAMHUB_BACKUP_DIR — snapshot root (default `<DATA_DIR>/backups`). */
  backupDir: string;
  /** STREAMHUB_BACKUP_CRON — daily schedule (default `30 3 * * *`). */
  cron: string;
}

export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_BACKUP_CRON = '30 3 * * *';

/** Opt-OUT flag: anything except an explicit off/false/0/no keeps it enabled. */
function enabledFlag(config: ConfigService, name: string): boolean {
  const v = (config.env(name) || '').trim().toLowerCase();
  if (v === '') return true;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function intOrDefault(
  config: ConfigService,
  name: string,
  fallback: number,
): number {
  const raw = config.env(name);
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? fallback : n;
}

/** Loose cron sanity check (5–6 whitespace-separated fields). */
function cronOrDefault(config: ConfigService, name: string): string {
  const raw = (config.env(name) || '').trim();
  if (raw === '') return DEFAULT_BACKUP_CRON;
  const fields = raw.split(/\s+/);
  return fields.length === 5 || fields.length === 6 ? raw : DEFAULT_BACKUP_CRON;
}

export function resolveBackupSettings(config: ConfigService): BackupSettings {
  const dirOverride = (config.env('STREAMHUB_BACKUP_DIR') || '').trim();
  return {
    enabled: enabledFlag(config, 'STREAMHUB_BACKUPS_ENABLED'),
    retentionDays: intOrDefault(
      config,
      'STREAMHUB_BACKUP_RETENTION_DAYS',
      DEFAULT_RETENTION_DAYS,
    ),
    backupDir: dirOverride || path.join(config.dataDir, 'backups'),
    cron: cronOrDefault(config, 'STREAMHUB_BACKUP_CRON'),
  };
}
