/**
 * DrmService — decides, per VOD packaging run, whether the HLS output is
 * packaged CLEAR (today's pipeline, unchanged) or ENCRYPTED (CENC/CBCS via
 * shaka-packager + a DrmProvider's content keys).
 *
 * The whole guard chain lives here so VodTranscodeService only branches on a
 * single {@link DrmDecision}:
 *
 *   features.drm.enabled=false            → { mode: 'clear' }          (default)
 *   provider unconfigured / no packager / → fail_open=false: 'skip'    (fail closed)
 *   key server returns nothing              fail_open=true : 'clear-degraded'
 *   everything available                  → { mode: 'encrypt', ctx }
 *
 * No vendor keys ship with StreamHub — until an external key server is
 * configured (and the shaka-packager binary is present) every decision is
 * `clear` or, when explicitly enabled, a loud fail-closed `skip`.
 */
import { Injectable, Logger } from '@nestjs/common';

import type {
  AppConfig,
  DrmFeatures,
  DrmScheme,
  DrmSystem,
} from '../../../shared/contracts';
import { SecretsStore } from '../../s3/secrets.store';
import { resolveDrmFeatures } from './drm-config';
import { isShakaPackagerAvailable } from './drm-packager.util';
import { ExternalDrmProvider } from './external-drm.provider';
import {
  DrmContentKeys,
  DrmProvider,
  NoopDrmProvider,
} from './drm-provider';

/** Everything the packaging step needs to encrypt one asset. */
export interface DrmPackagingContext {
  scheme: DrmScheme;
  systems: DrmSystem[];
  keys: DrmContentKeys;
  /** Extra shaka-packager argv from the provider (contains key material). */
  keyArgs: string[];
  /** Per-system license URLs to surface to players (public). */
  licenseUrls: Partial<Record<DrmSystem, string>>;
  /** FairPlay `skd://` key URI when the provider supplied one. */
  hlsKeyUri?: string;
}

/** Outcome of the per-run DRM guard chain. */
export type DrmDecision =
  /** DRM disabled — package clear exactly as before. */
  | { mode: 'clear' }
  /** DRM enabled but impossible; fail_open=false → NO HLS variants ship. */
  | { mode: 'skip'; reason: string }
  /** DRM enabled but impossible; fail_open=true → clear packaging, logged. */
  | { mode: 'clear-degraded'; reason: string }
  /** Encrypt: run shaka-packager with `ctx`. */
  | { mode: 'encrypt'; ctx: DrmPackagingContext };

@Injectable()
export class DrmService {
  private readonly logger = new Logger(DrmService.name);

  /** Injectable for tests — specs must never dial the network. */
  fetchFn: typeof fetch = fetch;

  constructor(private readonly secrets: SecretsStore) {}

  /** Resolved `features.drm` (defaults applied for pre-block fixtures). */
  featuresOf(cfg: AppConfig): DrmFeatures {
    return cfg.features?.drm ?? resolveDrmFeatures(undefined);
  }

  /** Whether the app opted into DRM at all. */
  enabledFor(cfg: AppConfig): boolean {
    return this.featuresOf(cfg).enabled;
  }

  /** Build the provider for an app (Noop unless external is configured). */
  async providerFor(cfg: AppConfig): Promise<DrmProvider> {
    const drm = this.featuresOf(cfg);
    if (!drm.enabled || drm.provider !== 'external') {
      return new NoopDrmProvider();
    }
    const token = drm.keyServerTokenEnv
      ? await this.secrets.get(drm.keyServerTokenEnv)
      : undefined;
    return new ExternalDrmProvider(drm, token, this.fetchFn);
  }

  /**
   * Run the full guard chain for one asset. Never throws; secrets never
   * appear in reasons/logs.
   */
  async decide(cfg: AppConfig, assetId: string): Promise<DrmDecision> {
    const drm = this.featuresOf(cfg);
    if (!drm.enabled) return { mode: 'clear' };

    const fail = (reason: string): DrmDecision => {
      this.logger.warn(`drm unavailable for "${cfg.name}": ${reason}`);
      return drm.failOpen
        ? { mode: 'clear-degraded', reason }
        : { mode: 'skip', reason };
    };

    const provider = await this.providerFor(cfg);
    if (!provider.ready()) {
      return fail(
        `drm provider "${drm.provider}" is not configured (set features.drm.provider=external + key_server_url)`,
      );
    }
    if (!(await isShakaPackagerAvailable())) {
      return fail(
        'shaka-packager binary not found (install it in the core image or set SHAKA_PACKAGER_BIN)',
      );
    }
    const keys = await provider.getContentKeys(assetId);
    if (!keys || keys.keys.length === 0) {
      return fail('key server returned no content keys');
    }

    const licenseUrls: Partial<Record<DrmSystem, string>> = {};
    for (const system of drm.systems) {
      const url = provider.getLicenseUrl(system);
      if (url) licenseUrls[system] = url;
    }
    return {
      mode: 'encrypt',
      ctx: {
        scheme: drm.scheme,
        systems: [...drm.systems],
        keys,
        keyArgs: provider.packagingArgs(keys, drm.scheme),
        licenseUrls,
        ...(keys.hlsKeyUri ? { hlsKeyUri: keys.hlsKeyUri } : {}),
      },
    };
  }
}
