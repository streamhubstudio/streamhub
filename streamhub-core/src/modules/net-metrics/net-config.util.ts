/**
 * Reader for the per-app `network:` config block (Wave 1C). The block is NOT
 * (yet) promoted into the typed AppConfig contract (shared/contracts is frozen
 * for this wave), so — exactly like the webhook sink reads `features.auto_record`
 * — we read it RAW from `apps/<app>/config.yaml`, snake_case, defaulting when
 * absent. Operators set it through the existing raw-config editor / config API:
 *
 *   network:
 *     threshold_gb_day: 100   # rolling-24h ingress+egress cap, in GB (GiB)
 *
 * Pure + best-effort: any parse/IO error yields an empty config (monitoring off).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/** Resolved per-app network settings. */
export interface NetworkConfig {
  /** Rolling-24h ingress+egress cap in GB; undefined / <=0 = no threshold. */
  thresholdGbDay?: number;
}

/**
 * Read `network:` from an app's on-disk config.yaml. `appDir` is the app's
 * directory (AppsService.appDir). Never throws.
 */
export function readNetworkConfig(appDir: string): NetworkConfig {
  try {
    const file = path.join(appDir, 'config.yaml');
    const parsed = yaml.load(fs.readFileSync(file, 'utf8')) as {
      network?: { threshold_gb_day?: unknown };
    } | null;
    const raw = parsed?.network?.threshold_gb_day;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) return { thresholdGbDay: n };
    return {};
  } catch {
    return {};
  }
}
