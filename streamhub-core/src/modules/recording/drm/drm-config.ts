/**
 * `features.drm` config resolution (pure — no I/O, no Nest).
 *
 * The on-disk snake_case block in `apps/<app>/config.yaml` is resolved into
 * the cross-module `DrmFeatures` contract with EVERY field defaulted (same
 * rule as the plugin `configSchema` contract: no undefined leaks past here).
 * Default is OFF → the VOD pipeline packages in the clear, unchanged.
 *
 * Used by AppsService (`toResolvedConfig`) and defensively re-applied by
 * DrmService for fixtures that predate the block.
 */
import type {
  DrmFeatures,
  DrmLicenseUrls,
  DrmScheme,
  DrmSystem,
} from '../../../shared/contracts';

/** Every DRM system StreamHub can signal for. */
export const DRM_SYSTEMS: readonly DrmSystem[] = [
  'widevine',
  'playready',
  'fairplay',
] as const;

/** On-disk (YAML, snake_case) shape of `features.drm`. Everything optional. */
export interface DiskDrmFeatures {
  enabled?: unknown;
  provider?: unknown;
  systems?: unknown;
  scheme?: unknown;
  key_server_url?: unknown;
  key_server_token_env?: unknown;
  license_urls?: {
    widevine?: unknown;
    playready?: unknown;
    fairplay?: unknown;
  };
  fairplay_cert_url?: unknown;
  fail_open?: unknown;
}

/** Defaults for every `features.drm` field (master switch OFF). */
export const DRM_FEATURE_DEFAULTS: Readonly<DrmFeatures> = Object.freeze({
  enabled: false,
  provider: 'none',
  systems: [...DRM_SYSTEMS],
  scheme: 'cbcs',
  keyServerUrl: '',
  keyServerTokenEnv: '',
  licenseUrls: Object.freeze({
    widevine: '',
    playready: '',
    fairplay: '',
  }) as DrmLicenseUrls,
  fairplayCertUrl: '',
  failOpen: false,
}) as DrmFeatures;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Resolve + sanitize the on-disk `features.drm` block. Absent/garbage input
 * degrades to the safe defaults: disabled, noop provider, cbcs, fail-closed.
 *  - `enabled`/`fail_open` are STRICT booleans (only `true` enables).
 *  - unknown `systems` entries are dropped (deduped, case-insensitive);
 *    an empty/invalid list falls back to all three systems.
 *  - unknown `provider` → `none`; unknown `scheme` → `cbcs`.
 */
export function resolveDrmFeatures(
  disk?: DiskDrmFeatures | null,
): DrmFeatures {
  const d = disk && typeof disk === 'object' ? disk : {};
  const provider =
    str(d.provider).toLowerCase() === 'external' ? 'external' : 'none';
  const scheme: DrmScheme =
    str(d.scheme).toLowerCase() === 'cenc' ? 'cenc' : 'cbcs';
  const seen = new Set<string>();
  const systems = (Array.isArray(d.systems) ? d.systems : [])
    .map((s) => str(s).toLowerCase())
    .filter((s): s is DrmSystem =>
      (DRM_SYSTEMS as readonly string[]).includes(s),
    )
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  const urls = d.license_urls;
  return {
    enabled: d.enabled === true,
    provider,
    systems: systems.length ? systems : [...DRM_SYSTEMS],
    scheme,
    keyServerUrl: str(d.key_server_url),
    keyServerTokenEnv: str(d.key_server_token_env),
    licenseUrls: {
      widevine: str(urls?.widevine),
      playready: str(urls?.playready),
      fairplay: str(urls?.fairplay),
    },
    fairplayCertUrl: str(d.fairplay_cert_url),
    failOpen: d.fail_open === true,
  };
}

/** Serialize a resolved block back to the on-disk snake_case shape. */
export function drmFeaturesToDisk(f: DrmFeatures): Required<DiskDrmFeatures> {
  return {
    enabled: f.enabled,
    provider: f.provider,
    systems: [...f.systems],
    scheme: f.scheme,
    key_server_url: f.keyServerUrl,
    key_server_token_env: f.keyServerTokenEnv,
    license_urls: {
      widevine: f.licenseUrls.widevine,
      playready: f.licenseUrls.playready,
      fairplay: f.licenseUrls.fairplay,
    },
    fairplay_cert_url: f.fairplayCertUrl,
    fail_open: f.failOpen,
  };
}
