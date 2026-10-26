/**
 * ExternalDrmProvider — SPEKE-style multi-DRM key server client (stub).
 *
 * This is the seam a real DRM-as-a-service vendor (EZDRM, Axinom, BuyDRM,
 * PallyCon, DRMtoday, …) plugs into: the app's `features.drm.key_server_url`
 * receives a POST `{asset_id, systems, scheme}` (bearer token from the
 * `key_server_token_env` secret ref) and answers with content keys + optional
 * per-system PSSH boxes and a FairPlay `skd://` key URI:
 *
 *   { "keys": [{ "key_id": "<32-hex>", "key": "<32-hex>", "iv": "<32-hex>?" }],
 *     "pssh": [{ "system": "widevine", "box": "<base64>" }],
 *     "hls_key_uri": "skd://..." }
 *
 * Vendors that speak real SPEKE/CPIX XML get their own subclass/adapter —
 * only `getContentKeys` changes. Any failure (network, non-2xx, malformed
 * body, bad hex) degrades to `null`; the DrmService decides fail-open/closed.
 * No vendor keys exist in this repo: without a configured key server this
 * provider is never `ready()` and the pipeline stays clear.
 */
import type { DrmFeatures, DrmScheme, DrmSystem } from '../../../shared/contracts';
import { DRM_SYSTEMS } from './drm-config';
import { buildRawKeyArgs } from './drm-packager.util';
import type {
  DrmContentKey,
  DrmContentKeys,
  DrmProvider,
  DrmPsshBox,
} from './drm-provider';

/** 16 bytes as lowercase hex. */
const HEX16 = /^[0-9a-f]{32}$/;
const KEY_REQUEST_TIMEOUT_MS = 10_000;

/** Normalize a hex-ish value: trim, strip 0x/dashes (UUID form), lowercase. */
function normHex(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim().replace(/^0x/i, '').replace(/-/g, '').toLowerCase();
}

export class ExternalDrmProvider implements DrmProvider {
  readonly id = 'external';

  constructor(
    private readonly cfg: DrmFeatures,
    /** Resolved bearer token (from the `key_server_token_env` ref) or none. */
    private readonly token?: string,
    /** Injectable for tests — specs must never dial the network. */
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  ready(): boolean {
    return (
      this.cfg.enabled &&
      this.cfg.provider === 'external' &&
      this.cfg.keyServerUrl.length > 0
    );
  }

  async getContentKeys(assetId: string): Promise<DrmContentKeys | null> {
    if (!this.ready()) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        KEY_REQUEST_TIMEOUT_MS,
      );
      let res: Response;
      try {
        res = await this.fetchFn(this.cfg.keyServerUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify({
            asset_id: assetId,
            systems: this.cfg.systems,
            scheme: this.cfg.scheme,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const body = (await res.json()) as {
        keys?: unknown;
        pssh?: unknown;
        hls_key_uri?: unknown;
        hlsKeyUri?: unknown;
      };
      const keys: DrmContentKey[] = (Array.isArray(body?.keys)
        ? (body.keys as Record<string, unknown>[])
        : []
      )
        .map((k) => {
          const iv = normHex(k?.iv);
          return {
            keyId: normHex(k?.key_id ?? k?.keyId),
            key: normHex(k?.key),
            ...(iv ? { iv } : {}),
          };
        })
        .filter(
          (k) =>
            HEX16.test(k.keyId) &&
            HEX16.test(k.key) &&
            (k.iv === undefined || HEX16.test(k.iv)),
        );
      if (!keys.length) return null;
      const pssh: DrmPsshBox[] = (Array.isArray(body?.pssh)
        ? (body.pssh as Record<string, unknown>[])
        : []
      )
        .map((p) => ({
          system: String(p?.system ?? '').toLowerCase() as DrmSystem,
          boxBase64: String(p?.box ?? p?.boxBase64 ?? '').trim(),
        }))
        .filter(
          (p) =>
            (DRM_SYSTEMS as readonly string[]).includes(p.system) &&
            p.boxBase64.length > 0,
        );
      const rawUri = body?.hls_key_uri ?? body?.hlsKeyUri;
      const hlsKeyUri =
        typeof rawUri === 'string' && rawUri.trim() ? rawUri.trim() : undefined;
      return {
        assetId,
        keys,
        ...(pssh.length ? { pssh } : {}),
        ...(hlsKeyUri ? { hlsKeyUri } : {}),
      };
    } catch {
      // Timeouts, DNS failures, JSON parse errors — all degrade to null.
      return null;
    }
  }

  getLicenseUrl(system: DrmSystem): string | null {
    if (!this.cfg.systems.includes(system)) return null;
    return this.cfg.licenseUrls[system] || null;
  }

  packagingArgs(keys: DrmContentKeys, scheme: DrmScheme): string[] {
    return buildRawKeyArgs(keys, scheme);
  }
}
