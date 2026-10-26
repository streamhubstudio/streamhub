/**
 * DrmProvider — the pluggable content-key seam of the VOD DRM pipeline.
 *
 * A provider answers three questions for one packaging run:
 *  1. `getContentKeys(assetId)` — which key(s) encrypt this asset (CENC/CBCS
 *     content keys + the per-system signaling blobs: PSSH boxes, FairPlay
 *     `skd://` key URI).
 *  2. `getLicenseUrl(system)`  — where players fetch licenses per DRM system.
 *  3. `packagingArgs(keys, scheme)` — extra shaka-packager argv that turns the
 *     clear packaging command into an encrypting one.
 *
 * Implementations: {@link NoopDrmProvider} (default — DRM off / not
 * configured) and `ExternalDrmProvider` (SPEKE-style multi-DRM key server).
 * Adding a vendor (EZDRM, Axinom, BuyDRM, PallyCon, …) = one new class here;
 * nothing else in the pipeline changes.
 *
 * SECURITY: `DrmContentKey.key` is the raw content key. It must NEVER be
 * logged, persisted to the DB, or serialized into callbacks/variant rows —
 * only `keyId`s are public.
 */
import type { DrmScheme, DrmSystem } from '../../../shared/contracts';

/** One CENC/CBCS content key (all values lowercase hex, 32 chars = 16 bytes). */
export interface DrmContentKey {
  /** Key id (public — appears in playlists/PSSH). */
  keyId: string;
  /** Content key (SECRET — never logged/persisted). */
  key: string;
  /** Optional constant IV (some providers pin it for cbcs). */
  iv?: string;
}

/** Per-system PSSH box as returned by a key provider. */
export interface DrmPsshBox {
  system: DrmSystem;
  /** The raw PSSH box, base64-encoded. */
  boxBase64: string;
}

/** Everything the packager needs to encrypt one asset. */
export interface DrmContentKeys {
  assetId: string;
  keys: DrmContentKey[];
  /** Per-system PSSH boxes (Widevine/PlayReady signaling in fMP4/DASH). */
  pssh?: DrmPsshBox[];
  /** FairPlay HLS key URI (`skd://…`) for EXT-X-KEY signaling. */
  hlsKeyUri?: string;
}

/** The pluggable DRM seam. */
export interface DrmProvider {
  /** Stable provider id (mirrors `features.drm.provider`). */
  readonly id: string;
  /** Whether the provider is configured well enough to encrypt at all. */
  ready(): boolean;
  /**
   * Fetch/derive the content keys for an asset. `null` = keys unavailable
   * (provider down / not configured) — the caller decides fail-open/closed.
   * Never throws.
   */
  getContentKeys(assetId: string): Promise<DrmContentKeys | null>;
  /** License server URL players use for `system`; null when not configured. */
  getLicenseUrl(system: DrmSystem): string | null;
  /** Extra shaka-packager argv enabling encryption with these keys. */
  packagingArgs(keys: DrmContentKeys, scheme: DrmScheme): string[];
}

/**
 * Default provider: DRM disabled / unconfigured. Never ready, never returns
 * keys, contributes no packaging args — the pipeline stays clear.
 */
export class NoopDrmProvider implements DrmProvider {
  readonly id = 'none';

  ready(): boolean {
    return false;
  }

  async getContentKeys(): Promise<DrmContentKeys | null> {
    return null;
  }

  getLicenseUrl(): string | null {
    return null;
  }

  packagingArgs(): string[] {
    return [];
  }
}
