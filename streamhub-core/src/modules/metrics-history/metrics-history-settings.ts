/**
 * Env-driven configuration of the metrics-history module (lightweight, in-app
 * host resource-usage history — CPU / RAM / Disk / Network sampled once per
 * hour into the global DB, complementary to the heavyweight Prometheus/Grafana
 * path). Resolved once per service through ConfigService so tests can pin
 * values per suite.
 *
 * Documented in https://streamhub.studio/docs/operations/ENV, .env.example and
 * https://streamhub.studio/docs/operations/OBSERVABILITY.
 */
import { ConfigService } from '../../shared/config/config.service';

export interface MetricsHistorySettings {
  /**
   * STREAMHUB_METRICS_HISTORY_ENABLED — the hourly sampler (default ON).
   * `false`/`0`/`off`/`no` disables the scheduler entirely; the read API keeps
   * serving whatever history is already stored.
   */
  enabled: boolean;
  /**
   * STREAMHUB_METRICS_HISTORY_RETENTION_DAYS — samples older than this many days
   * are pruned after every run (default 30). `0` disables age-based pruning.
   */
  retentionDays: number;
  /**
   * STREAMHUB_METRICS_HISTORY_CRON — sampling schedule (default hourly, on the
   * hour). Invalid patterns fall back to the default.
   */
  cron: string;
}

export const DEFAULT_RETENTION_DAYS = 30;
/** Once per hour, on the hour. */
export const DEFAULT_CRON = '0 * * * *';

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
  if (raw === '') return DEFAULT_CRON;
  const fields = raw.split(/\s+/);
  return fields.length === 5 || fields.length === 6 ? raw : DEFAULT_CRON;
}

export function resolveMetricsHistorySettings(
  config: ConfigService,
): MetricsHistorySettings {
  return {
    enabled: enabledFlag(config, 'STREAMHUB_METRICS_HISTORY_ENABLED'),
    retentionDays: intOrDefault(
      config,
      'STREAMHUB_METRICS_HISTORY_RETENTION_DAYS',
      DEFAULT_RETENTION_DAYS,
    ),
    cron: cronOrDefault(config, 'STREAMHUB_METRICS_HISTORY_CRON'),
  };
}
